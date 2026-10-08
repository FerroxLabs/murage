// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, useStore } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { openDeepLink } from "@/lib/deep-link";
import { learningConnectionLabel, learningEventLabel, learningRequestError, learningStatusLine, requestLearningAction, type LearningAction, type LearningEvent, type LearningPage, type LearningSource, type MemoryLearning } from "@/lib/memory-learning";
import { Card, Switch } from "./SettingsPrimitives";
import { MemorySettings, type MemoryStatus } from "./MemorySettings";
import { memoryButtonClass, memoryInputClass } from "./MemoryReview";
const buttonClass = `${memoryButtonClass} min-h-11`;
interface SectionStatus { mode: MemoryStatus["mode"]; learning?: MemoryLearning; configuration: { extractorInstanceId: string | null }; extractors: MemoryStatus["extractors"] }
interface ContentProps {
  status: SectionStatus; bots: Array<{ id: string; name: string }>;
  events: LearningEvent[]; cursor: string | null; filter: string; busy: boolean; historyBusy: boolean;
  refusals: Record<string, string>; workspace: ReactNode;
  onAction(action: LearningAction): void; onFilter(botId: string): void; onMore(): void; onOpen(source: LearningSource): void; onRefresh(): void;
}
export function MemorySectionContent({ status, bots, events, cursor, filter, busy, historyBusy, refusals, workspace, onAction, onFilter, onMore, onOpen, onRefresh }: ContentProps) {
  const learning = status.learning, settings = learning?.settings;
  const patch = (value: LearningAction & { action: "configure" }) => onAction(value);
  const configure = (value: Partial<NonNullable<typeof settings>>) => patch({ action: "configure", learning: value, learningRevision: learning!.revision });
  const stored = status.configuration.extractorInstanceId;
  const fast = status.extractors.find(item => item.instanceId === "@murage/flux-fast");
  const selected = stored === "@murage/flux-fast" ? "" : stored ?? "";
  return <div className="min-w-0 space-y-4" data-testid="memory-section">
    <section aria-label="Learning"><Card><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[15px] font-medium">Learning</h2><button className={buttonClass} disabled={busy || historyBusy} onClick={onRefresh}>Refresh learning settings</button></div>
      {!learning || !settings ? <p role="status" className="mt-3 text-[13px] text-ink-secondary">Learning settings are unavailable. Refresh settings to try again.</p> : <div className="mt-3 space-y-4 text-[13px]">
        <p role="status">{learningStatusLine(status.mode, learning)}</p>
        <label className="block space-y-1">Connection<select className={`${memoryInputClass} min-h-11`} disabled={busy} value={selected} onChange={event => patch({ action: "configure", extractorInstanceId: event.target.value || null })}>
          <option value="">{stored === "@murage/flux-fast" ? "Flux Fast (chosen)" : fast?.eligible ? "Flux Fast (default)" : "Flux Fast (default, add your key)"}</option>
          {selected && !status.extractors.some(item => item.instanceId === selected) && <option value={selected} disabled>{learningConnectionLabel(learning.connection.label)}: unavailable</option>}
          {status.extractors.filter(item => item.instanceId !== "@murage/flux-fast").map(item => <option key={item.instanceId} value={item.instanceId} disabled={!item.eligible}>{learningConnectionLabel(item.label)}{!item.eligible ? `: ${item.reason ?? "Unavailable"}` : ""}</option>)}
        </select></label>
        <p className="text-[12px] text-ink-secondary">Learning uses a separate connection for text. Your bot's chat engine is not used.</p>
        {learning.connection.suggestion && <p className="flex flex-wrap items-center gap-2 text-ink-secondary">You can use {learning.connection.suggestion.label}.<button className={buttonClass} disabled={busy} onClick={() => patch({ action: "configure", extractorInstanceId: learning.connection.suggestion!.instanceId })}>Use {learning.connection.suggestion.label}</button></p>}
        <fieldset disabled={busy} className="space-y-2"><legend className="mb-1 font-medium">Learn from</legend>
          <div className="flex min-h-11 items-center justify-between gap-4"><span id="memory-chats-label">My chats</span><Switch aria-labelledby="memory-chats-label" checked={settings.learnFrom.chats} onClick={() => configure({ learnFrom: { ...settings.learnFrom, chats: !settings.learnFrom.chats } })} /></div>
          <div className="flex min-h-11 items-center justify-between gap-4"><span id="memory-channels-label">My messages on connected channels</span><Switch aria-labelledby="memory-channels-label" checked={settings.learnFrom.channels} onClick={() => configure({ learnFrom: { ...settings.learnFrom, channels: !settings.learnFrom.channels } })} /></div>
          <div className="flex min-h-11 items-center justify-between gap-4"><span id="memory-facts-label">Learn facts automatically</span><Switch aria-labelledby="memory-facts-label" checked={settings.automaticFacts} onClick={() => configure({ automaticFacts: !settings.automaticFacts })} /></div>
          <div className="flex min-h-11 items-center justify-between gap-4"><span id="memory-procedures-label">Learn procedures automatically</span><Switch aria-labelledby="memory-procedures-label" checked={settings.automaticProcedures} onClick={() => configure({ automaticProcedures: !settings.automaticProcedures })} /></div>
          <div className="flex min-h-11 items-center justify-between gap-4"><span id="memory-review-label">Review before using</span><Switch aria-labelledby="memory-review-label" checked={settings.reviewMode} onClick={() => configure({ reviewMode: !settings.reviewMode })} /></div>
        </fieldset>
        <div className="space-y-2"><h3 className="font-medium">Allowance</h3><p>Today: {learning.allowance.usedPercent}% of the learning allowance used</p><progress aria-label="Learning allowance" className="h-2 w-full accent-accent" max={100} value={learning.allowance.usedPercent} />
          <details><summary className="min-h-11 cursor-pointer py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Details</summary><div className="space-y-1 text-[12px] text-ink-secondary"><p>{learning.allowance.day}: {learning.allowance.inputUsed.toLocaleString()} of {settings.dailyInputTokens.toLocaleString()} input tokens; {learning.allowance.outputUsed.toLocaleString()} of {settings.dailyOutputTokens.toLocaleString()} output tokens.</p><p>Input is estimated when the connection does not report usage. Unreported output keeps its reservation.</p><p>Up to {settings.callsPerMinute} calls per minute. Per call: {settings.perCallOutputTokens.extraction.toLocaleString()} extraction, {settings.perCallOutputTokens.grounding} grounding and {settings.perCallOutputTokens.reflection.toLocaleString()} reflection output tokens.</p></div></details>
        </div>
      </div>}
    </Card></section>
    <section aria-label="Bots"><Card><h2 className="text-[15px] font-medium">Bots</h2><ul className="mt-3 divide-y divide-hairline/40">{bots.map(bot => <li key={bot.id} className="flex min-h-16 items-center justify-between gap-4 py-3"><div className="min-w-0 text-[13px]"><p className="break-words font-medium">{bot.name}</p><p className="text-ink-secondary">Learn from our chats</p></div><Switch aria-label={`Learn from our chats with ${bot.name}`} disabled={busy || !learning} checked={Boolean(settings && !settings.botsPaused.includes(bot.id))} onClick={() => onAction({ action: "learning-bot", botId: bot.id, enabled: settings!.botsPaused.includes(bot.id), learningRevision: learning!.revision })} /></li>)}</ul>{!bots.length && <p className="mt-3 text-[13px] text-ink-secondary">Your bots will appear here.</p>}</Card></section>
    <section aria-label="What it learned"><Card><h2 className="text-[15px] font-medium">What it learned</h2><div className="mt-3 space-y-3">
      <label className="block space-y-1 text-[13px]">Filter by bot<select className={`${memoryInputClass} min-h-11`} value={filter} disabled={busy} onChange={event => onFilter(event.target.value)}><option value="">All bots</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      {historyBusy && <p role="status" className="text-[13px] text-ink-secondary">Loading learning history…</p>}
      <ul aria-label="Learning history" className="space-y-3">{events.map(event => {
        const lesson = event.lesson ?? null;
        const changeable = (["activated", "superseded"].includes(event.kind) && event.undone_at === null) || (event.kind === "lesson-learned" && lesson?.state === "active");
        const changed = lesson ? false : !event.record || event.record.version !== event.record_version || event.record.state !== "active";
        const reason = refusals[event.id] ?? (changed ? "This memory has changed. Review it in workspace memory below." : undefined);
        const from = event.source?.roomName ? `From ${event.source.roomName}` : event.source?.botName ? `From your chat with ${event.source.botName}` : "From your chat";
        return <li key={event.id} className="space-y-2 rounded-lg border border-hairline/40 p-3 text-[13px]">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{learningEventLabel(event.kind)}</h3><time className="text-[12px] text-ink-secondary" dateTime={new Date(event.created_at).toISOString()}>{new Date(event.created_at).toLocaleString()}</time></div>
          <p className="whitespace-pre-wrap break-words">{lesson?.text ?? event.record?.text ?? "Removed"}</p><p className="text-[12px] text-ink-secondary">{event.scopeLabel}</p>
          {event.source && <a className="inline-flex min-h-11 items-center text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" href={`#open=${encodeURIComponent(event.source.threadId)}${event.source.messageId ? `&msg=${encodeURIComponent(event.source.messageId)}` : ""}`} onClick={e => { e.preventDefault(); onOpen(event.source!); }}>{from}</a>}
          {changeable && <><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy || changed || event.kept_at !== null} onClick={() => onAction({ action: "learning-keep", eventId: event.id })}>{event.kept_at !== null ? "Kept" : "Keep"}</button><button className={buttonClass} disabled={busy || Boolean(reason)} aria-describedby={reason ? `learning-refusal-${event.id}` : undefined} onClick={() => onAction({ action: "learning-undo", eventId: event.id })}>Undo</button></div>{reason && <p id={`learning-refusal-${event.id}`} className="text-[12px] text-ink-secondary">{reason}</p>}</>}
        </li>;
      })}</ul>
      {!historyBusy && !events.length && <p className="text-[13px] text-ink-secondary">Nothing learned yet. New learning will appear here with its source.</p>}
      {cursor && <button className={buttonClass} disabled={busy || historyBusy} onClick={onMore}>Show more</button>}
    </div></Card></section>
    {workspace}
  </div>;
}
export default function MemorySection() {
  const desktop = useDesktopSurface(), { state, dispatch } = useStore();
  const [status, setStatus] = useState<MemoryStatus | null>(null), [events, setEvents] = useState<LearningEvent[]>([]), [cursor, setCursor] = useState<string | null>(null), [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false), [historyBusy, setHistoryBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState(false), [refusals, setRefusals] = useState<Record<string, string>>({}), [memoryRevision, setMemoryRevision] = useState(0);
  const mounted = useRef(false), historyGeneration = useRef(0), inFlight = useRef(false);
  // A save disables the controls, and the browser drops focus from a disabled
  // control. The control that was pressed gets focus back when the save ends,
  // so a keyboard user can press it again without finding their place.
  const pressed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (busy) return;
    const target = pressed.current; pressed.current = null;
    if (!target?.isConnected || target.matches(":disabled")) return;
    const active = document.activeElement;
    if (!active || active === document.body) target.focus();
  }, [busy]);
  const refreshStatus = useCallback(async () => { const value = await api("/api/memory/status") as MemoryStatus; if (mounted.current) setStatus(value); }, []);
  const loadHistory = useCallback(async (botId: string, next?: string) => {
    const generation = ++historyGeneration.current; setHistoryBusy(true);
    try {
      const page = await requestLearningAction(api, { action: "learning-history", ...(botId ? { botId } : {}), ...(next ? { cursor: next } : {}), limit: 20 }) as LearningPage;
      if (!mounted.current || generation !== historyGeneration.current) return;
      setEvents(previous => next ? [...previous, ...page.events.filter(row => !previous.some(item => item.id === row.id))] : page.events); setCursor(page.nextCursor);
    } finally { if (mounted.current && generation === historyGeneration.current) setHistoryBusy(false); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; historyGeneration.current++; }; }, []);
  useEffect(() => {
    if (desktop !== true) return;
    void refreshStatus().catch(() => { if (mounted.current) setError("Could not load memory settings. Refresh settings to try again."); });
  }, [desktop, refreshStatus]);
  useEffect(() => {
    if (desktop !== true) return;
    setEvents([]); setCursor(null);
    void loadHistory(filter).catch(() => { if (mounted.current) setError("Could not load learning history. Refresh settings to try again."); });
  }, [desktop, filter, loadHistory]);
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await Promise.all([refreshStatus(), loadHistory(filter)]); if (mounted.current) { setConflict(false); setRefusals({}); } }
    catch { if (mounted.current) setError("Could not refresh memory. Try again."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const act = async (action: LearningAction) => {
    if (inFlight.current || conflict || desktop !== true) return;
    inFlight.current = true; setBusy(true); setError(null);
    pressed.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    try {
      await requestLearningAction(api, action);
      await refreshStatus();
      if (action.action === "learning-keep" || action.action === "learning-undo") { await loadHistory(filter); if (mounted.current) setMemoryRevision(n => n + 1); }
    } catch (cause) {
      if (!mounted.current) return;
      const message = learningRequestError(cause); setError(message);
      if (cause instanceof Error && cause.message.includes("MEMORY_LEARNING_REVISION_CONFLICT")) setConflict(true);
      if (action.action === "learning-undo" && cause instanceof Error && (cause.message.startsWith("This memory") || cause.message === "This learning item cannot be changed.")) setRefusals(previous => ({ ...previous, [action.eventId]: message }));
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const workspaceMutated = () => {
    if (!mounted.current) return;
    historyGeneration.current++; setEvents([]); setCursor(null); setRefusals({});
    void loadHistory(filter).catch(() => { if (mounted.current) setError("Could not load learning history. Refresh settings to try again."); });
  };
  if (desktop !== true) return <p role="status" className="text-[13px] text-ink-secondary">Memory settings are available in the desktop app.</p>;
  return <div className="space-y-4">
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {conflict && <button className={buttonClass} disabled={busy} onClick={() => void refresh()}>Refresh changed settings</button>}
    {!status ? <><p role="status" className="text-[13px] text-ink-secondary">Loading memory settings…</p>{error && <button className={buttonClass} disabled={busy} onClick={() => void refresh()}>Refresh settings</button>}</> : <MemorySectionContent status={status} bots={state.bots.filter(bot => !bot.hidden)} events={events} cursor={cursor} filter={filter} busy={busy || conflict} historyBusy={historyBusy} refusals={refusals}
      onAction={action => void act(action)} onFilter={setFilter} onRefresh={() => void refresh()}
      onMore={() => { if (cursor) void loadHistory(filter, cursor).catch(() => { if (mounted.current) setError("Could not load more history. Try again."); }); }}
      onOpen={source => { if (openDeepLink({ threadId: source.threadId, ...(source.messageId ? { messageId: source.messageId } : {}) }, state, dispatch)) dispatch({ type: "toggleAppSettings", open: false }); else setError("This conversation is no longer available."); }}
      workspace={<MemorySettings key={memoryRevision} sharedStatus={status} onStatusChange={setStatus} onMutation={workspaceMutated} onNavigate={() => dispatch({ type: "toggleAppSettings", open: false })} />} />}
  </div>;
}
