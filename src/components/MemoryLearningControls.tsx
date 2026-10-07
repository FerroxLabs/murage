export interface MemoryHealthStatus {
  captured: { sources: number; lastAt: number | null };
  processed: { sources: number; lastAt: number | null };
  retrieved: { queries: number; hits: number; lastAt: number | null; available?: boolean };
  supplied: { turns: number; references: number; lastAt: number | null };
  synthesis: { state: "not-configured" | "disabled" | "configured" | "budget-limited"; reason: string | null };
}
const lastActivity = (at: number | null) => at === null ? "No activity recorded" : `Last activity: ${new Date(at).toLocaleString()}`;
export function MemoryHealth({ status }: { status: {
  health?: MemoryHealthStatus; workerError: string | null;
  backlog: { pending: number; leased: number; deferred: number; failed: number };
  runtime?: { indexing?: boolean; error?: string | null } | null;
} }) {
  const health = status.health;
  return <details className="rounded-lg border border-hairline/40 p-3">
    <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Workspace learning activity</summary>
    <div className="mt-3 space-y-2 text-[12px] text-ink-secondary">
      <p>Counts cover the whole workspace, including when viewing one bot. Saved or retrieved memory does not prove a bot used it.</p>
      {!health ? <p role="status">Activity details are unavailable. Refresh memory to try again.</p> : <>
        <dl className="space-y-2">
          <div><dt className="font-medium text-ink">Captured</dt><dd>{health.captured.sources} sources stored. {lastActivity(health.captured.lastAt)}</dd></div>
          <div><dt className="font-medium text-ink">Processed</dt><dd>{health.processed.sources} sources processed. {lastActivity(health.processed.lastAt)}</dd></div>
          <div><dt className="font-medium text-ink">Retrieved</dt><dd>{health.retrieved.available === false ? "Retrieval history has not been recorded yet." : <>{health.retrieved.queries} searches, {health.retrieved.hits} results. {lastActivity(health.retrieved.lastAt)}</>}</dd></div>
          <div><dt className="font-medium text-ink">Supplied to turns</dt><dd>{health.supplied.references} references supplied across {health.supplied.turns} turns. {lastActivity(health.supplied.lastAt)}</dd></div>
        </dl>
        <p>Synthesis: {health.synthesis.state === "configured" ? "connection configured; successful learning is not confirmed by configuration alone" : health.synthesis.state === "not-configured" ? "no connection configured; choose a connection in Settings, then Memory" : health.synthesis.state === "budget-limited" ? "waiting for available budget" : "disabled"}.{health.synthesis.reason && ` ${health.synthesis.reason}`}</p>
      </>}
      <p>{status.backlog.pending} queued · {status.backlog.leased} processing · {status.backlog.deferred} deferred · {status.backlog.failed} failed</p>
      {(status.workerError || status.runtime?.error) && <p role="status" className="break-words text-danger">Processing needs attention: {status.workerError || status.runtime?.error}</p>}
      {status.runtime?.indexing && <p>Search index is updating. Recent records may not appear yet.</p>}
    </div>
  </details>;
}
