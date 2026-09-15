import { useState } from "react";
import { memoryButtonClass } from "./MemoryReview";

export interface MemoryLearning {
  revision: number; automaticFacts: boolean; automaticProcedures: boolean; reviewMode: boolean;
  inputLimit: number; outputLimit: number; callsPerMinute: number; dailyCostUsd: number | null;
}
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
        <p>Synthesis: {health.synthesis.state === "configured" ? "connection configured; successful learning is not confirmed by configuration alone" : health.synthesis.state === "not-configured" ? "no connection configured; choose an existing extractor in workspace settings" : health.synthesis.state === "budget-limited" ? "waiting for available budget" : "disabled"}.{health.synthesis.reason && ` ${health.synthesis.reason}`}</p>
      </>}
      <p>{status.backlog.pending} queued · {status.backlog.leased} processing · {status.backlog.deferred} deferred · {status.backlog.failed} failed</p>
      {(status.workerError || status.runtime?.error) && <p role="status" className="break-words text-danger">Processing needs attention: {status.workerError || status.runtime?.error}</p>}
      {status.runtime?.indexing && <p>Search index is updating. Recent records may not appear yet.</p>}
    </div>
  </details>;
}

type LearningSwitches = Pick<MemoryLearning, "automaticFacts" | "automaticProcedures" | "reviewMode">;
export function MemoryLearningControls({ learning, disabled, onSave, onRefresh }: {
  learning: MemoryLearning; disabled: boolean;
  onSave: (patch: LearningSwitches, revision: number) => Promise<void>; onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<LearningSwitches>({ automaticFacts: learning.automaticFacts, automaticProcedures: learning.automaticProcedures, reviewMode: learning.reviewMode });
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const choices = [
    ["automaticFacts", "Learn facts automatically", "Keep supported facts from captured conversations available for recall."],
    ["automaticProcedures", "Learn procedures automatically", "Keep supported ways of working from captured experience."],
    ["reviewMode", "Review new learning before activation", "Optional. New learned facts and procedures wait in Needs review instead of becoming active automatically."],
  ] as const;
  return <section aria-label="Workspace automatic learning" className="rounded-lg border border-hairline/40 p-3">
    <h3 className="text-[14px] font-medium">Automatic learning</h3>
    <p className="mt-2 text-[12px] text-ink-secondary">These controls apply to the whole workspace. Ordinary automatic learning does not require approval. Processing also depends on memory mode, an available connection and its budget.</p>
    <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); if (busy || conflict || disabled) return; setBusy(true); setFeedback(null); setFailed(false); void onSave(draft, learning.revision).then(() => setFeedback("Learning settings saved.")).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not save learning settings. Try again.";
      const stale = message.includes("MEMORY_LEARNING_REVISION_CONFLICT"); setConflict(stale); setFailed(true);
      setFeedback(stale ? "Learning settings changed elsewhere. Refresh settings, review the latest choices, then save again." : message);
    }).finally(() => setBusy(false)); }}>
      <fieldset disabled={disabled || busy || conflict} className="space-y-2"><legend className="sr-only">Automatic learning choices</legend>
        {choices.map(([key, label, description]) => <label key={key} className="flex min-h-11 items-start gap-2 py-2 text-[13px]"><input type="checkbox" className="mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" checked={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.checked }))} /><span>{label}<span className="mt-1 block text-[12px] text-ink-secondary">{description}</span></span></label>)}
        <button className={memoryButtonClass}>Save learning settings</button>
      </fieldset>
      {feedback && <p role={failed ? "alert" : "status"} className={`break-words text-[13px] ${failed ? "text-danger" : "text-ink-secondary"}`}>{feedback}</p>}
      {conflict && <button type="button" className={memoryButtonClass} disabled={disabled || busy} onClick={() => { setBusy(true); void onRefresh().catch(() => setFeedback("Could not refresh settings. Try again before saving.")).finally(() => setBusy(false)); }}>Refresh learning settings</button>}
    </form>
    <p className="mt-3 text-[12px] text-ink-secondary">Daily limits: {learning.inputLimit.toLocaleString()} input tokens, {learning.outputLimit.toLocaleString()} output tokens; {learning.callsPerMinute} calls per minute. {learning.dailyCostUsd === null ? "No separate currency limit is configured." : `Currency limit: $${learning.dailyCostUsd} per day.`} Existing connection charges may apply. No model is downloaded by saving these choices.</p>
  </section>;
}
