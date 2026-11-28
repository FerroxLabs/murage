// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a forget (or a deleted conversation or bot, or a records revocation) leaves to do after its commit, as a durable job.
// The commit writes the deny facts for its targets only (memory_tombstones for named ids, memory_deny for a conversation or a
// bot's scopes, the deletion-epoch bump) and this job's row, so from that moment every reader refuses the material by ancestry
// (deny.ts, readable.ts, replay-lineage.ts). Nothing a reader needs is produced here: the job only brings the stored states into
// line, so its end state equals applyMemoryTombstones (restore.ts), in short bounded steps:
//   supporting  the rest of a many-version record's supporting and import tombstones (newest 256 evidence rows were inline)
//   imports     the rest of a many-revision source's import tombstones (newest 256 revisions were inline)
//   thread      a deleted conversation's sources, by its (thread_id, message_id) index: tombstoned, ended, text blanked
//   scope       a deleted bot's sources and records, in primary-key windows: tombstoned, ended, text blanked
//   bring-in    copies brought from an ended source (memory_source_origins seek; a pass over bring-in ids before it is built)
//   pip         stances naming an ended source are reconciled, one bot per step, each stance parsed once
//   expand      the records resting on an ended source (memory_evidence_by_source seek; primary-key windows of the evidence
//               before it is built), the targeted records, and everything derived from them (children paged)
//   receipts    receipts citing what ended, per id by the revocation index with a cursor (bundle windows before it is ready)
//   refs        a records revocation (archive, correct ...): every receipt citing an affected record or source, per id
//   bindings    evaluation and review bindings that copied ended evidence, paged by binding id
//   learning    what was learned from the material (evolution-forgetting.ts purgeLearningStep)
//   all         legacy global cleanup (bot deletions now retain only their scoped receipt work)
//   done        the job's own target rows, deleted in pages
// Ids live in memory_revocation_targets (job, kind, id, rev), paged by key: the job row (memory_scope_bindings, subject
// 'system'/'memory-revocation') carries only the phase and a scalar cursor, so it stays under 1 KB and resumes after a restart
// or any error; only completion removes it. When no job row waits, the runner fills the two late lookup tables instead.
import { syncThreadSummary, bumpChatsGen } from "../thread-summary.ts";
import { holdForgottenSources } from "../turn-source-holds.ts";
import { accountedPrepare, accountedDatabase, chargeReleaseStatement, chargeReleaseWork } from "./release-budget.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { lockedError } from "./revocation-index.ts";
import { beginBackground } from "../database.ts";
import { secureDeleteOn } from "../secure-delete.ts";
import { runningAppVersion } from "./app-version.ts";
import { ioBudget } from "../io-budget.ts";
import { scrubWalAfterDelete } from "../wal-maintenance.ts";
import { noteRevocation, revocationIndexReady, RECORD_REVOCATION_SCAN_SQL, RECORD_TOMBSTONE_AFFECTED, RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL } from "./revocation.ts";
import { newLearningPurgeCursor, purgeLearningStep, purgeEvolutionBinding, EVOLUTION_BINDING_SUBJECTS, type LearningPurgeCursor, type LearningLookup } from "./evolution-forgetting.ts";
import { reconcilePipStances } from "./pip-stance.ts";
import { armDeadline, bumpMemoVersion, memoVersion, onWake, wakeProbe } from "./revoke-wake.ts";
import { onWake as onCommitWake, WAKE_PRIORITY } from "./wake.ts";
import { JOB_BACKOFF, quarantineFailingJobs, quarantineLowTrust, quarantinedRevokeCount, retryQuarantinedOnNewVersion, revokeBackoffDueMs, revokeJobFailures, WINDOW_WAKE } from "./revoke-marker.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, chargeRevokeRows, endRevokeMeasure, floorMarkerSlice, noteRevokeClosing, REVOKE_IDLE_CLOSING, revokeClosingWaitMs, revokeFloorRows, revokeIdleClosingWaitMs, revokeFloorWaitMs, revokePaceNeed, revokePaceRows, revokePaceWaitMs, revokeSliceNeed, revokeWriteWaitMs } from "./revoke-budget.ts";
import { clearOrphanPending, enqueueReceipts, markerSlice, markerWorkPending, pruneDeletedBotMarks, releaseHold, totalChanges } from "./revoke-marker.ts";
import { coverReceiptChanges } from "./recall-view-schema.ts";
import { setFlipWake } from "./receipt-outputs.ts";
import { setSendFenceDeps } from "./send-fence-deps.ts";
import { MARKER_SLICE_ROWS, PENDING_ALL_SCOPES, PENDING_ALL_THREADS } from "./lineage-types.ts";
import { bumpDenyGeneration } from "./revoke-marker.ts";
import { LATE_REVOKE } from "./late-revoke.ts";
import { recordCounter } from "../health/counters.ts";
import { noteRevocationJobCreated, noteRevocationJobEnded, noteRevocationQueueEmpty } from "../health/pending-revocations.ts";

/** One prepared statement per connection and text: a job runs the same few statements hundreds of thousands of times, and on a
 * plain connection (restore, tests) a fresh statement each time left that many for the collector to finalise in long pauses. */
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function st(db: DatabaseSync, sql: string): StatementSync {
  let held = statements.get(db);
  if (!held) statements.set(db, held = new Map());
  let statement = held.get(sql);
  if (!statement) { statement = accountedPrepare(db, sql); if (held.size < 512) held.set(sql, statement); }
  return statement;
}

export const REVOCATION_JOB_SUBJECT = "memory-revocation";
const warnedJobs = new WeakMap<DatabaseSync, Set<string>>();
/** Failed cleanup needs attention, but retries must not repeat its warning on this connection. */
export function warnRevocationJobOnce(db: DatabaseSync, rowId: string, message: string): void {
  let warned = warnedJobs.get(db);
  if (!warned) warnedJobs.set(db, warned = new Set());
  if (warned.has(rowId)) return;
  warned.add(rowId);
  console.warn(message);
}
/** A retained engine session of a thread whose source was forgotten points at this set id, which no set row has: its next
 * check finds the set unprovable and resets the session (replay-lineage.ts sessionOutputRoots), in every memory mode. */
export const FORGOTTEN_SESSION_SET = "rs-forgotten";

/** Told which messages forgotten material came from (project-tables.ts markProjectDerivedStale; registered through forget.ts). */
export type ForgottenMessagesHook = (db: DatabaseSync, messageIds: string[], threadOf: ReadonlyMap<string, string>) => void;
let forgottenMessagesHook: ForgottenMessagesHook | null = null;
export function setForgottenMessagesHook(hook: ForgottenMessagesHook | null): void { forgottenMessagesHook = hook; }
export function forgottenMessages(db: DatabaseSync, sourceIds: readonly string[]): void {
  if (!sourceIds.length) return;
  const read = st(db, "SELECT message_id,thread_id FROM memory_sources WHERE id=?");
  const threadOf = new Map<string, string>();
  for (const id of sourceIds) { const row = read.get(id); if (typeof row?.message_id === "string" && typeof row.thread_id === "string" && row.message_id) threadOf.set(row.message_id, row.thread_id); }
  endedLines(db, sourceIds);
  if (threadOf.size) forgottenMessagesHook?.(db, [...threadOf.keys()], threadOf);
}

/** Any ended or forgotten source line leaves its chat's All chats preview in the same transaction (thread_summary). */
function endedLines(db: DatabaseSync, sourceIds: readonly string[]): void {
  if (!sourceIds.length || !db.prepare("SELECT 1 FROM sqlite_schema WHERE name='thread_summary'").get()) return;
  const threadOf = st(db, "SELECT thread_id FROM memory_sources WHERE id=?");
  const threads = new Set<string>();
  for (const id of sourceIds) { const t = threadOf.get(id)?.thread_id; if (typeof t === "string" && t) threads.add(t); }
  for (const threadId of threads) syncThreadSummary(db, threadId);
  if (threads.size) bumpChatsGen(db);
}

export type RevocationTarget = { id: string; rev: number | null };
type Phase = "supporting" | "imports" | "thread" | "scope" | "bring-in" | "pip" | "expand" | "receipts" | "refs" | "bindings" | "learning" | "records-scan" | "all" | "sourcework" | "supersede" | "done";
export type RevocationJob = {
  v: 2;
  /** the key of its rows in memory_revocation_targets */
  id: string;
  /** the deletion epoch its commit set (all: only receipts made before it) */
  epoch?: number;
  /** forget of a record: the record, its revision filter, whether it is a room's notes (no supporting tombstones) */
  record?: { id: string; rev: number | null; notes: boolean; after?: [number, string, number, number] | null;
    /** cause10 r2: where forget.ts stopped in the record's kept spans (keptSpanPairs); the supporting phase walks the rest */
    span?: KeptSpanCursor | null;
    /** cause10 v2: the Forget wrote the record's whole deny key set in its commit (forgetRecordKeys); nothing the job does gates a reader;
     * on a Forget an older build queued, set when an open of this build wrote them (legacy-forget-keys.ts) */
    keys?: true } | null;
  /** forget of a source: its import tombstones below this revision are the imports phase's; `mark` is memory_sources' largest rowid at
   * the commit, so a copy imported while the older hashes were not yet tombstoned is found and ended when they are (revbound r3 A6);
   * `scope` is the forgotten source's scope */
  imports?: { id: string; below: number; mark?: number; scope?: string;
    /** cause10 v2: every revision's import key is written: by the Forget's own commit (forget.ts, this build), or for a source Forget
     * an older build queued, by an open of this build (legacy-forget-keys.ts) */
    keys?: true } | null;
  /** the write-time revoke (revoke-commit.ts) this job's commit made: receipts it flips enter that revoke's marker, and its imports
   * phase releases that revoke's hold */
  revokeId?: number;
  /** a deleted conversation (records resting on its sources lose their text too) */
  thread?: string | null;
  /** a deleted bot's scopes */
  scopes?: string[] | null;
  /** threads the learning purge takes whole (a deleted conversation, the owner's excluded threads) */
  threads?: string[];
  /** a records revocation (refs): whether the evidence sources of the affected records end receipts too */
  via?: 0 | 1;
  phases: Phase[]; c: Record<string, any> | null;
  /** records-scan: a records revocation decided while the index was not ready (revocation.ts revokeRecordDisclosures) */
  rec?: { recordIds: readonly unknown[]; sourceIds: readonly unknown[]; via: 0 | 1; cause: string; tombstoneOf?: string };
  cause?: string; revoked?: number; total?: number;
};
const FORGET_PHASES: Phase[] = ["bring-in", "pip", "expand", "receipts", "bindings", "learning", "done"];
export const forgetJob = (extra: Partial<RevocationJob> = {}): RevocationJob =>
  ({ v: 2, id: randomUUID(), phases: [...FORGET_PHASES], c: null, cause: "tombstones", ...extra });

const hasTable = (db: DatabaseSync, name: string) => Boolean(st(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const ALL = -1;
const revKey = (rev: number | null) => rev === null ? ALL : rev;
const revOf = (rev: unknown) => Number(rev) === ALL ? null : Number(rev);

// ---- targets (memory_revocation_targets): s ended source, r ended record, m message, q record version to end, p parent whose
// children to enqueue, R/S affected record/source of a records revocation
export function addTarget(db: DatabaseSync, job: RevocationJob, kind: string, id: string, rev: number | null = null): boolean {
  return Number(st(db, "INSERT OR IGNORE INTO memory_revocation_targets(job_id,kind,id,rev) VALUES(?,?,?,?)").run(job.id, kind, id, revKey(rev)).changes) > 0;
}
const hasTarget = (db: DatabaseSync, job: RevocationJob, kind: string, id: string) => Boolean(st(db, "SELECT 1 FROM memory_revocation_targets WHERE job_id=? AND kind=? AND id=? LIMIT 1").get(job.id, kind, id));
/** The next targets of a kind after a (id, rev) key. */
function targetsAfter(db: DatabaseSync, job: RevocationJob, kind: string, after: [string, number] | null, n: number): Array<{ id: string; rev: number }> {
  const rows = after
    ? st(db, "SELECT id,rev FROM memory_revocation_targets WHERE job_id=? AND kind=? AND (id,rev)>(?,?) ORDER BY id,rev LIMIT ?").all(job.id, kind, after[0], after[1], n)
    : st(db, "SELECT id,rev FROM memory_revocation_targets WHERE job_id=? AND kind=? ORDER BY id,rev LIMIT ?").all(job.id, kind, n);
  return rows.map(row => ({ id: String(row.id), rev: Number(row.rev) }));
}
/** Ends a source found by a job (its state, its work, its message for the learning purge) and records it as a target. */
function endSource(db: DatabaseSync, job: RevocationJob, id: string, rev: number | null): void {
  st(db, "UPDATE memory_sources SET state='deleted' WHERE id=? AND state!='deleted' AND (? IS NULL OR revision=?)").run(id, rev, rev);
  endSourceWork(db, [{ id, rev }], job);
  noteSource(db, job, id, rev);
}
/** Records an ended source as a target, with its message id for the learning purge. */
export function noteSource(db: DatabaseSync, job: RevocationJob, id: string, rev: number | null): void {
  addTarget(db, job, "s", id, rev);
  const message = st(db, "SELECT message_id FROM memory_sources WHERE id=?").get(id)?.message_id;
  if (typeof message === "string" && message) addTarget(db, job, "m", message);
}

/** Writes the job row (caller's transaction). Null when the file has no scope to hang it on (then it has no memory to revoke). */
export function createRevocationJob(db: DatabaseSync, job: RevocationJob): string | null {
  const scope = st(db, "SELECT id FROM memory_scopes LIMIT 1").get()?.id;
  if (scope === undefined || scope === null) return null;
  const id = `${REVOCATION_JOB_SUBJECT}:${job.id}`;
  st(db, "INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)").run(id, String(scope), REVOCATION_JOB_SUBJECT, JSON.stringify(job));
  noteRevocationJobCreated();
  return id;
}

/** Every ended source's own cleanup: its jobs cancelled, parked ones forgotten, its learning events dropped (indexed by source),
 * and the retained engine sessions of its thread pointed at a set that cannot be proven. One page of each source's jobs and events
 * here (SOURCE_WORK_ROWS); a source with more (a much-revised source's history) is a `w` target of the job's sourcework phase, paged
 * by key (revbound r3 A5: never every row of one source in one statement). `job` is the caller's job; without one (a forget's
 * commit, restore.ts) a small job is made for the rest. */
export function endSourceWork(db: DatabaseSync, sources: readonly RevocationTarget[], job: RevocationJob | null = null): void {
  const sessions = hasTable(db, "memory_session_roots") ? st(db, "UPDATE memory_session_roots SET set_id=? WHERE thread_id=? AND set_id!=?") : null;
  const threadOf = st(db, "SELECT thread_id FROM memory_sources WHERE id=?");
  const threads = new Set<string>(), more: RevocationTarget[] = [];
  for (const t of sources) {
    if (sourceWorkPage(db, t, {}, SOURCE_WORK_ROWS) !== null) more.push(t);
    const thread = threadOf.get(t.id)?.thread_id;
    if (typeof thread === "string") threads.add(thread);
  }
  // a retained engine session of the thread may hold the forgotten words with no receipt to say so (capture only, memory off):
  // its lineage row now names a set that cannot be proven, so its next check resets it (bounded: the thread's sessions)
  if (sessions) for (const thread of threads) sessions.run(FORGOTTEN_SESSION_SET, thread, FORGOTTEN_SESSION_SET);
  if (more.length) queueSourceWork(db, job, more.map(t => ["w", t.id, t.rev] as const));
}
/** Rows of one source's own work a commit or a step touches per statement. */
export const SOURCE_WORK_ROWS = 256;
/** One page of a source's work after `c` (jobs by their unique key, then learning events by rowid). The cursor to go on from, or
 * null when none is left. */
function sourceWorkPage(db: DatabaseSync, t: RevocationTarget, c: Record<string, any>, n: number): Record<string, any> | null {
  const ending = "(?2 IS NULL OR source_revision=?2 OR EXISTS (SELECT 1 FROM memory_sources o WHERE o.id=?1 AND o.state='deleted'))";
  if (!c.events) {
    const keys = (c.at
      ? st(db, "SELECT rowid AS rid,source_revision AS r,stage AS s,stage_version AS v FROM memory_jobs WHERE source_id=? AND (source_revision,stage,stage_version)>(?,?,?) ORDER BY source_revision,stage,stage_version LIMIT ?").all(t.id, ...(c.at as [number, string, string]), n)
      : st(db, "SELECT rowid AS rid,source_revision AS r,stage AS s,stage_version AS v FROM memory_jobs WHERE source_id=? ORDER BY source_revision,stage,stage_version LIMIT ?").all(t.id, n)) as Array<{ rid: number; r: number; s: string; v: string }>;
    if (keys.length) {
      const ids = JSON.stringify(keys.map(k => Number(k.rid)));
      st(db, `UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1,lease_owner=NULL,lease_until=0 WHERE rowid IN (SELECT value FROM json_each(?3)) AND status!='cancelled' AND ${ending}`).run(t.id, t.rev, ids);
      st(db, `UPDATE memory_jobs SET error=NULL WHERE rowid IN (SELECT value FROM json_each(?3)) AND +status='cancelled' AND substr(error,1,7)='parked:' AND ${ending}`).run(t.id, t.rev, ids);
    }
    if (keys.length === n) { const last = keys[keys.length - 1]!; return { at: [Number(last.r), String(last.s), String(last.v)] }; }
    if (!hasTable(db, "memory_learning_events")) return null;
    c = { events: true, rid: 0 };
  }
  const rows = st(db, "SELECT rowid AS rid FROM memory_learning_events WHERE source_id=? AND rowid>? ORDER BY rowid LIMIT ?").all(t.id, Number(c.rid ?? 0), n).map(row => Number(row.rid));
  if (rows.length) st(db, `DELETE FROM memory_learning_events WHERE rowid IN (SELECT value FROM json_each(?3)) AND ${ending}`).run(t.id, t.rev, JSON.stringify(rows));
  return rows.length === n ? { events: true, rid: rows[rows.length - 1] } : null;
}
/** Adds sourcework targets (`w` a source's jobs and events, `P` a deleted source's version payloads) to the caller's job, or to a new
 * small job when there is none. */
function queueSourceWork(db: DatabaseSync, job: RevocationJob | null, targets: ReadonlyArray<readonly [string, string, number | null]>): void {
  const into = job ?? { v: 2 as const, id: randomUUID(), phases: ["sourcework" as Phase, "done" as Phase], c: null, cause: "source-work" };
  for (const [kind, id, rev] of targets) addTarget(db, into, kind, id, rev);
  if (job) { if (!job.phases.includes("sourcework")) job.phases.splice(Math.max(0, job.phases.indexOf("done")), 0, "sourcework"); }
  else if (createRevocationJob(db, into)) wakeIfStarted();
  else advanceRevocationJob(db, into, Number.MAX_SAFE_INTEGER);
}
// ---- sourcework: the rest of each ended source's jobs and events (w), and of a deleted source's version payloads (P), by key
function sourceWorkStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { kind: "w", at: null as null | [string, number], sub: {} as Record<string, any> });
  const n = chunk(budget);
  const [t] = targetsAfter(db, job, c.kind, c.at, 1);
  if (!t) { if (c.kind === "w") { job.c = { kind: "P", at: null, sub: {} }; return false; } return true; }
  if (c.kind === "w") {
    const next = sourceWorkPage(db, { id: t.id, rev: revOf(t.rev) }, c.sub, n);
    spend(budget, n);
    if (next) c.sub = next; else { c.at = [t.id, t.rev]; c.sub = {}; }
    return false;
  }
  const after = Number(c.sub.rev ?? -1);
  const revs = st(db, "SELECT revision FROM memory_source_versions WHERE source_id=? AND revision>? ORDER BY revision LIMIT ?").all(t.id, after, n).map(row => Number(row.revision));
  if (revs.length) st(db, "UPDATE memory_source_versions SET payload=?1 WHERE source_id=?2 AND revision IN (SELECT value FROM json_each(?3))").run(String(c.sub.payload ?? payloadOf(db, job, t.id)), t.id, JSON.stringify(revs));
  spend(budget, revs.length);
  if (revs.length === n) c.sub = { rev: revs[revs.length - 1], payload: c.sub.payload ?? payloadOf(db, job, t.id) }; else { c.at = [t.id, t.rev]; c.sub = {}; }
  return false;
}
const payloadOf = (db: DatabaseSync, job: RevocationJob, id: string) => { void db; void id; return JSON.stringify({ deleted: job.thread ? "thread-deleted" : "bot-deleted" }); };

type Budget = { rows: number; deadline: number; projections: Array<[string, number, number]> };
/** No single step reads more than this many candidate rows: the deadline is checked between steps, so a slice is never longer than
 * its budget plus one chunk, whichever phase it is in. */
export const STEP_CHUNK = 256;
const chunk = (budget: Budget) => Math.max(1, Math.min(STEP_CHUNK, budget.rows));
/** Steps whose every row ends a record or a source (several statements each) take fewer rows, so one step stays well inside a slice. */
export const HEAVY_CHUNK = 32;
const heavy = (budget: Budget) => Math.max(1, Math.min(HEAVY_CHUNK, budget.rows));
const spend = (budget: Budget, n: number) => { budget.rows -= Math.max(1, n); };
const exhausted = (budget: Budget) => budget.rows <= 0 || performance.now() >= budget.deadline;

/** Sentinel's operation class of each phase step (counts only; GAP-SENTINEL-109 4.2 revocation progress). */
const PHASE_OPERATION: Readonly<Record<Phase, string>> = {
  supporting: "tombstone", imports: "tombstone", thread: "lineage-walk", scope: "lineage-walk", "bring-in": "lineage-walk", pip: "state-update",
  expand: "affect", receipts: "index-update", refs: "index-update", bindings: "state-update", learning: "purge",
  "records-scan": "index-update", all: "index-update", sourcework: "lineage-walk", supersede: "state-update", done: "state-update",
};
/** Advances a job within the budget (caller's transaction). True when it is complete. */
export function advanceRevocationJob(db: DatabaseSync, job: RevocationJob, rows: number, ms = Number.POSITIVE_INFINITY): boolean {
  const budget: Budget = { rows: Math.max(1, rows), deadline: performance.now() + ms, projections: [] };
  while (job.phases.length && !exhausted(budget)) {
    const phase = job.phases[0]!;
    const step = Object.hasOwn(STEPS, phase) ? STEPS[phase] : undefined;
    if (!step) {
      // A phase another build persisted never leaves cleanup unfinished or wedges the queue (MEMDEL-SIMPLIFY-109): this build walks
      // the deleted conversations and bots the job names itself, drops the phases it does not know, and runs the rest.
      warnRevocationJobOnce(db, `${REVOCATION_JOB_SUBJECT}:${job.id}`, `[memory] revocation job ${job.id} has unknown phase ${JSON.stringify(phase)}; its deletions are walked again by this build`);
      rewalkDeletions(db, job);
      const known = job.phases.filter(phase => Object.hasOwn(STEPS, phase));
      job.phases = hasAnyTarget(db, job.id) ? carryPhases(known) : known; job.c = null;
      continue;
    }
    const finished = step(db, job, budget);
    // Finish record logging before covering this bounded step's receipt flips, so record rows cannot end the cover early.
    if (budget.projections.length) {
      const projections = budget.projections.splice(0);
      coverReceiptChanges(db, projections.map(([id, version]) => [id, version]), () => {
        for (const [id, version, force] of projections)
          st(db, "UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending' WHERE record_id=? AND record_version=? AND lexical_status!='delete-pending' AND (lexical_status!='deleted' OR ?=1)").run(id, version, force);
      });
    }
    recordCounter("io-pressure", PHASE_OPERATION[phase], "none");
    if (finished) {
      job.phases.shift(); job.c = null;
      if ((phase === "receipts" || phase === "refs" || phase === "records-scan" || phase === "all") && job.revoked) {
        job.total = (job.total ?? 0) + job.revoked;
        noteRevocation(phase === "all" ? "global" : "records", phase === "records-scan" ? job.rec?.cause ?? "records" : `${job.cause ?? "tombstones"}-job`, job.revoked);
        job.revoked = 0;
      }
    }
  }
  return job.phases.length === 0;
}

// ---- supporting: the rest of a forgotten record's supporting sources. forget.ts did the newest rows (versions descending) down to
// `record.after`; the job takes every row before that one in ascending key order, a primary-key range per step
function supportingStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const record = job.record!;
  const c = (job.c ??= { after: null as unknown[] | null });
  if (c.span) return keptSpanStep(db, job, c, budget);
  // forget.ts took every evidence row itself and left only a span: nothing for the row walk below to read again
  if (record.span && !record.after && !c.after) { job.c = { span: record.span }; return false; }
  const n = heavy(budget);
  const keys = "(record_version,source_id,source_revision,start_byte)";
  const where = ["record_id=?"], args: unknown[] = [record.id];
  if (record.rev !== null) { where.push("record_version=?"); args.push(record.rev); }
  if (c.after) { where.push(`${keys}>(?,?,?,?)`); args.push(...c.after); }
  if (record.after) { where.push(`${keys}<(?,?,?,?)`); args.push(...record.after); }
  const rows = st(db, `SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE ${where.join(" AND ")}
    ORDER BY record_version,source_id,source_revision,start_byte LIMIT ?`).all(...args as never[], n) as Array<{ v: number; s: string; r: number; b: number }>;
  spend(budget, rows.length);
  supportingTombstones(db, job, rows.map(row => ({ id: String(row.s), revision: Number(row.r) })), record.notes);
  if (rows.length < n) {
    // cause10 r2: then the rest of the record's kept spans (forget.ts did the newest revisions)
    if (record.span) { job.c = { span: record.span }; return false; }
    return true;
  }
  const last = rows[rows.length - 1]!;
  c.after = [Number(last.v), String(last.s), Number(last.r), Number(last.b)];
  return false;
}
/** An evidence row's key (record version, source, source revision, start byte) and, for that row, the revision its span is done down to. */
export type KeptSpanCursor = [number, string, number, number, number];
/** 1.0.21 cause10 r2 (review High): the notebook revisions a forgotten import chunk rested on that its evidence no longer names. The
 * chunk-diff import (import.ts) keeps an unchanged chunk's version and MOVES its one evidence handle to each new notebook revision, where
 * 1.0.20 wrote a version with its own handle at every revision. A chunk version `v` (written at revision v, import.ts) whose handle now
 * cites revision r > v therefore rested, with these words, on every revision v..r; forget reads only the handle (r), so without this the
 * contents of revisions v..r-1 kept no import tombstone and the same words under another topic of the scope could be imported again.
 * Returns up to `max` such (notebook, revision) pairs, newest first, reading at most `max` evidence rows from `cursor` (null: the newest
 * row) down, and where to go on; `next` null: every row is done. Only a notebook's own chunk (`<source>:chunk:<n>`) has a span. */
export function keptSpanPairs(db: DatabaseSync, record: { id: string; rev: number | null }, cursor: KeptSpanCursor | null, max: number): { pairs: Array<{ id: string; revision: number }>; next: KeptSpanCursor | null } {
  const keys = "(record_version,source_id,source_revision,start_byte)";
  const where = ["record_id=?"], args: unknown[] = [record.id];
  if (record.rev !== null) { where.push("record_version=?"); args.push(record.rev); }
  // a cursor row whose span is done (down to its version) is not read again: the walk moves on even one row at a time
  if (cursor) { where.push(`${keys}${cursor[4] <= cursor[0] ? "<" : "<="}(?,?,?,?)`); args.push(cursor[0], cursor[1], cursor[2], cursor[3]); }
  const rows = st(db, `SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE ${where.join(" AND ")}
    ORDER BY record_version DESC,source_id DESC,source_revision DESC,start_byte DESC LIMIT ?`).all(...args as never[], max) as Array<{ v: number; s: string; r: number; b: number }>;
  const pairs: Array<{ id: string; revision: number }> = [];
  for (const row of rows) {
    const v = Number(row.v), s = String(row.s), r = Number(row.r), b = Number(row.b);
    const resumed = Boolean(cursor && cursor[0] === v && cursor[1] === s && cursor[2] === r && cursor[3] === b);
    let below = resumed ? Math.min(r, Number(cursor![4])) : r;
    if (record.id.startsWith(`${s}:chunk:`) && Number.isSafeInteger(v) && Number.isSafeInteger(below) && v >= 1) {
      while (below > v) {
        if (pairs.length >= max) return { pairs, next: [v, s, r, b, below] };
        pairs.push({ id: s, revision: --below });
      }
    }
    // this row is done: a walk that goes on from it starts at the next row down
    if (row === rows[rows.length - 1]) return { pairs, next: rows.length < max ? null : [v, s, r, b, v] };
  }
  return { pairs, next: null };
}
function keptSpanStep(db: DatabaseSync, job: RevocationJob, c: Record<string, any>, budget: Budget): boolean {
  const record = job.record!, n = heavy(budget);
  const { pairs, next } = keptSpanPairs(db, record, c.span as KeptSpanCursor, n);
  spend(budget, n);
  supportingTombstones(db, job, pairs, record.notes);
  if (!next) return true;
  c.span = next;
  return false;
}
// 1.0.21 cause10 v2 r3: the import asks no queued Forget. r3 (pendingForgetOfImport) refused an import while a Forget's job still owed
// the keys of the older revisions, and v2 r2 kept that as an index of the keys older-build Forgets owed, read once per open database.
// Since the legacy pass (legacy-forget-keys.ts, database.ts) every such Forget is keyed whole before a writable open returns, so that
// index was empty on every open that can admit an import (an open that cannot write admits none), and nothing could show it refusing:
// it is removed. A forgotten revision is refused by its import key alone (import.ts), written by the Forget's commit or by the open.
/** 1.0.21 cause10 v2 (FORGET-ATOMIC.md): every (notebook or message source, revision) a forgotten record rested on, as set SQL: each
 * evidence row's own revision and, for a notebook's own chunk (`<source>:chunk:<n>`, version v >= 1), every revision from v up to its
 * handle, the span keptSpanPairs walks. `?1` record id, `?2` its version or NULL for every version. */
const FORGOTTEN_PAIRS = `SELECT DISTINCT e.source_id AS s,v.revision AS r,v.content_hash AS h FROM memory_evidence e
  JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision<=e.source_revision
    AND v.revision>=CASE WHEN e.record_version>=1 AND substr(e.record_id,1,length(e.source_id)+7)=e.source_id||':chunk:' THEN min(e.record_version,e.source_revision) ELSE e.source_revision END
  WHERE e.record_id=?1 AND (?2 IS NULL OR e.record_version=?2)`;
const TOMBSTONE_ID = "lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(6)))";
/** The whole deny key set of a record Forget, written in the Forget's own commit whatever the number of versions, evidence rows or kept
 * revisions (FORGET-ATOMIC.md): the import key (scope, content hash) of every revision the record rested on, read by import.ts and by
 * deny-read.ts for a copy imported before the Forget, and unless the record is a room's notes the supporting-source key (source,
 * revision) of each, read by every source verdict. Three set statements, linear in what is forgotten: an import key another Forget
 * already wrote may be written again (harmless, as 1.0.20 did; a per-row "already there" probe reads the scope's keys and is quadratic in
 * one statement), a source key is written once (its unique index). The job's supporting
 * phase then only ends what rested on those sources (endSource) and reclaims space: no reader waits on it. Returns the distinct sources. */
export function forgetRecordKeys(db: DatabaseSync, record: { id: string; rev: number | null }, notes: boolean, epoch: number, now: number): string[] {
  st(db, `INSERT INTO memory_tombstones SELECT ${TOMBSTONE_ID},'import',k.scope_id,NULL,k.h,?3,'forgotten-original',?4 FROM
    (SELECT DISTINCT s.scope_id,p.h FROM (${FORGOTTEN_PAIRS}) p JOIN memory_sources s ON s.id=p.s) k`).run(record.id, record.rev, epoch, now);
  if (!notes) st(db, `INSERT OR IGNORE INTO memory_tombstones SELECT ${TOMBSTONE_ID},'source',p.s,p.r,NULL,?3,'forgotten-supporting-source',?4 FROM (${FORGOTTEN_PAIRS}) p`).run(record.id, record.rev, epoch, now);
  return st(db, `SELECT DISTINCT source_id AS s FROM memory_evidence WHERE record_id=?1 AND (?2 IS NULL OR record_version=?2)`).all(record.id, record.rev).map(row => String(row.s));
}
/** The import key of every revision of a forgotten source (or the one named), in the Forget's own commit (FORGET-ATOMIC.md). */
export function forgetSourceKeys(db: DatabaseSync, source: { id: string; rev: number | null }, epoch: number, now: number): void {
  st(db, `INSERT INTO memory_tombstones SELECT ${TOMBSTONE_ID},'import',k.scope_id,NULL,k.h,?3,'forgotten-original',?4 FROM
    (SELECT DISTINCT s.scope_id,v.content_hash AS h FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE v.source_id=?1 AND (?2 IS NULL OR v.revision=?2)) k`).run(source.id, source.rev, epoch, now);
}
/** The import tombstone of each (source, revision) and, unless the record is a room's notes, its supporting-source tombstone and
 * end (shared by forget.ts for the inline rows and the supporting phase for the rest). */
export function supportingTombstones(db: DatabaseSync, job: RevocationJob | null, pairs: ReadonlyArray<{ id: string; revision: number }>, notes: boolean, keyed: boolean = Boolean(job?.record?.keys)): Array<{ id: string; revision: number }> {
  const read = st(db, "SELECT s.scope_id,v.content_hash FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?");
  const epoch = Number(st(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch), now = Date.now();
  const seen = new Set<string>(), ended: Array<{ id: string; revision: number }> = [];
  for (const pair of pairs) {
    const key = `${pair.id}\u0000${pair.revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = read.get(pair.revision, pair.id);
    if (!row) continue;
    // a Forget from cause10 v2 on wrote this key in its commit (forgetRecordKeys): neither probed nor written again (the probe read
    // the scope's import keys per pair). An older build's job (no `keys`) writes it here, as 1.0.20 did.
    if (!keyed) st(db, "INSERT INTO memory_tombstones VALUES(?,'import',?,NULL,?,?,'forgotten-original',?)").run(randomUUID(), String(row.scope_id), String(row.content_hash), epoch, now);
    if (notes) continue;
    // Source expansion must not reveal a forgotten record through its original span.
    st(db, "INSERT OR IGNORE INTO memory_tombstones VALUES(?,'source',?,?,NULL,?,'forgotten-supporting-source',?)").run(randomUUID(), pair.id, pair.revision, epoch, now);
    ended.push(pair);
    if (job) endSource(db, job, pair.id, pair.revision);
  }
  if (job && ended.length) {
    forgottenMessages(db, ended.map(pair => pair.id));
    // a turn that carried a message these sources were captured from no longer stands on it (forget.ts holds the inline rows)
    holdForgottenSources(db, ended.map(pair => pair.id));
  }
  return ended;
}

// ---- imports: the rest of a forgotten source's revisions' import tombstones, newest first
function importsStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const target = job.imports!;
  const c = (job.c ??= { below: target.below });
  if (c.window) return importWindowStep(db, job, c, budget);
  const n = chunk(budget);
  const rows = st(db, "SELECT s.scope_id,v.revision,v.content_hash FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE v.source_id=? AND v.revision<? ORDER BY v.revision DESC LIMIT ?").all(target.id, c.below, n);
  const epoch = Number(st(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch), now = Date.now();
  for (const row of rows) st(db, "INSERT INTO memory_tombstones VALUES(?,'import',?,NULL,?,?,'forgotten-original',?)").run(randomUUID(), String(row.scope_id), String(row.content_hash), epoch, now);
  spend(budget, rows.length);
  if (rows.length < n) {
    // every hash is tombstoned now: an import admitted before this point with one of them is found and ended (revbound r3 A6)
    if (target.mark !== undefined && target.scope !== undefined) { c.window = true; c.rid = target.mark; return false; }
    if (job.revokeId) releaseHold(db, job.revokeId, job.id);
    return true;
  }
  c.below = Number(rows[rows.length - 1]!.revision);
  return false;
}
/** The sources made since the forget's commit (memory_sources rowids after its mark: window-sized, never history) in the forgotten
 * source's scope whose content now has an import tombstone end with every revision; the expand phase ends what rests on them. The
 * revoke's pending scope rows held them "checking" until here (the hold). */
function importWindowStep(db: DatabaseSync, job: RevocationJob, c: Record<string, any>, budget: Budget): boolean {
  const target = job.imports!, n = heavy(budget);
  const ended: string[] = [];
  const rows = st(db, "SELECT rowid AS rid,id,scope_id,content_hash,state FROM memory_sources WHERE rowid>? ORDER BY rowid LIMIT ?").all(Number(c.rid), n) as Array<{ rid: number; id: string; scope_id: string; content_hash: string; state: string }>;
  for (const row of rows) {
    if (row.scope_id !== target.scope || row.id === target.id || row.state === "deleted") continue;
    if (!st(db, "SELECT 1 FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash=? LIMIT 1").get(target.scope, row.content_hash)) continue;
    if (!st(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND revision IS NULL").get(row.id))
      st(db, "INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,?,'forgotten-original',?)").run(randomUUID(), row.id, Number(st(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch), Date.now());
    endSource(db, job, row.id, null);
    ended.push(row.id);
  }
  // A forgotten original's line leaves the All chats preview in the same step that ends it.
  endedLines(db, ended);
  spend(budget, rows.length);
  if (rows.length === n) { c.rid = Number(rows[rows.length - 1]!.rid); return false; }
  if (job.revokeId) releaseHold(db, job.revokeId, job.id);
  return true;
}

/** A deleted conversation's or bot's source: tombstoned for every revision, ended, its words gone. */
function endPlacedSource(db: DatabaseSync, job: RevocationJob, id: string, reason: string, payload: string): void {
  if (!st(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND revision IS NULL").get(id))
    st(db, "INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,?,?,?)").run(randomUUID(), id, Number(job.epoch ?? 0), reason, Date.now());
  // (its jobs cancelled and parked ones forgotten, a page here and the rest in the sourcework phase: endSource -> endSourceWork)
  endSource(db, job, id, null);
  // its words: the newest page of versions here, the rest by key in the sourcework phase (revbound r3 A5)
  const revs = st(db, "SELECT revision FROM memory_source_versions WHERE source_id=? ORDER BY revision DESC LIMIT ?").all(id, SOURCE_WORK_ROWS + 1).map(row => Number(row.revision));
  st(db, "UPDATE memory_source_versions SET payload=?1 WHERE source_id=?2 AND revision IN (SELECT value FROM json_each(?3)) AND payload!=?1").run(payload, id, JSON.stringify(revs.slice(0, SOURCE_WORK_ROWS)));
  if (revs.length > SOURCE_WORK_ROWS) queueSourceWork(db, job, [["P", id, null]]);
}
// ---- thread: a deleted conversation's sources, through memory_sources_thread (message ids in order, then the few without one)
function threadStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { message: "", none: null as string | null, tail: false });
  const n = heavy(budget);
  const rows = (c.tail
    ? st(db, "SELECT id FROM memory_sources WHERE thread_id=? AND message_id IS NULL AND id>? ORDER BY id LIMIT ?").all(job.thread!, c.none ?? "", n)
    : st(db, "SELECT id,message_id FROM memory_sources WHERE thread_id=? AND message_id>? ORDER BY message_id LIMIT ?").all(job.thread!, c.message, n)) as Array<{ id: string; message_id?: string }>;
  const payload = JSON.stringify({ deleted: "thread-deleted" });
  for (const row of rows) endPlacedSource(db, job, String(row.id), "thread-deleted", payload);
  endedLines(db, rows.map(row => String(row.id)));
  spend(budget, rows.length);
  if (rows.length === n) { if (c.tail) c.none = String(rows[rows.length - 1]!.id); else c.message = String(rows[rows.length - 1]!.message_id); return false; }
  if (!c.tail) { c.tail = true; return false; }
  return true;
}
// ---- scope: a deleted bot's sources and records, in primary-key windows of each table (no scope index on sources)
function scopeStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { table: "sources", after: "", rec: null as null | [string, number] });
  const scopes = new Set(job.scopes ?? []);
  const n = heavy(budget);
  if (c.table === "sources") {
    const rows = st(db, "SELECT id,scope_id FROM memory_sources WHERE id>? ORDER BY id LIMIT ?").all(c.after, n);
    const payload = JSON.stringify({ deleted: "bot-deleted" });
    const ended = rows.filter(row => scopes.has(String(row.scope_id))).map(row => String(row.id));
    for (const id of ended) endPlacedSource(db, job, id, "bot-deleted", payload);
    // a deleted bot's lines in rooms it shared leave those rooms' previews in this step
    endedLines(db, ended);
    spend(budget, rows.length);
    if (rows.length === n) c.after = String(rows[rows.length - 1]!.id); else c.table = "records";
    return false;
  }
  // 1.0.22 revokehealth item 7: every record is tombstoned; the bot revoke's marks this deny now covers go, a page per step
  if (c.table === "prune") {
    const gone = job.revokeId ? pruneDeletedBotMarks(db, job.revokeId, n) : 0;
    spend(budget, gone);
    return gone < n;
  }
  const rows = (c.rec
    ? st(db, "SELECT id,version,scope_id FROM memory_records WHERE (id,version)>(?,?) ORDER BY id,version LIMIT ?").all(c.rec[0], c.rec[1], n)
    : st(db, "SELECT id,version,scope_id FROM memory_records ORDER BY id,version LIMIT ?").all(n)) as Array<{ id: string; version: number; scope_id: string }>;
  const epoch = Number(job.epoch ?? 0), now = Date.now();
  for (const row of rows) {
    if (!scopes.has(String(row.scope_id))) continue;
    const id = String(row.id), version = Number(row.version);
    if (!st(db, "SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND revision IS NULL").get(id))
      st(db, "INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,?,'bot-deleted',?)").run(randomUUID(), id, epoch, now);
    affect(db, job, budget, id, version);
  }
  spend(budget, rows.length);
  if (rows.length === n) { c.rec = [String(rows[rows.length - 1]!.id), Number(rows[rows.length - 1]!.version)]; return false; }
  c.table = "prune";
  return false;
}

// ---- bring-in: a copy brought into a project from an ended source goes with it (and a copy of that copy)
const BRING_IN_PAGE = "SELECT id FROM memory_sources WHERE id>? AND id<'bring-in;' ORDER BY id LIMIT ?";
/** Whether the origin lookup table is complete (memory_late_build 'origins'). */
export const lateReady = (db: DatabaseSync, name: "evidence" | "origins") => {
  try { return Number(st(db, "SELECT ready FROM memory_late_build WHERE name=?").get(name)?.ready) === 1; } catch { return false; }
};
/** The copies of these sources found in the commit: by their origin message (memory_sources(thread_id,message_id)) and, once
 * built, by memory_source_origins; bounded (8 rounds of at most 256 each). The job's bring-in phase finds the rest. */
export function bringInCopiesOf(db: DatabaseSync, sources: readonly RevocationTarget[]): RevocationTarget[] {
  const origin = st(db, "SELECT thread_id,message_id FROM memory_sources WHERE id=?");
  const copies = st(db, "SELECT id FROM memory_sources WHERE thread_id=? AND message_id=? AND kind='bring-in' AND state!='deleted' LIMIT 256");
  const byOrigin = lateReady(db, "origins") ? st(db, "SELECT bring_in_id AS id FROM memory_source_origins WHERE origin_id=? LIMIT 256") : null;
  const found: RevocationTarget[] = [];
  let frontier = sources.slice();
  for (let round = 0; frontier.length && round < 8; round++) {
    const candidates = new Set<string>();
    for (const t of frontier) {
      const row = origin.get(t.id);
      if (typeof row?.thread_id === "string" && typeof row.message_id === "string") for (const c of copies.all(row.thread_id, row.message_id)) candidates.add(String(c.id));
      if (byOrigin) for (const c of byOrigin.all(t.id)) candidates.add(String(c.id));
    }
    const ends = new Map<string, Array<number | null>>();
    for (const t of frontier) ends.set(t.id, [...(ends.get(t.id) ?? []), t.rev]);
    frontier = endBringIns(db, [...candidates], id => ends.get(id));
    found.push(...frontier);
  }
  return found;
}
/** Of these bring-in sources, ends the ones brought from an ended source (applyMemoryTombstones' forget rule); `ended` names the
 * revisions of an ended source (null: every one). */
function endBringIns(db: DatabaseSync, ids: readonly string[], ended: (id: string) => Array<number | null> | undefined): RevocationTarget[] {
  if (!ids.length) return [];
  const read = st(db, "SELECT s.id,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.kind='bring-in' AND s.state!='deleted'");
  const deleted = st(db, "SELECT 1 FROM memory_sources WHERE id=? AND state='deleted'");
  const end = st(db, "UPDATE memory_sources SET state='deleted' WHERE id=? AND state!='deleted'");
  const out: RevocationTarget[] = [];
  for (const id of ids) {
    const row = read.get(id);
    if (!row) continue;
    let from: unknown;
    try { from = (JSON.parse(String(row.payload)) as { broughtFrom?: { sources?: unknown } }).broughtFrom?.sources; } catch { continue; }
    if (!Array.isArray(from)) continue;
    const hit = from.some(item => {
      const ref = item as { id?: unknown; revision?: unknown } | null;
      const revs = typeof ref?.id === "string" ? ended(ref.id) : undefined;
      return revs !== undefined && revs.some(rev => rev === null || rev === ref!.revision || Boolean(deleted.get(ref!.id as string)));
    });
    if (hit && Number(end.run(id).changes)) out.push({ id, rev: null });
  }
  if (out.length) endSourceWork(db, out);
  return out;
}
function bringInStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const n = chunk(budget);
  const revsOf = (id: string) => {
    const rows = st(db, "SELECT rev FROM memory_revocation_targets WHERE job_id=? AND kind='s' AND id=?").all(job.id, id);
    return rows.length ? rows.map(row => revOf(row.rev)) : undefined;
  };
  if (lateReady(db, "origins")) {
    // per ended source (in key order; a copy that ends is added and reached later in the same order or by its own seek)
    const c = (job.c ??= { after: null as null | [string, number], copy: "" });
    const [t] = targetsAfter(db, job, "s", c.after, 1);
    if (!t) return true;
    const ids = st(db, "SELECT bring_in_id AS id FROM memory_source_origins WHERE origin_id=? AND bring_in_id>? ORDER BY bring_in_id LIMIT ?").all(t.id, c.copy, n).map(row => String(row.id));
    spend(budget, ids.length);
    for (const copy of endBringIns(db, ids, revsOf)) noteSource(db, job, copy.id, null);
    if (ids.length === n) c.copy = ids[ids.length - 1]!;
    else { c.after = [t.id, Number.MAX_SAFE_INTEGER]; c.copy = ""; } // (its other revisions: the same copies)
    return false;
  }
  // before the origins are built: rounds over every bring-in id, until a round ends nothing
  const c = (job.c ??= { after: "bring-in:", ended: 0 });
  const ids = (st(db, BRING_IN_PAGE).all(c.after, n) as Array<{ id: string }>).map(row => String(row.id));
  spend(budget, ids.length);
  if (ids.length) {
    c.after = ids[ids.length - 1];
    for (const copy of endBringIns(db, ids, revsOf)) { noteSource(db, job, copy.id, null); c.ended++; }
    return false;
  }
  if (c.ended) { job.c = { after: "bring-in:", ended: 0 }; return false; }
  return true;
}

// ---- pip: stances naming an ended source are reconciled, one bot per step (every bot for a deleted conversation or bot)
function pipStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { after: "" });
  const row = st(db, "SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='pip-stance' AND id>? ORDER BY id LIMIT 1").get(c.after);
  spend(budget, 1);
  if (!row) return true;
  c.after = String(row.id);
  let names = Boolean(job.thread || job.scopes?.length);
  if (!names) {
    // the stance parsed once into the set of source ids its handles name, each tested by a seek of this job's targets
    let stance: { support?: Record<string, unknown>; events?: Record<string, Record<string, unknown>> } = {};
    try { stance = JSON.parse(String(row.intent)); } catch { /* unreadable: reconciled below */ names = true; }
    const ids = new Set<string>();
    for (const list of Object.values(stance.support ?? {})) if (Array.isArray(list)) for (const id of list) if (typeof id === "string") ids.add(id);
    for (const events of Object.values(stance.events ?? {})) for (const id of Object.keys(events ?? {})) ids.add(id);
    pipStanceParses++;
    if (!names) for (const id of ids) if (hasTarget(db, job, "s", id)) { names = true; break; }
  }
  if (names) reconcilePipStances(db, String(row.id).slice("pip-stance:".length));
  return false;
}
/** Test hook: how many stances the pip phase parsed. */
export let pipStanceParses = 0;
export function resetPipStanceParses(): void { pipStanceParses = 0; }

// ---- expand: the records resting on an ended source or targeted, and every record derived from one
/** Ends one record version: deleted, its projection receipts queued for deletion, its learning events gone, its id a receipts
 * target, its derived children queued (paged by the expand step, never read whole here). */
function affect(db: DatabaseSync, job: RevocationJob, budget: Budget, id: string, version: number): void {
  const prior = st(db, "SELECT state,length(CAST(text AS BLOB)) AS bytes FROM memory_records WHERE id=? AND version=?").get(id, version);
  // Sentinel (S02 annotation): how often a record is ended, how often it was already deleted, and what the step rewrites.
  // Counts only, from the row this step reads anyway; the decision below is unchanged.
  observeAffect(prior);
  if (!prior) return;
  // Forget means the words are gone (Learn about me r3 C3): every record a forget ends loses its text in this same step, not only
  // those resting on a deleted conversation. Readers are already refused from the forget's commit; the indexes drop it by id.
  // One statement, so the record logs one recall change row, not one for the state and one for the text (T4: a slice's rows changed stay
  // inside SLICE_WORK_PER_ROW per budget row).
  st(db, "UPDATE memory_records SET state='deleted',owner_pinned=0,text='' WHERE id=? AND version=? AND (state!='deleted' OR owner_pinned!=0 OR text!='')").run(id, version);
  // A rolled checkpoint has a 'deleted' projection while its record is still
  // archived. Its first actual forget must also scrub old segments and WAL pages.
  // Repeated visits to an already deleted record keep completed work completed (scale finding A6); an already pending pair needs no rewrite.
  if (st(db, "SELECT 1 FROM memory_projection_receipts WHERE record_id=? AND record_version=? AND lexical_status!='delete-pending' AND (lexical_status!='deleted' OR ?=1) LIMIT 1").get(id, version, prior.state !== "deleted" ? 1 : 0))
    budget.projections.push([id, version, prior.state !== "deleted" ? 1 : 0]);
  // (indexed by record; the events naming it as their prior go in the learning phase's rowid windows: evolution-forgetting.ts)
  if (hasTable(db, "memory_learning_events")) st(db, "DELETE FROM memory_learning_events WHERE record_id=? AND record_version=?").run(id, version);
  addTarget(db, job, "r", id);
  addTarget(db, job, "terms", id, version);
  // what was derived from it goes too; a record deleted before (by an earlier forget) had its descendants handled then
  if (prior.state !== "deleted") addTarget(db, job, "p", id, version);
}
function observeAffect(prior: Record<string, unknown> | undefined): void {
  recordCounter("io-pressure", "affect-attempts", "none");
  if (!prior) return;
  if (prior.state === "deleted") recordCounter("io-pressure", "prior-deleted", "none");
  else recordCounter("io-pressure", "state-changed", "none");
  const bytes = Number(prior.bytes);
  if (Number.isFinite(bytes) && bytes > 0) recordCounter("io-pressure", "bytes-attributed", "none", undefined, bytes);
}
function expandStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { kids: null as null | { id: string; v: number; after: [string, number] | null }, rec: 0, src: null as null | [string, number], ev: null as null | unknown[], scan: null as null | unknown[] | "start" });
  const n = heavy(budget);
  // 1. the children of one parent, a page at a time
  if (c.kids) {
    const k = c.kids;
    const rows = (k.after
      ? st(db, "SELECT child_id,child_version FROM memory_derivations WHERE parent_id=? AND parent_version=? AND (child_id,child_version)>(?,?) ORDER BY child_id,child_version LIMIT ?").all(k.id, k.v, k.after[0], k.after[1], n)
      : st(db, "SELECT child_id,child_version FROM memory_derivations WHERE parent_id=? AND parent_version=? ORDER BY child_id,child_version LIMIT ?").all(k.id, k.v, n)) as Array<{ child_id: string; child_version: number }>;
    for (const row of rows) addTarget(db, job, "q", String(row.child_id), Number(row.child_version));
    spend(budget, rows.length);
    if (rows.length === n) k.after = [String(rows[rows.length - 1]!.child_id), Number(rows[rows.length - 1]!.child_version)]; else c.kids = null;
    return false;
  }
  // 2. the next parent whose children are to be queued
  const parent = st(db, "SELECT id,rev FROM memory_revocation_targets WHERE job_id=? AND kind='p' LIMIT 1").get(job.id);
  if (parent) {
    st(db, "DELETE FROM memory_revocation_targets WHERE job_id=? AND kind='p' AND id=? AND rev=?").run(job.id, parent.id, parent.rev);
    c.kids = { id: String(parent.id), v: Number(parent.rev), after: null };
    spend(budget, 1);
    return false;
  }
  // 3. queued record versions
  const queued = st(db, "SELECT id,rev FROM memory_revocation_targets WHERE job_id=? AND kind='q' LIMIT ?").all(job.id, n);
  if (queued.length) {
    for (const row of queued) {
      st(db, "DELETE FROM memory_revocation_targets WHERE job_id=? AND kind='q' AND id=? AND rev=?").run(job.id, row.id, row.rev);
      affect(db, job, budget, String(row.id), Number(row.rev));
    }
    spend(budget, queued.length);
    return false;
  }
  // 4. the targeted record's versions
  if (job.record && c.rec !== null) {
    const rows = st(db, "SELECT version FROM memory_records WHERE id=? AND version>? AND (?3 IS NULL OR version=?3) ORDER BY version LIMIT ?").all(job.record.id, c.rec, job.record.rev, n) as Array<{ version: number }>;
    for (const row of rows) affect(db, job, budget, job.record.id, Number(row.version));
    spend(budget, rows.length);
    c.rec = rows.length === n ? Number(rows[rows.length - 1]!.version) : null;
    return false;
  }
  // 5. the records resting on an ended source
  if (c.scan === null && lateReady(db, "evidence")) {
    // per ended source, a seek of memory_evidence_by_source with a key cursor
    // per ended source id once (a source ended at many revisions is still one pass over its evidence)
    if (!c.src) {
      const [t] = targetsAfter(db, job, "s", c.srcAfter ?? null, 1);
      if (!t) return true;
      c.src = [t.id, Number.MAX_SAFE_INTEGER]; c.ev = null;
    }
    const [id] = c.src;
    const revs = st(db, "SELECT rev FROM memory_revocation_targets WHERE job_id=? AND kind='s' AND id=? AND rev=?");
    const every = Boolean(revs.get(job.id, id, ALL));
    const rows = (c.ev
      ? st(db, "SELECT source_revision AS r,record_id AS i,record_version AS v,start_byte AS b FROM memory_evidence_by_source WHERE source_id=? AND (source_revision,record_id,record_version,start_byte)>(?,?,?,?) ORDER BY source_revision,record_id,record_version,start_byte LIMIT ?").all(id, ...(c.ev as [number, string, number, number]), n)
      : st(db, "SELECT source_revision AS r,record_id AS i,record_version AS v,start_byte AS b FROM memory_evidence_by_source WHERE source_id=? ORDER BY source_revision,record_id,record_version,start_byte LIMIT ?").all(id, n)) as Array<{ r: number; i: string; v: number; b: number }>;
    const deleted = Boolean(st(db, "SELECT 1 FROM memory_sources WHERE id=? AND state='deleted'").get(id));
    for (const row of rows) if (every || deleted || revs.get(job.id, id, Number(row.r))) affect(db, job, budget, String(row.i), Number(row.v));
    spend(budget, rows.length);
    if (rows.length === n) { const last = rows[rows.length - 1]!; c.ev = [Number(last.r), String(last.i), Number(last.v), Number(last.b)]; }
    else { c.srcAfter = c.src; c.src = null; c.ev = null; }
    return false;
  }
  // before memory_evidence_by_source is built: one pass over the evidence in primary-key windows for every ended source at once
  if (c.scan === "done") return true; // (what the pass queued was drained by the steps above)
  if (c.scan === null) c.scan = "start";
  const after = c.scan === "start" ? null : c.scan as [string, number, string, number, number];
  const rows = (after
    ? st(db, "SELECT record_id AS i,record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE (record_id,record_version,source_id,source_revision,start_byte)>(?,?,?,?,?) ORDER BY record_id,record_version,source_id,source_revision,start_byte LIMIT ?").all(...after, n)
    : st(db, "SELECT record_id AS i,record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence ORDER BY record_id,record_version,source_id,source_revision,start_byte LIMIT ?").all(n)) as Array<{ i: string; v: number; s: string; r: number; b: number }>;
  const revs = st(db, "SELECT rev FROM memory_revocation_targets WHERE job_id=? AND kind='s' AND id=?");
  const deleted = st(db, "SELECT 1 FROM memory_sources WHERE id=? AND state='deleted'");
  for (const row of rows) {
    const held = revs.all(job.id, String(row.s)).map(r => Number(r.rev));
    if (held.length && held.some(rev => rev === ALL || rev === Number(row.r) || Boolean(deleted.get(String(row.s))))) affect(db, job, budget, String(row.i), Number(row.v));
  }
  spend(budget, rows.length);
  if (rows.length === n) { const last = rows[rows.length - 1]!; c.scan = [String(last.i), Number(last.v), String(last.s), Number(last.r), Number(last.b)]; return false; }
  // pass finished: what it queued is drained by the steps above before the phase ends
  c.scan = "done";
  return !st(db, "SELECT 1 FROM memory_revocation_targets WHERE job_id=? AND kind IN ('p','q') LIMIT 1").get(job.id) && !c.kids;
}

// ---- receipts: the receipts citing what this job ended
/** The same per-row test the installation-wide statements make (restore.ts TOMBSTONE_REVOCATION_SQL), for one id: `+x.ref_*`
 * carries no affinity, so each comparison with a typed column applies that column's affinity exactly as there. */
const CITES_DELETED_RECORD = "EXISTS (SELECT 1 FROM memory_records r WHERE r.id=?2 AND r.id=+x.ref_id AND r.version=+x.ref_version AND r.state='deleted')";
const CITES_ENDED_SOURCE = `EXISTS (SELECT 1 FROM memory_sources s WHERE s.id=?2 AND s.id=+x.ref_id AND (s.state='deleted'
  OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=+x.ref_version))))`;
/** One id's citing receipts after a rowid cursor: an index seek on (kind, CAST(ref_id AS TEXT)), rowid order, at most ?4 candidates. */
export const citingSeekSql = (kind: "record" | "source", any = false) => `SELECT x.rowid AS rid,x.bundle_id AS bundle,${any ? "(+x.ref_id=?2)" : kind === "record" ? CITES_DELETED_RECORD : CITES_ENDED_SOURCE} AS hit
  FROM memory_disclosure_refs x WHERE x.kind=?1 AND CAST(x.ref_id AS TEXT)=?2 AND x.rowid>?3 ORDER BY x.rowid LIMIT ?4`;
export const FLIP_SQL = "UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND bundle_id IN (SELECT value FROM json_each(?))";
const SCAN_SQL = `UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND (EXISTS (
      SELECT 1 FROM json_each(memory_disclosures.record_versions) j JOIN memory_records r
      ON r.id=json_extract(j.value,'$.id') AND r.version=json_extract(j.value,'$.version') WHERE r.state='deleted'
    ) OR EXISTS (SELECT 1 FROM json_each(memory_disclosures.source_versions) j JOIN memory_sources s
      ON s.id=json_extract(j.value,'$.id') WHERE s.state='deleted' OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=json_extract(j.value,'$.revision')))))
    AND bundle_id>?1 AND bundle_id<=?2`;
/** The last bundle id and size of the page after ?1 ('' is before every id: bundle ids are non-empty text), a primary-key range. */
export const BUNDLE_PAGE_END = "SELECT max(bundle_id) AS b,count(*) AS n FROM (SELECT bundle_id FROM memory_disclosures WHERE bundle_id>?1 ORDER BY bundle_id LIMIT ?2)";
/** One page of receipts in bundle-id order (bundle ids, unlike rowids, survive a VACUUM): the statement runs on the key range
 * (c.after, end of page]; true when it was the last. */
function bundlePage(db: DatabaseSync, c: { after: string | null }, n: number, run: (after: string | null, end: string) => number, job: RevocationJob, budget: Budget): boolean {
  const page = st(db, BUNDLE_PAGE_END).get(c.after ?? "", n);
  const count = Number(page?.n ?? 0);
  if (count) job.revoked = (job.revoked ?? 0) + run(c.after ?? "", String(page!.b));
  spend(budget, count);
  if (count < n) return true;
  c.after = String(page!.b);
  return false;
}
/** Seeks the receipts citing each target of `kinds` (key order), flipping those `hit` names. */
function seekTargets(db: DatabaseSync, job: RevocationJob, budget: Budget, kinds: Array<[string, "record" | "source"]>, any: boolean, cursor?: Record<string, any>): boolean {
  const c = cursor ?? (job.c ??= { k: 0, at: null as null | [string, number], after: 0 });
  const n = chunk(budget);
  for (;;) {
    if (c.k >= kinds.length) return true;
    if (!c.cur) {
      const [t] = targetsAfter(db, job, kinds[c.k]![0], c.at, 1);
      if (!t) { c.k++; c.at = null; continue; }
      // a source ended at several revisions is one id here
      c.cur = t.id; c.at = [t.id, Number.MAX_SAFE_INTEGER]; c.after = 0;
    }
    break;
  }
  const kind = kinds[c.k]![1];
  const rows = st(db, citingSeekSql(kind, any)).all(kind, c.cur, c.after, n) as Array<{ rid: number; bundle: string; hit: number }>;
  const hits = rows.filter(row => row.hit).map(row => row.bundle);
  if (hits.length) job.revoked = (job.revoked ?? 0) + Number(st(db, FLIP_SQL).run(JSON.stringify(hits)).changes);
  // the flip drops the receipts' refs rows: the revoke's marker takes them from here (their output lines)
  if (hits.length && job.revokeId) enqueueReceipts(db, job.revokeId, hits);
  spend(budget, rows.length);
  if (rows.length < n) c.cur = null; else c.after = Number(rows[rows.length - 1]!.rid);
  return false;
}
function receiptsStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  if (!job.c && !revocationIndexReady(db)) job.c = { mode: "scan", after: null };
  if (job.c?.mode === "scan") return bundlePage(db, job.c as { after: string | null }, chunk(budget), (after, end) => Number(st(db, SCAN_SQL).run(after, end).changes), job, budget);
  return seekTargets(db, job, budget, [["r", "record"], ["s", "source"]], false);
}
// ---- refs: a records revocation, every receipt citing an affected record (R: the named ids and each record derived from one,
// transitively, found through a queue Rq) or, through the evidence, source (S)
function refsStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { stage: "closure", at: null as null | [string, number], after: null as null | unknown[] });
  const n = chunk(budget);
  if (c.stage === "closure") {
    const queued = st(db, "SELECT id FROM memory_revocation_targets WHERE job_id=? AND kind='Rq' LIMIT ?").all(job.id, n).map(row => String(row.id));
    for (const id of queued) {
      st(db, "DELETE FROM memory_revocation_targets WHERE job_id=? AND kind='Rq' AND id=?").run(job.id, id);
      if (addTarget(db, job, "R", id)) st(db, "INSERT OR IGNORE INTO memory_revocation_targets(job_id,kind,id,rev) SELECT DISTINCT ?,'Rq',child_id,-1 FROM memory_derivations WHERE parent_id=?").run(job.id, id);
    }
    spend(budget, queued.length);
    if (queued.length < n && !st(db, "SELECT 1 FROM memory_revocation_targets WHERE job_id=? AND kind='Rq' LIMIT 1").get(job.id)) c.stage = job.via ? "ev" : "seek";
    return false;
  }
  if (c.stage === "ev") {
    // the evidence sources of each affected record, a page of its evidence rows at a time
    const [t] = targetsAfter(db, job, "R", c.at, 1);
    if (!t) { c.stage = "seek"; return false; }
    const rows = (c.after
      ? st(db, "SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE record_id=? AND (record_version,source_id,source_revision,start_byte)>(?,?,?,?) ORDER BY record_version,source_id,source_revision,start_byte LIMIT ?").all(t.id, ...c.after, n)
      : st(db, "SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE record_id=? ORDER BY record_version,source_id,source_revision,start_byte LIMIT ?").all(t.id, n)) as Array<{ v: number; s: string; r: number; b: number }>;
    for (const row of rows) addTarget(db, job, "S", String(row.s));
    spend(budget, rows.length);
    if (rows.length === n) { const last = rows[rows.length - 1]!; c.after = [Number(last.v), String(last.s), Number(last.r), Number(last.b)]; }
    else { c.at = [t.id, t.rev]; c.after = null; }
    return false;
  }
  return seekTargets(db, job, budget, [["R", "record"], ["S", "source"]], true, (c.seek ??= { k: 0, at: null, after: 0 }));
}

// ---- bindings: evaluation and review bindings that copied ended evidence, one page of each subject's rows by id
function bindingsStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { k: 0, after: "" });
  const n = chunk(budget);
  if (c.k >= EVOLUTION_BINDING_SUBJECTS.length) return true;
  const rows = st(db, "SELECT id,subject_id,state,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? AND id>? ORDER BY id LIMIT ?").all(EVOLUTION_BINDING_SUBJECTS[c.k]!, c.after, n);
  for (const row of rows) purgeEvolutionBinding(db, row);
  spend(budget, rows.length);
  if (rows.length === n) c.after = String(rows[rows.length - 1]!.id); else { c.k++; c.after = ""; }
  return false;
}

// ---- learning: what was learned from the ended sources (and a deleted conversation, and the owner's excluded threads)
function learningStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { cursor: newLearningPurgeCursor(), threads: [...new Set([...(job.threads ?? []), ...excludedThreads(db)])] });
  const threads = new Set<string>(c.threads);
  const lookup: LearningLookup = {
    source: id => hasTarget(db, job, "s", id),
    message: id => hasTarget(db, job, "m", id),
    thread: id => threads.has(id),
  };
  const cursor = c.cursor as LearningPurgeCursor;
  const before = cursor.read ?? 0;
  const done = purgeLearningStep(db, lookup, cursor, chunk(budget));
  spend(budget, (cursor.read ?? 0) - before);
  return done;
}
/** The threads the owner excluded from learning (one settings row): every forget expires what was learned in them, as the
 * installation-wide pass does. */
function excludedThreads(db: DatabaseSync): string[] {
  try { return st(db, "SELECT e.value AS id FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' LIMIT 1024").all().map(row => String(row.id)); }
  catch { return []; }
}

// ---- records-scan: a records revocation while the index is not ready (archive, correct, supersede ...), in rowid windows
function recordsScanStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { after: 0, end: Number(st(db, "SELECT max(rowid) AS m FROM memory_disclosures").get()?.m ?? 0) });
  const rec = job.rec!;
  const hi = Math.min(c.end, c.after + chunk(budget));
  // one record's tombstone (applyRecordTombstone) keeps its own (id, version) closure; any other records revocation the id-level one
  job.revoked = (job.revoked ?? 0) + Number((rec.tombstoneOf !== undefined
    ? st(db, `${RECORD_TOMBSTONE_AFFECTED} ${RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL} AND memory_disclosures.rowid>?2 AND memory_disclosures.rowid<=?3`).run(rec.tombstoneOf, c.after, hi)
    : st(db, `${RECORD_REVOCATION_SCAN_SQL} AND memory_disclosures.rowid>?4 AND memory_disclosures.rowid<=?5`).run(JSON.stringify(rec.recordIds), JSON.stringify(rec.sourceIds), rec.via, c.after, hi)).changes);
  spend(budget, hi - c.after);
  c.after = hi;
  return hi >= c.end;
}

// ---- all: legacy global receipt cleanup, a page of bundle ids at a time; the policy
// revision moved in the commit, so readers already refuse them, and a receipt made since (a later epoch) is not touched
function allStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  // Older bot jobs already walked scope -> expand -> receipts. Keep that scoped result on restart as well.
  if (job.cause === "bot-deletion") return true;
  const c = (job.c ??= { after: null }) as { after: string | null };
  const n = chunk(budget);
  return bundlePage(db, c, n, (after, end) => Number(st(db, "UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND deletion_epoch<?3 AND bundle_id>?1 AND bundle_id<=?2").run(after, end, Number(job.epoch ?? 0)).changes), job, budget);
}

// ---- done: the job's target rows go, a page at a time
function doneStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  // the first page in key order, then a primary-key range delete up to its last key (the page is what is left at the front)
  const n = chunk(budget);
  const page = st(db, "SELECT kind,id,rev FROM memory_revocation_targets WHERE job_id=? ORDER BY kind,id,rev LIMIT ?").all(job.id, n);
  // Recall consumer owner: c3-memory-side; derived projection producer: recall-scope.
  // A retained or revoked view is still deletion debt. Drain its words before dropping
  // the durable record target; ordinary view upkeep cannot admit a revoked generation.
  if (hasTable(db, "memory_recall_view_terms")) for (const target of page) {
    if (target.kind !== "terms") continue;
    const removed = Number(st(db, `DELETE FROM memory_recall_view_terms
      WHERE (record_id,version,view_id,generation,term,sequence) IN (
        SELECT record_id,version,view_id,generation,term,sequence FROM memory_recall_view_terms
        WHERE record_id=? AND version=? ORDER BY view_id,generation,term,sequence LIMIT ?)`)
      .run(target.id, target.rev, n).changes);
    if (removed) { spend(budget, page.length + removed); return false; }
  }
  spend(budget, page.length);
  if (!page.length) return true;
  const last = page[page.length - 1]!;
  st(db, "DELETE FROM memory_revocation_targets WHERE job_id=? AND (kind,id,rev)<=(?,?,?)").run(job.id, last.kind, last.id, last.rev);
  return page.length < n;
}

/** supersede: removed from this build, still persisted by the earlier RC (phases ["supersede","done"]). Completed by marking the notebook links
 * for a fresh look (their stored hash is cleared, so the next sync reads each notebook again), then the job advances to its done phase. */
function supersedeStep(db: DatabaseSync, _job: RevocationJob, budget: Budget): boolean {
  const rows = st(db, "SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='notebook-link' AND state='granted'").all();
  for (const row of rows) {
    try {
      const link = JSON.parse(String(row.intent)) as Record<string, unknown>;
      if (link.hash === "" && link.checkedAt === 0) continue;
      st(db, "UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ ...link, hash: "", checkedAt: 0 }), String(row.id));
    } catch { /* an unreadable link is the sync's to report */ }
  }
  spend(budget, rows.length);
  return true;
}
/** This build's own walk of every deleted conversation and deleted bot a job it cannot run names (an unknown phase, or a format it cannot
 * read): new job rows with only phases this build knows, so the walk cannot recurse. Only deletions the deny table records are walked
 * (a thread the owner merely excluded has no thread deny row). Caller's transaction. */
function rewalkDeletions(db: DatabaseSync, named: Partial<RevocationJob> | null): void {
  if (!named || typeof named !== "object" || !hasTable(db, "memory_deny")) return;
  const denied = (kind: string, id: unknown): id is string => typeof id === "string" && Boolean(st(db, "SELECT 1 FROM memory_deny WHERE kind=? AND id=?").get(kind, id));
  const epoch = Number(st(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  for (const thread of new Set([named.thread, ...list(named.threads)].filter(id => denied("thread", id)) as string[])) {
    const job = forgetJob({ epoch, thread, threads: [thread], cause: "thread-deletion" });
    job.phases.unshift("thread");
    createRevocationJob(db, job);
  }
  const scopes = [...new Set(list(named.scopes).filter(id => denied("scope", id)) as string[])];
  if (scopes.length) {
    const job = forgetJob({ epoch, scopes, cause: "bot-deletion" });
    job.phases.unshift("scope");
    createRevocationJob(db, job);
  }
}

/** What a job this build cannot run as written still owes from its own target rows (memdel r2 High #1): a deleted conversation's message
 * ids (its messages are gone, so only these rows name them for the learning purge), the sources and records it ended, a records
 * revocation's ids. Each phase here reads only the job's targets and fields every job may lack, so the targets are drained under the
 * job's own id, then `done` drops them. Kept in this build's order, with the phases the job already had. */
const CARRY_PHASES: readonly Phase[] = ["bring-in", "pip", "expand", "receipts", "refs", "sourcework", "bindings", "learning", "done"];
const PHASE_ORDER: readonly Phase[] = ["supporting", "imports", "thread", "scope", "bring-in", "pip", "expand", "receipts", "refs", "records-scan", "bindings", "learning", "all", "sourcework", "supersede", "done"];
const carryPhases = (known: readonly Phase[]): Phase[] => { const want = new Set([...known, ...CARRY_PHASES]); return PHASE_ORDER.filter(phase => want.has(phase)); };
const hasAnyTarget = (db: DatabaseSync, jobId: string) => Boolean(st(db, "SELECT 1 FROM memory_revocation_targets WHERE job_id=? LIMIT 1").get(jobId));

const STEPS: Record<Phase, (db: DatabaseSync, job: RevocationJob, budget: Budget) => boolean> = {
  supporting: supportingStep, imports: importsStep, thread: threadStep, scope: scopeStep, "bring-in": bringInStep, pip: pipStep,
  expand: expandStep, receipts: receiptsStep, refs: refsStep, bindings: bindingsStep, learning: learningStep,
  "records-scan": recordsScanStep, all: allStep, sourcework: sourceWorkStep, supersede: supersedeStep, done: doneStep,
};

/** Runs a just-made job for a small budget inside the caller's transaction (a small one finishes here), keeping the row for what
 * is left. True when work is left for the runner (the caller's commit wakes it: wakeIfStarted). */
export function startRevocationJob(db: DatabaseSync, job: RevocationJob, inline: { rows: number; ms: number }): boolean {
  if (advanceRevocationJob(db, job, inline.rows, inline.ms)) return false;
  if (createRevocationJob(db, job)) { wakeIfStarted(); return true; }
  advanceRevocationJob(db, job, Number.MAX_SAFE_INTEGER); // no scope to hold the row: nothing of size to do
  return false;
}
/** A records revocation that would have scanned every receipt (index not ready): a bounded window here, a durable job for the rest.
 * Null when there is no scope to hold the row (then there is no receipt of size either: the caller scans). */
export function deferRecordsScan(db: DatabaseSync, rec: NonNullable<RevocationJob["rec"]>): { revoked: number; deferred: boolean } | null {
  const job: RevocationJob = { v: 2, id: randomUUID(), phases: ["records-scan"], c: null, rec };
  let revoked = 0;
  const budget: Budget = { rows: INLINE_REVOCATION.rows, deadline: performance.now() + INLINE_REVOCATION.ms, projections: [] };
  while (job.phases.length && !exhausted(budget)) { if (recordsScanStep(db, job, budget)) { job.phases.shift(); job.c = null; } }
  revoked += job.revoked ?? 0; job.revoked = 0;
  if (!job.phases.length) return { revoked, deferred: false };
  if (!createRevocationJob(db, job)) return null;
  wakeIfStarted();
  return { revoked, deferred: true };
}
/** A records revocation through the index (archive, correct, supersede ...): the affected record ids (each record derived from one,
 * transitively) and source ids are targets; the receipts citing any of them flip, INLINE_REVOCATION here and the rest in the job. */
export function revokeRecordsBounded(db: DatabaseSync, cause: string, recordIds: readonly string[], sourceIds: readonly string[], via: boolean, revokeId?: number): number {
  const job: RevocationJob = { v: 2, id: randomUUID(), phases: ["refs", "done"], c: null, via: via ? 1 : 0, cause, ...(revokeId ? { revokeId } : {}) };
  for (const id of recordIds) addTarget(db, job, "Rq", id);
  for (const id of sourceIds) addTarget(db, job, "S", id);
  const finished = advanceRevocationJob(db, job, INLINE_REVOCATION.rows, INLINE_REVOCATION.ms);
  const revoked = (job.total ?? 0) + (job.revoked ?? 0);
  // both counters are returned here: a job row that kept either would count these receipts again when it finishes
  job.total = 0; job.revoked = 0;
  if (!finished && !createRevocationJob(db, job)) advanceRevocationJob(db, job, Number.MAX_SAFE_INTEGER);
  else if (!finished) wakeIfStarted();
  return revoked;
}
/** Inline budget of a request: a few hundred candidate rows, a few milliseconds. */
export const INLINE_REVOCATION = { rows: 256, ms: 8 };

// ---- late builders: memory_evidence_by_source and memory_source_origins, filled for rows older than their triggers, a primary-key
// window at a time (VACUUM-safe), whenever no job row waits
const LATE_BUILDS: Array<{ name: "evidence" | "origins"; page: (after: unknown[] | null, n: number) => [string, unknown[]] }> = [
  { name: "evidence", page: (after, n) => [after
    ? "SELECT record_id,record_version,source_id,source_revision,start_byte FROM memory_evidence WHERE (record_id,record_version,source_id,source_revision,start_byte)>(?,?,?,?,?) ORDER BY record_id,record_version,source_id,source_revision,start_byte LIMIT ?"
    : "SELECT record_id,record_version,source_id,source_revision,start_byte FROM memory_evidence ORDER BY record_id,record_version,source_id,source_revision,start_byte LIMIT ?", after ? [...after, n] : [n]] },
  { name: "origins", page: (after, n) => [after
    ? "SELECT source_id,revision,payload FROM memory_source_versions WHERE source_id<'bring-in;' AND (source_id,revision)>(?,?) ORDER BY source_id,revision LIMIT ?"
    : "SELECT source_id,revision,payload FROM memory_source_versions WHERE source_id>'bring-in:' AND source_id<'bring-in;' ORDER BY source_id,revision LIMIT ?", after ? [...after, n] : [n]] },
];
/** One window of the first unfinished late build. False when every build is ready (or the file has none). */
export function lateBuildStep(db: DatabaseSync, rows: number): boolean {
  let state: Array<{ name: string; ready: number; cursor: string | null }>;
  try { state = st(db, "SELECT name,ready,cursor FROM memory_late_build ORDER BY name").all() as typeof state; } catch { return false; }
  const build = LATE_BUILDS.find(b => state.some(s => s.name === b.name && Number(s.ready) === 0));
  if (!build) return false;
  const row = state.find(s => s.name === build.name)!;
  const after = row.cursor ? JSON.parse(row.cursor) as unknown[] : null;
  const n = Math.max(1, Math.min(STEP_CHUNK * 4, rows));
  const [sql, args] = build.page(after, n);
  const page = st(db, sql).all(...args as never[]);
  if (build.name === "evidence") {
    const insert = st(db, "INSERT OR IGNORE INTO memory_evidence_by_source VALUES(?,?,?,?,?)");
    for (const e of page) insert.run(e.source_id, e.source_revision, e.record_id, e.record_version, e.start_byte);
  } else {
    const insert = st(db, "INSERT OR IGNORE INTO memory_source_origins SELECT json_extract(j.value,'$.id'),? FROM json_each(?,'$.broughtFrom.sources') j WHERE json_type(j.value,'$.id')='text'");
    for (const v of page) { try { if (st(db, "SELECT json_type(?,'$.broughtFrom.sources') AS t").get(v.payload)?.t === "array") insert.run(v.source_id, v.payload); } catch { /* not json: no origins */ } }
  }
  const last = page[page.length - 1];
  const cursor = last ? JSON.stringify(build.name === "evidence" ? [last.record_id, last.record_version, last.source_id, last.source_revision, last.start_byte] : [last.source_id, last.revision]) : row.cursor;
  st(db, "UPDATE memory_late_build SET ready=?,cursor=? WHERE name=?").run(page.length < n ? 1 : 0, cursor, build.name);
  return true;
}
/** Whether any revocation work is waiting (a job row, or a late build): a start-up VACUUM waits for it (rowid cursors). */
export function revocationWorkPending(db: DatabaseSync): boolean {
  try { return markerWorkPending(db) || Boolean(st(db, `SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='${REVOCATION_JOB_SUBJECT}' AND state IN ('granted','revoked') LIMIT 1`).get()); }
  catch { return false; }
}

// ---- the runner: one job at a time, oldest first, in timed slices with the loop handed back between them
export const REVOCATION_SLICE_MS = 8;
export const REVOCATION_MIN_PAUSE_MS = 4;
/** The pause after a slice is at least this many times the slice: the runner keeps the main thread at most a quarter busy. */
export const REVOCATION_PAUSE_FACTOR = 3;
export const REVOCATION_BUSY_PAUSE_MS = 250;
/** 1.0.3 (revoke storm, M3) let the marker yield to foreground turns for this long, then run one slice: with bots whose turns never stop
 * (a routine every few seconds) that was one slice every 10 s, the walks took days, and every line under their windows read "checking"
 * for as long (SELF-OVERLOAD-105 item 1c). The marker now trickles under a live turn instead: a half slice every busy pause (see tick). The
 * constant stays for callers; nothing reads it here. */
export const REVOCATION_MAX_YIELD_MS = 10_000;
/** Under a live turn the marker's slice is this fraction of the normal one, once every busyPauseMs (250 ms): about 1.6% of a core. */
export const REVOCATION_LIVE_SLICE_FRACTION = 0.5;
const START_ROWS = 64, MIN_ROWS = 8, MAX_ROWS = 4096, LOCK_RETRY_MS = 1000, RETRY_CAP_MS = 60_000;
export type RevocationRunnerOptions = { admit?: () => Promise<void>; busy?: () => boolean; sliceMs?: number; pauseMs?: number; busyPauseMs?: number; retryMs?: number };
/** maxSliceMs is the whole slice, its COMMIT included (on a file database that can carry SQLite's WAL auto-checkpoint, a disk cost
 * every writer shares); maxWorkMs is this module's own work in a slice, before the COMMIT. */
export const memoryRevocationStats = { slices: 0, maxSliceMs: 0, maxWorkMs: 0, busyPauses: 0, errorRetries: 0, lockedRetries: 0, workMs: 0, pauseMs: 0, maxJobBytes: 0, lateSlices: 0, markerSlices: 0, budgetWaits: 0, markerYields: 0, floorSlices: 0, jobBackoffs: 0, quarantined: 0, storageParks: 0, storageResets: 0, parkedNow: 0, idlePauses: 0, idleClosingSlices: 0, idleClosingWaits: 0, liveClosingWaits: 0, orphanPendingCleared: 0 };
// 1.0.22 fix1022-revoke-ioerr: a storage failure (SQLITE_IOERR, _CORRUPT, _NOTADB: "disk I/O error") is not a lock: a retry on the same
// connection meets it again. 1.0.21 retried it forever (70+ "trying again" lines in the field), and the job row it could not end held every
// chat's memory at checking:pending. After REVOKE_STORAGE_PARK_AFTER failures in a row the runner parks: the job row stays (its holds stay,
// fail closed; no owner data is touched) and it is reset at most REVOKE_STORAGE_SELF_RESETS times a process, REVOKE_STORAGE_RESET_MS apart,
// or by the start at listen / the owner's Forget (wakeMemoryRevocation resume). Any other wake (a turn's fence wait, wakeIfStarted, the bus) never unparks it.
export const REVOKE_STORAGE_PARK_AFTER = 5, REVOKE_STORAGE_SELF_RESETS = 3, REVOKE_STORAGE_RESET_MS = 5 * 60_000;
// 1.0.22 revokehealth: past the self resets the park was +Infinity (until a restart or a Forget, told to the console only). Each later reset
// now waits twice the one before, up to REVOKE_STORAGE_RESET_CAP_MS, and while parked the owner is told (revokeHealthNotices). The holds stay.
export const REVOKE_STORAGE_RESET_CAP_MS = 6 * 60 * 60_000;
const STORAGE_CODES = new Set([10, 11, 26]);
export function revokeStorageError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number" && STORAGE_CODES.has(code & 0xff)) return true;
  return /disk I\/O error|file is not a database|database disk image is malformed/.test(error instanceof Error ? error.message : String(error));
}
let storageFailures = 0, parked = false, parkResetAt = Number.POSITIVE_INFINITY, selfResets = 0;
function unpark(): void { if (!parked) return; parked = false; parkResetAt = Number.POSITIVE_INFINITY; storageFailures = 0; memoryRevocationStats.parkedNow = 0; memoryRevocationStats.storageResets++; }
let getDbRef: (() => DatabaseSync) | null = null, options: RevocationRunnerOptions = {};
/** What the owner is told about forgetting that cannot finish (GET /api/deletions/owed, beside the deletion lines). Fixed words, no error text. */
export interface RevokeHealthNotice { id: string; text: string; tryAgain: false; covers: string[] }
export function revokeHealthNotices(db: DatabaseSync | null): RevokeHealthNotice[] {
  const out: RevokeHealthNotice[] = [];
  if (parked) out.push({ id: "revoke:storage", text: "Murage can't finish forgetting right now because it can't write to its storage. What you asked it to forget stays hidden, and Murage keeps trying by itself.", tryAgain: false, covers: [] });
  let n = 0;
  try { n = db ? quarantinedRevokeCount(db) : 0; } catch { /* a file without revoke jobs */ }
  if (n) out.push({ id: "revoke:quarantined", text: `Murage couldn't finish forgetting ${n === 1 ? "one item" : `${n} items`}. ${n === 1 ? "It stays" : "They stay"} hidden from your bots, and nothing comes back.`, tryAgain: false, covers: [] });
  return out;
}
// 1.0.22 revokehealth: a bookkeeping row (memory_scope_bindings, run oldest first) whose step throws was the next tick's row again, so every
// row behind it waited, and the holds waiting on those. It now sits out its own backoff (JOB_BACKOFF, as V10's marker jobs) while the rows
// behind it run. Process state only: cleared by the row's first step that does not throw; a restart tries every row again.
const rowBackoff = new WeakMap<DatabaseSync, Map<string, { until: number; delay: number }>>();
let rowFailures = 0;
function rowsHeldDue(db: DatabaseSync): number {
  const map = rowBackoff.get(db), now = Date.now();
  let due = Number.POSITIVE_INFINITY;
  if (map) for (const held of map.values()) if (held.until > now) due = Math.min(due, held.until);
  return due;
}
/** Quarantines, in a transaction of its own (the failed slice rolled back), every marker job that failed JOB_QUARANTINE_AFTER times in a row.
 * One that cannot be written now is tried again at that job's next failure. */
function quarantineNow(): void {
  let db: DatabaseSync;
  try { db = getDbRef!(); } catch { return; }
  if (db.isTransaction) return;
  try {
    beginBackground(db, "revocation-job");
    let ids: number[];
    try { ids = quarantineFailingJobs(db); db.exec("COMMIT"); } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    if (ids.length) { memoryRevocationStats.quarantined += ids.length; console.warn(`[memory] revocation job: quarantined ${ids.join(",")} after repeated failures; what it covers reads withheld (the owner is told)`); }
  } catch { /* tried again at the job's next failure */ }
}
// MAIN-RULING REVOKEHEALTH-1022: the start at listen (the wake that passes options) puts back, once per connection, every job an older
// version quarantined (revoke-marker.ts retryQuarantinedOnNewVersion: the stamp is the once-per-version guard, across restarts). A write that
// fails here leaves them quarantined (fail closed).
function retryQuarantinedAtStart(getDb: () => DatabaseSync): void {
  startRecomputeOwed = false;
  try {
    const db = getDb();
    const version = runningAppVersion();
    // an unreadable version retries nothing, but the start still recomputes the quarantine low-water mark (revoke-marker.ts
    // refreshQuarantineLow, inside retryQuarantinedOnNewVersion): a file whose quarantined jobs have no stored mark gets one here
    if (db.isTransaction) throw new Error("a transaction is open");
    beginBackground(db, "revocation-job");
    let ids: number[];
    try { ids = retryQuarantinedOnNewVersion(db, version); db.exec("COMMIT"); } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    quarantineLowTrust.unproven = false;
    if (ids.length) console.warn(`[memory] revocation job: retrying ${ids.join(",")} once on this version (quarantined by an older one)`);
  } catch {
    // 1.0.23 scalefin2 (Astra a482cd6d07 High): a start pass that could not run (busy file, open transaction, no handle yet) is owed, not
    // dropped: the jobs stay quarantined and, until the pass lands, the readers do not trust the stored mark (quarantineLowTrust: a key
    // past the limit is withheld from lsn 0, fail closed). It is tried again on an unref'd timer of its own, never from a wake: a turn's
    // wake (settleRevokesForTurn) must not run the pass, whose work is one seek per quarantined job (Astra c94532778f High).
    startRecomputeOwed = true; quarantineLowTrust.unproven = true;
    if (!startRecomputeTimer) {
      startRecomputeTimer = setTimeout(() => { startRecomputeTimer = undefined; if (startRecomputeOwed && !stopped && getDbRef) retryQuarantinedAtStart(getDbRef); }, options.retryMs ?? START_RECOMPUTE_RETRY_MS);
      startRecomputeTimer.unref?.();
    }
  }
}
let startRecomputeOwed = false, startRecomputeTimer: ReturnType<typeof setTimeout> | undefined;
const START_RECOMPUTE_RETRY_MS = 1_000;
function chargeRow(db: DatabaseSync, id: string): void {
  let map = rowBackoff.get(db);
  if (!map) rowBackoff.set(db, map = new Map());
  const delay = Math.min(JOB_BACKOFF.capMs, map.has(id) ? map.get(id)!.delay * 2 : JOB_BACKOFF.firstMs);
  map.set(id, { until: Date.now() + delay, delay });
  rowFailures++;
}
let running = false, stopped = false, rowsPerSlice = START_ROWS, backoff = LOCK_RETRY_MS, idleWaiters: Array<() => void> = [];

/** Next slice size: grow while well inside the budget, halve at once when a slice came near it. */
export function nextRevocationRows(rows: number, ms: number, budget: number): number {
  const next = ms <= budget / 4 ? rows * 2 : ms > budget / 2 ? Math.floor(rows / 2) : rows;
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, next));
}
const wakeAll = () => { for (const wake of idleWaiters.splice(0)) wake(); };
/** Told when the runner has no more work (every revoke's marker walked): a held reply may now settle (server/held-replies.ts). */
let idleHook: (() => void) | null = null;
export function onRevocationIdle(hook: (() => void) | null): void { idleHook = hook; }
const ranOut = () => {
  // Source payloads and learning text can be removed after the chat's deletion
  // journal has completed. Scrub those later commits independently; a held log
  // remains owed to wal-maintenance and never holds up the next deletion.
  void scrubWalAfterDelete().catch(() => {});
  try { idleHook?.(); } catch (error) { console.warn(`[memory] revocation idle hook: ${error instanceof Error ? error.message : String(error)}`); }
};
// ---- MEMORY V2 (lane C, slice pace): the runner has no timer of its own and never polls. It runs on the `revoke` wake (revoke-wake.ts, the
// shim of lane W's bus) and, when it stops with work left (the pace is spent, a turn is live, a slice is over, a job sits out a backoff),
// arms ONE deadline for when that gate reopens. With nothing queued it holds no deadline at all.
export const RUNNER_WAKE = "revoke";
/** Bumped by every in-process site that queues revoke work (wakeIfStarted: revoke-commit.ts, the receipt flip wake). An empty queue is
 * remembered against it, so a bus wake that follows no such write costs 0 statements. */
export const QUEUE_VERSION = "revoke-queue";
let offRunnerWake: (() => void) | null = null;
/** `gateWait`: the armed deadline waits for a ledger, not for a pause: new closing work or a waiter may bring it forward. */
let ticking = false, gateWait = false, firstTick = true;
/** The queue found empty by the runner's own read, on this handle, at this queue version (null: not known). */
let emptyAt: { db: DatabaseSync; version: number } | null = null;
/** V8, in memory: whether a pending row stands (closing work). Read by one O(1) probe when a wake fires and again every
 * CLOSING_REPROBE_SLICES slices or after a slice that moved nothing; never a count, never per tick. */
let closing = false, closingStale = true, sinceClosingProbe = 0;
const CLOSING_REPROBE_SLICES = 64;
/** H1 (q1022-closing-batch): orphan pending rows (no job row) are cleared at the start at listen (the first resume wake on a handle) and
 * whenever the closing probe finds one (a job's tidy or prune left it). Found by one read first: no write lock is taken for nothing. */
let orphanSweep = true, sweptDb: DatabaseSync | null = null, orphanLookOwed = false;
const ORPHAN_SWEEP_ROWS = 256, ORPHAN_SWEEP_PAGES = 64;
const ORPHAN_SQL = "SELECT 1 FROM memory_deny_pending p WHERE NOT EXISTS (SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=p.revoke_id) UNION ALL SELECT 1 FROM memory_deny_pending_scope p WHERE NOT EXISTS (SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=p.revoke_id) LIMIT 1";
function orphanPendingStands(db: DatabaseSync): boolean {
  try { return Boolean(st(db, ORPHAN_SQL).get()); } catch { return false; }
}
/** One bounded sweep in its own background transaction, outside the runner's slice; more left: it runs again next tick. */
function sweepOrphanPending(db: DatabaseSync): void {
  if (!orphanPendingStands(db)) { orphanSweep = false; sweptDb = db; return; }
  try {
    // a busy start throws here: the catch keeps the sweep owed, and the runner's lock retry runs it again (Astra 925dd58881 High)
    beginBackground(db, "revocation-job");
    // page after page in this one transaction, so the closing probe after it reads the truth (at most ORPHAN_SWEEP_PAGES pages)
    let gone = 0, page = ORPHAN_SWEEP_ROWS;
    for (let i = 0; i < ORPHAN_SWEEP_PAGES && page >= ORPHAN_SWEEP_ROWS; i++) { page = clearOrphanPending(db, ORPHAN_SWEEP_ROWS); gone += page; }
    db.exec("COMMIT");
    orphanSweep = false; sweptDb = db;
    if (gone > 0) { memoryRevocationStats.orphanPendingCleared += gone; closingStale = true; console.warn(`[memory] revocation: cleared ${gone} pending row(s) whose revoke job no longer exists`); }
    if (page >= ORPHAN_SWEEP_ROWS) orphanSweep = true;
  } catch (error) { orphanSweep = true; if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } throw error; }
}
function pendingRowStands(db: DatabaseSync): boolean {
  try { return Boolean(st(db, "SELECT 1 FROM memory_deny_pending LIMIT 1").get()) || Boolean(st(db, "SELECT 1 FROM memory_deny_pending_scope LIMIT 1").get()); }
  catch { return false; }
}
function onRunnerWake(): void {
  if (stopped || !getDbRef) return;
  // parked on a storage failure: only its own reset deadline (bounded) unparks it here; a commit's bus wake does not
  if (parked) { if (Date.now() < parkResetAt) return; unpark(); startRun(); return; }
  // a running runner ticks at its own deadline (its pause is the main thread's 75%); a wake while one is armed changes nothing
  if (running) { if (!ticking && !wakeProbe.armed(RUNNER_WAKE)) void tick(); return; }
  try { if (emptyAt && emptyAt.version === memoVersion(QUEUE_VERSION) && emptyAt.db === getDbRef()) return; } catch { return; }
  startRun();
}
function startRun(): void {
  running = true; firstTick = true; closingStale = true; rowsPerSlice = START_ROWS; backoff = options.retryMs ?? LOCK_RETRY_MS; storageFailures = 0; schedule(0);
}
const schedule = (delay: number, gate = false) => {
  memoryRevocationStats.pauseMs += delay; gateWait = gate;
  offRunnerWake ??= onWake(RUNNER_WAKE, onRunnerWake);
  armDeadline(RUNNER_WAKE, Date.now() + delay);
};
/** Granted rows, and rows an earlier build parked as 'revoked' (they finish here like any other: MEMDEL-SIMPLIFY-109). */
const NEXT_JOB = `SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='${REVOCATION_JOB_SUBJECT}' AND state IN ('granted','revoked') ORDER BY rowid LIMIT 1`;
const NEXT_JOBS = `SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='${REVOCATION_JOB_SUBJECT}' AND state IN ('granted','revoked') ORDER BY rowid LIMIT ?`;
/** The oldest row not sitting out a backoff (undefined: none may run now). Reads at most one row past the ones held. */
function nextJobRow(db: DatabaseSync): Record<string, unknown> | undefined {
  const map = rowBackoff.get(db);
  if (!map?.size) return st(db, NEXT_JOB).get();
  const now = Date.now();
  return st(db, NEXT_JOBS).all(map.size + 1).find(row => { const held = map.get(String(row.id)); return held === undefined || held.until <= now; });
}
/** One step of one job row (caller's transaction); `done` when the row is finished and gone. A row in a format this build cannot read
 * is replaced by this build's walk of the deletions it names, then deleted. Never parked: every row runs until it ends. */
function stepJobRow(db: DatabaseSync, row: Record<string, unknown>, rows: number, ms = Number.POSITIVE_INFINITY): { done: boolean; job: RevocationJob | null } {
  let job: RevocationJob | null = null;
  try { job = JSON.parse(String(row.intent)) as RevocationJob; } catch { /* unreadable: replaced below */ }
  if (!job || job.v !== 2 || !Array.isArray(job.phases)) {
    warnRevocationJobOnce(db, String(row.id), "[memory] revocation job unreadable; its deletions are walked again by this build");
    rewalkDeletions(db, job);
    // the targets it collected are keyed by its own id (the row's, or the one it names): the row becomes this build's drain of them, in
    // place, so a deleted conversation's message ids still reach the learning purge (memdel r2 High #1)
    const own = String(row.id).startsWith(`${REVOCATION_JOB_SUBJECT}:`) ? String(row.id).slice(REVOCATION_JOB_SUBJECT.length + 1) : null;
    const carried = [typeof (job as { id?: unknown } | null)?.id === "string" ? String((job as { id: string }).id) : null, own].find(id => id !== null && hasAnyTarget(db, id));
    if (carried) {
      const drain: RevocationJob = { v: 2, id: carried, phases: carryPhases([]), c: null, cause: "carried-targets" };
      st(db, "UPDATE memory_scope_bindings SET intent=?,state='granted' WHERE id=?").run(JSON.stringify(drain), String(row.id));
      return { done: false, job: drain };
    }
  } else if (!advanceRevocationJob(db, job, rows, ms)) {
    const intent = JSON.stringify(job);
    memoryRevocationStats.maxJobBytes = Math.max(memoryRevocationStats.maxJobBytes, intent.length);
    st(db, "UPDATE memory_scope_bindings SET intent=?,state='granted' WHERE id=?").run(intent, String(row.id));
    return { done: false, job };
  }
  st(db, "DELETE FROM memory_scope_bindings WHERE id=?").run(String(row.id));
  return { done: true, job };
}

// 1.0.22 deep1022: the runner is nobody's background slice. Its wake is a microtask of the committing writer (wakeIfStarted) and its
// deadline a timer armed from there (revoke-wake.ts), so Node ran every later tick inside that writer's io-budget store: woken by a memory
// worker's commit the runner WAS "memory-worker" from then on, its writes met the background byte gate, and after one refused write of that
// slice (the store's sticky `deferred`) every tick threw BG_DEFERRED ("revocation job: BG_DEFERRED; trying again", 105 times in the field)
// while its '*' windows held every chat at checking:pending. A tick, and every deadline it arms, runs under no source: the runner is paced
// by its own ledger alone (revoke-budget.ts), whoever woke it.
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try { await ioBudget.withoutSource(tickOnce); } finally { ticking = false; }
}
async function tickOnce(): Promise<void> {
  if (stopped || !getDbRef) { running = false; wakeAll(); return; }
  const failuresBefore = revokeJobFailures() + rowFailures;
  try {
    if (options.admit) await options.admit();
    if (stopped) { running = false; wakeAll(); return; }
    const db = getDbRef();
    // a resuming wake (wakeMemoryRevocation): a handle this runner has not swept yet owes the orphan sweep (H1)
    if (orphanLookOwed) { orphanLookOwed = false; if (sweptDb !== db) orphanSweep = true; }
    // the first tick after a wake: a queue with nothing in it is found by a few point reads, with no write lock taken, and remembered
    if (firstTick) {
      firstTick = false;
      let none = false;
      // strict reads: one that throws proves nothing, and the tick below goes on as it always did
      try {
        none = !db.isTransaction && !markerWorkPending(db) && !st(db, NEXT_JOB).get() && !(orphanSweep && orphanPendingStands(db));
        if (none) { try { none = !st(db, "SELECT 1 FROM memory_late_build WHERE ready=0 LIMIT 1").get(); } catch { /* a file with no late builds */ } }
      } catch { none = false; }
      if (none) {
        orphanSweep = false; sweptDb = db; // the read above found no orphan on this handle
        emptyAt = { db, version: memoVersion(QUEUE_VERSION) };
        running = false; noteRevokeClosing(false); noteRevocationQueueEmpty(); wakeAll(); ranOut(); return;
      }
    }
    // the marker walks inside its write budget (revoke-budget.ts); under a live foreground turn it trickles (a half slice every busy pause)
    // rather than stopping: a window the walk holds open reads "checking" to every turn until the walk is done (SELF-OVERLOAD-105 item 1c)
    // 1.0.20 checkfix-n4: a turn waiting on a checking:pending fence (fence-pending.ts) waits for exactly this walk, so the walk is not
    // slowed for that turn (it slowed itself: every owner turn met a window the trickle had not closed, recall withheld). The pace still holds.
    const turnLive = options.busy?.() === true; // read once a tick
    const live = turnLive && fenceWaiters === 0;
    let marker = false;
    // MEMORY V2 V8: closing work (a pending row stands: a reader is held under it) is not paced per minute; its minute is the write budget,
    // turn or no turn. V14: while a turn waits on a window the runner has the full ledger too. Only tidy and prune keep the idle pace.
    if (orphanSweep && !db.isTransaction) sweepOrphanPending(db);
    if (closingStale || sinceClosingProbe >= CLOSING_REPROBE_SLICES) {
      closing = pendingRowStands(db); closingStale = false; sinceClosingProbe = 0;
      // a pending row with no job row (H1): the next tick sweeps it before it reads closing again
      if (closing && orphanPendingStands(db)) { orphanSweep = true; closingStale = true; }
    }
    const closingNow = closing || fenceWaiters > 0;
    // one look at the idle verdict a tick (io-budget.ts idleQuiet), as before for non-closing work; closing work under a live turn never asks
    const quiet = (!closingNow || !turnLive) && ioBudget.idleQuiet();
    // idle DO LESS (io-budget.ts idleQuiet): on an idle minute only closing work writes; tidy, prune and late builds wait for the next minute
    if (!closingNow && quiet) { noteRevokeClosing(false); memoryRevocationStats.idlePauses++; closingStale = true; schedule(Math.max(1, ioBudget.nextAdmissionMs()), true); return; }
    // q1022-closing-batch (revoke-budget.ts REVOKE_IDLE_CLOSING): closing work on an idle minute with no live turn runs `batch` slices in
    // one transaction and pauses 3x that: the same duty and rows a minute, 1/batch of the COMMITs and of their hot-page log frames
    const batch = closingNow && !turnLive && fenceWaiters === 0 && quiet ? Math.max(1, Math.floor(REVOKE_IDLE_CLOSING.batch)) : 1;
    // `waited`: a reader is held under this walk (a turn on a window, fence-pending.ts)
    noteRevokeClosing(closingNow, batch > 1, fenceWaiters > 0);
    // CLOSING-1022 (revoke-budget.ts revokeIdleClosingWaitMs): idle closing work waits for its wall-clock byte budget. A ledger wait (gate):
    // every wake (any commit on the handle, a turn's or a waiter's) ticks again at once, and a live turn or a waiter is never paced here
    if (batch > 1) {
      const paceIdle = revokeIdleClosingWaitMs();
      if (paceIdle > 0) { memoryRevocationStats.idleClosingWaits++; schedule(Math.max(1, Math.ceil(paceIdle)), true); return; }
      memoryRevocationStats.idleClosingSlices++;
    } else if (closingNow && fenceWaiters === 0) {
      // q1023-leftout (revoke-budget.ts REVOKE_LIVE_CLOSING): closing work on a minute that is not idle (a turn live, or the owner between
      // two turns) with no turn waiting on a window keeps its own wall-clock byte budget: the owner's own turn reads the durable rows, so
      // this walk holds nobody and gates only its own next tick
      const paceLive = revokeClosingWaitMs();
      if (paceLive > 0) { memoryRevocationStats.liveClosingWaits++; schedule(Math.max(1, Math.ceil(paceLive)), true); return; }
    }
    // the pace (revoke-budget.ts r3.5) holds every transaction of the runner, job steps and late builds too: none starts while its minute is
    // full. V8, the floor: closing work still moves REVOKE_CLOSING_FLOOR rows a minute through a shut ledger (floorMarkerSlice).
    const paceWait = revokePaceWaitMs(revokePaceNeed(db));
    const markerPending = markerWorkPending(db);
    let floor = false;
    const floorOwed = () => closingNow && markerPending && revokeFloorRows() > 0;
    const gate = (wait: number) => { memoryRevocationStats.budgetWaits++; schedule(Math.max(1, closingNow && markerPending ? Math.min(wait, revokeFloorWaitMs()) : wait), true); };
    if (paceWait > 0) { if (floorOwed()) floor = true; else { gate(paceWait); return; } }
    if (markerPending) {
      if (!floor) {
        const wait = revokeWriteWaitMs(revokeSliceNeed(db));
        if (wait > 0) { if (floorOwed()) floor = true; else { gate(wait); return; } }
      }
      marker = true;
      if (live) memoryRevocationStats.markerYields++;
    }
    const budget = (options.sliceMs ?? REVOCATION_SLICE_MS) * (live && marker ? REVOCATION_LIVE_SLICE_FRACTION : batch), t0 = performance.now();
    let more = false, budgetWait = false, workMs = 0, floorStuck = false;
    // a background runner: the write lock is taken within the background budget, never the handle's 1 s wait (a busy start retries)
    // 1.0.22 item 1a: a job step purges source payloads and learning text: its freed pages are zeroed (secure_delete=ON, server/secure-delete.ts)
    const restoreDelete = secureDeleteOn(db);
    try { beginBackground(db, "revocation-job"); } catch (error) { restoreDelete(); throw error; }
    // the runner's own transaction: what its commit writes to the WAL is measured into the budget's cost estimate (revoke-budget.ts S2)
    const measure = beginRevokeMeasure(db);
    let moved: boolean | "budget" = false;
    // Sentinel's pending figures (health/pending-revocations.ts), applied only once this transaction commits
    let jobEnded = false, queueEmpty = false;
    try {
      // the write-time marker first: its pending rows hold lines and memory "checking" until it is done (revoke-marker.ts)
      moved = floor ? floorMarkerSlice(db, rowsPerSlice, budget, lateBuildStep) : budgetedMarkerSlice(db, rowsPerSlice, budget, lateBuildStep);
      // a ledger that shut inside the admission (the pace's own look) leaves the floor its rows, in this same transaction
      if (moved === "budget" && !floor && floorOwed()) { floor = true; moved = floorMarkerSlice(db, rowsPerSlice, budget, lateBuildStep); }
      if (floor) { memoryRevocationStats.floorSlices++; if (moved !== true) floorStuck = true; }
      const row = moved === true ? null : nextJobRow(db);
      queueEmpty = row === undefined && !Number.isFinite(rowsHeldDue(db));
      // the minute had no room for the marker (a waiting receipt flip's whole commit, revoke-budget.ts): with no job row to run either,
      // the runner wakes when the minute has room, never stops here
      if (moved === "budget" && !row) { budgetWait = true; more = true; }
      else if (row === null) { more = true; memoryRevocationStats.markerSlices++; }
      else {
        // a runner job step or a late build (r3.6, H4): its input rows are what the transaction has left of the commit cap; it is charged
        // rows x C at once and measured into the pace at the COMMIT (an input row that fans out is bounded per input row; the next step waits)
        const cap = revokePaceRows(db);
        if (cap === 0) { budgetWait = true; more = true; }
        else {
          const before = totalChanges(db);
          try {
            if (row) {
              let done: boolean;
              try { done = stepJobRow(db, row, Math.min(rowsPerSlice, cap), budget).done; } catch (error) { chargeRow(db, String(row.id)); throw error; }
              rowBackoff.get(db)?.delete(String(row.id));
              if (done) jobEnded = true;
              more = true;
            } else if (lateBuildStep(db, Math.min(rowsPerSlice, cap))) { more = true; memoryRevocationStats.lateSlices++; }
          } finally { chargeRevokeRows(db, totalChanges(db) - before); }
        }
      }
      workMs = performance.now() - t0;
      memoryRevocationStats.maxWorkMs = Math.max(memoryRevocationStats.maxWorkMs, workMs);
      db.exec("COMMIT");
      storageFailures = 0; selfResets = 0;
      // measured right after its COMMIT, before anything else runs on this thread: for the pace always (whatever it held), and into C and
      // admission only when it held the marker's slice and nothing else (a job step or a late build ran otherwise)
      endRevokeMeasure(db, measure, moved === true);
      if (queueEmpty) noteRevocationQueueEmpty(); else if (jobEnded) noteRevocationJobEnded();
    } catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } endRevokeMeasure(db, measure, false, false); throw error; }
    finally { restoreDelete(); }
    const ms = performance.now() - t0;
    sinceClosingProbe++;
    if (moved !== true) closingStale = true;
    // V14: the turns waiting now have their own threads' and scopes' rows closed as soon as the revoke has written every mark (the existing
    // closeWaitedPending site and its allowance; the waiter itself no longer polls for it)
    if (waiterTargets.size && !db.isTransaction) {
      const threads = new Set<string>(), scopes = new Set<string>();
      for (const target of waiterTargets) { for (const id of target.threads) threads.add(id); for (const id of target.scopes) scopes.add(id); }
      closeWaitedPending(db, [...threads], [...scopes]);
    }
    if (!more) {
      // V10: every job left is sitting out a failure: the deadline is the earliest backoff, never a stop with work left
      const held = rowsHeldDue(db), due = Math.min(revokeBackoffDueMs(db), held);
      const left = markerWorkPending(db) || Number.isFinite(held);
      if (left && Number.isFinite(due)) { schedule(Math.max(1, due - Date.now()), true); return; }
      // H1 (Astra 1019b50def): more orphan rows than one sweep's page: the next sweep is owed before the runner stops
      if (orphanSweep) { schedule(options.pauseMs ?? REVOCATION_MIN_PAUSE_MS); return; }
      emptyAt = left ? null : { db, version: memoVersion(QUEUE_VERSION) };
      running = false; noteRevokeClosing(false); wakeAll(); ranOut(); return;
    }
    if (budgetWait) {
      memoryRevocationStats.budgetWaits++;
      const wait = Math.max(1, revokeWriteWaitMs(revokeSliceNeed(db)));
      schedule(closingNow && !floorStuck && markerWorkPending(db) ? Math.max(1, Math.min(wait, revokeFloorWaitMs())) : wait, true); return;
    }
    memoryRevocationStats.slices++; memoryRevocationStats.workMs += ms;
    memoryRevocationStats.maxSliceMs = Math.max(memoryRevocationStats.maxSliceMs, ms);
    // Size row work against its deadline. Shrinking rows cannot reduce fixed
    // commit/checkpoint costs; it only multiplies those costs on slow storage.
    // The pause below still includes all storage time, preserving duty cycle.
    rowsPerSlice = nextRevocationRows(rowsPerSlice, workMs, budget); backoff = options.retryMs ?? LOCK_RETRY_MS;
    if (live) { if (!marker) memoryRevocationStats.busyPauses++; schedule(options.busyPauseMs ?? REVOCATION_BUSY_PAUSE_MS); }
    else schedule(Math.max(options.pauseMs ?? REVOCATION_MIN_PAUSE_MS, Math.ceil(ms * REVOCATION_PAUSE_FACTOR)));
  } catch (error) {
    // the job stays in its row: a lock is tried again shortly, anything else with a doubling delay, until it completes
    if (lockedError(error)) { memoryRevocationStats.lockedRetries++; schedule(options.retryMs ?? LOCK_RETRY_MS); return; }
    memoryRevocationStats.errorRetries++;
    const message = error instanceof Error ? error.message : String(error);
    if (revokeStorageError(error) && ++storageFailures >= REVOKE_STORAGE_PARK_AFTER) {
      parked = true; running = false; memoryRevocationStats.storageParks++; memoryRevocationStats.parkedNow = 1;
      selfResets++;
      const resetMs = Math.min(REVOKE_STORAGE_RESET_CAP_MS, REVOKE_STORAGE_RESET_MS * 2 ** Math.max(0, selfResets - REVOKE_STORAGE_SELF_RESETS));
      parkResetAt = Date.now() + resetMs; armDeadline(RUNNER_WAKE, parkResetAt);
      console.warn(`[memory] revocation job: storage failure ${storageFailures} times in a row (${message}); parked: the job stays queued and its holds stay (fail closed), tried again in ${Math.round(resetMs / 60_000)} min or at the next start`);
      noteRevokeClosing(false); wakeAll(); return;
    }
    console.warn(`[memory] revocation job: ${message}; trying again`);
    // V10: a step that threw was charged to its own job (revoke-marker.ts backoff: 1 s doubling to 60 s on the deadline registry) and the
    // selectors now pass over it, so the queue behind it goes on after an ordinary pause; only a failure no job owns backs the runner off
    if (revokeJobFailures() + rowFailures !== failuresBefore) {
      memoryRevocationStats.jobBackoffs++;
      // a marker job that failed JOB_QUARANTINE_AFTER times in a row is quarantined in a transaction of its own (revoke-marker.ts)
      quarantineNow();
      schedule(Math.max(options.pauseMs ?? REVOCATION_MIN_PAUSE_MS, REVOCATION_SLICE_MS * REVOCATION_PAUSE_FACTOR)); return; }
    schedule(backoff); backoff = Math.min(RETRY_CAP_MS, backoff * 2);
  }
}

/** Starts (or wakes) the runner over every job row and late build: at listen (resuming what a stopped process left), and after each
 * commit that wrote one. Options given here stay for the process. */
export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions, resume = next !== undefined): void {
  // parked on a storage failure: only the start at listen (it passes options), the owner's Forget (resume) or the park's own reset deadline
  // unpark it. A turn's fence wait, a delegated reply's recheck or any other wake is a no-op until then (Astra 73cbd5d493: each turn's wake
  // unparked it, so the bounded resets never bounded anything)
  if (parked && !resume && !stopped && Date.now() < parkResetAt) return;
  getDbRef = getDb; stopped = false;
  if (next) { options = { ...options, ...next }; retryQuarantinedAtStart(getDb); }
  unpark();
  // a direct wake says work may have been queued: what the runner remembered of an empty queue is dropped and its first tick looks again
  emptyAt = null; closingStale = true;
  // the handle is compared on the tick that opens it (orphanLookOwed), never read here: a wake never spends one of the getter's calls
  if (resume) orphanLookOwed = true;
  if (!running) startRun();
  // waiting on a ledger: the gate may have moved (closing work or a waiter arrived), so the wait is looked at again now
  else if (gateWait && !ticking) { gateWait = false; armDeadline(RUNNER_WAKE, Date.now()); }
}
/** Runs every job row of `db` to completion now, in the caller's transaction (offline helpers and tests). Returns the receipts revoked. */
export function runRevocationJobsNow(db: DatabaseSync): number {
  let total = 0;
  for (;;) {
    if (markerSlice(db, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, lateBuildStep)) continue;
    const row = st(db, NEXT_JOB).get();
    if (!row) { if (!db.isTransaction) noteRevocationQueueEmpty(); return total; }
    const step = stepJobRow(db, row, Number.MAX_SAFE_INTEGER);
    total += step.job?.total ?? 0;
    if (step.done) noteRevocationJobEnded();
  }
}
/** The marker drain (DESIGN-WRITETIME 5, "after the marker drains"; the write-time differential and offline helpers): every revoke's marker
 * phases (flow, mark, hold, tidy, undo) and every bookkeeping job they wait on run to their end now, on the caller's connection, each slice
 * in its own transaction when none is open. Returns the slices run and whether any revoke still has work (true only when a job cannot move:
 * a node that does not parse; its pending rows then stay, fail closed). */
export function drainRevokeMarker(db: DatabaseSync, maxSlices = 50_000_000): { slices: number; pending: boolean } {
  let slices = 0;
  const own = !db.isTransaction;
  for (;;) {
    if (++slices > maxSlices) throw new Error("MEMORY_REVOKE_DRAIN_UNBOUNDED");
    if (own) beginBackground(db, "revoke-drain");
    let moved = false, ended = false, empty = false;
    try {
      if (markerSlice(db, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, lateBuildStep)) moved = true;
      else {
        const row = st(db, NEXT_JOB).get();
        empty = !row;
        if (row) { ended = stepJobRow(db, row, Number.MAX_SAFE_INTEGER).done; moved = true; }
      }
      if (own) db.exec("COMMIT");
      if (ended) noteRevocationJobEnded(); else if (empty && own) noteRevocationQueueEmpty();
    } catch (error) {
      if (own && db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } }
      if (error instanceof Error && error.message === "MEMORY_REVOKE_NODE_UNREADABLE") return { slices, pending: true };
      throw error;
    }
    if (!moved) return { slices, pending: markerWorkPending(db) };
  }
}
/** 1.0.20 closer-n1 (option B, Fable pick): a turn waiting on a checking:pending fence closes ITS threads' and scopes' pending rows (and the
 * revoke's '*' rows) ahead of the paced tidy pages, and only those of a revoke whose walk has written every mark: active, phase 'tidy', no
 * frontier row (revoke-marker.ts tidyStep's own precondition; an inherit hold pushes a frontier row and sends the revoke back to 'mark').
 * Before that nothing goes early: a mark into a thread can come from any frontier node. Its own background transaction (bounded lock wait,
 * re-checked inside), measured into the revoke pace like any runner commit, at most WAITED_PENDING_ROWS rows a call and
 * WAITED_PENDING_ROWS_PER_MIN in any rolling minute for the whole process (every waiter shares it). Busy or any error deletes nothing (the
 * wait goes on). 1.0.21 closer2: the '*' rows always count once there is a target (no any-scope pick: it would examine the whole backlog,
 * Astra H1). True when it deleted a row. */
export const WAITED_PENDING_ROWS = 32;
export const WAITED_PENDING_ROWS_PER_MIN = 256;
export const WAITED_EXAMINE_ROWS = 256;
const WAITED_WINDOW_MS = 60_000;
// 1.0.21 closer2 (C2): a rolling minute of (time, rows) charges, never a fixed window (two windows across a boundary admitted 512 rows in 60 s).
// At most WAITED_PENDING_ROWS_PER_MIN entries: each charge is at least one row.
const waitedLog: Array<{ at: number; rows: number }> = [];
export function resetWaitedPendingAllowance(): void { waitedLog.length = 0; }
function waitedInMinute(now: number): number {
  while (waitedLog.length && now - waitedLog[0].at >= WAITED_WINDOW_MS) waitedLog.shift();
  let rows = 0;
  for (const entry of waitedLog) rows += entry.rows;
  return rows;
}
// 1.0.21 closer2 (C3): every mark written = active, no frontier row and no hold row (revoke-marker.ts HOLD_PREFIX 'hold:'), in 'tidy' or in the
// 'mark'/'hold' it still reads until the paced runner's next ticks: markStep with no frontier row goes to 'hold', and 'hold' with no hold row and
// no frontier row goes to 'tidy', with no mark written in between. A frontier row (still walking, or an inherit since), a hold or an unread late note keeps the row.
const READY_REVOKE = "SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=p.revoke_id AND j.state='active' AND j.phase IN ('mark','hold','tidy') AND NOT EXISTS (SELECT 1 FROM memory_revoke_frontier f WHERE f.revoke_id=j.revoke_id) AND NOT EXISTS (SELECT 1 FROM memory_revoke_reached h WHERE h.revoke_id=j.revoke_id AND h.thread_id>='hold:' AND h.thread_id<'hold;')"
  // 1.0.23 D3 (FABLE 067e8a15c9 HIGH-1 on the denyfable lineage; ASTRA precheck of cbd526caf8 here): a late note past the job's place in the
  // shared list (revoke-marker.ts LATE_REVOKE, the job's cursor c.late) is a child written under its window that its hold step has not
  // looked up again yet; its mark may still be owed, so the pending row that holds it is not closed before the rescan.
  + ` AND NOT EXISTS (SELECT 1 FROM memory_revoke_reached l WHERE l.revoke_id=${LATE_REVOKE} AND l.thread_id>='late:' AND l.thread_id<'late;' AND l.thread_id>coalesce(CASE WHEN json_valid(j.cursor) THEN json_extract(j.cursor,'$.late') END,''))`;
export function closeWaitedPending(db: DatabaseSync, threads: readonly string[], scopes: readonly string[]): boolean {
  if (db.isTransaction || (!threads.length && !scopes.length)) return false;
  const now = performance.now();
  const room = Math.min(WAITED_PENDING_ROWS, WAITED_PENDING_ROWS_PER_MIN - waitedInMinute(now));
  if (room <= 0) return false;
  // the '*' row of either table counts for every target (deny-read.ts memoryPendingSince reads both), so it is always a candidate. At most
  // WAITED_EXAMINE_ROWS raw rows per table are examined BEFORE the READY guard (as deny-read.ts rawPending): a backlog of revokes still
  // walking costs a bounded read and charges nothing; a ready row past it waits for the paced tidy (fail closed). Astra H1.
  const pick = (table: "memory_deny_pending" | "memory_deny_pending_scope", column: string, all: string, keys: readonly string[], n: number) => n <= 0 ? []
    : st(db, `WITH p AS MATERIALIZED (SELECT ${column},since_lsn,revoke_id FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?1) UNION SELECT ?2) LIMIT ?4) SELECT p.${column} AS k,p.since_lsn AS s,p.revoke_id AS r FROM p WHERE EXISTS (${READY_REVOKE}) LIMIT ?3`)
      .all(JSON.stringify(keys), all, n, WAITED_EXAMINE_ROWS);
  try {
    const rows = pick("memory_deny_pending", "thread_id", PENDING_ALL_THREADS, threads, room);
    const scoped = pick("memory_deny_pending_scope", "scope_id", PENDING_ALL_SCOPES, scopes, room - rows.length);
    if (!rows.length && !scoped.length) return false;
    waitedLog.push({ at: now, rows: rows.length + scoped.length }); // charged before the write: a failed attempt still spends its share
    beginBackground(db, "waited-pending");
    let measure: ReturnType<typeof beginRevokeMeasure> | null = null, gone = 0;
    try {
      measure = beginRevokeMeasure(db);
      // re-read inside the writer: the revoke may have moved back to 'mark' between the read above and this transaction
      for (const [table, column, list] of [["memory_deny_pending", "thread_id", rows], ["memory_deny_pending_scope", "scope_id", scoped]] as const)
        for (const row of list) gone += Number(st(db, `DELETE FROM ${table} AS p WHERE p.${column}=? AND p.since_lsn=? AND p.revoke_id=? AND EXISTS (${READY_REVOKE})`).run(row.k, row.s, row.r).changes);
      if (gone) bumpDenyGeneration(db);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } }
      if (measure) endRevokeMeasure(db, measure, false, false);
      throw error;
    }
    // after the COMMIT: the pace accounting cannot turn a committed close into a failed attempt
    try { endRevokeMeasure(db, measure!, false); } catch { /* the delete is committed; accounting is best effort here */ }
    return gone > 0;
  } catch { return false; }
}
/** The send fence's inline drain (send-fence.ts): rows and wall time one send may spend walking a revoke's marker. */
export const SEND_FENCE_DRAIN = { rows: 2048, ms: 40 };
/** Walks the revoke marker inline within `budget` (each slice its own transaction), for a send whose prompt reads "checking: pending": the
 * runner yields to a live owner turn, so without this the owner's next turn would be refused for a revoke nobody walks while it waits.
 * Bounded (a large revoke is left to the runner); never inside a caller's transaction. True while marker work is left. */
export function drainRevokeMarkerBounded(db: DatabaseSync, budget: { rows: number; ms: number } = SEND_FENCE_DRAIN, options: { background?: boolean } = {}): boolean {
  chargeReleaseWork();
  if (db.isTransaction) return markerWorkPending(db);
  // (MEMORY V2 V8: a turn's own drain no longer ends the closing budget; closing work keeps its minute while a pending row stands)
  const deadline = performance.now() + budget.ms;
  let rows = budget.rows;
  while (rows > 0 && performance.now() < deadline) {
    revokePaceNeed(db); // the drain's outstanding copies are settled outside its transaction first: its own copy (revoke-budget.ts r3.6c)
    // the upgrade's slices take the background budget; the send fence (an owner's send is waiting) keeps the handle's owner wait
    chargeReleaseStatement();
    // Reserve both transaction exits before BEGIN. Cleanup cannot need a new
    // reservation after a failed row/check has sealed the generation.
    chargeReleaseStatement();
    chargeReleaseStatement();
    if (options.background) beginBackground(db, "revoke-marker"); else db.exec("BEGIN IMMEDIATE");
    const measure = beginRevokeMeasure(db); // this drain's own transaction: its commit is measured into the cost estimate (revoke-budget.ts S2)
    let moved: boolean | "budget";
    // inside the marker's write budget (revoke-budget.ts): a minute with no room left walks nothing more here; the runner carries on later
    try {
      moved = budgetedMarkerSlice(accountedDatabase(db), Math.min(rows, MARKER_SLICE_ROWS), Math.max(1, deadline - performance.now()), lateBuildStep);
      db.exec("COMMIT"); endRevokeMeasure(db, measure);
    }
    catch (error) {
      if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } }
      endRevokeMeasure(db, measure, false, false);
      if (error instanceof Error && error.message === "MEMORY_REVOKE_NODE_UNREADABLE") return true;
      throw error;
    }
    if (!moved || moved === "budget") break;
    rows -= Math.min(rows, MARKER_SLICE_ROWS);
  }
  return markerWorkPending(db);
}

/** How long a turn the send fence refused for a revoke still being walked waits for the marker before it rebuilds its prompt once. */
export const REDISPATCH_SETTLE_MS = 5_000;
/** Before a refused turn rebuilds its prompt: walks the revoke marker in bounded slices, yielding between them, until nothing is pending or
 * `maxMs` passed (the runner yields to the owner's live turn, so without this the rebuilt prompt would meet the same window). True when
 * the marker is done. Each slice is SEND_FENCE_DRAIN-bounded: the event loop keeps serving. */
export async function settleRevokesForTurn(db: DatabaseSync, maxMs = REDISPATCH_SETTLE_MS, targets?: WaiterTargets): Promise<boolean> {
  const started = performance.now();
  let outcome: "cleared" | "deadline" | "error" | "stopped" | "in-tx" = "error";
  // MEMORY V2 V14: the settle no longer walks the marker itself and no longer waits for the global queue. It is a waiter: the runner has
  // the full ledger while it waits (noteFenceWaiter), and it looks again only when the `window` wake says a pending row went or the deny
  // generation moved. `targets`: only the windows covering this turn are looked at (their keys and the `*` rows). Without targets the
  // caller named no turn, so today's answer is kept: done when no marker work is left.
  const waiting = noteFenceWaiter(targets);
  try {
    const look = (): WindowLook => (targets ? windowsStand(db, targets) : markerWorkPending(db)) ? "wait" : "done";
    if (!db.isTransaction && look() === "done") { outcome = "cleared"; return true; }
    try { wakeMemoryRevocation(getDbRef && !stopped ? getDbRef : () => db); } catch { /* the wait is still bounded */ }
    const result = await awaitWindowWake(db, maxMs, look);
    // "in-tx" refines only a bound reached inside a caller's transaction, as before V14 (the diagnostic line's reader tells the two apart)
    let inTx = false;
    if (result === "deadline") { try { inTx = db.isTransaction; } catch { /* diagnostic only */ } }
    outcome = result === "done" ? "cleared" : result === "fail" ? "error" : inTx ? "in-tx" : result;
    return result === "done";
  } catch { return false; }
  finally {
    waiting();
    // Diagnostics must never alter a return or mask an exception. -1 means the count could not be read; activeJobs does not count flips/folds.
    try {
      const ms = Math.max(0, Math.round(performance.now() - started));
      let activeJobs = -1;
      try { activeJobs = (db.prepare("SELECT count(*) AS activeJobs FROM (SELECT 1 FROM memory_revoke_jobs WHERE state IN ('active','undoing') LIMIT 1001)").get() as { activeJobs: number }).activeJobs; } catch { /* diagnostic only */ }
      console.warn(`[memory] settle outcome=${outcome} ms=${ms} slices=0 activeJobs=${activeJobs > 1000 ? ">1000" : activeJobs}`);
    } catch { /* diagnostic only */ }
  }
}
/** Whether a pending row stands on one of the turn's own keys or on the `*` keys (two seeks; unreadable: yes, fail closed). */
function windowsStand(db: DatabaseSync, targets: WaiterTargets): boolean {
  try {
    return Boolean(st(db, "SELECT 1 FROM memory_deny_pending WHERE thread_id IN (SELECT value FROM json_each(?1) UNION SELECT ?2) LIMIT 1").get(JSON.stringify(targets.threads), PENDING_ALL_THREADS))
      || Boolean(st(db, "SELECT 1 FROM memory_deny_pending_scope WHERE scope_id IN (SELECT value FROM json_each(?1) UNION SELECT ?2) LIMIT 1").get(JSON.stringify(targets.scopes), PENDING_ALL_SCOPES));
  } catch { return true; }
}
/** MEMORY V2 V14, the one wait of every turn held under a pending window (fence-pending.ts, the turn-start settle). `look` is the waiter's
 * own exact question; it runs when the `window` wake is raised (a pending row was deleted or the deny generation moved, revoke-marker.ts)
 * and once at the bound, never on a timer in between and never inside a transaction. "deadline": the bound passed with the question still
 * open: the caller refuses (a timeout never authorises a resend). The waiter issues NO statement while it waits: the only timer work in
 * between is `cancelled()`, read in memory once every WINDOW_CANCEL_LOOK_MS (a Stop must not sit out the 65 s bound; lane W's bus can
 * replace it with a raise from the Stop sites). */
export type WindowLook = "done" | "fail" | "wait";
export const WINDOW_CANCEL_LOOK_MS = 1_000;
const WINDOW_IN_TX_RECHECK_MS = 5;
/** Test seam (mutants): `timeoutAllows` resolves a waiter "done" at its bound. Never set outside a test. */
export const windowWaitTestHooks = { timeoutAllows: false };
let windowWaiters = 0;
export function awaitWindowWake(db: DatabaseSync, maxMs: number, look: () => WindowLook, cancelled: () => boolean = () => false): Promise<"done" | "fail" | "deadline" | "stopped"> {
  return new Promise(resolve => {
    const topic = `window-wait:${++windowWaiters}`, due = Date.now() + maxMs;
    let over = false, recheck = false;
    const finish = (result: "done" | "fail" | "deadline" | "stopped") => {
      if (over) return;
      over = true; offWindow(); offOwn(); armDeadline(topic, Number.POSITIVE_INFINITY); resolve(result);
    };
    // a handle that cannot say (closed under the waiter): null, and the wait refuses instead of throwing in the bus on every wake
    const inTransaction = (): boolean | null => { try { return db.isTransaction; } catch { return null; } };
    // the waiter's one deadline: the in-memory Stop look, or the short look after a caller's transaction; never later than the bound
    const arm = () => armDeadline(topic, Math.min(due, Date.now() + (recheck ? WINDOW_IN_TX_RECHECK_MS : WINDOW_CANCEL_LOOK_MS)));
    const exact = () => {
      if (over) return;
      if (cancelled()) return finish("stopped");
      const late = Date.now() >= due;
      const inTx = inTransaction();
      if (inTx === null) return finish("fail");
      if (inTx) {
        // never a read inside someone's transaction (its uncommitted rows are not a verdict): look again right after, or refuse at the bound
        if (late) return finish(windowWaitTestHooks.timeoutAllows ? "done" : "deadline");
        recheck = true; arm(); return;
      }
      recheck = false;
      let result: WindowLook;
      try { result = look(); } catch { return finish("fail"); }
      if (result !== "wait") return finish(result);
      if (late) return finish(windowWaitTestHooks.timeoutAllows ? "done" : "deadline");
    };
    const offWindow = onWake(WINDOW_WAKE, exact);
    const offOwn = onWake(topic, () => {
      if (over) return;
      if (cancelled()) return finish("stopped");
      if (recheck || Date.now() >= due) exact();
      // still waiting (a look after a transaction that answered "wait" included): the Stop look and the bound stay armed
      if (!over) arm();
    });
    if (cancelled()) return finish("stopped");
    // entered inside a caller's transaction (the caller's entry look was skipped): the first look comes right after it ends
    recheck = inTransaction() === true;
    arm();
  });
}
/** Wakes the runner if this process started it, once the caller's synchronous transaction is over (a microtask runs after it):
 * a wake is never issued inside a transaction, and one after a rollback finds no row and stops. */
/** Turns now waiting on a checking:pending fence. While any waits, a live turn does not slow the marker: the waiting turn is that turn. */
let fenceWaiters = 0;
export type WaiterTargets = { threads: readonly string[]; scopes: readonly string[] };
const waiterTargets = new Set<WaiterTargets>();
/** `targets`: the threads and scopes the waiting turn is held under; the runner closes their rows first (closeWaitedPending, V14). */
export function noteFenceWaiter(targets?: WaiterTargets): () => void {
  fenceWaiters++;
  if (targets) waiterTargets.add(targets);
  let done = false;
  return () => { if (!done) { done = true; fenceWaiters--; if (targets) waiterTargets.delete(targets); } };
}
/** How many turns wait on a checking:pending fence now (tests, diagnostics). */
export const fenceWaitersNow = (): number => fenceWaiters;
export function wakeIfStarted(): void {
  bumpMemoVersion(QUEUE_VERSION); // a write queued work: an empty queue the runner remembered is no longer known
  // a parked runner stays parked: wakeMemoryRevocation without resume is a no-op before the park's reset deadline (the bound lives there)
  if (!getDbRef || stopped) return;
  queueMicrotask(() => { if (getDbRef && !stopped) wakeMemoryRevocation(getDbRef); });
}
// Lane W's wake bus (wake.ts) sees every COMMIT of the main connection: a job row inserted or put back to an unfinished state, or a
// receipt flip queued, by ANY writer (one that never calls wakeIfStarted included, and the open-time probe after a crash) raises
// `revoke` there. It is taken as the same in-process wake: the remembered empty queue is dropped and the runner looks once. A wake
// with nothing behind it costs that one look and arms nothing. Owner of the bus and its triggers: lane W; of this subscriber: lane C.
onCommitWake(RUNNER_WAKE, () => { wakeIfStarted(); }, { priority: WAKE_PRIORITY.closing, name: "revoke-runner" });

/** MEMORY V2 section 5, M2: the standing revoke queue's migration step. Owner of this body: lane C. Owner of the runner that registers
 * and calls it (migration-v2.ts `registerMigrationStep("M2", revokeDrainMigrationStep)`), of its order and of its cursor row: lane I.
 * The queue is drained "as it is" by the revoke runner itself, as closing work on its own wake (V8), in its own measured transactions:
 * every job's phase and cursor are already durable, and a walk run inside the migration runner's transaction would escape the pace's
 * measure and be budgeted twice. So one batch here is one O(1) read: whether any revoke still has work. When one has, the runner is
 * woken (a no-op if it is already running) and the step is not done; when none has, it is. No row is written here, so the step is
 * idempotent from any cursor, and it never deletes a pending row or touches a job (P4). */
export function revokeDrainMigrationStep(db: DatabaseSync, _cursor: unknown, _now: number): { cursor: { pending: boolean }; done: boolean } {
  const pending = markerWorkPending(db);
  if (pending) wakeIfStarted();
  return { cursor: { pending }, done: !pending };
}
/** Resolves when the runner has no job or late build left (or was stopped). */
export function memoryRevocationIdle(): Promise<void> {
  return running ? new Promise<void>(resolve => { idleWaiters.push(resolve); }) : Promise.resolve();
}
/** Ends the runner (shutdown, tests). The rows stay; the next start resumes them. */
export function stopMemoryRevocation(): void {
  stopped = true;
  armDeadline(RUNNER_WAKE, Number.POSITIVE_INFINITY);
  offRunnerWake?.(); offRunnerWake = null;
  running = false; gateWait = false; emptyAt = null; closing = false; closingStale = true; options = {}; noteRevokeClosing(false); wakeAll();
  parked = false; parkResetAt = Number.POSITIVE_INFINITY; storageFailures = 0; selfResets = 0; memoryRevocationStats.parkedNow = 0;
  if (startRecomputeTimer) { clearTimeout(startRecomputeTimer); startRecomputeTimer = undefined; }
  startRecomputeOwed = false; quarantineLowTrust.unproven = false;
}
/** Test hook: back to the starting counters. */
export function resetMemoryRevocationStats(): void { for (const key of Object.keys(memoryRevocationStats) as Array<keyof typeof memoryRevocationStats>) memoryRevocationStats[key] = 0; }

// a receipt any path turns 'revoked' wakes the runner, which commits it as a receipt root (receipt-outputs.ts)
setFlipWake(wakeIfStarted);

setSendFenceDeps({ drain: db => { drainRevokeMarkerBounded(db); } });
