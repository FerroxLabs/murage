import { useEffect, useRef, useState } from "react";
import { acceptBrowserGeneration, expectedStaleBrowserFrame } from "@/lib/browser-view-state";
import { Hand, Maximize2, RotateCcw } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { BrowserLiveView, type LiveBrowserFrame } from "./BrowserLiveView";
type Status = { owned?: boolean; canReclaim?: boolean; generation: number; held: boolean; connected: boolean; protectedDocument: boolean; url: string };
export function UnifiedBrowserPanel({ bot, size = "compact", onExpand }: { bot: Bot; size?: "compact" | "expanded"; onExpand?: () => void; control?: unknown; controlPending?: boolean; onControl?: unknown; onCollapse?: () => void }) {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [frame, setFrame] = useState<LiveBrowserFrame | null>(null);
  const [address, setAddress] = useState("");
  const [pageText, setPageText] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
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
    current.current = null; setStatus(null); setFrame(null); setAddress(""); setError("");
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
        if (next?.generation === generation) setFrame(old => old?.seq === next.seq ? old : next);
      } catch (cause) {
        if (alive) { setError(cause instanceof Error ? cause.message : "Browser connection unavailable"); setFrame(null); lastStatus = 0; }
      } finally { if (alive) timer = setTimeout(poll, document.hidden ? 1000 : 100); }
    };
    void poll();
    return () => { alive = false; epoch.current++; clearTimeout(timer); };
  }, [base, bot.browserProfile]);
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
    <div className="relative overflow-hidden rounded-xl border border-hairline"><BrowserLiveView frame={frame} generation={status?.generation ?? 0} held={!!status?.held && status.owned !== false && !pending} onInput={input} />{!frame && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-secondary" role="status">{status?.connected ? "Waiting for the page…" : "Connecting to browser…"}</div>}</div>
    {status?.held && status.owned !== false && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if(pageText){input({type:"input_keyboard",eventType:"char",text:pageText});setPageText("");} }}>
      <input type="password" autoComplete="off" aria-label="Text for focused browser field" placeholder="Focus a page field, then type here" maxLength={100} value={pageText} onChange={event => setPageText(event.target.value)} className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <button disabled={!pageText || pending} className="rounded-lg bg-control px-3 text-sm disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Send text</button>
    </form>}
    <div className="flex flex-wrap items-center justify-between gap-2"><span role="status" className="text-xs text-ink-secondary">{status?.connected ? "Live" : "Disconnected"} · {status?.held ? "Human control" : "Agent control"}</span><button disabled={!status || pending || (status.held && status.owned === false && !status.canReclaim)} onClick={() => void action(status?.held && status.owned === false ? "reclaim" : status?.held ? "release" : "take")} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><Hand size={14} />{pending ? "Please wait…" : status?.held && status.owned === false ? "Take control here" : status?.held ? "Return to agent" : "Take control"}</button></div>
    {status?.protectedDocument && <div className="rounded-lg bg-card p-3 text-xs text-ink-secondary">This session contains protected interaction. The agent cannot read or act on it. Take control and reopen a blank page to clear the protected document.<button disabled={!status.held || pending} onClick={() => void action("reopen")} className="mt-2 flex items-center gap-2 rounded bg-control px-2 py-1 text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={12} />Reopen blank page</button></div>}
    <label className="flex min-w-0 items-center gap-2 text-sm">Profile<select aria-label="Browser profile" value={bot.browserProfile ?? ""} disabled={bot.busy || pending || status?.held} className="min-w-0 flex-1 rounded bg-inset p-2 focus-visible:ring-2 focus-visible:ring-accent" onChange={async event => {
      try { const result = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify({ browserProfile: event.target.value || null }) }); dispatch({ type: "botPatched", bot: result.bot }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Profile change failed"); }
    }}><option value="">{bot.name}'s own</option>{(state.config?.browserProfiles ?? []).map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}<option value="guest">Guest</option></select></label>
    <p className="text-xs text-ink-secondary">Take control before interacting. Disconnecting keeps human control until you return it. Tab leaves the browser page.</p>
    {error && <div role="alert" className="rounded-lg border border-danger/30 p-2 text-xs text-danger">{error}</div>}
  </div>;
}
