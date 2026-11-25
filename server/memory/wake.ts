// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory V2, the shared mechanism (design section 3; owner: lane W). Memory work has a named cause: a committed change or a deadline armed
// for one row. Nothing here polls, and with nothing written and nothing due this module runs no statement and holds no timer.
//
//   onWake(topic, fn)        subscribe: fn runs (one bounded slice, off the committing stack) after a commit that wrote the topic's rows
//   raise(topic)             the same wake from code (a worker's notice, a probe, a gate that reopened)
//   armDeadline(topic, due)  the ONLY timer memory code may hold: one timer for the earliest wall-clock due time; at `due` the topic is raised
//   memoVersion(name)        a counter a memo is keyed on: moved by every write to the tables the memo declared, and by every rollback
//
// How a wake is made. TEMP triggers on the main connection write the topic into temp.mem_wake inside the writer's own transaction, so a
// rollback takes the wake with it. The connection wrapper (io-budget.ts instrumentDatabase) reports every end of a transaction and every
// autocommit write, whatever statement ended it; the drain then empties the table and raises what it held. No persisted object is added,
// dropped or edited (rule C1: schema v13 text-exact); everything is connection-local and is installed again on every open.
//
// No lost wake. A subscriber that returns { more: true } must have armed a deadline for its topic (ctx.armDeadline) or named the gate it
// waits on (ctx.until). Otherwise the fault is reported (thrown to the fault sink under test, logged once in production) and the topic is
// retried after a second, so the work is late and never stranded. A subscriber that throws keeps its place and retries after 1 s, doubling
// to 60 s; the error is logged by class.
import type { DatabaseSync, StatementSync } from "node:sqlite";

// ── the frozen API (Wave 0) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The topics written by the TEMP triggers. Any other string is a code-only topic (raised by raise() or a deadline). */
export const WAKE_TOPICS = ["journal", "revoke", "window", "jobs", "projection", "links"] as const;
export type WakeTopic = (typeof WAKE_TOPICS)[number] | (string & {});
/** Who runs first when several subscribers are owed a slice: the owner's path, closing work a reader waits on, the recall applier, background. */
export const WAKE_PRIORITY = { owner: 1, closing: 2, applier: 3, background: 4 } as const;
export type WakePriority = (typeof WAKE_PRIORITY)[keyof typeof WAKE_PRIORITY];
export interface WakeContext {
  readonly topic: string;
  /** Run this subscriber's topic again at `dueMs` (wall clock; a time not in the future means the next turn of the event loop). */
  armDeadline(dueMs: number): void;
  /** Run this subscriber again when `gate` settles (a writer gate, a turn's end): the other way to leave work without losing it. */
  until(gate: PromiseLike<unknown>): void;
}
export type WakeResult = void | boolean | { more?: boolean };
export type WakeSubscriber = (context: WakeContext) => WakeResult | Promise<WakeResult>;
export interface WakeOptions { priority?: WakePriority; name?: string }

interface Subscription { topic: string; fn: WakeSubscriber; priority: number; name: string; order: number; failures: number; running: boolean; again: boolean; gone: boolean }
const subscribers = new Map<string, Set<Subscription>>();
const owed = new Map<Subscription, number>();   // subscriber -> the order its wake arrived in
const unheard = new Set<string>();              // raised with nobody subscribed yet: delivered to the first subscriber (start-up order)
let arrival = 0, subscriptions = 0, pumpQueued = false;
const counters = { commits: 0, drains: 0, drained: 0, raised: 0, runs: 0, faults: 0, failures: 0, timerArms: 0, timerFires: 0, installs: 0, probes: 0, setupStatements: 0 };
/** Counters for the gates. The drain, the install and the probes use the connection's un-instrumented statements (they are outside the
 * background budget by design), so G-IDLE and G-START count them from here: `drains` is one statement each, `setupStatements` is every
 * exec or prepare of an install and of a probe pass. */
export function wakeStats(): Readonly<typeof counters> & { timerArmed: boolean; deadlines: number; owed: number } {
  return { ...counters, timerArmed: timer !== null, deadlines: deadlines.size, owed: owed.size };
}

/** Subscribe to a topic. Returns the unsubscribe. A wake raised before anyone listened is delivered now. */
export function onWake(topic: WakeTopic, fn: WakeSubscriber, options: WakeOptions = {}): () => void {
  const sub: Subscription = { topic, fn, priority: options.priority ?? WAKE_PRIORITY.background, name: options.name ?? `${topic}#${subscriptions}`, order: subscriptions++, failures: 0, running: false, again: false, gone: false };
  let set = subscribers.get(topic);
  if (!set) subscribers.set(topic, set = new Set());
  set.add(sub);
  if (unheard.delete(topic)) owe(sub);
  return () => { sub.gone = true; set.delete(sub); owed.delete(sub); deadlines.delete(retryKey(sub)); rearm(); };
}

/** Wake every subscriber of the topic: each gets one slice on a later turn of the event loop, by priority. Never runs a subscriber inline. */
export function raise(topic: WakeTopic): void {
  counters.raised++;
  const set = subscribers.get(topic);
  if (!set || set.size === 0) { unheard.add(topic); return; }
  for (const sub of set) owe(sub);
}

/** Arm the topic's deadline: at `dueMs` (wall clock) the topic is raised once. The earliest armed time of a topic wins; no row due means no timer. */
export function armDeadline(topic: WakeTopic, dueMs: number): void {
  if (!Number.isFinite(dueMs)) throw new TypeError("armDeadline: dueMs must be a wall-clock time in ms");
  const known = deadlines.get(topic);
  if (known && known.due <= dueMs) return;
  deadlines.set(topic, { due: dueMs, run: () => raise(topic) });
  rearm();
}
/** Forget the topic's deadline (the row it was armed for is gone). */
export function disarmDeadline(topic: WakeTopic): void { if (deadlines.delete(topic)) rearm(); }
/** When the topic is next due, or undefined. */
export function deadlineOf(topic: WakeTopic): number | undefined { return deadlines.get(topic)?.due; }

/** The version a memo is keyed on (design 3.4). It never decreases; it moves on every row written to a table the memo watches
 * (watchMemo) and on every rollback, savepoint rollback and statement abort of the connection. While the watch is not installed on the
 * open connection (no connection, a read-only start, a failed install, a table that does not exist) every call answers a new number, so
 * no memo ever matches: fail closed. A memo kept across transactions must be stored outside one and also keyed on PRAGMA data_version
 * and databaseGeneration() (rules a and c are the caller's: this counter only covers this connection's own writes). */
export function memoVersion(name: string): number {
  if (!memoTables.has(name)) throw new Error(`memoVersion: no memo named ${name} (declare it with watchMemo)`);
  if (!memoInstalled.has(name)) return ++undoEpoch + (memoCounts.get(name) ?? 0);
  return undoEpoch + (memoCounts.get(name) ?? 0);
}
// ── end of the frozen API ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// ── the queue ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function owe(sub: Subscription, retry = false): void {
  if (sub.gone) return;
  if (sub.running) { sub.again = true; return; }
  // a subscriber that is backing off after a failure runs at its retry time, not on every wake in between: the retry reads the work
  // that arrived meanwhile (a failing subscriber must not become a loop)
  if (!retry && deadlines.has(retryKey(sub))) return;
  if (!owed.has(sub)) owed.set(sub, arrival++);
  if (!pumpQueued) { pumpQueued = true; setImmediate(pump); }
}
function pump(): void {
  pumpQueued = false;
  sweepDeadlines();
  let next: Subscription | undefined, at = 0;
  for (const [sub, order] of owed) if (!next || sub.priority < next.priority || (sub.priority === next.priority && order < at)) { next = sub; at = order; }
  if (!next) return;
  owed.delete(next);
  run(next);
  // one bounded slice each, then the event loop: a turn, a Stop or a higher-priority wake gets in between
  if (owed.size > 0 && !pumpQueued) { pumpQueued = true; setImmediate(pump); }
}
const retryKey = (sub: Subscription) => `\u0000retry:${sub.order}`;
function run(sub: Subscription): void {
  counters.runs++;
  sub.running = true;
  let armed = false, gated = false;
  const context: WakeContext = {
    topic: sub.topic,
    armDeadline: dueMs => { armed = true; armDeadline(sub.topic, dueMs); },
    until: gate => { gated = true; const again = () => owe(sub); Promise.resolve(gate).then(again, again); },
  };
  const settled = (result: WakeResult) => {
    sub.running = false; sub.failures = 0;
    const more = result === true || (typeof result === "object" && result !== null && result.more === true);
    if (more && !armed && !gated && !sub.again && !deadlines.has(sub.topic)) {
      // the no-lost-wake rule: late, never stranded
      armDeadline(sub.topic, now() + 1_000);
      fault(new LostWakeError(sub.name, sub.topic));
    }
    if (sub.again) { sub.again = false; owe(sub); }
  };
  const failed = (error: unknown) => {
    sub.running = false; sub.again = false; sub.failures++; counters.failures++;
    const wait = Math.min(60_000, 1_000 * 2 ** Math.min(16, sub.failures - 1));
    logOnce(`wake-fail:${sub.name}:${errorClass(error)}`, `[memory-wake] ${sub.name} failed class=${errorClass(error)} retry=${wait}ms: ${error instanceof Error ? error.message : String(error)}`);
    armKey(retryKey(sub), now() + wait, () => owe(sub, true));
  };
  try {
    const result = sub.fn(context);
    if (result && typeof (result as PromiseLike<WakeResult>).then === "function") (result as PromiseLike<WakeResult>).then(settled, failed);
    else settled(result as WakeResult);
  } catch (error) { failed(error); }
}
/** The class a failure is logged and counted under (F37): BUSY, FULL, deferred, quota, other. */
export function errorClass(error: unknown): "BUSY" | "FULL" | "deferred" | "quota" | "other" {
  const e = error as { code?: unknown; errcode?: unknown; name?: unknown; message?: unknown } | null;
  const text = `${String(e?.name ?? "")} ${String(e?.code ?? "")} ${String(e?.message ?? "")}`;
  if (e?.errcode === 5 || e?.errcode === 6 || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|DATABASE_BUSY/i.test(text)) return "BUSY";
  if (e?.errcode === 13 || /SQLITE_FULL|ENOSPC|disk is full/i.test(text)) return "FULL";
  if (/BgDeferred|deferred/i.test(text)) return "deferred";
  if (/quota/i.test(text)) return "quota";
  return "other";
}
// (plain fields, no parameter properties: this module is also loaded by child processes that only strip types)
export class LostWakeError extends Error {
  readonly subscriber: string;
  readonly topic: string;
  constructor(subscriber: string, topic: string) {
    super(`memory wake: ${subscriber} left work on "${topic}" with no deadline armed and no gate named`);
    this.name = "LostWakeError"; this.subscriber = subscriber; this.topic = topic;
  }
}
let faultSink: ((error: Error) => void) | null = null;
/** Tests: receive rule faults instead of the default (thrown on a later turn under vitest so the run fails; logged once in production). */
export function setWakeFaultSink(sink: ((error: Error) => void) | null): void { faultSink = sink; }
function fault(error: Error): void {
  counters.faults++;
  if (faultSink) { faultSink(error); return; }
  if (process.env.VITEST) { setImmediate(() => { throw error; }); return; }
  logOnce(`wake-fault:${error.message}`, `[memory-wake] ${error.message}`);
}
const logged = new Set<string>();
function logOnce(key: string, line: string): void { if (logged.has(key)) return; if (logged.size < 512) logged.add(key); console.warn(line); }

// ── the deadline registry (3.2) ─────────────────────────────────────────────────────────────────────────────────────────────────────
const deadlines = new Map<string, { due: number; run: () => void }>();
let timer: ReturnType<typeof setTimeout> | null = null, timerDue = Number.POSITIVE_INFINITY;
let now: () => number = () => Date.now();
/** Tests: a wall clock that can jump (a machine that slept). */
export function setWakeClockForTest(clock: (() => number) | null): void { now = clock ?? (() => Date.now()); }
function armKey(key: string, due: number, runAt: () => void): void { deadlines.set(key, { due, run: runAt }); rearm(); }
function rearm(): void {
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of deadlines.values()) if (entry.due < earliest) earliest = entry.due;
  if (earliest === timerDue && (timer !== null || earliest === Number.POSITIVE_INFINITY)) return;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  timerDue = earliest;
  if (earliest === Number.POSITIVE_INFINITY) return;
  counters.timerArms++;
  // one timer, for the earliest due time; it never keeps the process alive
  timer = setTimeout(fireDeadlines, Math.min(2_147_483_647, Math.max(0, earliest - now())));
  (timer as { unref?: () => void }).unref?.();
}
function fireDeadlines(): void {
  timer = null; timerDue = Number.POSITIVE_INFINITY;
  counters.timerFires++;
  runDue();
  rearm();
}
function runDue(): void {
  const at = now();
  for (const [key, entry] of [...deadlines]) if (entry.due <= at && deadlines.get(key) === entry) { deadlines.delete(key); try { entry.run(); } catch (error) { logOnce(`deadline:${key}`, `[memory-wake] deadline ${key} failed: ${String(error)}`); } }
}
/** Deadlines are wall-clock times and a timer does not count a sleep: on every event the bus sees (a commit, a wake) the due ones run once. */
function sweepDeadlines(): void { if (timerDue <= now()) { if (timer !== null) { clearTimeout(timer); timer = null; } timerDue = Number.POSITIVE_INFINITY; runDue(); rearm(); } }

// ── memo versions (3.4) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const memoTables = new Map<string, readonly string[]>();
const memoCounts = new Map<string, number>();
const memoInstalled = new Set<string>();
let undoEpoch = 0;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
/** Declare a memo and the tables its answer is read from. Declared at module load; installed on every open (and at once on an open
 * connection that is not inside a transaction). A write to any of the tables moves memoVersion(name). */
export function watchMemo(name: string, tables: readonly string[]): void {
  if (!NAME.test(name) || name.includes("__")) throw new Error(`watchMemo: bad memo name ${name}`);
  for (const table of tables) if (!NAME.test(table)) throw new Error(`watchMemo: bad table name ${table}`);
  const known = memoTables.get(name);
  const next = [...new Set([...(known ?? []), ...tables])].sort();
  if (known && known.length === next.length) return;
  memoTables.set(name, next);
  memoInstalled.delete(name); undoEpoch++;
  const live = current;
  if (live && !live.readOnly && !live.failed) { try { if (live.db.isOpen && !live.db.isTransaction) installMemo(live, name); } catch { /* stays uninstalled: every read is a new number */ } }
}
/** Every rollback, savepoint rollback and statement abort moves every memo version (called by the connection wrapper, raw rollbacks included). */
export function memoUndone(): void { undoEpoch++; }
function installMemo(live: Installed, name: string): void {
  const tables = memoTables.get(name) ?? [];
  const present = new Set(live.tables);
  if (tables.length === 0 || tables.some(table => !present.has(table))) return;
  live.exec(tables.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event =>
    `CREATE TEMP TRIGGER IF NOT EXISTS mem_memo_${name}__${table}__${event[0]!.toLowerCase()} AFTER ${event} ON main.${table} BEGIN SELECT murage_memo_bump('${name}'); END;`)).join("\n"));
  memoInstalled.add(name);
}

// ── guards (3.3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** G-JOB. `memory_recall_job_u` journals every UPDATE of memory_jobs (it has no WHEN clause and cannot be edited: K1). A lease, a
 * heartbeat or a settle keeps the row, the id and the source, which is all a view reads of a job; the guard notes such an update and
 * drops the one journal insert the persisted trigger then makes for exactly that job. An INSERT, a DELETE or an UPDATE that moves the id
 * or the source clears the note first and is journaled. Same object names and text as lane A's base (mem-f1), so either installer is a
 * no-op after the other. */
export const JOB_GUARD_SQL = `
CREATE TEMP TABLE IF NOT EXISTS recall_job_same(id INTEGER PRIMARY KEY CHECK(id=1),job_id TEXT);
INSERT OR IGNORE INTO recall_job_same VALUES(1,NULL);
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_u BEFORE UPDATE ON main.memory_jobs BEGIN
 UPDATE recall_job_same SET job_id=CASE WHEN OLD.rowid IS NEW.rowid AND OLD.id IS NEW.id AND OLD.source_id IS NEW.source_id THEN NEW.id END WHERE id=1; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_i BEFORE INSERT ON main.memory_jobs BEGIN UPDATE recall_job_same SET job_id=NULL WHERE id=1 AND job_id IS NOT NULL; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_d BEFORE DELETE ON main.memory_jobs BEGIN UPDATE recall_job_same SET job_id=NULL WHERE id=1 AND job_id IS NOT NULL; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_c BEFORE INSERT ON main.memory_recall_changes
 WHEN NEW.kind='job' AND NEW.version=0 AND NEW.object_id IS (SELECT job_id FROM recall_job_same WHERE id=1) BEGIN
 UPDATE recall_job_same SET job_id=NULL WHERE id=1; SELECT RAISE(IGNORE); END;
`;

/** G-VISIT, the call-site form. A presentation-only writer is declared with the ONE column it may change. While its single statement runs
 * inside presentationWrite(), an update of a row of its table that changes any other column ABORTS the statement, and each row that passes
 * lets exactly one move of the recall epoch be dropped (the one the persisted external trigger makes for that row). Nothing is inferred
 * from column lists: a statement that is not flagged moves the epoch as always, and so does any other epoch move inside a flagged one. */
export interface PresentationWriter { name: string; table: string; column: string }
const presentationWriters = new Map<string, PresentationWriter>();
let presenting: string | null = null, visitToken = 0;
export function declarePresentationWriter(writer: PresentationWriter): void {
  for (const part of [writer.name, writer.table, writer.column]) if (!NAME.test(part)) throw new Error(`declarePresentationWriter: bad name ${part}`);
  const known = presentationWriters.get(writer.name);
  if (known && (known.table !== writer.table || known.column !== writer.column)) throw new Error(`declarePresentationWriter: ${writer.name} is already declared differently`);
  for (const other of presentationWriters.values()) if (other.table === writer.table && other.name !== writer.name) throw new Error(`declarePresentationWriter: ${writer.table} already has the presentation writer ${other.name}`);
  presentationWriters.set(writer.name, writer);
  const live = current;
  if (live && !live.readOnly && !live.failed && !live.visit.has(writer.name)) { try { if (live.db.isOpen && !live.db.isTransaction) installVisit(live, writer); } catch { /* not installed: presentationWrite runs unflagged */ } }
}
/** Run the declared writer's ONE statement flagged. Without the guard on this connection (read-only start, failed install, another
 * connection) the statement runs unflagged and moves the epoch as today. The flag never outlives the call. */
export function presentationWrite<T>(db: DatabaseSync, name: string, statement: () => T): T {
  if (!presentationWriters.has(name)) throw new Error(`presentationWrite: no writer named ${name}`);
  if (presenting !== null) throw new Error("presentationWrite: a flagged statement is already running");
  if (current?.db !== db || !current.visit.has(name)) return statement();
  presenting = name; visitToken = 0;
  try { return statement(); } finally { presenting = null; visitToken = 0; }
}
function installVisit(live: Installed, writer: PresentationWriter): void {
  if (!live.tables.includes(writer.table) || !live.tables.includes("memory_recall_epoch")) return;
  const columns = (live.prepare(`SELECT name FROM pragma_table_info('${writer.table}')`).all() as { name: string }[]).map(row => row.name);
  if (!columns.includes(writer.column) || columns.some(column => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))) return;
  // The one epoch move a validated row may drop is the one its own persisted AFTER UPDATE trigger makes in the same row step. Exactly one
  // such trigger must exist, or the allowance could outlive the row and swallow another statement's move: then nothing is installed and
  // the writer runs unflagged.
  const movers = (live.prepare("SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=?").all(writer.table) as { sql: string | null }[])
    .filter(row => /AFTER\s+UPDATE\s+ON/i.test(row.sql ?? "") && /UPDATE\s+memory_recall_epoch\b/i.test(row.sql ?? ""));
  if (movers.length !== 1 || /\bWHEN\b/i.test(movers[0]!.sql ?? "")) return;
  const others = columns.filter(column => column !== writer.column).map(column => `OLD."${column}" IS NOT NEW."${column}"`).join(" OR ") || "0";
  live.exec(`
CREATE TEMP TRIGGER IF NOT EXISTS mem_visit_${writer.name}_abort BEFORE UPDATE ON main.${writer.table}
 WHEN murage_presenting() IS '${writer.name}' AND (${others}) BEGIN SELECT RAISE(ABORT,'memory guard: a presentation write changed another column'); END;
CREATE TEMP TRIGGER IF NOT EXISTS mem_visit_${writer.name}_pass BEFORE UPDATE ON main.${writer.table}
 WHEN murage_presenting() IS '${writer.name}' BEGIN SELECT murage_visit_token(1); END;
CREATE TEMP TRIGGER IF NOT EXISTS mem_visit_other_${writer.table}_i BEFORE INSERT ON main.${writer.table}
 WHEN murage_presenting() IS NOT NULL BEGIN SELECT RAISE(ABORT,'memory guard: a presentation write may only update its column'); END;
CREATE TEMP TRIGGER IF NOT EXISTS mem_visit_other_${writer.table}_d BEFORE DELETE ON main.${writer.table}
 WHEN murage_presenting() IS NOT NULL BEGIN SELECT RAISE(ABORT,'memory guard: a presentation write may only update its column'); END;`);
  live.visit.add(writer.name);
}
const VISIT_EPOCH_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS mem_visit_epoch BEFORE UPDATE ON main.memory_recall_epoch
 WHEN murage_presenting() IS NOT NULL AND murage_visit_token(0)=1 BEGIN SELECT RAISE(IGNORE); END;`;

// ── the TEMP wake table and its triggers (3.1) ──────────────────────────────────────────────────────────────────────────────────────
// The row is what a rollback takes back; the mark tells the bus there is something to drain, so a commit that touched no wake table
// costs no statement at all (a mark left by a rolled-back write costs one empty drain, never a missed one).
// No conflict clause: SQLite replaces a trigger statement's own ON CONFLICT with that of the statement that fired the trigger, so an
// `INSERT OR IGNORE` here would become an ABORT, FAIL or ROLLBACK under an outer `INSERT OR ABORT` (import.ts) and fail the owner's write
// on a topic already recorded. The row is inserted only when it is not there, which no outer clause can change.
const wakeRow = (topic: string) => `INSERT INTO mem_wake(topic) SELECT '${topic}' WHERE NOT EXISTS(SELECT 1 FROM mem_wake WHERE topic='${topic}'); SELECT murage_wake_mark()`;
// ('folded': the job's work was copied into a fold bulk and no slice serves it, revoke-marker.ts. Any state not named here wakes.)
const UNFINISHED_REVOKE = "NEW.state NOT IN ('done','undone','folded')";
const PENDING_JOB = "NEW.status IN ('pending','partial','deferred')";
// Every other job INSERT (born complete or cancelled in capture.ts, complete in bring-in.ts): no worker owes it anything, but it moves
// max(rowid), which is what makes lane I's retention lap due (migration-v2.ts retentionLapDue; CONTRACT-REQ W from memv2-I r4).
const OTHER_JOB_INSERT = "NEW.status NOT IN ('pending','partial','deferred')";
// pending, pending-archive and delete-pending (a forget's removal from the helper's postings: projection.ts DELETIONS), on either column
const CHECKPOINT_DEBT = "NEW.subject_type='system' AND NEW.subject_id='checkpoint-pending'";
const PENDING_PROJECTION = "(NEW.lexical_status LIKE '%pending%' OR NEW.embedding_status LIKE '%pending%')";
const LINK = (row: string) => `${row}.id LIKE 'notebook-link:%'`;
/** Per (table, event), the triggers that say what a row that means work looks like (memory_jobs INSERT has two, by status). A trigger is installed only when its table exists. */
export const WAKE_TRIGGERS: readonly { name: string; table: string; event: "INSERT" | "UPDATE" | "DELETE"; topic: (typeof WAKE_TOPICS)[number]; when?: string }[] = [
  { name: "mem_wake_journal_i", table: "memory_recall_changes", event: "INSERT", topic: "journal" },
  { name: "mem_wake_revoke_i", table: "memory_revoke_jobs", event: "INSERT", topic: "revoke", when: UNFINISHED_REVOKE },
  { name: "mem_wake_revoke_u", table: "memory_revoke_jobs", event: "UPDATE", topic: "revoke", when: UNFINISHED_REVOKE },
  { name: "mem_wake_flip_i", table: "memory_receipt_flips", event: "INSERT", topic: "revoke" },
  { name: "mem_wake_window_i", table: "memory_deny_pending", event: "INSERT", topic: "window" },
  { name: "mem_wake_window_d", table: "memory_deny_pending", event: "DELETE", topic: "window" },
  { name: "mem_wake_window_scope_i", table: "memory_deny_pending_scope", event: "INSERT", topic: "window" },
  { name: "mem_wake_window_scope_d", table: "memory_deny_pending_scope", event: "DELETE", topic: "window" },
  { name: "mem_wake_jobs_i", table: "memory_jobs", event: "INSERT", topic: "jobs", when: PENDING_JOB },
  { name: "mem_wake_jobs_u", table: "memory_jobs", event: "UPDATE", topic: "jobs", when: PENDING_JOB },
  { name: "mem_wake_jobs_born_i", table: "memory_jobs", event: "INSERT", topic: "jobs", when: OTHER_JOB_INSERT },
  { name: "mem_wake_projection_i", table: "memory_projection_receipts", event: "INSERT", topic: "projection", when: PENDING_PROJECTION },
  { name: "mem_wake_projection_u", table: "memory_projection_receipts", event: "UPDATE", topic: "projection", when: PENDING_PROJECTION },
  // checkpoint debt (CONTRACT-REQ E, board line 1517): a born-complete capture job is INSERTed 'complete', so its debt is this binding row
  { name: "mem_wake_debt_i", table: "memory_scope_bindings", event: "INSERT", topic: "jobs", when: CHECKPOINT_DEBT },
  { name: "mem_wake_links_i", table: "memory_scope_bindings", event: "INSERT", topic: "links", when: LINK("NEW") },
  { name: "mem_wake_links_u", table: "memory_scope_bindings", event: "UPDATE", topic: "links", when: `${LINK("OLD")} OR ${LINK("NEW")}` },
  { name: "mem_wake_links_d", table: "memory_scope_bindings", event: "DELETE", topic: "links", when: LINK("OLD") },
];
/** The tables whose writes can mean a wake: a connection whose declared write set holds none of them never owes a notice. */
export const WAKE_TABLES: readonly string[] = [...new Set(WAKE_TRIGGERS.map(trigger => trigger.table))].sort();
function wakeSql(tables: readonly string[]): string {
  const present = new Set(tables);
  return ["CREATE TEMP TABLE IF NOT EXISTS mem_wake(topic TEXT PRIMARY KEY) WITHOUT ROWID;",
    ...WAKE_TRIGGERS.filter(trigger => present.has(trigger.table)).map(trigger =>
      // The body runs once per topic per drain cycle, not once per row: the WHEN clause is a primary-key seek of the TEMP table, so a
      // statement that writes 30,000 journal rows pays 30,000 seeks and one insert (cost follows the change, I3).
      `CREATE TEMP TRIGGER IF NOT EXISTS ${trigger.name} AFTER ${trigger.event} ON main.${trigger.table} WHEN ${trigger.when ? `(${trigger.when}) AND ` : ""}NOT EXISTS(SELECT 1 FROM mem_wake WHERE topic='${trigger.topic}') BEGIN ${wakeRow(trigger.topic)}; END;`)].join("\n");
}

// ── open-time probes (M0, W-ORPHAN-COMMIT) ──────────────────────────────────────────────────────────────────────────────────────────
/** One O(1) read per topic: is there work a crash, a worker's death or an older build may have left? A lane that owns a topic replaces
 * its probe with the exact one (lane A: "a journal row above the applier mark"); the default errs towards raising. */
export type WakeProbe = (db: DatabaseSync) => boolean;
// Every probe is a seek of a key or an index, never a scan: "any row at all" is the first entry at or above the lowest value of the key's
// first column (a TEXT column holds text or blobs, both >= ''; an INTEGER column holds nothing below INT_MIN).
const INT_MIN = "-9223372036854775808";
export const REVOKE_STATE_INDEX = "memory_revoke_jobs_state_kind_phase";
const unfinishedRange = (range: string) => `EXISTS(SELECT 1 FROM memory_revoke_jobs INDEXED BY ${REVOKE_STATE_INDEX} WHERE ${range})`;
/** The revoke open probe: a seek into each gap of the state index around 'done' < 'folded' < 'undone' (BINARY order; state is NOT NULL). */
export const REVOKE_UNFINISHED_PROBE = `SELECT 1 WHERE ${["state<'done'", "state>'done' AND state<'folded'", "state>'folded' AND state<'undone'", "state>'undone'"].map(unfinishedRange).join(" OR ")}`;
const seek = (sql: string): WakeProbe => db => db.prepare(sql).get() !== undefined;
const probes = new Map<string, WakeProbe>([
  ["journal", seek(`SELECT 1 FROM memory_recall_changes WHERE sequence>=${INT_MIN} LIMIT 1`)],
  // Unfinished = every state but done, undone and folded. The registered state index (REVOKE_JOB_STATE, built before listen) is read
  // as the complement of those three values: four range seeks, one statement, the same cost at 10 jobs and 10 million, whichever ids
  // hold the work. Never a read of the id range. A file without the index (not built yet, or deferred) cannot be asked in O(1): the
  // prepare fails and the topic is raised (probeWakes), so the subscriber reads for itself.
  ["revoke", db => db.prepare(REVOKE_UNFINISHED_PROBE).get() !== undefined || db.prepare(`SELECT 1 FROM memory_receipt_flips WHERE thread_no>=${INT_MIN} LIMIT 1`).get() !== undefined],
  ["window", db => db.prepare("SELECT 1 FROM memory_deny_pending WHERE thread_id>='' LIMIT 1").get() !== undefined || db.prepare("SELECT 1 FROM memory_deny_pending_scope WHERE scope_id>='' LIMIT 1").get() !== undefined],
  // a pending job, or any checkpoint-debt binding row: the subject index covers both columns, so this is one seek; the row's state is not
  // read (a revoked debt row a bot deletion left behind would otherwise be walked row by row; it raises instead, and the subscriber reads)
  ["jobs", db => db.prepare("SELECT 1 FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status IN ('pending','partial','deferred','leased') LIMIT 1").get() !== undefined
    || db.prepare("SELECT 1 FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' LIMIT 1").get() !== undefined],
  // The index names the lexical status only; a receipt whose embedding alone is pending has no O(1) seek, so the default raises
  // whenever a lexical status is pending (three seeks, delete-pending included) or any receipt exists at all. Lanes A and E replace it.
  ["projection", db => db.prepare("SELECT 1 FROM memory_projection_receipts INDEXED BY memory_projection_pending WHERE lexical_status IN ('pending','pending-archive','delete-pending') LIMIT 1").get() !== undefined
    || db.prepare("SELECT 1 FROM memory_projection_receipts WHERE record_id>='' LIMIT 1").get() !== undefined],
  ["links", seek("SELECT 1 FROM memory_scope_bindings WHERE id>='notebook-link:' AND id<'notebook-link;' LIMIT 1")],
]);
export function setWakeProbe(topic: WakeTopic, probe: WakeProbe): void { probes.set(topic, probe); }
/** Run every probe on the open connection and raise what it finds. A probe that cannot be read raises its topic (the subscriber then
 * reads for itself). Called at every open, when a worker exits or errors, when an acknowledgement is late and when the helper restarts. */
export function probeWakes(reason = "open"): string[] {
  const live = current;
  if (!live || live.readOnly || live.failed) return [];
  let open = false;
  try { open = live.db.isOpen; } catch { /* closed */ }
  if (!open) return [];
  counters.probes++;
  const found: string[] = [];
  for (const [topic, probe] of probes) {
    let work = true;
    try { work = probe(live.rawView); } catch { work = true; }
    if (work) { found.push(topic); raise(topic); }
  }
  void reason;
  return found;
}

// ── other connections (W-WRITERS, W-ORPHAN-COMMIT) ──────────────────────────────────────────────────────────────────────────────────
export const WAKE_MESSAGE = "memory-wake";
export interface WakeNotice { type: typeof WAKE_MESSAGE; topics: string[] }
/** What each worker that opens the main database writable may write there (W-WRITERS; a name ending in * is a family). None of them
 * holds a table of WAKE_TABLES, so none owes a wake notice; a set that ever takes one must post wakeNotice() after its commits. */
export const WORKER_WRITE_SETS = {
  // exactly the tables its clear steps delete from, and the mark (root-set-reclaim.ts ENGINE_SOURCE; `memory_root_sets` is not in the
  // `memory_root_set_` family, which is why each is named)
  "root-set-reclaim": ["memory_root_set_members", "memory_root_set_parents", "memory_root_sets", "memory_output_roots", "memory_session_roots", "memory_root_set_compaction", "memory_lineage_lsn_meta"],
  "root-set-vacuum": [],
  "optional-index": [],
  "provenance-stamp": [],
  "root-set-compaction": [],
  "inbox-fill": [],
} as const satisfies Record<string, readonly string[]>;
export type WorkerOpener = keyof typeof WORKER_WRITE_SETS;
/** Plain JavaScript for the workers (they are started from source text and cannot import): on the worker's own connection, a TEMP
 * trigger refuses every row write to a memory table outside the declared set. Nothing persists; DDL and pragmas are not row writes. */
export const WRITE_SET_GUARD_JS = [
  "function guardWriteSet(db, opener, writes) {",
  "  var tables = db.prepare(\"SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7)='memory_' AND sql NOT LIKE 'CREATE VIRTUAL%'\").all()",
  "    .map(function (row) { return String(row.name); }).filter(function (name) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name); });",
  "  var events = ['INSERT', 'UPDATE', 'DELETE'], sql = '', refused = 0;",
  "  for (var i = 0; i < tables.length; i++) {",
  "    var table = tables[i], allowed = false;",
  "    for (var j = 0; j < writes.length; j++) { var w = writes[j]; if (w === table || (w.charAt(w.length - 1) === '*' && table.indexOf(w.slice(0, -1)) === 0)) allowed = true; }",
  "    if (allowed) continue;",
  "    refused++;",
  "    for (var k = 0; k < 3; k++) sql += 'CREATE TEMP TRIGGER IF NOT EXISTS mem_writeset_' + table + '_' + events[k].charAt(0).toLowerCase() + ' BEFORE ' + events[k] + ' ON main.' + table",
  "      + \" BEGIN SELECT RAISE(ABORT,'memory write outside the declared set of \" + opener + ': ' + table + \"'); END;\\n\";",
  "  }",
  "  if (sql) db.exec(sql);",
  "  return refused;",
  "}",
].join("\n");
/** The same guard for a worker that is a module (it can import): identical triggers, checked equal by wake-writers.test.ts. */
export function guardWriteSet(db: DatabaseSync, opener: WorkerOpener): number {
  const writes: readonly string[] = WORKER_WRITE_SETS[opener];
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7)='memory_' AND sql NOT LIKE 'CREATE VIRTUAL%'").all() as { name: string }[])
    .map(row => String(row.name)).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  const refused = tables.filter(table => !writes.some(write => write === table || (write.endsWith("*") && table.startsWith(write.slice(0, -1)))));
  const sql = refused.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event =>
    `CREATE TEMP TRIGGER IF NOT EXISTS mem_writeset_${table}_${event[0]!.toLowerCase()} BEFORE ${event} ON main.${table} BEGIN SELECT RAISE(ABORT,'memory write outside the declared set of ${opener}: ${table}'); END;\n`)).join("");
  if (sql) db.exec(sql);
  return refused.length;
}
/** The text a worker source carries straight after it opens `db`. */
export function writeSetGuardCall(opener: WorkerOpener): string {
  return `${WRITE_SET_GUARD_JS}\nguardWriteSet(db, ${JSON.stringify(opener)}, ${JSON.stringify(WORKER_WRITE_SETS[opener])});\n`;
}
export function wakeNotice(topics: readonly string[]): WakeNotice { return { type: WAKE_MESSAGE, topics: [...topics] }; }

interface WorkerLike { on(event: "message", listener: (message: unknown) => void): unknown; on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown }
/** The main thread's side of a writer on another connection (a worker, the helper): its notices are raised, and its exit or error runs
 * the open-time probes again, so a commit followed by the writer's death cannot strand work while this process stays up. */
export function adoptWorker(worker: WorkerLike, name: string): void {
  worker.on("message", message => {
    const notice = message as Partial<WakeNotice> | null;
    if (notice && notice.type === WAKE_MESSAGE && Array.isArray(notice.topics)) for (const topic of notice.topics) if (typeof topic === "string") raise(topic);
  });
  // An opener whose declared set holds no wake table carries the guard that proves it committed none: its exit has no cause to probe
  // (work has a named cause, I2). Any other writer's exit or error asks the tables.
  const writes: readonly string[] | undefined = (WORKER_WRITE_SETS as Record<string, readonly string[]>)[name];
  if (writes && !WAKE_TABLES.some(table => writes.some(write => write === table || (write.endsWith("*") && table.startsWith(write.slice(0, -1)))))) return;
  const lost = () => { probeWakes(`worker:${name}`); };
  worker.on("exit", lost); worker.on("error", lost);
}
let acks = 0;
/** An acknowledgement that must arrive within `ms` (5 s): the returned function is called when it does. If it does not, the probes run
 * (the writer may have committed and gone silent). Uses the deadline registry: no timer of its own. */
export function expectAck(name: string, ms = 5_000): () => void {
  const key = `\u0000ack:${acks++}:${name}`;
  armKey(key, now() + ms, () => { probeWakes(`late:${name}`); });
  return () => { if (deadlines.delete(key)) rearm(); };
}

// ── cross-thread commit notice (3.1, for the checkpointer worker: lane D) ───────────────────────────────────────────────────────────
const noticeCells = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
/** Bumped at the commit observation point; a worker waits on cell 0 with Atomics.waitAsync. */
export function commitNotice(): SharedArrayBuffer { return noticeCells.buffer as SharedArrayBuffer; }

// ── the installer (every open) and the commit observer ──────────────────────────────────────────────────────────────────────────────
export interface RawConnection { exec(sql: string): void; prepare(sql: string): StatementSync }
interface Installed { db: DatabaseSync; exec(sql: string): void; prepare(sql: string): StatementSync; rawView: DatabaseSync; readOnly: boolean; failed: Error | null; tables: string[]; visit: Set<string>; drain: StatementSync | null; drainQueued: boolean; marked: boolean; drainFailures: number; drainHeldUntil: number }
let current: Installed | null = null;
export interface ConnectionEvents { ended(): void; undone(): void }
export interface WakeInstall { installed: boolean; error: Error | null; events: ConnectionEvents | null; probed: string[] }

/** Install the TEMP wake table, its triggers, the guards and the declared memo watches on a freshly opened main connection, then run the
 * probes. Called on EVERY open, outside any transaction, with the connection's un-instrumented exec/prepare (so the install and the
 * drain are outside the background budget and the statement meter). A read-only start installs nothing and memory serves recall as
 * before. A failed install on a writable handle is returned to the caller, which sets memory aside (fail closed): a missing trigger
 * could hide a wake. */
export function installMemoryWake(db: DatabaseSync, raw: RawConnection, options: { readOnly?: boolean } = {}): WakeInstall {
  detachMemoryWake();
  undoEpoch++; // a new handle: no memo of the old one matches (rule a)
  const exec = (sql: string) => { counters.setupStatements++; statementTap?.(sql); raw.exec(sql); };
  const prepare = (sql: string) => { counters.setupStatements++; statementTap?.(sql); return raw.prepare(sql); };
  const live: Installed = { db, exec, prepare, rawView: { prepare, exec } as unknown as DatabaseSync, readOnly: options.readOnly === true, failed: null, tables: [], visit: new Set(), drain: null, drainQueued: false, marked: false, drainFailures: 0, drainHeldUntil: 0 };
  current = live;
  if (live.readOnly) return { installed: false, error: null, events: null, probed: [] };
  try {
    if (db.isTransaction) throw new Error("the memory wake install must run outside a transaction");
    installFault?.();
    db.function("murage_memo_bump", (name: unknown) => { const key = String(name); memoCounts.set(key, (memoCounts.get(key) ?? 0) + 1); return 0; });
    db.function("murage_presenting", () => presenting);
    db.function("murage_wake_mark", () => { live.marked = true; return 0; });
    // (1) grants the token for one validated row; (0) takes it: 1 exactly once
    db.function("murage_visit_token", (grant: unknown) => { if (Number(grant) === 1) { visitToken = 1; return 1; } const had = visitToken; visitToken = 0; return had; });
    live.tables = (prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(row => row.name);
    const present = new Set(live.tables);
    exec(wakeSql(live.tables));
    if (present.has("memory_jobs") && present.has("memory_recall_changes")) exec(JOB_GUARD_SQL);
    if (present.has("memory_recall_epoch")) exec(VISIT_EPOCH_SQL);
    for (const writer of presentationWriters.values()) installVisit(live, writer);
    for (const name of memoTables.keys()) installMemo(live, name);
    live.drain = raw.prepare("DELETE FROM temp.mem_wake RETURNING topic");
    counters.installs++;
  } catch (error) {
    live.failed = error instanceof Error ? error : new Error(String(error));
    memoInstalled.clear();
    return { installed: false, error: live.failed, events: null, probed: [] };
  }
  const events: ConnectionEvents = {
    ended: () => { if (current !== live) return; counters.commits++; commitTap?.(live.marked); Atomics.add(noticeCells, 0, 1); Atomics.notify(noticeCells, 0); sweepDeadlines(); if (live.marked) queueDrain(live); },
    undone: memoUndone,
  };
  // each lane's own part of M0 (the applier mark, a cursor read): after the triggers exist, before the probes raise
  for (const hook of installHooks) { try { hook(db); } catch (error) { logOnce(`install-hook:${errorClass(error)}`, `[memory-wake] an open hook failed: ${error instanceof Error ? error.message : String(error)}`); } }
  return { installed: true, error: null, events, probed: probeWakes("open") };
}
const installHooks = new Set<(db: DatabaseSync) => void>();
/** Run `hook` on every open of a writable connection, after the wake triggers are installed and before the open-time probes (M0: a
 * lane's fixed number of single-row reads; never a scan). Returns the removal. */
export function onWakeInstall(hook: (db: DatabaseSync) => void): () => void { installHooks.add(hook); return () => { installHooks.delete(hook); }; }
let installFault: (() => void) | null = null;
let statementTap: ((sql: string) => void) | null = null;
/** Tests: see the text of every statement the installer and the probes run (G-START: what an open reads, and how). */
export function setWakeStatementTapForTest(tap: ((sql: string) => void) | null): void { statementTap = tap; }
let commitTap: ((marked: boolean) => void) | null = null;
/** Test seam (null by default): called on the committing stack each time the main handle's observer reports a transaction end, with
 *  whether a wake row is marked, so the per-site witness can name the call site that ended it (wake-commit-sites.test.ts). */
export function setWakeCommitTapForTest(tap: ((marked: boolean) => void) | null): void { commitTap = tap; }
/** Tests: make the next installs fail at their first step (the fail-closed path of a writable handle). */
export function setWakeInstallFaultForTest(fault: (() => void) | null): void { installFault = fault; }
/** The process has turned read-only after the open (low disk at a boot step): the connection refuses every write from now on, the TEMP
 * wake table included, so the bus stops draining and probing; nothing can be written, so nothing can be missed. */
export function suspendMemoryWake(db: DatabaseSync): void { if (current?.db === db) current.readOnly = true; }
/** The connection is closing (or was replaced): its TEMP objects die with it, and every memo answers a new number until the next install. */
export function detachMemoryWake(db?: DatabaseSync): void {
  if (db && current?.db !== db) return;
  if (deadlines.delete(DRAIN_RETRY)) rearm();
  current = null; memoInstalled.clear(); undoEpoch++; presenting = null; visitToken = 0;
}
/** Whether the wake bus is installed on this connection (false: read-only start, failed install, another connection). */
export function wakeInstalled(db: DatabaseSync): boolean { return current?.db === db && !current.readOnly && !current.failed; }
function queueDrain(live: Installed): void {
  if (live.drainQueued) return;
  live.drainQueued = true;
  // A microtask: after the committing call has returned, before the event loop goes on. The drain is one statement and only queues
  // work (subscribers run on later turns), and it holds no handle, so the bus is never the reason a process or a test sees a pending
  // immediate. Inside a transaction that spans awaits it finds the transaction open and waits for its end.
  queueMicrotask(() => { live.drainQueued = false; drain(live); });
}
/** Empty temp.mem_wake and raise what it held. Inside a transaction (one held across turns) it waits: that transaction's end queues it
 * again, because the mark stays set until a drain has run. A drain that fails asks the tables themselves once (the probes), then backs
 * off through the deadline registry (1 s doubling to 60 s): a wake table that cannot be read is late, never a loop and never a loss. */
function drain(live: Installed): void {
  if (current !== live || !live.drain || live.readOnly) return;
  let topics: string[];
  try {
    if (!live.db.isOpen || live.db.isTransaction) return;
    if (live.drainHeldUntil > now()) return;
    counters.drains++;
    live.marked = false;
    topics = (live.drain.all() as { topic: string }[]).map(row => row.topic);
    live.drainFailures = 0; live.drainHeldUntil = 0;
  } catch (error) {
    live.marked = true;
    const wait = Math.min(60_000, 1_000 * 2 ** Math.min(16, live.drainFailures++));
    live.drainHeldUntil = now() + wait;
    logOnce(`drain:${errorClass(error)}`, `[memory-wake] drain failed class=${errorClass(error)} retry=${wait}ms: ${error instanceof Error ? error.message : String(error)}`);
    armKey(DRAIN_RETRY, live.drainHeldUntil, () => { live.drainHeldUntil = 0; drain(live); });
    probeWakes("drain-failed");
    return;
  }
  counters.drained += topics.length;
  for (const topic of topics) raise(topic);
}
const DRAIN_RETRY = "\u0000drain";
/** Tests: drain now (the synchronous equivalent of the queued drain). */
export function drainWakesNow(): void { if (current) drain(current); }
/** Tests: forget every subscriber, deadline, memo watch and counter (a fresh module state). */
export function resetWakeForTest(): void {
  subscribers.clear(); owed.clear(); unheard.clear(); deadlines.clear(); rearm();
  memoTables.clear(); memoCounts.clear(); memoInstalled.clear(); presentationWriters.clear(); presenting = null; visitToken = 0;
  faultSink = null; logged.clear(); now = () => Date.now(); installHooks.clear(); installFault = null; statementTap = null; commitTap = null;
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0;
  probes.clear(); for (const [topic, probe] of defaultProbes) probes.set(topic, probe);
}
const defaultProbes = [...probes];
