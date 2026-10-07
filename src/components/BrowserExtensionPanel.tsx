// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserApprovalMode } from "./BrowserApprovalMode";
import { BrowserApprovedSites } from "./BrowserApprovedSites";
import { BrowserActivityLog } from "./BrowserActivityLog";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot } from "@/state/store";
export type ExtensionSiteAccess = "allow" | "ask" | "never";
export type BrowserExtensionPanelStatus = {
  profiles: { profileId: string; browser: string }[];
  bindings: { bindingId: string; botId: string; threadId: string; profileId: string; state: "active" | "paused" | "stopped"; /** Paused for a step only the owner can do (spec 2.5.1). */ handoff?: boolean; /** The task ended (End task or Stop): the offer to allow its sites for good reads this. */ taskEnded?: boolean; /** A failed save turned Allow always sites back to Ask (the status poll carries it). */ sitesLowered?: boolean; sites: Record<string, ExtensionSiteAccess> }[];
  helper: { running: boolean; reason?: string; problem?: "repair" | "foreign"; shared?: Partial<Record<Browser, string[]>> };
  storeUrl: string | null;
  extensionBuild?: "release" | "development" | "none";
  /** The server's route for starting a new task after Stop (C2). Absent until that route exists; the button stays hidden. */
  startTaskRoute?: string;
};
type Browser = "chrome" | "edge" | "brave";
/** The tasks the server says have ended, whose sites the bot used (spec 2.3). */
export const endedBindingIds = (status: BrowserExtensionPanelStatus | null | undefined): string[] => (status?.bindings ?? []).filter(item => item.taskEnded === true).map(item => item.bindingId);
/** Whether any binding says a failed save lowered the owner's Allow always sites. */
export const sitesLoweredIn = (status: BrowserExtensionPanelStatus | null | undefined): boolean => (status?.bindings ?? []).some(item => item.sitesLowered === true);
/** The feature check for Start a new task: the server advertises its own route, and only an app route counts. */
export const startNewTaskRoute = (status: BrowserExtensionPanelStatus | null | undefined): string | null =>
  typeof status?.startTaskRoute === "string" && /^\/api\/[A-Za-z0-9/_-]+$/.test(status.startTaskRoute) ? status.startTaskRoute : null;
const BROWSER_NAMES: Record<string, string> = { chrome: "Chrome", edge: "Edge", brave: "Brave", chromium: "Chromium" };
/** "Chrome and Brave", in the order the owner chose first. */
export function browserList(chosen: Browser, shared: string[] | undefined): string {
  const names = [chosen, ...(shared ?? []).filter(item => item !== chosen)].map(item => BROWSER_NAMES[item] ?? item);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}
/** The browser this bot was connected in before, else Chrome. */
export function rememberedBrowser(bot: Pick<Bot, "browserExtensionBrowser">): Browser { return bot.browserExtensionBrowser ?? "chrome"; }
const control = "browser-extension-control min-h-11 rounded-lg bg-control px-3 py-2 text-sm text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export function BrowserExtensionConsent({ botName, pending, onConfirm, onCancel }: { botName: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div role="dialog" aria-label="Use my browser" className="flex flex-col gap-3 rounded-lg bg-card p-3 text-sm text-ink">
    <p>{botName} can work in tabs you share through Murage for Chrome, using your signed-in accounts.</p>
    <p className="text-ink-secondary">You choose the sites it may access. Actions that send, post, buy or change something need separate approval. You can pause or stop in the browser.</p>
    <p className="text-ink-secondary">Setup is optional. Keep using Murage without the extension if you prefer.</p>
    <div className="flex flex-wrap gap-2"><button className={control} disabled={pending} onClick={onConfirm}>Set up my browser</button><button className={control} disabled={pending} onClick={onCancel}>Keep current browser</button></div>
  </div>;
}
type ViewProps = { botName: string; profileId?: string; status: BrowserExtensionPanelStatus | null; pending: boolean; error: string; connectBrowser: Browser; onConnectBrowser: (browser: Browser) => void; onCheck: (browser: Browser) => void; onProfile: (profileId: string) => void; onAction: (action: "stop" | "pause", bindingId: string) => void; /** Start a new task after Stop; shown only when the status carries the route. */ onStartNew?: (bindingId: string) => void; onSite: (bindingId: string, origin: string, access: ExtensionSiteAccess) => void; onOwnBrowser: () => void;
  /** Mode, approved sites and activity (T34); the container fills it. */ settings?: ReactNode; removing?: boolean; removedNote?: string; onRepair?: (browser: Browser) => void; onRemoveAsk?: () => void; onRemoveConfirm?: (browser: Browser) => void; onRemoveCancel?: () => void };
export function BrowserExtensionPanelView({ botName, profileId, status, pending, error, connectBrowser, onConnectBrowser, onCheck, onProfile, onAction, onStartNew, onSite, onOwnBrowser, settings, removing, removedNote, onRepair, onRemoveAsk, onRemoveConfirm, onRemoveCancel }: ViewProps) {
  const connected = !!status?.profiles.some(profile => !profileId || profile.profileId === profileId);
  return <section aria-label={`${botName}'s browser connection`} className="flex min-h-0 flex-col gap-3 overflow-y-auto p-1 text-sm text-ink">
    <h3 className="font-medium">Use my browser</h3>
    <p role="status" aria-live="polite" className="text-ink-secondary">{!status ? (error ? "Browser connection unavailable" : "Checking browser connection…") : connected ? "Browser profile connected" : profileId && status.profiles.length ? "Your selected browser profile is not connected" : "Browser extension not connected"}</p>
    {error && <p role="alert" className="rounded-lg border border-danger/30 p-3 text-danger">{error}</p>}
    {!connected && <div className="flex flex-col gap-3 rounded-lg bg-card p-3">
      {status?.extensionBuild === "development" && <p>Open Murage for Chrome in your browser to connect. No store listing is available yet. This build uses an unpacked development extension.</p>}
      <p className="text-ink-secondary">{status?.helper.reason || (status?.helper.running ? "Murage is waiting for the extension. Open its side panel, then check again." : "The browser helper needs to be connected before your tabs can be shared.")}</p>
      {status?.storeUrl && <a className={`${control} text-center`} href={status.storeUrl} target="_blank" rel="noopener noreferrer">Open Chrome Web Store</a>}
      {status?.helper.problem === "repair" && onRepair && <button className={control} disabled={pending} onClick={() => onRepair(connectBrowser)}>Repair connection</button>}
      <label className="flex flex-col gap-2">Browser to connect<select className={control} value={connectBrowser} disabled={pending} onChange={event => onConnectBrowser(event.target.value as "chrome" | "edge" | "brave")}><option value="chrome">Chrome</option><option value="edge">Edge</option><option value="brave">Brave</option></select></label>
      <button className={control} disabled={pending} onClick={() => onCheck(connectBrowser)}>{pending ? "Checking…" : "Check connection"}</button>
    </div>}
    {status && (status.profiles.length > 1 || (!profileId && status.profiles.length === 1)) && <label className="flex flex-col gap-2">Browser profile<select className={control} aria-label="Connected browser profile" value={profileId ?? ""} disabled={pending} onChange={event => onProfile(event.target.value)}><option value="" disabled>Choose a profile</option>{status.profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.browser} · {profile.profileId.slice(0, 8)}</option>)}</select></label>}
    {connected && <>
      <p className="text-ink-secondary">Share a tab from the extension side panel. Resume there after checking the page. Private input stays paused until you choose to continue.</p>
      {!status?.bindings.length && <p>No browser task is active. Ask {botName} to use a shared tab.</p>}
      {status?.bindings.map(binding => <div key={binding.bindingId} className="flex flex-col gap-3 rounded-lg border border-hairline p-3">
        {binding.handoff && binding.state === "paused" && <div role="status" data-your-turn className="rounded-lg border-2 border-warning p-3"><p className="font-medium">{t("browserExt.yourTurn.title")}</p><p className="text-ink-secondary">{t("browserExt.yourTurn.chatReminder", { bot: botName })}</p></div>}
        <p role="status">{binding.state === "active" ? "Ready to work in shared tabs" : binding.state === "paused" ? "Paused by you" : "Stopped by you"}</p>
        <div className="flex flex-wrap gap-2"><button className={control} disabled={pending || binding.state === "stopped"} onClick={() => onAction("stop", binding.bindingId)}>Stop</button><button className={control} disabled={pending || binding.state !== "active"} onClick={() => onAction("pause", binding.bindingId)}>Pause</button>{binding.state === "stopped" && onStartNew && startNewTaskRoute(status) && <button className={control} data-action="start-new-task" disabled={pending} onClick={() => onStartNew(binding.bindingId)}>{t("browserExt.task.startNew")}</button>}</div>
        {Object.entries(binding.sites).map(([origin, access]) => <label key={origin} className="flex min-w-0 flex-col gap-2"><span className="break-all">{origin}</span><select aria-label={`Site access for ${origin}`} className={control} disabled={pending} value={access} onChange={event => onSite(binding.bindingId, origin, event.target.value as ExtensionSiteAccess)}><option value="allow">Allow site access</option><option value="ask">Ask each time</option><option value="never">Never allow</option></select></label>)}
      </div>)}
      <p className="text-xs text-ink-secondary">Site access permits reading that site. It does not approve sending, posting or other changes.</p>
    </>}
    {settings}
    <button className={control} disabled={pending} onClick={onOwnBrowser}>Use {botName}'s own browser</button>
    {removedNote && <p role="status" className="text-ink-secondary">{removedNote}</p>}
    {onRemoveAsk && !removing && <button className={control} disabled={pending} onClick={onRemoveAsk}>Remove browser helper</button>}
    {removing && <div role="dialog" aria-label="Remove browser helper" className="flex flex-col gap-3 rounded-lg bg-card p-3">
      <label className="flex flex-col gap-2">Browser<select className={control} value={connectBrowser} disabled={pending} onChange={event => onConnectBrowser(event.target.value as Browser)}><option value="chrome">Chrome</option><option value="edge">Edge</option><option value="brave">Brave</option></select></label>
      <p>Remove Murage's helper registration for {BROWSER_NAMES[connectBrowser]}? Browser tasks must be stopped first.</p>
      {(status?.helper.shared?.[connectBrowser]?.length ?? 0) > 1 && <p>{browserList(connectBrowser, status?.helper.shared?.[connectBrowser])} share one helper registration on this computer, so removing it affects both.</p>}
      <p className="text-ink-secondary">This does not uninstall Murage for Chrome. Remove the extension itself from your browser's Extensions page. Murage only removes files it can prove it wrote.</p>
      <div className="flex flex-wrap gap-2"><button className={control} disabled={pending} onClick={() => onRemoveConfirm?.(connectBrowser)}>Remove helper</button><button className={control} disabled={pending} onClick={onRemoveCancel}>Cancel</button></div>
    </div>}
  </section>;
}
export function BrowserExtensionPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [status, setStatus] = useState<BrowserExtensionPanelStatus | null>(null);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [pending, setPending] = useState(false);
  const [connectBrowser, setConnectBrowser] = useState<Browser>(rememberedBrowser(bot));
  const [removing, setRemoving] = useState(false);
  const [removedNote, setRemovedNote] = useState("");
  const epoch = useRef(0);
  const base = `/api/bots/${encodeURIComponent(bot.id)}/browser-extension`;
  useEffect(() => {
    let alive = true; const generation = ++epoch.current; let timer: ReturnType<typeof setTimeout>;
    setStatus(null); setError(""); setConnectionError(""); setPending(false);
    const refresh = async () => { try { const next = await api(base) as BrowserExtensionPanelStatus; if (alive && epoch.current === generation) { setStatus(next); setConnectionError(""); } } catch (cause) { if (alive) { setStatus(null); setConnectionError(cause instanceof Error ? cause.message : "Connection check failed. Try again."); } } finally { if (alive) timer = setTimeout(refresh, 2500); } };
    void refresh(); return () => { alive = false; epoch.current++; clearTimeout(timer); };
  }, [base]);
  const perform = async (operation: () => Promise<void>) => { const generation = epoch.current; setPending(true); setError(""); try { await operation(); } catch(cause) { if (epoch.current === generation) setError(cause instanceof Error ? cause.message : "Browser update failed. Try again."); } finally { if (epoch.current === generation) setPending(false); } };
  const action = (body: Record<string, unknown>) => perform(async () => { const generation = epoch.current; await api(base, { method: "POST", body: JSON.stringify(body) }); const next = await api(base) as BrowserExtensionPanelStatus; if (generation === epoch.current) setStatus(next); });
  // Repair: remove only the owned registration this build cannot reuse, then connect again.
  const repair = (browser: Browser) => perform(async () => { const generation = epoch.current; await api(base, { method: "POST", body: JSON.stringify({ action: "remove", browser }) }); await api(base, { method: "POST", body: JSON.stringify({ action: "connect", browser }) }); const next = await api(base) as BrowserExtensionPanelStatus; if (generation === epoch.current) setStatus(next); });
  const remove = (browser: Browser) => perform(async () => {
    const generation = epoch.current;
    const result = await api(base, { method: "POST", body: JSON.stringify({ action: "remove", browser }) }) as BrowserExtensionPanelStatus & { removed?: { status: string; sharedBrowsers: string[] } };
    if (generation !== epoch.current) return;
    setRemoving(false); setStatus(result);
    setRemovedNote(result.removed?.status === "removed" ? `Removed the helper registration for ${browserList(browser, result.removed.sharedBrowsers)}.` : `No Murage helper registration was found for ${BROWSER_NAMES[browser]}.`);
  });
  const patch = (body: Record<string, unknown>) => perform(async () => { const generation = epoch.current; const result = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify(body) }); if (generation === epoch.current) dispatch({ type: "botPatched", bot: result.bot }); });
  return <BrowserExtensionPanelView botName={bot.name} profileId={bot.browserExtensionProfileId} status={status} pending={pending} error={error || connectionError} connectBrowser={connectBrowser} onConnectBrowser={setConnectBrowser} onCheck={browser => void action({ action: "connect", browser })} onProfile={profileId => void patch({ useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: profileId })} onAction={(name, bindingId) => void action({ action: name, bindingId })} onStartNew={bindingId => { const route = startNewTaskRoute(status); if (route) void perform(async () => { const generation = epoch.current; await api(route, { method: "POST", body: JSON.stringify({ bindingId }) }); const next = await api(base) as BrowserExtensionPanelStatus; if (generation === epoch.current) setStatus(next); }); }} onSite={(bindingId, origin, access) => void action({ action: "site", bindingId, origin, access })} onOwnBrowser={() => void patch({ useMyChrome: false, browserTransport: null, browserExtensionProfileId: null })}
    settings={<><BrowserApprovalMode bot={bot} /><BrowserApprovedSites bot={bot} profileId={bot.browserExtensionProfileId} endedBindingIds={endedBindingIds(status)} sitesLowered={sitesLoweredIn(status)} /><BrowserActivityLog bot={bot} /></>} removing={removing} removedNote={removedNote} onRepair={browser => void repair(browser)} onRemoveAsk={() => { setRemovedNote(""); setRemoving(true); }} onRemoveConfirm={browser => void remove(browser)} onRemoveCancel={() => setRemoving(false)} />;
}
