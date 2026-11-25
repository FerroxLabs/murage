// Memory V2 migration runner (MEMORY-V2-DESIGN section 5, 3.5). Owner: lane I (runner, cursors, order, pace, M5, the retention lap).
// Step owners: M2 lane C (revokeDrainMigrationStep, memory-revocation.ts), M3 and M4 lane A (recallJournalTrimStep,
// recallDeadTermsStep, recall-view.ts), M6 lane H. M6 needs no call (CONTRACT-REQ I memv2-H): H's session-orphan lap is
// self-contained and writes its own marker `memory-v2:session-orphans`; this file only reads that marker for "finished".
// There is no format step: the file stays schema v13 and every cursor is a marker row `memory-v2:<task>` in
// `memory_scope_bindings` (subject `system`, subject id `memory-v2`, a NOISY system subject: a cursor write moves no epoch),
// written in the SAME transaction as the batch it describes, so a crash at any point resumes at the last committed batch.
// Wakes: lane W's bus (wake.ts). No timer unless work is left: more work raises the topic again (one slice per macrotask); a step
// that made no progress backs off 1 s doubling to 60 s; work held back by a live turn arms ONE deadline; a throw is the bus's
// failure path (1 s doubling to 60 s, error class logged). At rest (every task done, no lap due) nothing is armed.
import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { BACKGROUND_BUSY_MS, DatabaseBusyError } from "../db-busy.ts";
import { revokeDrainMigrationStep } from "./memory-revocation.ts";
import { recallDeadTermsStep, recallJournalTrimStep } from "./recall-view.ts";
import { pruneDeadJobsPage, PAYLOAD_STUB_ENABLED, RETENTION_AGE_MS, stubPayloadsPage } from "./retention-v2.ts";
import { armDeadline, disarmDeadline, onWake, onWakeInstall, raise, WAKE_PRIORITY } from "./wake.ts";

/** The tasks this runner drives, in design order. M6 is lane H's own lap (see the header). */
export const MIGRATION_TASKS = ["M2", "M3", "M4", "M5"] as const;
export type MigrationTask = typeof MIGRATION_TASKS[number];
export const MIGRATION_TOPIC = "migration-v2";
/** The steady-state retention lap (4.10 after M5): its own deadline topic, raised only when a lap is due. */
export const RETENTION_LAP_TOPIC = "retention-v2";
export const MIGRATION_SUBJECT = "memory-v2";
/** Lane H's marker for M6 (session-proof-schema.ts, CONTRACT-REQ I memv2-H). */
export const M6_MARKER_ID = "memory-v2:session-orphans";
/** One slice: at most 8 ms, half while a turn is live (section 5). */
export const SLICE_MS = 8;
const LIVE_RETRY_MS = 1000;
export const STALL_MIN_MS = 1000, STALL_MAX_MS = 60_000;
/** A lap after new jobs were written runs at most this long after the first of them (the bound is "publishing jobs + 7 days"). */
export const LAP_DELAY_MS = 24 * 60 * 60 * 1000;

/** The cursor of a task is opaque JSON; a step gets the last committed one and returns the next. */
export type MigrationCursor = unknown;
export type StepResult = { cursor: MigrationCursor; done: boolean };
/** A step runs ONE bounded batch inside the runner's transaction and must be idempotent for a re-run from the same cursor. */
export type MigrationStep = (db: DatabaseSync, cursor: MigrationCursor, now: number) => StepResult;

const steps = new Map<MigrationTask, MigrationStep>();
/** M5 runs only while no turn is live (section 5). */
const IDLE_ONLY: ReadonlySet<MigrationTask> = new Set(["M5"]);

export function registerMigrationStep(task: MigrationTask, step: MigrationStep): () => void {
  steps.set(task, step);
  return () => { if (steps.get(task) === step) steps.delete(task); };
}

/** M5 (lane I): the retention backlog of 4.10 for the tables lane I owns. Sub-passes in order, each its own cursor part.
 * `seen` = the newest job rowid when the pass started; `young` = the oldest source-version time among jobs dead in every way
 * but age (the next lap is due at young + 7 d); `at` = when the pass started (jobs written after it make a lap due at
 * at + LAP_DELAY_MS, a fixed time that survives a restart); `lap` = this pass is a steady-state lap, not the first migration. */
type M5Cursor = { pass: "jobs" | "payload"; after: number; seen?: number; at?: number; young?: number; lap?: boolean };
export const m5Step: MigrationStep = (db, raw, now) => {
  const prior: M5Cursor = isM5Cursor(raw) ? raw : { pass: "jobs", after: 0 };
  const seen = prior.seen ?? maxJobRowid(db), at = prior.at ?? now;
  const base = { seen, at, ...(prior.lap ? { lap: true } : {}) };
  if (prior.pass === "jobs") {
    const page = pruneDeadJobsPage(db, prior.after, now);
    const young = minDefined(prior.young, page.young);
    const cursor = { pass: "jobs" as const, after: page.cursor, ...base, ...(young === undefined ? {} : { young }) };
    if (!page.done) return { cursor, done: false };
    return PAYLOAD_STUB_ENABLED ? { cursor: { ...cursor, pass: "payload", after: 0 }, done: false } : { cursor, done: true };
  }
  const page = stubPayloadsPage(db, prior.after, now);
  return { cursor: { ...prior, ...base, after: page.cursor }, done: page.done };
};
const isM5Cursor = (value: unknown): value is M5Cursor => typeof value === "object" && value !== null
  && ((value as M5Cursor).pass === "jobs" || (value as M5Cursor).pass === "payload") && Number.isSafeInteger((value as M5Cursor).after);
const minDefined = (a?: number, b?: number) => a === undefined ? b : b === undefined ? a : Math.min(a, b);
const maxJobRowid = (db: DatabaseSync) => Number(db.prepare("SELECT max(rowid) AS r FROM memory_jobs").get()?.r ?? 0);

const DEFAULT_STEPS: ReadonlyArray<[MigrationTask, MigrationStep]> = [
  ["M2", revokeDrainMigrationStep], ["M3", recallJournalTrimStep], ["M4", recallDeadTermsStep], ["M5", m5Step],
];
for (const [task, step] of DEFAULT_STEPS) steps.set(task, step);

export const markerId = (task: MigrationTask) => `memory-v2:${task}`;
type Marker = { cursor: MigrationCursor; done: boolean };

export function readMarker(db: DatabaseSync, task: MigrationTask): Marker | undefined {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id=?").get(markerId(task), MIGRATION_SUBJECT);
  if (!row) return undefined;
  try { const parsed = JSON.parse(String(row.intent)); return { cursor: parsed.cursor ?? null, done: parsed.done === true }; } catch { return undefined; }
}

function writeMarker(db: DatabaseSync, task: MigrationTask, marker: Marker): boolean {
  // A marker needs a scope row (the binding's foreign key); a file without one holds nothing to migrate.
  const scope = db.prepare("SELECT id FROM memory_scopes ORDER BY id LIMIT 1").get()?.id;
  if (scope === undefined) return false;
  db.prepare(`INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)
    ON CONFLICT(id) DO UPDATE SET intent=excluded.intent WHERE intent IS NOT excluded.intent`)
    .run(markerId(task), String(scope), MIGRATION_SUBJECT, JSON.stringify({ cursor: marker.cursor ?? null, done: marker.done }));
  return true;
}

/** `stalled`: the task's batch was not done and left its cursor where it was (a revoke still draining in its own runner, a
 * build holding the journal trim): the runner backs off instead of asking again on every macrotask. */
export type SliceOutcome = { ran?: MigrationTask; more: boolean; waitLive?: boolean; stalled?: MigrationTask };
export type SliceOptions = { now?: number; turnLive?: () => boolean; db?: DatabaseSync; budgetMs?: number };

/** Runs batches of the first unfinished registered task until the slice budget is spent. Every batch and its cursor are one
 * transaction (`transaction()` = BEGIN IMMEDIATE); a throw rolls both back, so the next slice re-runs the same batch. */
export function runMigrationSlice(options: SliceOptions = {}): SliceOutcome {
  const db = options.db ?? database(), live = options.turnLive?.() ?? false;
  const budget = (options.budgetMs ?? SLICE_MS) / (live ? 2 : 1), started = performance.now();
  let ran: MigrationTask | undefined;
  for (;;) {
    const task = nextTask(db, live);
    if (!task) return { ran, more: false, waitLive: live && pendingIdleOnly(db) };
    const step = steps.get(task)!;
    const now = options.now ?? Date.now();
    let empty = false;
    const batch = stalledOr(tx => {
      const prior = readMarker(tx, task);
      if (prior?.done) return { finished: true, moved: true };
      const before = JSON.stringify(prior?.cursor ?? null), wrote = totalChanges(tx);
      const result = step(tx, prior?.cursor ?? null, now);
      // Progress = the batch finished, moved its cursor, or wrote rows (M4 continues a large version from the same cursor).
      const moved = result.done || JSON.stringify(result.cursor ?? null) !== before || totalChanges(tx) !== wrote;
      if (!writeMarker(tx, task, { cursor: result.cursor, done: result.done })) { empty = true; return { finished: true, moved: true }; }
      // I5: a batch that moved nothing changed nothing (its marker write is the same row), so it ends in ROLLBACK, never a COMMIT
      if (!moved) throw NO_PROGRESS;
      return { finished: result.done, moved };
    }, { op: `memory-v2-${task}`, busyMs: BACKGROUND_BUSY_MS });
    if (batch === NO_PROGRESS) return { ran: task, more: false, stalled: task };
    // Only after the commit: a rolled-back batch leaves nothing in process state.
    if (empty) finishedEmpty.add(task);
    ran = task;
    if (performance.now() - started >= budget) return { ran, more: !batch.finished || nextTask(db, live) !== undefined };
  }
}

const NO_PROGRESS: unique symbol = Symbol("memory-v2 batch made no progress");
/** `transaction()`, except that a batch throwing NO_PROGRESS is rolled back and answers NO_PROGRESS instead of throwing. */
function stalledOr<T>(operation: (tx: DatabaseSync) => T, options: { op: string; busyMs: number }): T | typeof NO_PROGRESS {
  try { return transaction(operation, options); }
  catch (error) { if (error === NO_PROGRESS) return NO_PROGRESS; throw error; }
}
const totalChanges = (db: DatabaseSync) => Number(db.prepare("SELECT total_changes() AS n").get()?.n ?? 0);

/** Tasks found finished on a file with no scope row (nothing to migrate), kept per process. */
const finishedEmpty = new Set<MigrationTask>();

function nextTask(db: DatabaseSync, live: boolean): MigrationTask | undefined {
  for (const task of MIGRATION_TASKS) {
    if (!steps.has(task) || finishedEmpty.has(task)) continue;
    if (readMarker(db, task)?.done) continue;
    // Strict design order: a later task never runs while an earlier one is unfinished (M2 first: standing windows withhold memory).
    if (live && IDLE_ONLY.has(task)) return undefined;
    return task;
  }
  return undefined;
}

const pendingIdleOnly = (db: DatabaseSync) => [...IDLE_ONLY].some(task => steps.has(task) && !finishedEmpty.has(task) && !readMarker(db, task)?.done);

/** M5 is finished once its first pass ended: a steady-state lap in progress does not re-open the migration. */
function taskFinished(db: DatabaseSync, task: MigrationTask): boolean {
  if (finishedEmpty.has(task)) return true;
  const marker = readMarker(db, task);
  return marker?.done === true || (task === "M5" && isM5Cursor(marker?.cursor) && marker.cursor.lap === true);
}

/** "Migration finished" (the precondition of I1): every task of section 5 has its cursor at the end, M6 by lane H's marker. */
export function migrationV2Finished(db: DatabaseSync = database()): boolean {
  return MIGRATION_TASKS.every(task => steps.has(task) && taskFinished(db, task)) && m6Done(db);
}
const m6Done = (db: DatabaseSync) => Boolean(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND subject_type='system'").get(M6_MARKER_ID));

export function migrationV2Progress(db: DatabaseSync = database()): Record<MigrationTask | "M6", "done" | "running" | "unregistered"> {
  const out = Object.fromEntries(MIGRATION_TASKS.map(task => [task,
    taskFinished(db, task) ? "done" : steps.has(task) ? "running" : "unregistered"])) as Record<MigrationTask | "M6", "done" | "running" | "unregistered">;
  out.M6 = m6Done(db) ? "done" : "running";
  return out;
}

// ---- the steady-state retention lap (4.10: "publishing jobs + 7 days" holds after the migration, not only once) ----

/** When the next lap is due, from M5's finished cursor and the job table's newest rowid (two single-row reads, no scan):
 * at young + 7 d when a job was too young to go; within LAP_DELAY_MS when jobs were written after the last pass started
 * (a source moved to a new revision writes a capture job, which is what turns its old revision's jobs dead). */
export function retentionLapDue(db: DatabaseSync, now: number): number | undefined {
  const marker = readMarker(db, "M5");
  if (!marker?.done || !isM5Cursor(marker.cursor)) return undefined;
  const { young, seen, at } = marker.cursor;
  const byAge = young === undefined ? undefined : young + RETENTION_AGE_MS;
  const byWrites = seen !== undefined && maxJobRowid(db) > seen ? (at ?? now) + LAP_DELAY_MS : undefined;
  return minDefined(byAge, byWrites);
}

/** Re-opens M5 as a lap from the start of the job table, in one transaction; the runner then drives it like the first pass. */
export function openRetentionLap(now: number): boolean {
  return transaction(tx => {
    const due = retentionLapDue(tx, now);
    if (due === undefined || due > now) return false;
    return writeMarker(tx, "M5", { cursor: { pass: "jobs", after: 0, lap: true }, done: false });
  }, { op: "memory-v2-lap", busyMs: BACKGROUND_BUSY_MS });
}

/** Whether the armed lap deadline already counts the jobs written since the last pass (the `jobs` wake then has nothing to add). */
let writesArmed = false;
function armLap(db: DatabaseSync): void {
  const now = Date.now(), due = retentionLapDue(db, now);
  writesArmed = due !== undefined && (readM5(db)?.seen ?? Infinity) < maxJobRowid(db);
  if (due === undefined) disarmDeadline(RETENTION_LAP_TOPIC);
  else armDeadline(RETENTION_LAP_TOPIC, due);
}
const readM5 = (db: DatabaseSync) => { const cursor = readMarker(db, "M5")?.cursor; return isM5Cursor(cursor) ? cursor : undefined; };

/** Background pace (section 5: the background bucket, never a busy loop): after a slice of `t` ms the next one starts no sooner
 * than PACE_RATIO x t later, so the runner holds at most 1 / (1 + PACE_RATIO) of the main thread (20%). */
export const PACE_RATIO = 4;
let started: (() => void)[] | undefined;
let stallWait = 0;
/** Called once after the server listens (server/index.ts). A reopened writable handle re-raises through lane W's open hook.
 * `turnLive`: an owner turn is live (half slices, M5 held). `defer`: the shared background budget asks background work to wait. */
export function startMigrationV2(turnLive: () => boolean = () => false, defer: () => boolean = () => false): void {
  if (started) { raise(MIGRATION_TOPIC); return; }
  started = [
    onWake(MIGRATION_TOPIC, context => {
      if (defer()) { context.armDeadline(Date.now() + LIVE_RETRY_MS); return; }
      const begun = performance.now();
      let outcome: SliceOutcome;
      // a writer holding the lock: this slice waits at most the background wait (50 ms), then tries again later
      try { outcome = runMigrationSlice({ turnLive }); }
      catch (error) { if (!(error instanceof DatabaseBusyError)) throw error; context.armDeadline(Date.now() + LIVE_RETRY_MS); return; }
      const spent = performance.now() - begun;
      if (outcome.stalled) {
        stallWait = Math.min(STALL_MAX_MS, stallWait ? stallWait * 2 : STALL_MIN_MS);
        context.armDeadline(Date.now() + stallWait);
        return;
      }
      stallWait = 0;
      if (outcome.more) { context.armDeadline(Date.now() + Math.ceil(spent * PACE_RATIO)); return; }
      if (outcome.waitLive) { context.armDeadline(Date.now() + LIVE_RETRY_MS); return; }
      // at the end: a back-off deadline left from a stall is dropped; only a due lap stays armed
      disarmDeadline(MIGRATION_TOPIC);
      armLap(database());
    }, { priority: WAKE_PRIORITY.background, name: "migration-v2" }),
    onWake(RETENTION_LAP_TOPIC, () => {
      const db = database();
      if (openRetentionLap(Date.now())) { writesArmed = false; raise(MIGRATION_TOPIC); }
      else armLap(db);
    }, { priority: WAKE_PRIORITY.background, name: "retention-lap" }),
    // A job written: only arms the lap's deadline (no read beyond two single rows, no work now).
    onWake("jobs", () => { if (!writesArmed) armLap(database()); }, { priority: WAKE_PRIORITY.background, name: "retention-lap-arm" }),
    onWakeInstall(() => { raise(MIGRATION_TOPIC); }),
  ];
  raise(MIGRATION_TOPIC);
}

/** Test seam. */
export function resetMigrationV2ForTests(): void {
  for (const off of started ?? []) off();
  started = undefined; stallWait = 0; writesArmed = false; finishedEmpty.clear();
  disarmDeadline(MIGRATION_TOPIC); disarmDeadline(RETENTION_LAP_TOPIC);
  steps.clear(); for (const [task, step] of DEFAULT_STEPS) steps.set(task, step);
}
