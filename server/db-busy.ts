// SPDX-License-Identifier: AGPL-3.0-or-later
// The serving thread's lock budgets (database.ts invariants 1, 2 and 4), in a leaf module: the slice runners (message tables, branch fill,
// the memory backfills) take the write lock through beginBackground without importing the whole server, and database.ts re-exports all of it.
import type { DatabaseSync } from "node:sqlite";
import { currentBusy, ioBudget, noteBusyTimeout, setBusyWitness } from "./io-budget.ts";
import { oldestLongOp, rateLimited } from "./observe.ts";

/** Owner actions wait this long, then answer 409 "Busy for a moment, try again" (never a 500). */
export const OWNER_BUSY_MS = 1000;
/** What every handle opens with and what a call with no budget waits: the owner budget (it was 5 s). */
export const DEFAULT_BUSY_MS = OWNER_BUSY_MS;
/** Background memory work gives up after this and tries later: no error state, no attempt spent. */
export const BACKGROUND_BUSY_MS = 50;
/** Work that runs on behalf of the memory worker, the idle notebook steps, an after-listen step and the boot recoveries it starts, and the recovery
 * scheduler's passes takes the background budget without asking (transactions, autocommit writes and bare BEGINs alike: io-budget.ts lowerForHold). */
const BACKGROUND_SOURCES: ReadonlySet<string> = new Set(["memory-worker", "memory-idle", "memory-notebook", "startup", "recovery"]);
/** Whether the ambient I/O source is a background one (its writes take BACKGROUND_BUSY_MS). */
export function backgroundSourceNow(): boolean { return BACKGROUND_SOURCES.has(ioBudget.currentSource() ?? ""); }
export { currentBusy };

/** The database was locked past the caller's budget. Background callers treat it as "try later" (no error state, no attempt
 * spent); owner actions surface it as a retryable 503 (code DATABASE_BUSY, Retry-After) with a plain sentence, never a 500 and never a 409 (which clients read as a conflict). */
export class DatabaseBusyError extends Error {
  readonly status = 503;
  readonly code = "DATABASE_BUSY";
  readonly op: string;
  readonly waitedMs: number;
  // (no parameter properties: the server runs as TypeScript with types stripped, which cannot express them)
  constructor(op: string, waitedMs: number) { super("Busy for a moment, try again"); this.op = op; this.waitedMs = waitedMs; }
}
/** Seconds a client should wait before it repeats a request that met DatabaseBusyError (the Retry-After header). */
export const DATABASE_BUSY_RETRY_AFTER_S = 1;
export function isDatabaseBusy(error: unknown): boolean {
  if (error instanceof DatabaseBusyError) return true;
  const e = error as { errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  // SQLITE_BUSY is 5; its extended codes (517 snapshot, 261 recovery) keep 5 in the low byte.
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  return typeof e.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
}
/** A hold on the writer lock that write-bearing requests wait out ASYNCHRONOUSLY (awaitWriterGate, before their first
 * mutation), so the event loop stays free and /api/health and reads keep answering. The revocation index build no longer
 * takes it (it writes in slices of a few tens of milliseconds, revocation-index.ts); it stays as the one place a future
 * long writer would declare itself. The synchronous busy wait is deliberately not raised. */
let writerGate: { promise: Promise<void>; release: () => void } | null = null;
export function holdWritersForIndexBuild(on: boolean) {
  if (on && !writerGate) {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    writerGate = { promise, release };
  } else if (!on && writerGate) {
    const gate = writerGate; writerGate = null; gate.release();
  }
}
/** True while a writer hold is in force. */
export function writersHeldForIndexBuild(): boolean { return writerGate !== null; }
/** Resolves when no writer hold is in force; at once when none is. */
export function awaitWriterGate(): Promise<void> { return writerGate ? writerGate.promise : Promise.resolve(); }
/** The longest an owner-foreground write waits for a writer hold. Past it the write goes on and meets the lock as a
 * retryable "busy" (DATABASE_BUSY, 503 with Retry-After), never a hang. */
export const FOREGROUND_GATE_MAX_MS = 3000;
/** Called by every foreground path that is about to write messages.db (an authenticated request, a turn start, a room turn,
 * a channel delivery, Stop/Cancel). Waits (bounded) while a writer hold is in force; with none it costs nothing. */
export async function awaitWriterGateForeground(): Promise<void> {
  if (!writerGate) return;
  const gate = writerGate.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<void>(resolve => { timer = setTimeout(resolve, FOREGROUND_GATE_MAX_MS); timer.unref?.(); });
  try { await Promise.race([gate, ceiling]); }
  finally { if (timer) clearTimeout(timer); }
}
/** The request-level gate: an owner write ends the index build and waits (bounded) for the lock; GET, HEAD and OPTIONS (health, reads, static files) never wait. */
export function gateWriteRequest(method: string | undefined): Promise<void> {
  return method === "GET" || method === "HEAD" || method === "OPTIONS" ? Promise.resolve() : awaitWriterGateForeground();
}
/** Sets the lock wait of a handle (cached, so a repeat costs nothing). Callers that lower it restore DEFAULT_BUSY_MS in a finally. */
export function setBusy(db: DatabaseSync, requested: number) {
  if (currentBusy(db) === requested) return;
  db.exec(`PRAGMA busy_timeout=${requested}`);
  noteBusyTimeout(db, requested);
}
export function noteBusy(op: string, waited: number) {
  // the process's own declared writer (a VACUUM, a CREATE INDEX) is named as such, never as another process
  rateLimited(`sqlite-busy:${op}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${Math.round(waited)} holder=${writersHeldForIndexBuild() ? "writer-hold" : oldestLongOp() ?? "other-process"}${suppressed ? ` more=${suppressed}` : ""}`);
}

/** Handles whose commit a background slice made with synchronous=NORMAL; FULL comes back when the transaction ends (io-budget.ts calls
 * transactionEnded) or, for a handle the instrumentation does not wrap, on the next microtask. A WAL commit under NORMAL does not fsync
 * under the write lock (the checkpoint does it, outside the lock); a power cut can only lose a slice, which is resumable from its cursor. */
const relaxed = new WeakSet<object>();
function restoreSynchronous(db: DatabaseSync): void {
  if (!relaxed.has(db)) return;
  try {
    if (!db.isOpen) { relaxed.delete(db); return; }
    if (db.isTransaction) { setImmediate(() => restoreSynchronous(db)); return; }
    db.exec("PRAGMA synchronous=FULL");
  } catch { /* closed meanwhile */ }
  relaxed.delete(db);
}
function relaxSynchronous(db: DatabaseSync): void {
  if (relaxed.has(db) || db.isTransaction) return;
  try { db.exec("PRAGMA synchronous=NORMAL"); } catch { return; }
  relaxed.add(db);
  queueMicrotask(() => restoreSynchronous(db));
}
setBusyWitness({ defaultMs: DEFAULT_BUSY_MS, holdMs: BACKGROUND_BUSY_MS, held: () => writersHeldForIndexBuild(), background: backgroundSourceNow, transactionEnded: db => restoreSynchronous(db as DatabaseSync) });

/** BEGIN IMMEDIATE for background work on the serving thread: waits BACKGROUND_BUSY_MS at most, then throws DatabaseBusyError (callers
 * treat it as "try later"); the handle's usual wait is back either way. The slice commits with synchronous=NORMAL (FULL is put back when its
 * transaction ends). Never for an owner request. */
export function beginBackground(db: DatabaseSync, op: string): void {
  relaxSynchronous(db);
  setBusy(db, BACKGROUND_BUSY_MS);
  const started = performance.now();
  try { db.exec("BEGIN IMMEDIATE"); }
  catch (error) {
    restoreSynchronous(db);
    if (isDatabaseBusy(error)) { const waited = performance.now() - started; noteBusy(op, waited); throw new DatabaseBusyError(op, waited); }
    throw error;
  }
  finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
}
/** An autocommit write of background work on a handle (a slice runner's progress mark): within BACKGROUND_BUSY_MS, then DatabaseBusyError
 * ("try later"); the handle's usual wait is back either way. */
export function backgroundWrite<T>(db: DatabaseSync, op: string, run: () => T): T {
  setBusy(db, BACKGROUND_BUSY_MS);
  const started = performance.now();
  try { return run(); }
  catch (error) {
    if (isDatabaseBusy(error) && !(error instanceof DatabaseBusyError)) { const waited = performance.now() - started; noteBusy(op, waited); throw new DatabaseBusyError(op, waited); }
    throw error;
  } finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
}
/** BEGIN IMMEDIATE with the wait the caller's I/O source earns: the background budget under a background source (beginBackground), the
 * handle's usual wait otherwise (an owner path, a start-up migration). For a function both kinds of caller reach. */
export function beginForSource(db: DatabaseSync, op: string): void {
  if (backgroundSourceNow()) beginBackground(db, op);
  else db.exec("BEGIN IMMEDIATE");
}
