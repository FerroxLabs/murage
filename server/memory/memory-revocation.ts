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
//   all         a deleted bot: every receipt made before the commit's epoch, paged by bundle id
//   done        the job's own target rows, deleted in pages
// Ids live in memory_revocation_targets (job, kind, id, rev), paged by key: the job row (memory_scope_bindings, subject
// 'system'/'memory-revocation') carries only the phase and a scalar cursor, so it stays under 1 KB and resumes after a restart
// or any error; only completion removes it. When no job row waits, the runner fills the two late lookup tables instead.
import { holdForgottenSources } from "../turn-source-holds.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { lockedError } from "./revocation-index.ts";
import { beginBackground } from "../database.ts";
import { scrubWalAfterDelete } from "../wal-maintenance.ts";
import { noteRevocation, revocationIndexReady, RECORD_REVOCATION_SCAN_SQL, RECORD_TOMBSTONE_AFFECTED, RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL } from "./revocation.ts";
import { newLearningPurgeCursor, purgeLearningStep, purgeEvolutionBinding, EVOLUTION_BINDING_SUBJECTS, type LearningPurgeCursor, type LearningLookup } from "./evolution-forgetting.ts";
import { reconcilePipStances } from "./pip-stance.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, revokeSliceNeed, revokeWriteWaitMs } from "./revoke-budget.ts";
import { enqueueReceipts, markerSlice, markerWorkPending, releaseHold } from "./revoke-marker.ts";
import { setFlipWake } from "./receipt-outputs.ts";
import { setSendFenceDeps } from "./send-fence.ts";
import { MARKER_SLICE_ROWS } from "./lineage-types.ts";
import { recordCounter } from "../health/counters.ts";
import { noteRevocationJobCreated, noteRevocationJobEnded, noteRevocationQueueEmpty } from "../health/pending-revocations.ts";

/** One prepared statement per connection and text: a job runs the same few statements hundreds of thousands of times, and on a
 * plain connection (restore, tests) a fresh statement each time left that many for the collector to finalise in long pauses. */
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function st(db: DatabaseSync, sql: string): StatementSync {
  let held = statements.get(db);
  if (!held) statements.set(db, held = new Map());
  let statement = held.get(sql);
  if (!statement) { statement = db.prepare(sql); if (held.size < 512) held.set(sql, statement); }
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
  if (!forgottenMessagesHook || !sourceIds.length) return;
  const read = st(db, "SELECT message_id,thread_id FROM memory_sources WHERE id=?");
  const threadOf = new Map<string, string>();
  for (const id of sourceIds) { const row = read.get(id); if (typeof row?.message_id === "string" && typeof row.thread_id === "string" && row.message_id) threadOf.set(row.message_id, row.thread_id); }
  if (threadOf.size) forgottenMessagesHook(db, [...threadOf.keys()], threadOf);
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
  record?: { id: string; rev: number | null; notes: boolean; after?: [number, string, number, number] | null } | null;
  /** forget of a source: its import tombstones below this revision are the imports phase's; `mark` is memory_sources' largest rowid at
   * the commit, so a copy imported while the older hashes were not yet tombstoned is found and ended when they are (revbound r3 A6);
   * `scope` is the forgotten source's scope */
  imports?: { id: string; below: number; mark?: number; scope?: string } | null;
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

type Budget = { rows: number; deadline: number };
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
  const budget: Budget = { rows: Math.max(1, rows), deadline: performance.now() + ms };
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
  if (rows.length < n) return true;
  const last = rows[rows.length - 1]!;
  c.after = [Number(last.v), String(last.s), Number(last.r), Number(last.b)];
  return false;
}
/** The import tombstone of each (source, revision) and, unless the record is a room's notes, its supporting-source tombstone and
 * end (shared by forget.ts for the inline rows and the supporting phase for the rest). */
export function supportingTombstones(db: DatabaseSync, job: RevocationJob | null, pairs: ReadonlyArray<{ id: string; revision: number }>, notes: boolean): Array<{ id: string; revision: number }> {
  const read = st(db, "SELECT s.scope_id,v.content_hash FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?");
  const epoch = Number(st(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch), now = Date.now();
  const seen = new Set<string>(), ended: Array<{ id: string; revision: number }> = [];
  for (const pair of pairs) {
    const key = `${pair.id}\u0000${pair.revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = read.get(pair.revision, pair.id);
    if (!row) continue;
    st(db, "INSERT INTO memory_tombstones VALUES(?,'import',?,NULL,?,?,'forgotten-original',?)").run(randomUUID(), String(row.scope_id), String(row.content_hash), epoch, now);
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
  const rows = st(db, "SELECT rowid AS rid,id,scope_id,content_hash,state FROM memory_sources WHERE rowid>? ORDER BY rowid LIMIT ?").all(Number(c.rid), n) as Array<{ rid: number; id: string; scope_id: string; content_hash: string; state: string }>;
  for (const row of rows) {
    if (row.scope_id !== target.scope || row.id === target.id || row.state === "deleted") continue;
    if (!st(db, "SELECT 1 FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash=? LIMIT 1").get(target.scope, row.content_hash)) continue;
    if (!st(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND revision IS NULL").get(row.id))
      st(db, "INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,?,'forgotten-original',?)").run(randomUUID(), row.id, Number(st(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch), Date.now());
    endSource(db, job, row.id, null);
  }
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
    for (const row of rows) if (scopes.has(String(row.scope_id))) endPlacedSource(db, job, String(row.id), "bot-deleted", payload);
    spend(budget, rows.length);
    if (rows.length === n) c.after = String(rows[rows.length - 1]!.id); else c.table = "records";
    return false;
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
    st(db, "UPDATE memory_records SET text='' WHERE id=? AND version=? AND text!=''").run(id, version);
    affect(db, job, id, version);
  }
  spend(budget, rows.length);
  if (rows.length === n) { c.rec = [String(rows[rows.length - 1]!.id), Number(rows[rows.length - 1]!.version)]; return false; }
  return true;
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
function affect(db: DatabaseSync, job: RevocationJob, id: string, version: number): void {
  const prior = st(db, "SELECT state,length(CAST(text AS BLOB)) AS bytes FROM memory_records WHERE id=? AND version=?").get(id, version);
  // Sentinel (S02 annotation): how often a record is ended, how often it was already deleted, and what the step rewrites.
  // Counts only, from the row this step reads anyway; the decision below is unchanged.
  observeAffect(prior);
  if (!prior) return;
  st(db, "UPDATE memory_records SET state='deleted',owner_pinned=0 WHERE id=? AND version=? AND (state!='deleted' OR owner_pinned!=0)").run(id, version);
  // Forget means the words are gone (Learn about me r3 C3): every record a forget ends loses its text in this same step, not only
  // those resting on a deleted conversation. Readers are already refused from the forget's commit; the indexes drop it by id.
  st(db, "UPDATE memory_records SET text='' WHERE id=? AND version=? AND text!=''").run(id, version);
  // A rolled checkpoint has a 'deleted' projection while its record is still
  // archived. Its first actual forget must also scrub old segments and WAL pages.
  // Repeated visits to an already deleted record keep completed work completed (scale finding A6); an already pending pair needs no rewrite.
  st(db, "UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending' WHERE record_id=? AND record_version=? AND lexical_status!='delete-pending' AND (lexical_status!='deleted' OR ?=1)").run(id, version, prior.state !== "deleted" ? 1 : 0);
  // (indexed by record; the events naming it as their prior go in the learning phase's rowid windows: evolution-forgetting.ts)
  if (hasTable(db, "memory_learning_events")) st(db, "DELETE FROM memory_learning_events WHERE record_id=? AND record_version=?").run(id, version);
  addTarget(db, job, "r", id);
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
      affect(db, job, String(row.id), Number(row.rev));
    }
    spend(budget, queued.length);
    return false;
  }
  // 4. the targeted record's versions
  if (job.record && c.rec !== null) {
    const rows = st(db, "SELECT version FROM memory_records WHERE id=? AND version>? AND (?3 IS NULL OR version=?3) ORDER BY version LIMIT ?").all(job.record.id, c.rec, job.record.rev, n) as Array<{ version: number }>;
    for (const row of rows) affect(db, job, job.record.id, Number(row.version));
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
    for (const row of rows) if (every || deleted || revs.get(job.id, id, Number(row.r))) affect(db, job, String(row.i), Number(row.v));
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
    if (held.length && held.some(rev => rev === ALL || rev === Number(row.r) || Boolean(deleted.get(String(row.s))))) affect(db, job, String(row.i), Number(row.v));
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

// ---- all: every receipt made before the commit's epoch ends (a deleted bot), a page of bundle ids at a time; the policy
// revision moved in the commit, so readers already refuse them, and a receipt made since (a later epoch) is not touched
function allStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  const c = (job.c ??= { after: null }) as { after: string | null };
  const n = chunk(budget);
  return bundlePage(db, c, n, (after, end) => Number(st(db, "UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND deletion_epoch<?3 AND bundle_id>?1 AND bundle_id<=?2").run(after, end, Number(job.epoch ?? 0)).changes), job, budget);
}

// ---- done: the job's target rows go, a page at a time
function doneStep(db: DatabaseSync, job: RevocationJob, budget: Budget): boolean {
  // the first page in key order, then a primary-key range delete up to its last key (the page is what is left at the front)
  const n = chunk(budget);
  const page = st(db, "SELECT kind,id,rev FROM memory_revocation_targets WHERE job_id=? ORDER BY kind,id,rev LIMIT ?").all(job.id, n);
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
    job.phases.unshift("scope"); job.phases.splice(job.phases.indexOf("done"), 0, "all");
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
  const budget: Budget = { rows: INLINE_REVOCATION.rows, deadline: performance.now() + INLINE_REVOCATION.ms };
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
export const memoryRevocationStats = { slices: 0, maxSliceMs: 0, maxWorkMs: 0, busyPauses: 0, errorRetries: 0, lockedRetries: 0, workMs: 0, pauseMs: 0, maxJobBytes: 0, lateSlices: 0, markerSlices: 0, budgetWaits: 0, markerYields: 0 };
let getDbRef: (() => DatabaseSync) | null = null, options: RevocationRunnerOptions = {}, timer: ReturnType<typeof setTimeout> | null = null;
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
const schedule = (delay: number) => { memoryRevocationStats.pauseMs += delay; timer = setTimeout(() => { void tick(); }, delay); timer.unref?.(); };
/** Granted rows, and rows an earlier build parked as 'revoked' (they finish here like any other: MEMDEL-SIMPLIFY-109). */
const NEXT_JOB = `SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='${REVOCATION_JOB_SUBJECT}' AND state IN ('granted','revoked') ORDER BY rowid LIMIT 1`;
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

async function tick(): Promise<void> {
  timer = null;
  if (stopped || !getDbRef) { running = false; wakeAll(); return; }
  try {
    if (options.admit) await options.admit();
    if (stopped) { running = false; wakeAll(); return; }
    const db = getDbRef();
    // the marker walks inside its write budget (revoke-budget.ts); under a live foreground turn it trickles (a half slice every busy pause)
    // rather than stopping: a window the walk holds open reads "checking" to every turn until the walk is done (SELF-OVERLOAD-105 item 1c)
    const live = options.busy?.() === true;
    let marker = false;
    if (markerWorkPending(db)) {
      const wait = revokeWriteWaitMs(revokeSliceNeed(db));
      if (wait > 0) { memoryRevocationStats.budgetWaits++; schedule(wait); return; }
      marker = true;
      if (live) memoryRevocationStats.markerYields++;
    }
    const budget = (options.sliceMs ?? REVOCATION_SLICE_MS) * (live && marker ? REVOCATION_LIVE_SLICE_FRACTION : 1), t0 = performance.now();
    let more = false, budgetWait = false;
    // a background runner: the write lock is taken within the background budget, never the handle's 1 s wait (a busy start retries)
    beginBackground(db, "revocation-job");
    // the runner's own transaction: what its commit writes to the WAL is measured into the budget's cost estimate (revoke-budget.ts S2)
    const measure = beginRevokeMeasure(db);
    let moved: boolean | "budget" = false;
    // Sentinel's pending figures (health/pending-revocations.ts), applied only once this transaction commits
    let jobEnded = false, queueEmpty = false;
    try {
      // the write-time marker first: its pending rows hold lines and memory "checking" until it is done (revoke-marker.ts)
      moved = budgetedMarkerSlice(db, rowsPerSlice, budget, lateBuildStep);
      const row = moved === true ? null : st(db, NEXT_JOB).get();
      queueEmpty = row === undefined;
      // the minute had no room for the marker (a waiting receipt flip's whole commit, revoke-budget.ts): with no job row to run either,
      // the runner wakes when the minute has room, never stops here
      if (moved === "budget" && !row) { budgetWait = true; more = true; }
      else if (row === null) { more = true; memoryRevocationStats.markerSlices++; }
      else if (row) {
        if (stepJobRow(db, row, rowsPerSlice, budget).done) jobEnded = true;
        more = true;
      } else if (lateBuildStep(db, rowsPerSlice)) { more = true; memoryRevocationStats.lateSlices++; }
      memoryRevocationStats.maxWorkMs = Math.max(memoryRevocationStats.maxWorkMs, performance.now() - t0);
      db.exec("COMMIT");
      if (queueEmpty) noteRevocationQueueEmpty(); else if (jobEnded) noteRevocationJobEnded();
      // measured only when the transaction held the marker's slice and nothing else (a job step or a late build ran otherwise)
      if (moved === true) endRevokeMeasure(db, measure);
    } catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } throw error; }
    const ms = performance.now() - t0;
    if (!more) { running = false; wakeAll(); ranOut(); return; }
    if (budgetWait) { memoryRevocationStats.budgetWaits++; schedule(Math.max(1, revokeWriteWaitMs(revokeSliceNeed(db)))); return; }
    memoryRevocationStats.slices++; memoryRevocationStats.workMs += ms;
    memoryRevocationStats.maxSliceMs = Math.max(memoryRevocationStats.maxSliceMs, ms);
    rowsPerSlice = nextRevocationRows(rowsPerSlice, ms, budget); backoff = options.retryMs ?? LOCK_RETRY_MS;
    if (live) { if (!marker) memoryRevocationStats.busyPauses++; schedule(options.busyPauseMs ?? REVOCATION_BUSY_PAUSE_MS); }
    else schedule(Math.max(options.pauseMs ?? REVOCATION_MIN_PAUSE_MS, Math.ceil(ms * REVOCATION_PAUSE_FACTOR)));
  } catch (error) {
    // the job stays in its row: a lock is tried again shortly, anything else with a doubling delay, until it completes
    if (lockedError(error)) { memoryRevocationStats.lockedRetries++; schedule(options.retryMs ?? LOCK_RETRY_MS); return; }
    memoryRevocationStats.errorRetries++;
    console.warn(`[memory] revocation job: ${error instanceof Error ? error.message : String(error)}; trying again`);
    schedule(backoff); backoff = Math.min(RETRY_CAP_MS, backoff * 2);
  }
}

/** Starts (or wakes) the runner over every job row and late build: at listen (resuming what a stopped process left), and after each
 * commit that wrote one. Options given here stay for the process. */
export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions): void {
  getDbRef = getDb; stopped = false;
  if (next) options = { ...options, ...next };
  if (!running) { running = true; rowsPerSlice = START_ROWS; backoff = options.retryMs ?? LOCK_RETRY_MS; schedule(0); }
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
/** The send fence's inline drain (send-fence.ts): rows and wall time one send may spend walking a revoke's marker. */
export const SEND_FENCE_DRAIN = { rows: 2048, ms: 40 };
/** Walks the revoke marker inline within `budget` (each slice its own transaction), for a send whose prompt reads "checking: pending": the
 * runner yields to a live owner turn, so without this the owner's next turn would be refused for a revoke nobody walks while it waits.
 * Bounded (a large revoke is left to the runner); never inside a caller's transaction. True while marker work is left. */
export function drainRevokeMarkerBounded(db: DatabaseSync, budget: { rows: number; ms: number } = SEND_FENCE_DRAIN, options: { background?: boolean } = {}): boolean {
  if (db.isTransaction) return markerWorkPending(db);
  const deadline = performance.now() + budget.ms;
  let rows = budget.rows;
  while (rows > 0 && performance.now() < deadline) {
    // the upgrade's slices take the background budget; the send fence (an owner's send is waiting) keeps the handle's owner wait
    if (options.background) beginBackground(db, "revoke-marker"); else db.exec("BEGIN IMMEDIATE");
    const measure = beginRevokeMeasure(db); // this drain's own transaction: its commit is measured into the cost estimate (revoke-budget.ts S2)
    let moved: boolean | "budget";
    // inside the marker's write budget (revoke-budget.ts): a minute with no room left walks nothing more here; the runner carries on later
    try { moved = budgetedMarkerSlice(db, Math.min(rows, MARKER_SLICE_ROWS), Math.max(1, deadline - performance.now()), lateBuildStep); db.exec("COMMIT"); endRevokeMeasure(db, measure); }
    catch (error) {
      if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } }
      if (error instanceof Error && error.message === "MEMORY_REVOKE_NODE_UNREADABLE") return true;
      throw error;
    }
    if (!moved || moved === "budget") break;
    rows -= Math.min(rows, MARKER_SLICE_ROWS);
  }
  return markerWorkPending(db);
}
setSendFenceDeps({ drain: db => { drainRevokeMarkerBounded(db); } });
/** How long a turn the send fence refused for a revoke still being walked waits for the marker before it rebuilds its prompt once. */
export const REDISPATCH_SETTLE_MS = 5_000;
/** Before a refused turn rebuilds its prompt: walks the revoke marker in bounded slices, yielding between them, until nothing is pending or
 * `maxMs` passed (the runner yields to the owner's live turn, so without this the rebuilt prompt would meet the same window). True when
 * the marker is done. Each slice is SEND_FENCE_DRAIN-bounded: the event loop keeps serving. */
export async function settleRevokesForTurn(db: DatabaseSync, maxMs = REDISPATCH_SETTLE_MS): Promise<boolean> {
  const deadline = performance.now() + maxMs;
  for (;;) {
    let pending: boolean;
    try { pending = db.isTransaction ? true : drainRevokeMarkerBounded(db); } catch { return false; }
    if (!pending) return true;
    if (performance.now() >= deadline) return false;
    // a minute whose write budget is spent walks nothing until it has room: wait for that (or the deadline) instead of spinning
    const wait = revokeWriteWaitMs(revokeSliceNeed(db));
    if (wait > 0) await new Promise<void>(resolve => { setTimeout(resolve, Math.max(1, Math.min(wait, deadline - performance.now()))).unref?.(); });
    else await new Promise<void>(resolve => setImmediate(resolve));
  }
}
/** Wakes the runner if this process started it, once the caller's synchronous transaction is over (a microtask runs after it):
 * a wake is never issued inside a transaction, and one after a rollback finds no row and stops. */
export function wakeIfStarted(): void {
  if (!getDbRef || stopped) return;
  queueMicrotask(() => { if (getDbRef && !stopped) wakeMemoryRevocation(getDbRef); });
}
/** Resolves when the runner has no job or late build left (or was stopped). */
export function memoryRevocationIdle(): Promise<void> {
  return running ? new Promise<void>(resolve => { idleWaiters.push(resolve); }) : Promise.resolve();
}
/** Ends the runner (shutdown, tests). The rows stay; the next start resumes them. */
export function stopMemoryRevocation(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
  running = false; options = {}; wakeAll();
}
/** Test hook: back to the starting counters. */
export function resetMemoryRevocationStats(): void { for (const key of Object.keys(memoryRevocationStats) as Array<keyof typeof memoryRevocationStats>) memoryRevocationStats[key] = 0; }

// a receipt any path turns 'revoked' wakes the runner, which commits it as a receipt root (receipt-outputs.ts)
setFlipWake(wakeIfStarted);
