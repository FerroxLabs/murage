import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import type { MemoryRecord } from "../../shared/memory";
import { MemoryNotebookPicker } from "./MemoryNotebookPicker";
import { MemoryReview, memoryButtonClass, memoryInputClass, type MemoryAction, type MemoryAudience, type MemoryInspection } from "./MemoryReview";

export interface MemoryStatus {
  mode: "off" | "capture" | "active" | "paused";
  policyRevision: number; deletionEpoch: number;
  configuration: { excludedThreadIds: string[]; extractorInstanceId: string | null };
  scopes: MemoryAudience[];
  backlog: { pending: number; leased: number; deferred: number; failed: number; oldestQueuedAt: number | null };
  retention?: { sourceBytes: number; records: Array<{ state: string; count: number; bytes: number | null }> };
  records: Record<"candidate" | "active" | "archived" | "superseded" | "deleted", number>;
  model: { state: "missing" | "unverified" | "downloading" | "ready" | "failed"; bytesDownloaded: number; totalBytes: number; revision: string; model: string; error?: string };
  extractors: Array<{ instanceId: string; label: string; eligible: boolean; reason?: string }>;
  cost: { day: string; inputReserved: number; outputReserved: number; callsThisMinute: number; inputLimit: number; outputLimit: number; callsPerMinuteLimit: number };
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
const message = (error: unknown) => error instanceof Error ? error.message : "Memory request failed. Try again.";

export function MemorySettings({ botId, onNavigate }: { botId?: string; onNavigate?: () => void }) {
  const desktop = useDesktopSurface();
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<MemoryStatus["mode"]>("off");
  const [extractor, setExtractor] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [bindingScope, setBindingScope] = useState("");
  const [subject, setSubject] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [importChoice, setImportChoice] = useState(botId ? `bot:${botId}` : "");
  const [topic, setTopic] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [trackImports, setTrackImports] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loadStatus = useCallback(async () => {
    const next = await api("/api/memory/status") as MemoryStatus;
    if (!mounted.current) return;
    setStatus(next); setMode(next.mode); setExtractor(next.configuration.extractorInstanceId ?? ""); setExcluded(next.configuration.excludedThreadIds);
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
    setBusy(true); setError(null);
    applied.current = { query: "", scopeId: "", recordState: "", view: "search" };
    setQuery(""); setScopeId(""); setRecordState(""); setView("search"); setPageIndex(0); setPageCursors([undefined]); setInspection(null);
    void Promise.all([loadStatus(), request(memoryListAction("", "", "", botId, undefined, "search"))]).then(([, result]) => {
      if (!cancelled) { setRecords(result.records); setCursor(result.nextCursor); setScopeIds(result.scopeIds ?? null); }
    }).catch(error => { if (!cancelled) setError(message(error)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [desktop, botId, loadStatus]);
  useEffect(() => {
    if (status?.model.state !== "downloading") return;
    const timer = window.setInterval(() => { void loadStatus().catch(error => { if (mounted.current) setError(message(error)); }); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.model.state, loadStatus]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await work(); } catch (error) { if (mounted.current) setError(message(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const perform = async (action: MemoryAction, success: string) => run(async () => {
    await request(action);
    if (!mounted.current) return;
    setNotice(success); setInspection(null);
    await Promise.all([loadStatus(), loadRecords()]);
    if (view === "review") await loadConflicts();
  });
  const subjects = [...state.bots.map(bot => ({ value: `bot:${bot.id}`, label: bot.name })), ...state.groups.map(group => ({ value: `room:${group.id}`, label: `Room: ${group.name}` }))];
  const subjectFields = () => { const separator = subject.indexOf(":"); return { subjectType: subject.slice(0, separator), subjectId: subject.slice(separator + 1) }; };
  const threads = [...new Map([
    ...excluded.map(id => ({ id, label: `Conversation ${id}` })),
    ...state.bots.flatMap(bot => [{ id: bot.threadId, label: bot.name }, ...(bot.tasks ?? []).map(task => ({ id: task.threadId, label: `${bot.name}: ${task.title ?? "task"}` }))]),
    ...state.groups.map(group => ({ id: group.threadId, label: `Room: ${group.name}` })),
  ].map(item => [item.id, item])).values()];
  const sections = [...new Set(state.bots.map(bot => bot.section ?? ""))];
  if (desktop !== true) return <section className="rounded-xl bg-card p-4"><h2 className="text-[15px] font-medium">Managed memory</h2><p role="status" className="mt-2 text-[13px] text-ink-secondary">{desktop === undefined ? "Checking owner access…" : "Memory management is available in the local desktop app. Remote sessions cannot manage workspace memory."}</p></section>;
  return <section aria-label={botId ? "Bot memory" : "Workspace memory"} className="min-w-0 space-y-4 rounded-xl bg-card p-4 text-ink" data-testid="memory-settings">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[16px] font-medium">{botId ? "Bot memory" : "Workspace memory"}</h2><button className={memoryButtonClass} disabled={busy} onClick={() => void run(async () => { await Promise.all([loadStatus(), loadRecords()]); })}>Refresh memory</button></div>
    <p className="text-[13px] text-ink-secondary">Search saved knowledge, inspect its source and choose who can use it.</p>
    {busy && <p role="status" className="text-[13px] text-ink-secondary">Working…</p>}
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {notice && <p role="status" className="text-[13px] text-success">{notice}</p>}
    {status && <>
      <p className="text-[12px] text-ink-secondary">{botId ? `${records.length} records on this page${cursor ? " · more available" : ""}` : `${status.records.active} active records · ${status.records.candidate} awaiting review`} · Workspace mode: {status.mode === "active" ? "Capture and recall" : status.mode === "capture" ? "Capture only" : status.mode === "paused" ? "Paused" : "Off"}</p>
      <p className="text-[12px] text-ink-secondary">{status.mode === "active" ? "New work is captured and relevant memory is recalled across engines." : status.mode === "capture" ? "New work is captured. Recall is off." : "Capture and recall are not running. Active records remain saved."} {status.model.state !== "ready" ? "Keyword-only recall; the optional local model is not ready." : "Local semantic model ready."} {status.workerError ? "Processing needs attention." : status.runtime?.indexing ? "Search index is updating." : ""}</p>
      {status.workerError && <p role="alert" className="text-[13px] text-danger">{status.workerError}</p>}
      {botId && <div className="space-y-2 text-[13px]"><p className="text-ink-secondary">Capture, model downloads and processing settings apply to the whole workspace.</p><button type="button" className={memoryButtonClass} onClick={() => { onNavigate?.(); dispatch({ type: "showTeamMap", memory: true }); }}>Open workspace memory settings</button></div>}
      {status.mode === "off" && <div className="space-y-2 rounded-lg border border-hairline/50 p-3 text-[13px]"><p>Memory is off. Enable workspace capture and recall and import detected Murage bot notebooks. Originals are preserved and each notebook stays private to its bot. Recalled context is sent to the engine you choose; optional model extraction stays off unless you select it.</p><button type="button" className={memoryButtonClass} disabled={busy} onClick={() => void perform({ action: "enable-and-import" }, "Capture and recall enabled. Detected bot notebooks are being imported; originals are preserved.")}>Enable and import notebooks</button></div>}
      <nav aria-label="Memory views" className="flex flex-wrap gap-2">{([["search", "Search"], ["important", "Important"], ["recent", "Recent"], ["review", "Needs review"]] as const).map(([value, label]) => <button key={value} type="button" aria-label={value === "search" ? "Search view" : label} aria-pressed={view === value} className={`${memoryButtonClass} ${view === value ? "border-focus bg-inset" : ""}`} disabled={busy} onClick={() => void run(async () => { setView(value); setRecordState(""); setInspection(null); await loadRecords(undefined, { query, scopeId, recordState: "", view: value }); if (value === "review") await loadConflicts(); })}>{label}</button>)}</nav>
      <form className="grid min-w-0 gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))" }} onSubmit={event => { event.preventDefault(); setInspection(null); void run(() => loadRecords(undefined, { query, scopeId, recordState, view })); }}>
        <label className="col-span-full block min-w-0 space-y-1 text-[13px]">Search memory<input className={memoryInputClass} value={query} maxLength={4096} onChange={event => setQuery(event.target.value)} /></label>
        <label className="block space-y-1 text-[13px]">Audience<select className={memoryInputClass} value={scopeId} onChange={event => setScopeId(event.target.value)}><option value="">{botId ? "All audiences for this bot" : "All workspace audiences"}</option>{status.scopes.filter(scope => !scopeIds || scopeIds.includes(scope.id) || scope.id === scopeId).map(scope => <option key={scope.id} value={scope.id}>{scope.label}</option>)}</select></label>
        {view === "search" && <label className="block space-y-1 text-[13px]">Record status<select className={memoryInputClass} value={recordState} onChange={event => setRecordState(event.target.value)}><option value="">All statuses</option>{["candidate", "active", "archived", "superseded", "deleted"].map(value => <option key={value}>{value}</option>)}</select></label>}
        <button className={memoryButtonClass} disabled={busy}>Search</button>
      </form>
      {searchNotice && <p role="status" className="text-[12px] text-ink-secondary">{searchNotice}</p>}
      <ul aria-label="Memory records" className="space-y-2">
        {records.map(record => <li key={`${record.id}:${record.version}`} className="rounded-lg border border-hairline/40 p-3" data-memory-id={record.id}>
          <p className="whitespace-pre-wrap break-words text-[13px] line-clamp-3">{record.text}</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[12px] text-ink-secondary">{status.scopes.find(scope => scope.id === record.scopeId)?.label ?? "Unavailable audience"} · Record: {record.state}{record.ownerPinned ? " · Pinned" : ""} · {record.assertion.replaceAll("-", " ")} · <time dateTime={new Date(record.validFrom).toISOString()}>{new Date(record.validFrom).toLocaleDateString()}</time></span><button className={memoryButtonClass} disabled={busy} onClick={() => void run(async () => { const result = await request({ action: "inspect", id: record.id, version: record.version }); if (mounted.current) setInspection(result); })}>Inspect memory</button></div>
        </li>)}
      </ul>
      {!records.length && !busy && <p className="text-[13px] text-ink-secondary">No memories match these filters.</p>}
      {(cursor || pageIndex > 0) && <nav aria-label="Memory pages" className="flex items-center gap-3"><button className={memoryButtonClass} disabled={busy || pageIndex === 0} onClick={() => void run(async () => { const previous = pageIndex - 1; const history = pageCursors; await loadRecords(history[previous]); setPageCursors(history); setPageIndex(previous); setInspection(null); })}>Previous page</button><span className="text-[12px] text-ink-secondary">Page {pageIndex + 1}</span><button className={memoryButtonClass} disabled={busy || !cursor} onClick={() => void run(async () => { const next = pageIndex + 1; const history = [...pageCursors.slice(0, next), cursor]; await loadRecords(cursor); setPageCursors(history); setPageIndex(next); setInspection(null); })}>Next page</button></nav>}
      {view === "review" && <section aria-label="Notebook changes needing review" className="space-y-2"><h3 className="text-[14px] font-medium">Notebook changes</h3><p className="text-[12px] text-ink-secondary">These files changed after a memory was pinned, edited, archived or forgotten, or could not be read safely. Your saved decisions have been preserved.</p>{conflicts.map(link => <div key={link.id} className="space-y-2 rounded-lg border border-hairline/40 p-3 text-[13px]"><p>{link.selection.kind === "bot" ? `${state.bots.find(bot => bot.id === link.selection.botId)?.name ?? link.selection.botId}: ${link.selection.topic ?? "MEMORY.md"}` : `Team brief: ${link.selection.section || "General"}`}</p><p className="text-ink-secondary">{link.error === "MEMORY_IMPORT_REVIEW_CONFLICT" ? "The changed notebook conflicts with a saved memory decision." : "This notebook needs attention before it can be imported."}</p><button className={memoryButtonClass} disabled={busy} onClick={() => void perform({ action: "import-stop-tracking", id: link.id }, "Saved memory kept. Notebook tracking stopped.")}>Keep saved memory and stop tracking</button></div>)}{!conflicts.length && <p className="text-[12px] text-ink-secondary">No notebook conflicts need review.</p>}{conflictCursor && <button className={memoryButtonClass} disabled={busy} onClick={() => void run(() => loadConflicts(conflictCursor))}>Next notebook changes</button>}</section>}
      {inspection && <MemoryReview key={`${inspection.record.id}:${inspection.record.version}`} inspection={inspection} audiences={status.scopes} busy={busy} onAction={perform} onClose={() => setInspection(null)} />}

      {status.retention && <p className="text-[12px] text-ink-secondary">Retained source data: {status.retention.sourceBytes.toLocaleString()} bytes. Archived memories stay available for historical recall; nothing is permanently forgotten automatically.</p>}
      {!botId && <>
      <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Workspace settings and processing</summary>
        <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void perform({ action: "configure", mode, excludedThreadIds: excluded, extractorInstanceId: extractor || null }, "Memory settings saved."); }}>
          <fieldset disabled={busy} className="space-y-3"><legend className="sr-only">Memory configuration</legend>
            <label className="block space-y-1 text-[13px]">Memory mode<select className={memoryInputClass} value={mode} onChange={event => setMode(event.target.value as MemoryStatus["mode"])}><option value="off">Off</option><option value="capture">Capture only</option><option value="active">Capture and recall</option><option value="paused">Paused</option></select></label>
            <label className="block space-y-1 text-[13px]">Extractor preference<select className={memoryInputClass} value={extractor} onChange={event => setExtractor(event.target.value)}><option value="">No optional extractor</option>{status.extractors.map(item => <option key={item.instanceId} value={item.instanceId} disabled={!item.eligible}>{item.label}</option>)}</select></label>
            {status.extractors.find(item => item.instanceId === extractor)?.reason && <p className="text-[13px] text-ink-secondary">{status.extractors.find(item => item.instanceId === extractor)?.reason}</p>}
            <p className="text-[12px] text-ink-secondary">Optional: use this connection to turn captured text into memory candidates for review. Uses your existing key and may incur model charges.</p>
            <fieldset className="space-y-1"><legend className="text-[13px] font-medium">Exclude conversations from capture</legend><p className="text-[12px] text-ink-secondary">Excluding a conversation also retires its existing memory sources. Including it again does not restore retired memories.</p>{threads.map(thread => <label key={thread.id} className="flex min-h-10 items-center gap-2 text-[13px]"><input type="checkbox" checked={excluded.includes(thread.id)} onChange={event => setExcluded(previous => event.target.checked ? [...previous, thread.id] : previous.filter(id => id !== thread.id))} />{thread.label}</label>)}</fieldset>
            <button className={memoryButtonClass}>Save memory settings</button>
          </fieldset>
        </form>
        <div className="mt-4 space-y-2 text-[12px] text-ink-secondary"><h3 className="text-[13px] font-medium text-ink">Processing backlog</h3><p>{status.backlog.pending} queued · {status.backlog.leased} processing · {status.backlog.deferred} deferred · {status.backlog.failed} failed</p>{status.backlog.oldestQueuedAt !== null && <p>Oldest queued item: {new Date(status.backlog.oldestQueuedAt).toLocaleString()}</p>}<p>{status.deletion.pending} deletion updates pending</p>{status.workerError && <p role="alert" className="text-danger">{status.workerError}</p>}
          <h3 className="text-[13px] font-medium text-ink">Extraction usage and limits</h3><p>{status.cost.day}: {status.cost.inputReserved} / {status.cost.inputLimit} input tokens reserved; {status.cost.outputReserved} / {status.cost.outputLimit} output tokens reserved. {status.cost.callsThisMinute} / {status.cost.callsPerMinuteLimit} calls this minute.</p><p>These are usage reservations, not a currency invoice.</p>
        </div>
      </details>

      <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Local model</summary><div className="mt-3 space-y-2 text-[13px]"><p data-testid="memory-model-status">Local model: {status.model.state}</p><p className="break-words text-ink-secondary">{status.model.model} · Revision {status.model.revision}</p>{status.model.state !== "ready" && <p className="text-ink-secondary">Semantic recall is unavailable until the local model is verified. Lexical recall can still be used.</p>}{status.model.state === "downloading" && <p role="status">{status.model.bytesDownloaded} / {status.model.totalBytes} bytes downloaded</p>}{status.model.error && <p role="alert" className="text-danger">{status.model.error}</p>}<button className={memoryButtonClass} disabled={busy || status.model.state === "downloading" || status.model.state === "ready"} onClick={() => void perform({ action: "model-download", confirm: true }, "Local model download requested. Check the status for completion.")}>Download local model</button><p className="text-[12px] text-ink-secondary">Downloads the pinned model files to this computer. No provider model call is made by this action.</p></div></details>

      <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Audience access and projects</summary><fieldset disabled={busy} className="mt-3 space-y-3"><legend className="sr-only">Share audience access</legend>
        <label className="block space-y-1 text-[13px]">Allow access for<select className={memoryInputClass} value={subject} onChange={event => setSubject(event.target.value)}><option value="">Choose a bot or room</option>{subjects.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void perform({ action: "bind", scopeId: bindingScope, ...subjectFields() }, "Audience access saved."); }}><label className="block space-y-1 text-[13px]">Shared audience<select className={memoryInputClass} value={bindingScope} onChange={event => setBindingScope(event.target.value)}><option value="">Choose an audience</option>{status.scopes.filter(scope => ["project", "team", "workspace", "preferences", "room"].includes(scope.kind)).map(scope => <option key={scope.id} value={scope.id}>{scope.label}</option>)}</select></label><button className={memoryButtonClass} disabled={!subject || !bindingScope}>Grant audience access</button></form>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void perform({ action: "project", path: projectPath, ...subjectFields() }, "Project audience created and access granted."); }}><label className="block space-y-1 text-[13px]">Project folder<input className={memoryInputClass} value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="Absolute folder path" /></label><button className={memoryButtonClass} disabled={!subject || !projectPath.trim()}>Add project audience</button></form>
      </fieldset></details>

      </>}
      <details className="rounded-lg border border-hairline/40 p-3"><summary className="cursor-pointer text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Import existing notes</summary><div className="mt-3 space-y-3"><p className="text-[12px] text-ink-secondary">Preview the full notebook or team brief before importing it. Imported records retain an unverified-import label; original files are preserved.</p>
        <MemoryNotebookPicker botId={botId} onPreview={setPreview} />
        <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" checked={trackImports} onChange={event => setTrackImports(event.target.checked)} /><span>Keep imported notebooks updated when their files change. Pinned, edited, archived or forgotten memories require review.</span></label>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void run(async () => {
          const separator = importChoice.indexOf(":"); const kind = importChoice.slice(0, separator), value = importChoice.slice(separator + 1);
          const selection = kind === "bot" ? { kind, botId: value, ...(topic.trim() ? { topic: topic.trim() } : {}) } : { kind: "section", section: value };
          const result = await request({ action: "import-preview", selections: [selection] }); if (mounted.current) setPreview(result);
        }); }}>
          <label className="block space-y-1 text-[13px]">Notes to import<select className={memoryInputClass} value={importChoice} onChange={event => { setImportChoice(event.target.value); setPreview(null); }}><option value="">Choose notes</option>{state.bots.filter(bot => !botId || bot.id === botId).map(bot => <option key={bot.id} value={`bot:${bot.id}`}>{bot.name}: notebook</option>)}{!botId && sections.map(section => <option key={section} value={`section:${section}`}>{section || "General"}: team brief</option>)}</select></label>
          {importChoice.startsWith("bot:") && <label className="block space-y-1 text-[13px]">Topic file (optional)<input className={memoryInputClass} value={topic} onChange={event => { setTopic(event.target.value); setPreview(null); }} placeholder="Leave empty for MEMORY.md" /></label>}
          <button className={memoryButtonClass} disabled={busy || !importChoice}>Preview import</button>
        </form>
        {preview && <section aria-label="Import preview" className="space-y-2">{preview.items.map(item => <div key={item.path} className="rounded-lg border border-hairline/40 p-3"><p className="break-all text-[12px]">{item.path}</p><p className="text-[12px] text-ink-secondary">{item.scopeLabel} · {item.bytes} bytes · {item.alreadyImported ? "Already imported" : "New imported record"}</p><p className="mt-2 whitespace-pre-wrap break-words text-[13px]">{item.text}</p><p className="mt-2 break-all font-mono text-[11px] text-ink-secondary">Hash: {item.hash}</p></div>)}<p className="text-[12px] text-ink-secondary">Preview expires {new Date(preview.expiresAt).toLocaleString()}.</p><button className={memoryButtonClass} disabled={busy || preview.expiresAt <= Date.now()} onClick={() => void run(async () => { const result = await request({ action: "import-commit", previewId: preview.previewId, track: trackImports }); if (!mounted.current) return; setNotice(`${result.imported} imported, ${result.skipped} skipped. Originals ${result.originals}.`); setPreview(null); await Promise.all([loadStatus(), loadRecords()]); })}>Import selected notes</button></section>}
      </div></details>
    </>}
  </section>;
}
