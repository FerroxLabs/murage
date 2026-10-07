// Jobs whose source is retired can never be claimed (the claim joins on an
// active source), yet while `pending` they kept the idle guard open and every
// claim scanned past them. They are parked instead: status `cancelled`, which
// the schema already allows and every older build treats as terminal, with the
// job's own status and error remembered in `error` as
// `parked:v1:{"s":<prior status>,"e":<prior error or null>}`.
// Re-activating the source puts exactly that status and error back (NULL stays
// NULL, the empty string stays the empty string). No schema change:
// validateMemorySchema checks tables and indexes, and the status CHECK is
// unchanged.
//
// The marker is read back only when it is a JSON object whose `s` is one of
// the statuses parking can remember and whose `e` is null or text; anything
// else that merely starts with `parked:` is an ordinary cancelled job, never
// reopened and never an error. A worker reason that starts with `parked:` is
// stored with a `~` in front (jobErrorText), so no worker text can read as a
// marker. Every permanent cancellation clears the marker (forgetParked*).
//
// Access paths, all asserted by tests through EXPLAIN QUERY PLAN:
//  - thread park/reopen: memory_sources_thread drives, then the job's
//    (source_id,...) unique index is probed, so the cost follows that thread's
//    sources, not the open jobs of the whole database;
//  - restore parking: the `leased` status range (a handful of rows) with a
//    source primary-key probe each;
//  - the one-time sweep: a window of the next PARK_SWEEP_WINDOW existing job
//    rowids by rowid seek, then an update over exactly that rowid range;
//  - the reconciliation after a downgrade: the next window of `cancelled`
//    index entries, then one rowid update per candidate.
import type { DatabaseSync } from "node:sqlite";
import { runningAppVersion } from "./app-version.ts";
import { turnTraceEnabled } from "../turn-trace.ts";

const OPEN = "('pending','partial','deferred','leased')";
const MARKER_PREFIX = "parked:v1:";
const PARK_SET = `status='cancelled',error='${MARKER_PREFIX}'||json_object('s',CASE status WHEN 'leased' THEN 'pending' ELSE status END,'e',error),
  lease_generation=lease_generation+1,lease_owner=NULL,lease_until=0`;
/** True only for a well-formed marker on a cancelled row; the CASE keeps the JSON functions from running on anything else. */
const parkedMarker = (p: string) => `(CASE WHEN ${p}status='cancelled' AND substr(${p}error,1,${MARKER_PREFIX.length + 1})='${MARKER_PREFIX}{' AND json_valid(substr(${p}error,${MARKER_PREFIX.length + 1})) THEN
  (json_type(substr(${p}error,${MARKER_PREFIX.length + 1}))='object' AND json_extract(substr(${p}error,${MARKER_PREFIX.length + 1}),'$.s') IN ('pending','partial','deferred')
   AND json_type(substr(${p}error,${MARKER_PREFIX.length + 1}),'$.e') IN ('null','text')) ELSE 0 END)`;
const REOPEN_SET = `status=json_extract(substr(error,${MARKER_PREFIX.length + 1}),'$.s'),error=json_extract(substr(error,${MARKER_PREFIX.length + 1}),'$.e')`;
export const PARK_WINDOW_SQL = 500;
export const PARK_SWEEP_WINDOW = PARK_WINDOW_SQL;

export const PARK_SQL = {
  thread: `UPDATE memory_jobs SET ${PARK_SET} WHERE rowid IN (SELECT j.rowid FROM memory_sources s CROSS JOIN memory_jobs j ON j.source_id=s.id
    WHERE s.thread_id=? AND s.state='retired' AND +j.status IN ${OPEN})`,  // the unary plus keeps the status index out of the plan: the jobs are probed by source id
  reopenThread: `UPDATE memory_jobs SET ${REOPEN_SET} WHERE rowid IN (SELECT j.rowid FROM memory_sources s CROSS JOIN memory_jobs j ON j.source_id=s.id AND j.source_revision=s.revision
    WHERE s.thread_id=? AND s.state='active' AND +j.status='cancelled' AND ${parkedMarker("j.")})`,
  restore: `UPDATE memory_jobs SET ${PARK_SET} WHERE status='leased' AND EXISTS (SELECT 1 FROM memory_sources s WHERE s.id=memory_jobs.source_id AND s.state='retired')`,
  sweepSelect: `SELECT rowid AS r FROM memory_jobs NOT INDEXED WHERE rowid>? ORDER BY rowid LIMIT ${PARK_WINDOW_SQL}`,
  sweepPark: `UPDATE memory_jobs NOT INDEXED SET ${PARK_SET} WHERE rowid>? AND rowid<=? AND status IN ${OPEN}
    AND EXISTS (SELECT 1 FROM memory_sources s WHERE s.id=memory_jobs.source_id AND s.state='retired')`,
  // The cursor is (retry_at,rowid). A tuple comparison would seek on retry_at only and walk the tied rows
  // again on every call (retry_at is 0 for almost every cancelled job), so the window is read in two seeks:
  // the rest of the cursor's own retry_at by rowid, then the later retry_at values.
  reconcileTied: `SELECT retry_at AS t,rowid AS r FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status='cancelled' AND retry_at=? AND rowid>?
    ORDER BY rowid LIMIT ${PARK_WINDOW_SQL}`,
  reconcileLater: `SELECT retry_at AS t,rowid AS r FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status='cancelled' AND retry_at>?
    ORDER BY retry_at,rowid LIMIT ?`,
  reconcileReopen: `UPDATE memory_jobs SET ${REOPEN_SET} WHERE rowid=? AND ${parkedMarker("")}
    AND EXISTS (SELECT 1 FROM memory_sources s WHERE s.id=memory_jobs.source_id AND s.revision=memory_jobs.source_revision AND s.state='active')`,
  // The unary plus on status keeps the (status,retry_at) index out of the plan: these seek the jobs by source id
  // and never walk the cancelled range, which holds every job ever cancelled.
  forgetSource: `UPDATE memory_jobs SET error=NULL WHERE source_id=? AND +status='cancelled' AND substr(error,1,7)='parked:'`,
  forgetThreads: `UPDATE memory_jobs SET error=NULL WHERE rowid IN (SELECT j.rowid FROM memory_sources s CROSS JOIN memory_jobs j ON j.source_id=s.id
    WHERE s.thread_id IN (SELECT value FROM json_each(?)) AND +j.status='cancelled' AND substr(j.error,1,7)='parked:')`,
  /** A restore that deletes sources (a tombstone, or a source already deleted): driven by those sources and tombstones, jobs sought by source id. */
  forgetTombstoned: `UPDATE memory_jobs SET error=NULL WHERE rowid IN (
    SELECT j.rowid FROM memory_sources s CROSS JOIN memory_jobs j ON j.source_id=s.id WHERE s.state='deleted' AND +j.status='cancelled' AND substr(j.error,1,7)='parked:'
    UNION
    SELECT j.rowid FROM memory_tombstones t CROSS JOIN memory_jobs j ON j.source_id=t.target_id
    WHERE t.target_type='source' AND (t.revision IS NULL OR t.revision=j.source_revision) AND +j.status='cancelled' AND substr(j.error,1,7)='parked:')`,
} as const;

/** A worker's reason, as stored in `error`: never able to read as a parking marker. */
export function jobErrorText(reason: string): string {
  return reason.startsWith("parked:") ? `~${reason}` : reason;
}

/** Park the open jobs of every retired source of one thread. */
export function parkRetiredThreadJobs(db: DatabaseSync, threadId: string) {
  return Number(db.prepare(PARK_SQL.thread).run(threadId).changes);
}

/** Re-open, as they were, the parked jobs of every active source of one thread
 * (only for the revision the job belongs to: a newer revision already replaced it). */
export function reopenParkedThreadJobs(db: DatabaseSync, threadId: string) {
  return Number(db.prepare(PARK_SQL.reopenThread).run(threadId).changes);
}

/** A restore requeues leased jobs; one whose source is retired is parked, not requeued. */
export function parkRetiredLeasedJobs(db: DatabaseSync) {
  db.prepare(PARK_SQL.restore).run();
}

/** A permanent cancellation (supersede, deletion, settings exclusion) of a
 * source's jobs also ends any parking of them: the marker is cleared on rows
 * parking had already cancelled, so they can never reopen. */
export function forgetParkedSource(db: DatabaseSync, sourceId: string) {
  db.prepare(PARK_SQL.forgetSource).run(sourceId);
}
export function forgetParkedThreads(db: DatabaseSync, threadIds: readonly string[]) {
  db.prepare(PARK_SQL.forgetThreads).run(JSON.stringify(threadIds));
}

/** Run `work` inside the caller's transaction when there is one, else in its
 * own; reports whether the work is durable once this returns. */
function inTransaction<T>(db: DatabaseSync, work: () => T): { value: T; durable: boolean } {
  if (db.isTransaction) return { value: work(), durable: false };
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return { value, durable: true }; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* the transaction is already gone */ } throw error; }
}
function bigRows(db: DatabaseSync, sql: string) { const statement = db.prepare(sql); statement.setReadBigInts(true); return statement; }

const SWEEP_MARKER = "memory-parked-sweep";
let sweepDone = false;
export function parkSweepFinished() { return sweepDone; }
/** Test hook: forget the in-memory done flag. */
export function resetParkSweep() { sweepDone = false; }

/** One resumable step of the one-time sweep that parks jobs already stuck behind
 * retired sources in an existing database. A step takes the next
 * PARK_SWEEP_WINDOW job rowids that exist after the cursor (a rowid seek, so
 * gaps between rowids cost nothing and every step covers real rows) and parks
 * the open jobs of retired sources among exactly those rows, recording the
 * cursor in the same transaction. The sweep is finished when a step finds
 * fewer rows than the window. The marker lives in memory_scope_bindings like
 * the origin backfill's cursor; the in-memory flag is set only once the
 * transaction that wrote the marker has committed (inside a caller's
 * transaction the durable marker is read instead). Returns the number parked
 * in this step and whether the sweep is finished. */
export function parkStuckJobsStep(db: DatabaseSync, sink: (line: string) => void = line => console.log(line)): { parked: number; done: boolean } {
  if (sweepDone) return { parked: 0, done: true };
  const step = inTransaction(db, () => {
    const previous = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(SWEEP_MARKER);
    const progress = previous ? JSON.parse(String(previous.intent)) as { cursor: number | string; done?: boolean } : { cursor: 0 };
    if (progress.done) return { parked: 0, done: true, quiet: true };
    const scope = db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id;
    if (scope == null) return { parked: 0, done: true, quiet: true };  // no scope, so no sources and no jobs; later retirements park their own
    const cursor = BigInt(progress.cursor);
    const rows = bigRows(db, PARK_SQL.sweepSelect).all(cursor) as Array<{ r: bigint }>;
    const upto = rows.length ? rows[rows.length - 1].r : cursor;
    const parked = rows.length ? Number(db.prepare(PARK_SQL.sweepPark).run(cursor, upto).changes) : 0;
    const done = rows.length < PARK_WINDOW_SQL;
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','parked-sweep',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
      .run(SWEEP_MARKER, scope, JSON.stringify({ cursor: String(upto), done }));
    return { parked, done, quiet: false };
  });
  if (step.durable && step.value.done) sweepDone = true;
  if (turnTraceEnabled() && !step.value.quiet && (step.value.parked || step.value.done)) sink(`[turn-trace] phase=memory.park${step.value.parked ? ` parked=${step.value.parked}` : ""}${step.value.done ? " done=true" : ""}`);
  return { parked: step.value.parked, done: step.value.done };
}

const MIN_INT64 = -9223372036854775808n;
let reconcileCursor: { t: bigint; r: bigint } = { t: MIN_INT64, r: MIN_INT64 };
let reconcileDone = false;
let reconcileLoaded = false;
export function parkReconcileFinished() { return reconcileDone; }
/** Test hook: start the reconciliation over, as a new launch does. */
export function resetParkReconcile() { reconcileCursor = { t: MIN_INT64, r: MIN_INT64 }; reconcileDone = false; reconcileLoaded = false; }

const RECONCILE_MARKER = "memory-parked-reconcile";
const runningVersion = runningAppVersion;
interface ReconcileMarker { version: string; done: boolean; t?: string; r?: string }
function readReconcileMarker(db: DatabaseSync): ReconcileMarker | null {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(RECONCILE_MARKER);
  try { const value = row ? JSON.parse(String(row.intent)) : null; return value && typeof value.version === "string" ? value : null; } catch { return null; }
}
function writeReconcileMarker(db: DatabaseSync, marker: ReconcileMarker) {
  const scope = db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id;
  if (scope == null) return;
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','parked-reconcile',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(RECONCILE_MARKER, scope, JSON.stringify(marker));
}

/** One step of the reconciliation: an older build can re-activate a source
 * without knowing about parking, leaving its parked job cancelled although the
 * source is active again. A step takes the next PARK_SWEEP_WINDOW `cancelled`
 * index entries (the cost follows the cancelled jobs, not the table) and
 * reopens, by rowid, the ones holding a well-formed marker whose source is
 * active at the job's own revision.
 *
 * A downgrade followed by an upgrade always changes the version, so the pass
 * only matters when the running version differs from the one recorded when the
 * last pass finished. The marker (memory_scope_bindings, like the sweep's)
 * holds that version and, while a pass is under way, its cursor, so an
 * interrupted pass resumes where it stopped and a finished one is skipped. */
export function parkReconcileStep(db: DatabaseSync, sink: (line: string) => void = line => console.log(line)): { reopened: number; done: boolean } {
  if (reconcileDone) return { reopened: 0, done: true };
  const version = runningVersion();
  if (!reconcileLoaded && !db.isTransaction) {
    reconcileLoaded = true;
    const marker = version === null ? null : readReconcileMarker(db);
    if (marker && marker.version === version) {
      if (marker.done) { reconcileDone = true; return { reopened: 0, done: true }; }
      if (marker.t !== undefined && marker.r !== undefined) { try { reconcileCursor = { t: BigInt(marker.t), r: BigInt(marker.r) }; } catch { /* start over */ } }
    }
  }
  const step = inTransaction(db, () => {
    const rows = bigRows(db, PARK_SQL.reconcileTied).all(reconcileCursor.t, reconcileCursor.r) as Array<{ t: bigint; r: bigint }>;
    if (rows.length < PARK_WINDOW_SQL) rows.push(...bigRows(db, PARK_SQL.reconcileLater).all(reconcileCursor.t, BigInt(PARK_WINDOW_SQL - rows.length)) as Array<{ t: bigint; r: bigint }>);
    const reopen = db.prepare(PARK_SQL.reconcileReopen);
    let reopened = 0;
    for (const row of rows) reopened += Number(reopen.run(row.r).changes);
    const done = rows.length < PARK_WINDOW_SQL, last = rows.at(-1) ?? reconcileCursor;
    if (version !== null) writeReconcileMarker(db, { version, done, t: String(last.t), r: String(last.r) });
    return { reopened, rows, done };
  });
  // The cursor moves only after the step committed, so a rolled-back step is repeated.
  if (step.durable) {
    const last = step.value.rows.at(-1);
    if (last) reconcileCursor = { t: last.t, r: last.r };
    if (step.value.done) reconcileDone = true;
  }
  if (turnTraceEnabled() && (step.value.reopened || step.value.done)) sink(`[turn-trace] phase=memory.park-reconcile${step.value.reopened ? ` reopened=${step.value.reopened}` : ""}${step.value.done ? " done=true" : ""}`);
  return { reopened: step.value.reopened, done: step.value.done };
}

/** True while either maintenance pass still has work for this launch. */
export function parkMaintenancePending() { return !sweepDone || !reconcileDone; }
/** One bounded maintenance step: the one-time sweep first, then the per-launch reconciliation. */
export function parkMaintenanceStep(db: DatabaseSync, sink?: (line: string) => void) {
  if (!sweepDone) parkStuckJobsStep(db, sink);
  else if (!reconcileDone) parkReconcileStep(db, sink);
}
