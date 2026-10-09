import type { MemoryLearning } from "@/lib/memory-learning";
import { ProcedureEvaluationAdmissions } from "./ProcedureEvaluationAdmissions";
import type { ProcedureEvolutionStatus } from "@/lib/procedure-evaluation-admissions";
import { MemoryEvolutionControls } from "./MemoryEvolutionControls";
import type { MemoryEvolutionStatus } from "@/lib/memory-evolution-controls";
import { useCallback, useEffect, useRef, useState } from "react";
import { Switch } from "./SettingsPrimitives";
import { api, useStore } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import type { MemoryRecord } from "../../shared/memory";
import { MemoryHealth, type MemoryHealthStatus } from "./MemoryLearningControls";
import { MemoryNotebookPicker } from "./MemoryNotebookPicker";
import { MemoryPeople, type HumanBindingsStatus, type HumanLinkIntent, type HumanShareIntent } from "./MemoryPeople";
import { MemoryReview, memoryButtonClass, memoryInputClass, memoryStateLabel, memoryOriginLabel, type MemoryAction, type MemoryAudience, type MemoryInspection } from "./MemoryReview";
import { MemoryNeedsYou } from "./MemoryNeedsYou";
import { useMemoryWaiting } from "@/lib/use-memory-waiting";
import { errorSentence } from "@/lib/memory-review";
import { modelSentence, workerSentence } from "@/lib/memory-words";

export interface MemoryStatus {
  evolution?:MemoryEvolutionStatus|null;
  classificationEvolution?:MemoryEvolutionStatus|null;
  procedureEvolution?:ProcedureEvolutionStatus|null;
  learning?: MemoryLearning;
  health?: MemoryHealthStatus;
  mode: "off" | "capture" | "active" | "paused";
  policyRevision: number; deletionEpoch: number;
  configuration: { excludedThreadIds: string[]; extractorInstanceId: string | null };
  scopes: MemoryAudience[];
  backlog: { pending: number; leased: number; deferred: number; failed: number; oldestQueuedAt: number | null };
  retention?: { sourceBytes: number; records: Array<{ state: string; count: number; bytes: number | null }> };
  records: Record<"candidate" | "active" | "archived" | "superseded" | "deleted", number>;
  model: { state: "missing" | "unverified" | "downloading" | "ready" | "failed"; bytesDownloaded: number; totalBytes: number; revision: string; model: string; error?: string };
  extractors: Array<{ instanceId: string; label: string; eligible: boolean; reason?: string }>;
  deletion: { pending: number }; workerError: string | null;
  runtime?: { running?: boolean; ready?: boolean; indexing?: boolean; error?: string | null } | null;
}
interface ImportPreview {
  previewId: string; expiresAt: number;
  items: Array<{ path: string; hash: string; bytes: number; text: string; scopeId: string; scopeLabel: string; alreadyImported: boolean }>;
}
export type MemoryView = "search" | "important" | "recent" | "review";
export function memoryListAction(query: string, scopeId: string, state: string, botId?: string, cursor?: string, view?: MemoryView): MemoryAction {
  return { action: "list", ...(query.trim() ? { query: query.trim() } : {}), ...(scopeId ? { scopeId } : {}), ...(state ? { state } : {}), ...(botId ? { botId } : {}), ...(cursor ? { cursor } : {}), ...(view ? { view } : {}) };
}
const request = (action: MemoryAction) => api("/api/memory/action", { method: "POST", body: JSON.stringify(action) });
const message = (error: unknown) => errorSentence(error);

/** "Folder memory" is the audience of a bound folder (scope kind "project"):
 * nothing to do with a channel project, so it is never called one (PM5). */
export function memoryAudienceLabel(scope: { kind: string; label: string }): string {
  return scope.kind === "project" ? `Folder memory: ${scope.label}` : scope.label;
}
/** Folder memory is offered only where it is already in use (PM5). */
export function folderMemoryInUse(scopes: ReadonlyArray<{ kind: string }>): boolean {
  return scopes.some(scope => scope.kind === "project");
}

export function memoryModeDescription(mode: MemoryStatus["mode"]): string {
  return mode === "active" ? "Capture and recall are on." : mode === "capture" ? "Capture is on. Recall is off." : mode === "paused" ? "Processing and recall are paused. New sources are still captured." : "Memory is off. Capture and recall are off.";
}

export function MemorySettings({ botId, onNavigate, compact = false, onStatusChange, sharedStatus, onMutation, refreshToken }: { botId?: string; onNavigate?: () => void; compact?: boolean; onStatusChange?: (status: MemoryStatus) => void; sharedStatus?: MemoryStatus; onMutation?: () => void; refreshToken?: number }) {
  const desktop = useDesktopSurface();
  const { state, dispatch } = useStore();
  const [localStatus, setStatus] = useState<MemoryStatus | null>(null);
  const status = sharedStatus ?? localStatus;
  const [people, setPeople] = useState<HumanBindingsStatus | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [recordState, setRecordState] = useState("");
  const [view, setView] = useState<MemoryView>("search");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [scopeIds, setScopeIds] = useState<string[] | null>(null);
  const [searchNotice, setSearchNotice] = useState<string>();
  const [conflicts, setConflicts] = useState<Array<{ id: string; selection: { kind: string; botId?: string; topic?: string; section?: string }; error?: string }>>([]);
  const [conflictCursor, setConflictCursor] = useState<string>();
  const applied = useRef({ query: "", scopeId: "", recordState: "", view: "search" as MemoryView });
  const [cursor, setCursor] = useState<string>();
  const [inspection, setInspection] = useState<MemoryInspection | null>(null);
  // No global busy state (PROPOSAL-v2 0.8): a press while another is in flight is ignored, and nothing dims, disables or inserts a line.
  const acting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<MemoryStatus["mode"]>("off");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [bindingScope, setBindingScope] = useState("");
  const [subject, setSubject] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [importChoice, setImportChoice] = useState(botId ? `bot:${botId}` : "");
  const [topic, setTopic] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [trackImports, setTrackImports] = useState(false);
  const mounted = useRef(true);
  const waiting = useMemoryWaiting();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const applyStatus = useCallback((next: MemoryStatus) => {
    if (!mounted.current) return;
    setStatus(next); onStatusChange?.(next); setMode(next.mode); setExcluded(next.configuration.excludedThreadIds);
  }, [onStatusChange]);
  const loadStatus = useCallback(async () => { applyStatus(await api("/api/memory/status") as MemoryStatus); }, [applyStatus]);
  const loadPeople = useCallback(async () => {
    const next = await request({ action: "humans" }) as HumanBindingsStatus;
    if (mounted.current) setPeople(next);
  }, []);
  const loadRecords = useCallback(async (nextCursor?: string, filters = applied.current) => {
    const result = await request(memoryListAction(filters.query, filters.scopeId, filters.recordState, botId, nextCursor, filters.view)) as { records: MemoryRecord[]; nextCursor?: string; scopeIds?: string[] | null; searchNotice?: string };
    if (!mounted.current) return;
    applied.current = filters;
    setRecords(result.records); setCursor(result.nextCursor); if (!filters.scopeId) setScopeIds(result.scopeIds ?? null); setSearchNotice(result.searchNotice);
    if (!nextCursor) { setPageIndex(0); setPageCursors([undefined]); }
  }, [botId]);
  const loadConflicts = async (nextCursor?: string) => {
    const result = await request({ action: "import-review-list", ...(botId ? { botId } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
    if (mounted.current) { setConflicts(result.links); setConflictCursor(result.nextCursor); }
  };
  useEffect(() => {
    if (desktop !== true) return;
    let cancelled = false;
    setError(null);
    applied.current = { query: "", scopeId: "", recordState: "", view: "search" };
    setQuery(""); setScopeId(""); setRecordState(""); setView("search"); setPageIndex(0); setPageCursors([undefined]); setInspection(null); setRecords([]); setCursor(undefined); setConflicts([]); setConflictCursor(undefined); setSearchNotice(undefined); setPeople(null);
    void Promise.all([loadStatus(), request(memoryListAction("", "", "", botId, undefined, "search")), botId ? Promise.resolve() : loadPeople()]).then(([, result]) => {
      if (!cancelled) { setRecords(result.records); setCursor(result.nextCursor); setScopeIds(result.scopeIds ?? null); }
    }).catch(error => { if (!cancelled) setError(message(error)); });
    return () => { cancelled = true; };
  }, [desktop, botId, loadPeople, loadStatus]);
  // A change made elsewhere on the page (a learning Keep or Undo) refreshes the list in place: no remount, no loading line.
  const firstToken = useRef(true);
  useEffect(() => {
    if (firstToken.current) { firstToken.current = false; return; }
    if (desktop === true) void loadRecords(undefined, applied.current).catch(() => undefined);
  }, [refreshToken]);
  useEffect(() => {
    if (status?.model.state !== "downloading") return;
    const timer = window.setInterval(() => { void loadStatus().catch(error => { if (mounted.current) setError(message(error)); }); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.model.state, loadStatus]);

  const run = async (work: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true; setError(null);
    try { await work(); } catch (error) { if (mounted.current) setError(message(error)); }
    finally { acting.current = false; }
  };
  // Actions that change what the status itself lists (audiences, imports). Record actions never reload it.
  const changesStatus = new Set(["bind", "project", "import-commit", "enable-and-import", "import-stop-tracking"]);
  const perform = async (action: MemoryAction, success: string) => run(async () => {
    const answer = await request(action);
    if (!mounted.current) return;
    setNotice(success); setInspection(null);
    // The answer carries what changed: a new status for a settings save, the changed record for a record action.
    if (action.action === "configure" && answer?.mode) applyStatus(answer as MemoryStatus);
    else if (action.action === "enable-and-import" && answer?.status?.mode) applyStatus(answer.status as MemoryStatus);
    else if (changesStatus.has(action.action)) await loadStatus();
    await loadRecords(undefined, applied.current);
    onMutation?.();
    if (view === "review") await loadConflicts();
  });
  const changePerson = async (intent: HumanLinkIntent) => {
    await request({ action: "human-link", ...intent });
    await loadPeople();
  };
  const sharePerson = async (intent: HumanShareIntent) => {
    await request({ action: "human-share", ...intent });
    await loadPeople();
  };
  const subjects = [...state.bots.map(bot => ({ value: `bot:${bot.id}`, label: bot.name })), ...state.groups.map(group => ({ value: `room:${group.id}`, label: `Channel: ${group.name}` }))];
  const subjectFields = () => { const separator = subject.indexOf(":"); return { subjectType: subject.slice(0, separator), subjectId: subject.slice(separator + 1) }; };
  const threads = [...new Map([
    ...excluded.map(id => ({ id, label: "A conversation that is no longer here" })),
    ...state.bots.flatMap(bot => [{ id: bot.threadId, label: bot.name }, ...(bot.tasks ?? []).map(task => ({ id: task.threadId, label: `${bot.name}: ${task.title ?? "task"}` }))]),
    ...state.groups.map(group => ({ id: group.threadId, label: `Channel: ${group.name}` })),
  ].map(item => [item.id, item])).values()];
  const sections = [...new Set(state.bots.map(bot => bot.section ?? ""))];
  const filters = <>
    <label className="block space-y-1 text-[13px]">Audience<select className={memoryInputClass} value={scopeId} onChange={event => setScopeId(event.target.value)}><option value="">{botId ? "All audiences for this bot" : "All workspace audiences"}</option>{status?.scopes.filter(scope => !scopeIds || scopeIds.includes(scope.id) || scope.id === scopeId).map(scope => <option key={scope.id} value={scope.id}>{memoryAudienceLabel(scope)}</option>)}</select></label>
    {view === "search" && <label className="block space-y-1 text-[13px]">Show<select className={memoryInputClass} value={recordState} onChange={event => setRecordState(event.target.value)}><option value="">Everything</option>{["candidate", "active", "archived", "superseded", "deleted"].map(value => <option key={value} value={value}>{memoryStateLabel(value)}</option>)}</select></label>}
  </>;
  const folderMemoryUsed = folderMemoryInUse(status?.scopes ?? []);
  if (desktop !== true) return <section className="rounded-xl bg-card p-4"><h2 className="text-[15px] font-medium">Managed memory</h2><p role="status" className="mt-2 text-[13px] text-ink-secondary">{desktop === undefined ? "Checking owner access…" : "Memory management is available in the local desktop app. Remote sessions cannot manage workspace memory."}</p></section>;
  return <section aria-label={botId ? "Bot memory" : "Workspace memory"} className={`min-w-0 space-y-4 text-ink ${compact ? "p-3" : "rounded-xl bg-card p-4"}`} data-testid="memory-settings" data-compact={compact || undefined}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[16px] font-medium">{botId ? "Bot memory" : "Workspace memory"}</h2><button className={memoryButtonClass} onClick={() => void run(async () => { await Promise.all([loadStatus(), loadRecords(), ...(botId ? [] : [loadPeople()])]); })}>Refresh memory</button></div>
    {!compact && <p className="text-[13px] text-ink-secondary">Search what is saved, see where it came from and choose who can use it.</p>}
    {botId
      ? <MemoryNeedsYou subject={{ kind: "bot", id: botId, name: state.bots.find(bot => bot.id === botId)?.name ?? "Your bot" }} />
      : waiting.subjects.filter(item => item.waiting > 0 || item.later > 0).map(item => <MemoryNeedsYou key={`${item.kind}:${item.id}`} subject={{ kind: item.kind, id: item.id, name: item.name || (item.kind === "bot" ? state.bots.find(bot => bot.id === item.id)?.name : state.groups.find(group => group.id === item.id)?.name) || "Shared notes" }} />)}
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {notice && <p role="status" className="text-[13px] text-success">{notice}</p>}
    {status && <>
      <MemoryHealth status={status} />
      {!botId && people && <MemoryPeople people={people} audiences={status.scopes} disabled={false} onLink={changePerson} onShare={sharePerson} onRefresh={loadPeople} />}
      {compact ? <p role="status" className="text-[13px] text-ink-secondary">{memoryModeDescription(status.mode)}{status.mode !== "active" && " Saved records remain available here."}{status.workerError ? " Processing needs attention." : status.runtime?.indexing ? " Search index is updating." : ""}</p> : <>
      <p className="text-[12px] text-ink-secondary">{botId ? `${records.length} ${records.length === 1 ? "memory" : "memories"} on this page${cursor ? " · more available" : ""}` : `${status.records.active} saved ${status.records.active === 1 ? "memory" : "memories"} · ${waiting.total} waiting for you`} · Workspace mode: {status.mode === "active" ? "Capture and recall" : status.mode === "capture" ? "Capture only" : status.mode === "paused" ? "Paused" : "Off"}</p>
      <p className="text-[12px] text-ink-secondary">{memoryModeDescription(status.mode)} {status.mode === "active" && status.model.state !== "ready" ? "Keyword-only recall; the optional local model is not ready." : status.model.state === "ready" ? "Local semantic model ready." : "The optional local model is not ready."} {status.workerError ? "Processing needs attention." : status.runtime?.indexing ? "Search index is updating." : ""}</p>
      </>}
      {status.workerError && <p role="status" className="text-[13px] text-ink-secondary">{workerSentence(status.workerError)}</p>}
      {!compact && botId && <div className="space-y-2 text-[13px]"><p className="text-ink-secondary">Capture, model downloads and processing settings apply to the whole workspace.</p><button type="button" className={memoryButtonClass} onClick={() => { onNavigate?.(); dispatch({ type: "toggleAppSettings", open: true, section: "memory" }); }}>Open workspace memory settings</button></div>}
      {!compact && status.mode === "off" && <div className="space-y-2 rounded-lg border border-hairline/50 p-3 text-[13px]"><p>Memory is off. Enable workspace capture and recall and import detected Murage bot notebooks. Originals are preserved and each notebook stays private to its bot. Recalled context is sent to the engine you choose; learning follows your choices in Settings, then Memory.</p><button type="button" className={memoryButtonClass} onClick={() => void perform({ action: "enable-and-import" }, "Capture and recall enabled. Detected bot notebooks are being imported; originals are preserved.")}>Enable and import notebooks</button></div>}
      <nav aria-label="Memory views" className="flex flex-wrap gap-2">{([["search", "Search"], ["important", "Important"], ["recent", "Recent"], ["review", "Waiting"]] as const).map(([value, label]) => <button key={value} type="button" aria-label={value === "search" ? "Search view" : label} aria-pressed={view === value} className={`${memoryButtonClass} ${view === value ? "border-focus bg-inset" : ""}`} onClick={() => void run(async () => { setView(value); setRecordState(""); setInspection(null); await loadRecords(undefined, { query, scopeId, recordState: "", view: value }); if (value === "review") await loadConflicts(); })}>{label}</button>)}</nav>
      <form className="grid min-w-0 gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))" }} onSubmit={event => { event.preventDefault(); setInspection(null); void run(() => loadRecords(undefined, { query, scopeId, recordState, view })); }}>
        <label className="col-span-full block min-w-0 space-y-1 text-[13px]">Search memory<input className={memoryInputClass} value={query} maxLength={4096} onChange={event => setQuery(event.target.value)} /></label>
        {compact ? <details className="col-span-full"><summary className="min-h-10 cursor-pointer py-2 text-[13px] text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Filters{scopeId || recordState ? " (selected)" : ""}</summary><div className="space-y-3 pt-2">{filters}</div></details> : filters}
        <button className={memoryButtonClass}>Search</button>
      </form>
      {searchNotice && <p role="status" className="text-[12px] text-ink-secondary">{searchNotice}</p>}
      {compact && records.length > 0 && <p className="text-[12px] text-ink-secondary">{records.length} {records.length === 1 ? "memory" : "memories"} on this page{cursor ? " · more available" : ""}</p>}
      <ul aria-label="Memory records" className="space-y-2">
        {records.map(record => <li key={`${record.id}:${record.version}`} className="rounded-lg border border-hairline/40 p-3" data-memory-id={record.id}>
          <p className="whitespace-pre-wrap break-words text-[13px] line-clamp-3">{record.text}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[12px] text-ink-secondary">{!compact && <>{status.scopes.find(scope => scope.id === record.scopeId)?.label ?? "Unavailable audience"} · </>}{memoryStateLabel(record.state)}{record.ownerPinned ? " · Pinned" : ""}{!compact && <> · {memoryOriginLabel(record.assertion)}</>} · <time dateTime={new Date(record.validFrom).toISOString()}>{new Date(record.validFrom).toLocaleDateString()}</time></span><button className={memoryButtonClass} onClick={() => void run(async () => { const result = await request({ action: "inspect", id: record.id, version: record.version }); if (mounted.current) setInspection(result); })}>Inspect memory</button></div>
        </li>)}
      </ul>
      {!records.length && <p className="text-[13px] text-ink-secondary">No memories match these filters.</p>}
      {(cursor || pageIndex > 0) && <nav aria-label="Memory pages" className="flex items-center gap-3"><button className={memoryButtonClass} disabled={pageIndex === 0} onClick={() => void run(async () => { const previous = pageIndex - 1; const history = pageCursors; await loadRecords(history[previous]); setPageCursors(history); setPageIndex(previous); setInspection(null); })}>Previous page</button><span className="text-[12px] text-ink-secondary">Page {pageIndex + 1}</span><button className={memoryButtonClass} disabled={!cursor} onClick={() => void run(async () => { const next = pageIndex + 1; const history = [...pageCursors.slice(0, next), cursor]; await loadRecords(cursor); setPageCursors(history); setPageIndex(next); setInspection(null); })}>Next page</button></nav>}
      {view === "review" && <section aria-label="Notebook changes needing review" className="space-y-2"><h3 className="text-[14px] font-medium">Notebook changes</h3><p className="text-[12px] text-ink-secondary">These files changed after a memory was pinned, edited, archived or forgotten, or could not be read. Your saved decisions have been preserved.</p>{conflicts.map(link => <div key={link.id} className="space-y-2 rounded-lg border border-hairline/40 p-3 text-[13px]"><p>{link.selection.kind === "bot" ? `${state.bots.find(bot => bot.id === link.selection.botId)?.name ?? "A bot that is no longer here"}: ${link.selection.topic ?? "MEMORY.md"}` : `Team brief: ${link.selection.section || "General"}`}</p><p className="text-ink-secondary">{link.error === "MEMORY_IMPORT_REVIEW_CONFLICT" ? "The changed notebook conflicts with a saved memory decision." : "This notebook needs attention before it can be imported."}</p><button className={memoryButtonClass} onClick={() => void perform({ action: "import-stop-tracking", id: link.id }, "Saved memory kept. Notebook tracking stopped.")}>Keep saved memory and stop tracking</button></div>)}{!conflicts.length && <p className="text-[12px] text-ink-secondary">No notebook conflicts need review.</p>}{conflictCursor && <button className={memoryButtonClass} onClick={() => void run(() => loadConflicts(conflictCursor))}>Next notebook changes</button>}</section>}
      {inspection && <MemoryReview key={`${inspection.record.id}:${inspection.record.version}`} inspection={inspection} audiences={status.scopes} onAction={perform} onClose={() => setInspection(null)} />}

      {compact && <div className="space-y-2 border-t border-hairline/40 pt-3 text-[13px]"><p className="text-ink-secondary">Manage capture, imports and the optional local model for the workspace.</p><button type="button" className={memoryButtonClass} onClick={() => { onNavigate?.(); dispatch({ type: "toggleAppSettings", open: true, section: "memory" }); }}>Open workspace memory settings</button></div>}
      {!compact && status.retention && <p className="text-[12px] text-ink-secondary">Archived memories can still be used for older conversations. Nothing is forgotten unless you forget it.</p>}
      {!compact && !botId && <>
      <MemoryEvolutionControls status={status.evolution??null} disabled={false} onRefresh={loadStatus}/>
      <MemoryEvolutionControls kind="classification" status={status.classificationEvolution??null} disabled={false} onRefresh={loadStatus}/>
      <ProcedureEvaluationAdmissions status={status.procedureEvolution??null} disabled={false} onRefresh={loadStatus}/>
      <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Workspace settings and processing</summary>
        <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void perform({ action: "configure", mode, excludedThreadIds: excluded }, "Memory settings saved."); }}>
          <fieldset className="space-y-3"><legend className="sr-only">Memory configuration</legend>
            <label className="block space-y-1 text-[13px]">Memory mode<select className={memoryInputClass} value={mode} onChange={event => setMode(event.target.value as MemoryStatus["mode"])}><option value="off">Off</option><option value="capture">Capture only</option><option value="active">Capture and recall</option><option value="paused">Paused</option></select></label>
            <fieldset className="space-y-1"><legend className="text-[13px] font-medium">Exclude conversations from capture</legend><p className="text-[12px] text-ink-secondary">Excluding a conversation also retires its existing memory sources. Including it again does not restore retired memories.</p>{threads.map(thread => <label key={thread.id} className="flex min-h-10 items-center gap-2 text-[13px]"><input type="checkbox" checked={excluded.includes(thread.id)} onChange={event => setExcluded(previous => event.target.checked ? [...previous, thread.id] : previous.filter(id => id !== thread.id))} />{thread.label}</label>)}</fieldset>
            <button className={memoryButtonClass}>Save memory settings</button>
          </fieldset>
        </form>
        <div className="mt-4 space-y-2 text-[12px] text-ink-secondary"><h3 className="text-[13px] font-medium text-ink">Processing backlog</h3><p>{status.backlog.pending} queued · {status.backlog.leased} processing · {status.backlog.deferred} deferred · {status.backlog.failed} failed</p>{status.backlog.oldestQueuedAt !== null && <p>Oldest queued item: {new Date(status.backlog.oldestQueuedAt).toLocaleString()}</p>}<p>{status.deletion.pending} deletion updates pending</p>{status.workerError && <p role="status">{workerSentence(status.workerError)}</p>}
        </div>
      </details>

      <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Search model</summary><div className="mt-3 space-y-2 text-[13px]"><p data-testid="memory-model-status">Search model: {({ missing: "not downloaded", unverified: "downloaded, being checked", downloading: "downloading", ready: "ready", failed: "not available" } as const)[status.model.state]}</p>{status.model.state !== "ready" && <p className="text-ink-secondary">Semantic recall is unavailable until the local model is verified. Lexical recall can still be used.</p>}{status.model.state === "downloading" && <p role="status">Downloading: {status.model.totalBytes > 0 ? Math.round(100 * status.model.bytesDownloaded / status.model.totalBytes) : 0}% done</p>}{status.model.error && <p role="alert" className="text-danger">{modelSentence(status.model.error)}</p>}<button className={memoryButtonClass} disabled={status.model.state === "downloading" || status.model.state === "ready"} onClick={() => void perform({ action: "model-download", confirm: true }, "Local model download requested. Check the status for completion.")}>Download local model</button><p className="text-[12px] text-ink-secondary">Downloads the pinned model files to this computer. No provider model call is made by this action.</p></div></details>

      <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{folderMemoryUsed ? "Audience access and folder memory" : "Audience access"}</summary><fieldset className="mt-3 space-y-3"><legend className="sr-only">Share audience access</legend>
        <label className="block space-y-1 text-[13px]">Allow access for<select className={memoryInputClass} value={subject} onChange={event => setSubject(event.target.value)}><option value="">Choose a bot or channel</option>{subjects.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void perform({ action: "bind", scopeId: bindingScope, ...subjectFields() }, "Audience access saved."); }}><label className="block space-y-1 text-[13px]">Shared audience<select className={memoryInputClass} value={bindingScope} onChange={event => setBindingScope(event.target.value)}><option value="">Choose an audience</option>{status.scopes.filter(scope => ["project", "team", "workspace", "preferences", "room"].includes(scope.kind)).map(scope => <option key={scope.id} value={scope.id}>{memoryAudienceLabel(scope)}</option>)}</select></label><button className={memoryButtonClass} disabled={!subject || !bindingScope}>Grant audience access</button></form>
        {/* Folder memory (the "project" scope kind) is not a channel project; shown only where it is already used (plan 3.8, PM5). */}
        {folderMemoryUsed && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void perform({ action: "project", path: projectPath, ...subjectFields() }, "Folder memory created and access granted."); }}><label className="block space-y-1 text-[13px]">Folder<input className={memoryInputClass} value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="Absolute folder path" /></label><button className={memoryButtonClass} disabled={!subject || !projectPath.trim()}>Add folder memory</button></form>}
      </fieldset></details>

      </>}
      {!compact && <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Import existing notes</summary><div className="mt-3 space-y-3"><p className="text-[12px] text-ink-secondary">Preview the full notebook or team brief before importing it. Imported records retain an unverified-import label; original files are preserved.</p>
        <MemoryNotebookPicker botId={botId} onPreview={setPreview} />
        <div className="flex items-start justify-between gap-3 text-[13px]"><span id="memory-track-imports">Keep imported notebooks updated when their files change. Pinned, edited, archived or forgotten memories require review.</span><Switch aria-labelledby="memory-track-imports" checked={trackImports} onClick={() => setTrackImports(!trackImports)} /></div>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void run(async () => {
          const separator = importChoice.indexOf(":"); const kind = importChoice.slice(0, separator), value = importChoice.slice(separator + 1);
          const selection = kind === "bot" ? { kind, botId: value, ...(topic.trim() ? { topic: topic.trim() } : {}) } : { kind: "section", section: value };
          const result = await request({ action: "import-preview", selections: [selection] }); if (mounted.current) setPreview(result);
        }); }}>
          <label className="block space-y-1 text-[13px]">Notes to import<select className={memoryInputClass} value={importChoice} onChange={event => { setImportChoice(event.target.value); setPreview(null); }}><option value="">Choose notes</option>{state.bots.filter(bot => !botId || bot.id === botId).map(bot => <option key={bot.id} value={`bot:${bot.id}`}>{bot.name}: notebook</option>)}{!botId && sections.map(section => <option key={section} value={`section:${section}`}>{section || "General"}: team brief</option>)}</select></label>
          {importChoice.startsWith("bot:") && <label className="block space-y-1 text-[13px]">Topic file (optional)<input className={memoryInputClass} value={topic} onChange={event => { setTopic(event.target.value); setPreview(null); }} placeholder="Leave empty for MEMORY.md" /></label>}
          <button className={memoryButtonClass} disabled={!importChoice}>Preview import</button>
        </form>
        {preview && <section aria-label="Import preview" className="space-y-2">{preview.items.map(item => <div key={item.path} className="rounded-lg border border-hairline/40 p-3"><p className="break-all text-[12px]">{item.path}</p><p className="text-[12px] text-ink-secondary">{item.scopeLabel} · {item.alreadyImported ? "Already imported" : "New to Murage"}</p><p className="mt-2 whitespace-pre-wrap break-words text-[13px]">{item.text}</p></div>)}<p className="text-[12px] text-ink-secondary">Preview expires {new Date(preview.expiresAt).toLocaleString()}.</p><button className={memoryButtonClass} disabled={preview.expiresAt <= Date.now()} onClick={() => void run(async () => { const result = await request({ action: "import-commit", previewId: preview.previewId, track: trackImports }); if (!mounted.current) return; setNotice(`${result.imported} imported, ${result.skipped} skipped. Originals ${result.originals}.`); setPreview(null); await Promise.all([loadStatus(), loadRecords()]); })}>Import selected notes</button></section>}
      </div></details>}
    </>}
  </section>;
}
