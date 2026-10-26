import { BrowserExtensionPanel, pairedExtensionProfile, upgradedToExtension, type BrowserExtensionPanelStatus } from "./BrowserExtensionPanel";
import { useEffect, useRef, useState } from "react";
import { acceptBrowserGeneration, expectedStaleBrowserFrame } from "@/lib/browser-view-state";
import { Hand, Maximize2, RotateCcw } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { fromAnswer } from "@/state/answer-tag";
import { BrowserLiveView, type LiveBrowserFrame } from "./BrowserLiveView";
import { describeDesktopOnlyRouteError, routeErrorFrom } from "@/lib/desktop-only-route-error";
/** Select value for "Use my Chrome"; "@" can never appear in a profile id. */
export const MY_CHROME = "@my-chrome";
/** The old "Use my browser" value: since 1.0.7 the same one choice. */
export const MY_BROWSER = "@my-browser";
/** The PATCH a browser choice sends, or null when it must be confirmed first.
 * "Use my Chrome" is one choice: the server picks Murage for Chrome when it is
 * paired and Chrome's remote debugging only when it is not (browserTransport "auto"). */
export function browserChoicePatch(bot: Pick<Bot, "useMyChrome" | "browserTransport">, value: string): Record<string, unknown> | null {
  if (value === MY_CHROME || value === MY_BROWSER) return bot.useMyChrome ? {} : null;
  return { ...(bot.useMyChrome ? { useMyChrome: false } : {}), browserProfile: value || null };
}
/** The PATCH a confirmed "Use my Chrome" sends. */
export const USE_MY_CHROME_PATCH = { useMyChrome: true, browserTransport: "auto" } as const;
/** What choosing "Use my Chrome" means, said at the moment of choosing. */
export function MyChromeConsent({ botName, pending, onConfirm, onCancel }: { botName: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div role="dialog" aria-label="Use my Chrome" className="flex flex-col gap-2 rounded-lg bg-card p-3 text-xs">
    <p className="text-sm text-ink">{botName} works in your Chrome, signed in as you, in a tab of its own.</p>
    <p className="text-ink-secondary">Murage connects through Murage for Chrome when it is installed, and shows you one step if it is not. With Murage for Chrome you choose which sites {botName} may use, and anything that sends, posts, buys or changes something asks you first. You can pause or stop at any time.</p>
    <p className="text-ink-secondary">If Murage for Chrome is not connected but Chrome's remote debugging is on, Murage uses that instead. Chrome asks you once to Allow it, {botName} can then reach your open tabs, and one bot at a time can use it.</p>
    <div className="flex gap-2"><button disabled={pending} onClick={onConfirm} className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Use my Chrome</button><button onClick={onCancel} className="rounded-lg bg-control px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-accent">Cancel</button></div>
  </div>;
}
/** "Use my Chrome" over remote debugging could not connect: one new attempt,
 * offered where the owner is looking. Never a timer: each attempt is a new
 * "Allow remote debugging?" prompt in Chrome. */
export function UserChromeRetryNotice({ botName, pending, onRetry }: { botName: string; pending: boolean; onRetry: () => void }) {
  return <div role="status" className="rounded-lg bg-card p-3 text-xs text-ink-secondary"><p className="text-ink">Chrome did not connect.</p><p className="mt-1">{botName} will also try again on its next step.</p><button disabled={pending} onClick={onRetry} className="mt-2 flex items-center gap-2 rounded bg-control px-2 py-1 text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={12} />Try again</button></div>;
}
/** The live view's words for the owner's Chrome while its first connection waits. */
export const WAITING_FOR_CHROME = "Waiting for Chrome: click Allow in its remote debugging prompt.";
type Status = { owned?: boolean; canReclaim?: boolean; generation: number; held: boolean; connected: boolean; protectedDocument: boolean; protectedReason?: "owner-input" | "sensitive-page" | null; url: string; notRunning?: boolean; problem?: string; problemCode?: string; waitingForChrome?: boolean; control?: number };
/** The locked-page note, in the owner's words: why the bot cannot use the
 * page and the one step that gives it back. */
export function ProtectedBrowserNotice({ botName, reason, held, pending, onReopen }: { botName: string; reason?: Status["protectedReason"]; held: boolean; pending: boolean; onReopen: () => void }) {
  const why = reason === "sensitive-page"
    ? `${botName} can't use this page because it has a password, code or card field, an embedded frame, or content Murage can't check. ${botName} can open a different page itself, or you can take control and reopen a blank page to give ${botName} its browser back.`
    : `${botName} can't use this page because you typed or clicked in it. Take control, then reopen a blank page to give ${botName} its browser back.`;
  return <div role="status" className="rounded-lg bg-card p-3 text-xs text-ink-secondary">{why}<button disabled={!held || pending} onClick={onReopen} className="mt-2 flex items-center gap-2 rounded bg-control px-2 py-1 text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={12} />Reopen blank page</button></div>;
}
/** The bot's browser stopped answering and no page lock is showing: the one
 * step that restarts it, offered where the owner is already looking. */
export function BrowserRestartNotice({ botName, held, pending, onReopen }: { botName: string; held: boolean; pending: boolean; onReopen: () => void }) {
  return <div role="status" className="rounded-lg bg-card p-3 text-xs text-ink-secondary">{held ? `Reopen a blank page to restart ${botName}'s browser.` : `Take control, then reopen a blank page to restart ${botName}'s browser.`}<button disabled={!held || pending} onClick={onReopen} className="mt-2 flex items-center gap-2 rounded bg-control px-2 py-1 text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={12} />Reopen blank page</button></div>;
}
/** The bot's browser engine is not running (often after it stopped while
 * idle and could not start again in time). Its own state, never a page lock:
 * the one step is Restart browser, with no need to take control first. */
export function BrowserNotRunningNotice({ botName, pending, onRestart }: { botName: string; pending: boolean; onRestart: () => void }) {
  return <div role="status" className="rounded-lg bg-card p-3 text-xs text-ink-secondary">{`${botName}'s browser is not running. Restart it to give ${botName} its browser back.`}<button disabled={pending} onClick={onRestart} className="mt-2 flex items-center gap-2 rounded bg-control px-2 py-1 text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={12} />Restart browser</button></div>;
}
/** The panel's alerts. A refused browser choice ("only one bot at a time")
 * is the person's answer and comes first, on its own: a connection problem
 * (a timed-out engine) used to replace it in the one alert box. */
export function BrowserPanelAlerts({ refusal, problem }: { refusal: string; problem: string }) {
  return <>
    {refusal && <div role="alert" className="rounded-lg border border-danger/30 p-2 text-xs text-danger">{refusal}</div>}
    {problem && <div role="alert" className="rounded-lg border border-danger/30 p-2 text-xs text-danger">{problem}</div>}
  </>;
}
/** Linux AppImage: Ubuntu allows Chrome's sandbox only under an AppArmor
 * rule. Enable browser asks for the system's administrator prompt to add it;
 * closing the prompt leaves the message above as it was. */
export function BrowserSandboxEnable({ pending, note, onEnable }: { pending: boolean; note: string; onEnable: () => void }) {
  return <div role="status" className="rounded-lg bg-card p-3 text-xs text-ink-secondary"><button disabled={pending} onClick={onEnable} className="flex items-center gap-2 rounded bg-control px-2 py-1 text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">{pending ? "Waiting for the administrator prompt" : "Enable browser"}</button>{note && <p className="mt-2">{note}</p>}</div>;
}
/** The refusal code the server sends when Enable browser can fix it. */
export const BROWSER_SANDBOX_ENABLE_CODE = "browser_sandbox_enable";
type UnifiedBrowserPanelProps = { bot: Bot; size?: "compact" | "expanded"; onExpand?: () => void; control?: unknown; controlPending?: boolean; onControl?: unknown; onCollapse?: () => void };
export function UnifiedBrowserPanel(props: UnifiedBrowserPanelProps) {
  return props.bot.useMyChrome && props.bot.browserTransport === "extension" ? <BrowserExtensionPanel key={props.bot.id} bot={props.bot} /> : <LegacyBrowserPanel {...props} />;
}
function LegacyBrowserPanel({ bot, size = "compact", onExpand }: UnifiedBrowserPanelProps) {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [frame, setFrame] = useState<LiveBrowserFrame | null>(null);
  const [address, setAddress] = useState("");
  const [pageText, setPageText] = useState("");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [canEnable, setCanEnable] = useState(false);
  const [enableNote, setEnableNote] = useState("");
  const [refusal, setRefusal] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmMyChrome, setConfirmMyChrome] = useState(false);
  const [switching, setSwitching] = useState(false);
  const current = useRef<Status | null>(null);
  const epoch = useRef(0);
  const queue = useRef(Promise.resolve());
  const queueSize = useRef(0);
  const base = `/api/bots/${encodeURIComponent(bot.id)}/browser`;
  const accept = (next: Status) => {
    if (!acceptBrowserGeneration(current.current?.generation, next?.generation)) return;
    if (current.current && next.generation !== current.current.generation) setFrame(null);
    current.current = next; setStatus(next);
  };
  useEffect(() => {
    let alive = true; const identity = ++epoch.current;
    current.current = null; setStatus(null); setFrame(null); setAddress(""); setError(""); setConnectionError(""); setRefusal("");
    let timer: ReturnType<typeof setTimeout>;
    let lastStatus = 0;
    const poll = async () => {
      try {
        if (!current.current || Date.now() - lastStatus > 1000) {
          const next = await api(base) as Status;
          if (!alive) return;
          accept(next); lastStatus = Date.now();
        }
        const generation = current.current!.generation;
        let next: LiveBrowserFrame | null;
        try { next = await api(`${base}/frame?generation=${generation}`) as LiveBrowserFrame | null; }
        catch (cause) { if (expectedStaleBrowserFrame(cause)) { lastStatus = 0; return; } throw cause; }
        if (!alive || epoch.current !== identity || current.current?.generation !== generation) return;
        // The Enable browser note stays until a page actually shows.
        setConnectionError(""); setCanEnable(false); if (next) setEnableNote("");
        if (next?.generation === generation) setFrame(old => old?.seq === next.seq ? old : next);
      } catch (cause) {
        if (alive) { setConnectionError(describeDesktopOnlyRouteError(cause instanceof Error ? routeErrorFrom(cause) : { message: "Browser connection unavailable" })); setCanEnable(cause instanceof Error && routeErrorFrom(cause).code === BROWSER_SANDBOX_ENABLE_CODE); setFrame(null); lastStatus = 0; }
      } finally { if (alive) timer = setTimeout(poll, document.hidden ? 1000 : 100); }
    };
    void poll();
    return () => { alive = false; epoch.current++; clearTimeout(timer); };
  }, [base, bot.browserProfile, bot.useMyChrome]);
  // On remote debugging, Murage for Chrome pairing moves the bot over by
  // itself, once it is idle and the owner is not holding control.
  const remoteDebugging = !!bot.useMyChrome && bot.browserTransport !== "extension";
  const busy = !!bot.busy;
  useEffect(() => {
    if (!remoteDebugging || busy) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await api(`/api/bots/${encodeURIComponent(bot.id)}/browser-extension`) as BrowserExtensionPanelStatus;
        const paired = pairedExtensionProfile(next?.profiles ?? []);
        // Only with exactly one Chrome profile, read successfully, while idle and not held.
        if (alive && paired.profileId && !current.current?.held) {
          upgradedToExtension.add(bot.id);
          const result = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify({ useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: paired.profileId }) });
          if (alive) dispatch({ type: "botPatched", ...fromAnswer(result.bot), bot: result.bot });
          return;
        }
      } catch { upgradedToExtension.delete(bot.id); /* tried again on the next check */ }
      if (alive) timer = setTimeout(check, 3000);
    };
    timer = setTimeout(check, 1000);
    return () => { alive = false; clearTimeout(timer); };
  }, [bot.id, remoteDebugging, busy]);
  const chooseBrowser = async (body: Record<string, unknown>) => {
    setRefusal("");
    try {
      // Holding control: give it back first, then switch (the hold never locks the picker).
      if (current.current?.held && current.current.owned !== false) { setSwitching(true); await api(base, { method: "POST", body: JSON.stringify({ action: "release", generation: current.current.generation, control: current.current.control }) }); }
      const result = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify(body) }); dispatch({ type: "botPatched", ...fromAnswer(result.bot), bot: result.bot }); setConfirmMyChrome(false);
    }
    // Refused: close the confirmation (the picker falls back to the saved
    // choice) and say why where nothing else can cover it.
    catch (cause) { setConfirmMyChrome(false); setRefusal(cause instanceof Error ? cause.message : `Could not change ${bot.name}'s browser. Try again.`); }
    finally { setSwitching(false); }
  };
  const enableBrowser = async () => {
    setPending(true); setEnableNote("");
    try {
      const result = await api("/api/browser/linux-sandbox/enable", { method: "POST", body: "{}" }) as { outcome?: string };
      // Enabled: the next poll asks Chrome again and the browser comes up.
      if (result.outcome !== "enabled") setEnableNote("The administrator prompt was closed, so nothing changed.");
    } catch (cause) { setEnableNote(cause instanceof Error ? cause.message : "Enable browser failed"); }
    finally { setPending(false); }
  };
  const action = async (name: string, extra: Record<string, unknown> = {}) => {
    const identity = epoch.current; setPending(true); setError("");
    try {
      const next = await api(base, { method: "POST", body: JSON.stringify({ action: name, generation: current.current?.generation, control: current.current?.control, ...extra }) }) as Status;
      if (identity === epoch.current && next?.generation) accept(next);
    } catch (cause) { if (identity === epoch.current) setError(describeDesktopOnlyRouteError(cause instanceof Error ? routeErrorFrom(cause) : { message: "Browser action failed" })); }
    finally { if (identity === epoch.current) setPending(false); }
  };
  const input = (event: Record<string, unknown>) => {
    const generation = current.current?.generation, identity = epoch.current;
    if (!current.current?.held || current.current.owned === false || pending) return;
    if (queueSize.current >= 24) { setError("Input is catching up. Wait a moment before typing again."); return; }
    queueSize.current++;
    queue.current = queue.current.then(async () => {
      if (epoch.current !== identity || current.current?.generation !== generation) return;
      await api(base, { method: "POST", body: JSON.stringify({ action: "input", generation, event }) });
    }).catch(() => { if (epoch.current === identity) setError("Input stopped because browser control changed."); }).finally(() => { queueSize.current--; });
  };
  return <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-1">
    <div className="flex items-center justify-between gap-2 text-sm"><span>{bot.name}'s browser</span>{size === "compact" && onExpand && <button aria-label="Expand browser" className="rounded p-2 focus-visible:ring-2 focus-visible:ring-accent" onClick={onExpand}><Maximize2 size={16} /></button>}</div>
    <form className="flex min-w-0 gap-2" onSubmit={e => { e.preventDefault(); void action("navigate", { url: address }); }}>
      <input aria-label="Web address" value={address} onChange={e => setAddress(e.target.value)} placeholder={status?.url || "https://example.com"} disabled={!status?.held || pending} className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <button disabled={!status?.held || pending || !address.trim()} className="rounded-lg bg-control px-3 text-sm disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Go</button>
    </form>
    <div className="relative overflow-hidden rounded-xl border border-hairline"><BrowserLiveView frame={frame} generation={status?.generation ?? 0} held={!!status?.held && status.owned !== false && !pending} onInput={input} />{!frame && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-secondary" role="status">{status?.notRunning ? "Browser not running" : status?.waitingForChrome ? WAITING_FOR_CHROME : bot.useMyChrome && (connectionError || status?.problem) ? "Chrome did not connect." : connectionError || status?.problem ? "Browser unavailable" : status?.connected ? "Waiting for the page…" : "Connecting to browser…"}</div>}</div>
    {status?.held && status.owned !== false && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if(pageText){input({type:"input_keyboard",eventType:"char",text:pageText});setPageText("");} }}>
      <input type="password" autoComplete="off" aria-label="Text for focused browser field" placeholder="Focus a page field, then type here" maxLength={100} value={pageText} onChange={event => setPageText(event.target.value)} className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <button disabled={!pageText || pending} className="rounded-lg bg-control px-3 text-sm disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Send text</button>
    </form>}
    <div className="flex flex-wrap items-center justify-between gap-2"><span role="status" className="text-xs text-ink-secondary">{status?.notRunning ? "Not running" : status?.waitingForChrome ? "Waiting for Chrome" : connectionError || status?.problem ? "Unavailable" : status?.connected ? (bot.useMyChrome ? "Connected to your Chrome" : "Live") : "Disconnected"} · {status?.held ? "Human control" : "Bot control"}</span><button disabled={!status || pending || (status.held && status.owned === false && !status.canReclaim)} onClick={() => void action(status?.held && status.owned === false ? "reclaim" : status?.held ? "release" : "take")} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><Hand size={14} />{pending ? "Please wait…" : status?.held && status.owned === false ? "Take control here" : status?.held ? "Return to bot" : "Take control"}</button></div>
    {status?.notRunning && !bot.useMyChrome && status.owned !== false && <BrowserNotRunningNotice botName={bot.name} pending={pending} onRestart={() => void action("restart")} />}
    {bot.useMyChrome && !status?.waitingForChrome && !status?.connected && (status?.problem || connectionError) && <UserChromeRetryNotice botName={bot.name} pending={pending} onRetry={() => void action("retry")} />}
    {!bot.useMyChrome && status?.problem && status.problemCode !== BROWSER_SANDBOX_ENABLE_CODE && !status.notRunning && !status.protectedDocument && status.owned !== false && <BrowserRestartNotice botName={bot.name} held={status.held} pending={pending} onReopen={() => void action("reopen")} />}
    {status?.protectedDocument && <ProtectedBrowserNotice botName={bot.name} reason={status.protectedReason} held={status.held} pending={pending} onReopen={() => void action("reopen")} />}
    <label className="flex min-w-0 items-center gap-2 text-sm">Profile<select aria-label="Browser profile" value={confirmMyChrome || bot.useMyChrome ? MY_CHROME : bot.browserProfile ?? ""} disabled={bot.busy || pending || switching} className="min-w-0 flex-1 rounded bg-inset p-2 focus-visible:ring-2 focus-visible:ring-accent" onChange={event => {
      const patch = browserChoicePatch(bot, event.target.value);
      // Nothing changes until the owner confirms what attaching means.
      if (!patch) { setConfirmMyChrome(true); return; }
      setConfirmMyChrome(false);
      if (Object.keys(patch).length) void chooseBrowser(patch);
    }}><option value="">{bot.name}'s own</option>{(state.config?.browserProfiles ?? []).map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}<option value="guest">Guest</option><option value={MY_CHROME}>Use my Chrome</option></select></label>
    {bot.busy ? <p className="text-xs text-ink-secondary">Stop {bot.name}'s turn to change its browser.</p> : switching ? <p role="status" className="text-xs text-ink-secondary">Returning control, then switching…</p> : status?.held && status.owned !== false && <p className="text-xs text-ink-secondary">Choosing another browser returns control to {bot.name} first.</p>}
    {confirmMyChrome && !bot.useMyChrome && <MyChromeConsent botName={bot.name} pending={pending || switching} onConfirm={() => void chooseBrowser({ ...USE_MY_CHROME_PATCH })} onCancel={() => setConfirmMyChrome(false)} />}
    {bot.useMyChrome && <p className="text-xs text-ink-secondary">Using your Chrome, signed in as you. {bot.name} can see your open tabs.</p>}
    <p className="text-xs text-ink-secondary">Take control before interacting. Disconnecting keeps human control until you return it. Tab leaves the browser page.</p>
    <BrowserPanelAlerts refusal={refusal} problem={connectionError || error || status?.problem || ""} />
    {((canEnable && connectionError) || (!connectionError && status?.problemCode === BROWSER_SANDBOX_ENABLE_CODE)) && <BrowserSandboxEnable pending={pending} note={enableNote} onEnable={() => void enableBrowser()} />}
  </div>;
}
