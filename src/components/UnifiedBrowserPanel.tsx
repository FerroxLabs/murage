import { useEffect, useRef, useState } from "react";
import { acceptBrowserGeneration, expectedStaleBrowserFrame } from "@/lib/browser-view-state";
import { Hand, Maximize2, RotateCcw } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { BrowserLiveView, type LiveBrowserFrame } from "./BrowserLiveView";
/** Select value for "Use my Chrome"; "@" can never appear in a profile id. */
export const MY_CHROME = "@my-chrome";
/** The PATCH a browser choice sends, or null when it must be confirmed first. */
export function browserChoicePatch(bot: Pick<Bot, "useMyChrome">, value: string): Record<string, unknown> | null {
  if (value === MY_CHROME) return bot.useMyChrome ? {} : null;
  return { ...(bot.useMyChrome ? { useMyChrome: false } : {}), browserProfile: value || null };
}
/** What choosing "Use my Chrome" means, said at the moment of choosing. */
export function MyChromeConsent({ botName, pending, onConfirm, onCancel }: { botName: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div role="dialog" aria-label="Use my Chrome" className="flex flex-col gap-2 rounded-lg bg-card p-3 text-xs">
    <p className="text-sm text-ink">{botName} will act inside your own Chrome, signed in as you, and can see your open tabs.</p>
    <p className="text-ink-secondary">To connect, open chrome://inspect/#remote-debugging in Chrome and turn on remote debugging. Chrome does not restart and your windows stay open. Chrome asks you to Allow the connection, and {botName} works in a tab of its own. Only one bot can use your Chrome at a time.</p>
    <div className="flex gap-2"><button disabled={pending} onClick={onConfirm} className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Use my Chrome</button><button onClick={onCancel} className="rounded-lg bg-control px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-accent">Cancel</button></div>
  </div>;
}
type Status = { owned?: boolean; canReclaim?: boolean; generation: number; held: boolean; connected: boolean; protectedDocument: boolean; protectedReason?: "owner-input" | "sensitive-page" | null; url: string };
/** The locked-page note, in the owner's words: why the bot cannot use the
 * page and the one step that gives it back. */
export function ProtectedBrowserNotice({ botName, reason, held, pending, onReopen }: { botName: string; reason?: Status["protectedReason"]; held: boolean; pending: boolean; onReopen: () => void }) {
  const why = reason === "sensitive-page"
    ? `${botName} can't use this page because it has a password, code or card field, an embedded frame, or content Murage can't check. ${botName} can open a different page itself, or you can take control and reopen a blank page to give ${botName} its browser back.`
    : `${botName} can't use this page because you typed or clicked in it. Take control, then reopen a blank page to give ${botName} its browser back.`;
  return <div role="status" className="rounded-lg bg-card p-3 text-xs text-ink-secondary">{why}<button disabled={!held || pending} onClick={onReopen} className="mt-2 flex items-center gap-2 rounded bg-control px-2 py-1 text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={12} />Reopen blank page</button></div>;
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
export function UnifiedBrowserPanel({ bot, size = "compact", onExpand }: { bot: Bot; size?: "compact" | "expanded"; onExpand?: () => void; control?: unknown; controlPending?: boolean; onControl?: unknown; onCollapse?: () => void }) {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [frame, setFrame] = useState<LiveBrowserFrame | null>(null);
  const [address, setAddress] = useState("");
  const [pageText, setPageText] = useState("");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [refusal, setRefusal] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmMyChrome, setConfirmMyChrome] = useState(false);
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
        setConnectionError("");
        if (next?.generation === generation) setFrame(old => old?.seq === next.seq ? old : next);
      } catch (cause) {
        if (alive) { setConnectionError(cause instanceof Error ? cause.message : "Browser connection unavailable"); setFrame(null); lastStatus = 0; }
      } finally { if (alive) timer = setTimeout(poll, document.hidden ? 1000 : 100); }
    };
    void poll();
    return () => { alive = false; epoch.current++; clearTimeout(timer); };
  }, [base, bot.browserProfile, bot.useMyChrome]);
  const chooseBrowser = async (body: Record<string, unknown>) => {
    setRefusal("");
    try { const result = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify(body) }); dispatch({ type: "botPatched", bot: result.bot }); setConfirmMyChrome(false); }
    // Refused: close the confirmation (the picker falls back to the saved
    // choice) and say why where nothing else can cover it.
    catch (cause) { setConfirmMyChrome(false); setRefusal(cause instanceof Error ? cause.message : "Profile change failed"); }
  };
  const action = async (name: string, extra: Record<string, unknown> = {}) => {
    const identity = epoch.current; setPending(true); setError("");
    try {
      const next = await api(base, { method: "POST", body: JSON.stringify({ action: name, generation: current.current?.generation, ...extra }) }) as Status;
      if (identity === epoch.current && next?.generation) accept(next);
    } catch (cause) { if (identity === epoch.current) setError(cause instanceof Error ? cause.message : "Browser action failed"); }
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
    <div className="relative overflow-hidden rounded-xl border border-hairline"><BrowserLiveView frame={frame} generation={status?.generation ?? 0} held={!!status?.held && status.owned !== false && !pending} onInput={input} />{!frame && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-secondary" role="status">{connectionError ? "Browser unavailable" : status?.connected ? "Waiting for the page…" : "Connecting to browser…"}</div>}</div>
    {status?.held && status.owned !== false && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if(pageText){input({type:"input_keyboard",eventType:"char",text:pageText});setPageText("");} }}>
      <input type="password" autoComplete="off" aria-label="Text for focused browser field" placeholder="Focus a page field, then type here" maxLength={100} value={pageText} onChange={event => setPageText(event.target.value)} className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <button disabled={!pageText || pending} className="rounded-lg bg-control px-3 text-sm disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Send text</button>
    </form>}
    <div className="flex flex-wrap items-center justify-between gap-2"><span role="status" className="text-xs text-ink-secondary">{connectionError ? "Unavailable" : status?.connected ? "Live" : "Disconnected"} · {status?.held ? "Human control" : "Bot control"}</span><button disabled={!status || pending || (status.held && status.owned === false && !status.canReclaim)} onClick={() => void action(status?.held && status.owned === false ? "reclaim" : status?.held ? "release" : "take")} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><Hand size={14} />{pending ? "Please wait…" : status?.held && status.owned === false ? "Take control here" : status?.held ? "Return to bot" : "Take control"}</button></div>
    {status?.protectedDocument && <ProtectedBrowserNotice botName={bot.name} reason={status.protectedReason} held={status.held} pending={pending} onReopen={() => void action("reopen")} />}
    <label className="flex min-w-0 items-center gap-2 text-sm">Profile<select aria-label="Browser profile" value={confirmMyChrome || bot.useMyChrome ? MY_CHROME : bot.browserProfile ?? ""} disabled={bot.busy || pending || status?.held} className="min-w-0 flex-1 rounded bg-inset p-2 focus-visible:ring-2 focus-visible:ring-accent" onChange={event => {
      const patch = browserChoicePatch(bot, event.target.value);
      // Nothing changes until the owner confirms what attaching means.
      if (!patch) { setConfirmMyChrome(true); return; }
      setConfirmMyChrome(false);
      if (Object.keys(patch).length) void chooseBrowser(patch);
    }}><option value="">{bot.name}'s own</option>{(state.config?.browserProfiles ?? []).map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}<option value="guest">Guest</option><option value={MY_CHROME}>Use my Chrome</option></select></label>
    {confirmMyChrome && !bot.useMyChrome && <MyChromeConsent botName={bot.name} pending={pending} onConfirm={() => void chooseBrowser({ useMyChrome: true })} onCancel={() => setConfirmMyChrome(false)} />}
    {bot.useMyChrome && <p className="text-xs text-ink-secondary">Using your Chrome, signed in as you. {bot.name} can see your open tabs.</p>}
    <p className="text-xs text-ink-secondary">Take control before interacting. Disconnecting keeps human control until you return it. Tab leaves the browser page.</p>
    <BrowserPanelAlerts refusal={refusal} problem={connectionError || error} />
  </div>;
}
