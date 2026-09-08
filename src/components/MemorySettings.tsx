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
}
interface ImportPreview {
  previewId: string; expiresAt: number;
  items: Array<{ path: string; hash: string; bytes: number; text: string; scopeId: string; scopeLabel: string; alreadyImported: boolean }>;
}
export function memoryListAction(query: string, scopeId: string, state: string, botId?: string, cursor?: string): MemoryAction {
  return { action: "list", ...(query.trim() ? { query: query.trim() } : {}), ...(scopeId ? { scopeId } : {}), ...(state ? { state } : {}), ...(botId ? { botId } : {}), ...(cursor ? { cursor } : {}) };
}
const request = (action: MemoryAction) => api("/api/memory/action", { method: "POST", body: JSON.stringify(action) });
const message = (error: unknown) => error instanceof Error ? error.message : "Memory request failed. Try again.";

export function MemorySettings({ botId }: { botId?: string }) {
  const desktop = useDesktopSurface();
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [recordState, setRecordState] = useState("");
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
  const loadRecords = useCallback(async (nextCursor?: string) => {
    const result = await request(memoryListAction(query, scopeId, recordState, botId, nextCursor)) as { records: MemoryRecord[]; nextCursor?: string };
    if (!mounted.current) return;
    setRecords(previous => nextCursor ? [...previous, ...result.records] : result.records); setCursor(result.nextCursor);
  }, [query, scopeId, recordState, botId]);
  useEffect(() => {
    if (desktop !== true) return;
    let cancelled = false;
    setBusy(true); setError(null);
    void Promise.all([loadStatus(), request(memoryListAction("", "", "", botId))]).then(([, result]) => {
      if (!cancelled) { setRecords(result.records); setCursor(result.nextCursor); }
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
      <p className="text-[12px] text-ink-secondary">{botId ? `${records.length} matching records${cursor ? " · more available" : ""}` : `${status.records.active} active · ${status.records.candidate} awaiting review`} · Workspace mode: {status.mode === "active" ? "Capture and recall" : status.mode === "capture" ? "Capture only" : status.mode === "paused" ? "Paused" : "Off"}</p>
      {botId && <div className="space-y-2 text-[13px]"><p className="text-ink-secondary">Capture, model downloads and processing settings apply to the whole workspace.</p><button type="button" className={memoryButtonClass} onClick={() => dispatch({ type: "showTeamMap", memory: true })}>Open workspace memory settings</button></div>}
      {!botId && status.mode === "off" && <div className="space-y-2 rounded-lg border border-hairline/50 p-3 text-[13px]"><p>Memory is off. Enable local capture and recall for new work, and import existing notebooks separately. Recalled context is sent to the engine you choose; optional model extraction stays off unless you select it.</p><button type="button" className={memoryButtonClass} disabled={busy} onClick={() => void perform({ action: "configure", mode: "active" }, "Capture and recall enabled. Existing notebooks can now be imported below.")}>Enable capture and recall</button></div>}
      <form className="grid min-w-0 gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))" }} onSubmit={event => { event.preventDefault(); setInspection(null); void run(() => loadRecords()); }}>
        <label className="col-span-full block min-w-0 space-y-1 text-[13px]">Search memory<input className={memoryInputClass} value={query} maxLength={4096} onChange={event => setQuery(event.target.value)} /></label>
        <label className="block space-y-1 text-[13px]">Audience<select className={memoryInputClass} value={scopeId} onChange={event => setScopeId(event.target.value)}><option value="">{botId ? "All audiences for this bot" : "All workspace audiences"}</option>{status.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.label}</option>)}</select></label>
        <label className="block space-y-1 text-[13px]">Record status<select className={memoryInputClass} value={recordState} onChange={event => setRecordState(event.target.value)}><option value="">All statuses</option>{["candidate", "active", "archived", "superseded", "deleted"].map(value => <option key={value}>{value}</option>)}</select></label>
        <button className={memoryButtonClass} disabled={busy}>Search</button>
      </form>
      <ul aria-label="Memory records" className="space-y-2">
        {records.map(record => <li key={`${record.id}:${record.version}`} className="rounded-lg border border-hairline/40 p-3" data-memory-id={record.id}>
          <p className="whitespace-pre-wrap break-words text-[13px] line-clamp-3">{record.text}</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[12px] text-ink-secondary">{status.scopes.find(scope => scope.id === record.scopeId)?.label ?? "Unavailable audience"} · {record.state}{record.ownerPinned ? " · Pinned" : ""}</span><button className={memoryButtonClass} disabled={busy} onClick={() => void run(async () => { const result = await request({ action: "inspect", id: record.id, version: record.version }); if (mounted.current) setInspection(result); })}>Inspect memory</button></div>
        </li>)}
      </ul>
      {!records.length && !busy && <p className="text-[13px] text-ink-secondary">No memories match these filters.</p>}
      {cursor && <button className={memoryButtonClass} disabled={busy} onClick={() => void run(() => loadRecords(cursor))}>Load more memories</button>}
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
