import { initializeTeamIdentityTables } from "./team-identities.ts";
import { chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { MEMORY_PRE_V2_SNAPSHOT, MEMORY_PRE_V3_SNAPSHOT, MEMORY_PRE_V4_SNAPSHOT, lineageRepairPending, migrateMemorySchema, repairOutputRootBackfill } from "./memory/schema.ts";
import { memoryUpgradeReporter } from "./memory/upgrade-status.ts";
import { finishLineageStorageAtStartup } from "./memory/root-set-compaction.ts";
import { initializeInbox } from "./inbox.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";
import { inStatementReusePass, instrumentDatabase, ioBudget } from "./io-budget.ts";
import { noteIdentityEpoch } from "./memory/provenance-stamp.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { browserCheckIndexExists, ensureBrowserCheckIndex, initializeMessageTables } from "./message-tables.ts";
import { startTranscriptBackfill } from "./transcript-backfill.ts";
import { initializeOwnerSends } from "./send-store.ts";
import { backfillMessageSearchIndex } from "./message-search-index.ts";
import { startupMark } from "./startup-trace.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { initializeProjectCardDelivery } from "./project-card-delivery-schema.ts";
import { observeLine, oldestLongOp, rateLimited } from "./observe.ts";
import { startWalMaintenance, stopWalMaintenance } from "./wal-maintenance.ts";

/** A random id per opened connection: every stamp, hold and verdict cache that rests on what a connection saw carries it, so nothing judged on one
 * connection is ever reused on its replacement (two fresh connections can show identical change counters). */
const connectionIds = new WeakMap<object, string>();
export function connectionId(db: object): string {
  let id = connectionIds.get(db);
  if (!id) { id = randomUUID().slice(0, 8); connectionIds.set(db, id); }
  return id;
}
const closeHooks = new Set<() => void>();
/** Runs when the connection closes (or is replaced): holders of per-connection memory clear it. */
export function onDatabaseClose(hook: () => void): void { closeHooks.add(hook); }
/** Set when the lineage repair did not finish: replay of outputs from threads not yet repaired is withheld until a later repair succeeds. */
const unrepaired = new WeakMap<object, { failures: number; nextAt: number; timer?: ReturnType<typeof setTimeout> }>();
export function ancestryUnrepaired(db: object): boolean { return unrepaired.has(db); }
export const REPAIR_RETRY_BASE_MS = 5_000;
export const REPAIR_RETRY_MAX_MS = 300_000;
let repairRetryBase = REPAIR_RETRY_BASE_MS;
/** Test hook: shorten the retry delay. */
export function setRepairRetryBaseMs(ms: number): void { repairRetryBase = ms; }
/** The repair hook, replaceable by a test that injects a failure. */
/** The start-up note's writer, replaceable by a test that records the order of the notes against the work. */
let reporterFactory: typeof memoryUpgradeReporter = memoryUpgradeReporter;
export function setUpgradeReporterForTest(fn: typeof memoryUpgradeReporter | null): void { reporterFactory = fn ?? memoryUpgradeReporter; }
let repairRunner: (db: DatabaseSync, options?: { onProgress?: (progress: { done: number; total: number }) => void }) => unknown = repairOutputRootBackfill;
export function setRepairRunnerForTest(fn: ((db: DatabaseSync, options?: { onProgress?: (progress: { done: number; total: number }) => void }) => unknown) | null): void { repairRunner = fn ?? repairOutputRootBackfill; }
function runRepair(db: DatabaseSync, onProgress?: (progress: { done: number; total: number }) => void): void {
  try {
    repairRunner(db, onProgress ? { onProgress } : undefined);
    const state = unrepaired.get(db);
    if (state?.timer) clearTimeout(state.timer);
    unrepaired.delete(db);
  } catch (error) {
    const state = unrepaired.get(db) ?? { failures: 0, nextAt: 0 };
    state.failures++;
    const delay = Math.min(REPAIR_RETRY_MAX_MS, repairRetryBase * 2 ** Math.min(state.failures - 1, 10));
    state.nextAt = Date.now() + delay;
    if (state.timer) clearTimeout(state.timer);
    unrepaired.set(db, state);
    console.warn(`[memory] lineage backfill repair: ${error instanceof Error ? error.message : String(error)}; replay of earlier outputs is withheld until it succeeds (retry in ${Math.round(delay / 1000)}s)`);
    state.timer = setTimeout(() => { if (handle === db) runRepair(db); }, delay);
    state.timer.unref?.();
  }
}
/** Retry the repair now (also what the background timer runs). */
export function retryAncestryRepair(): void { if (handle) runRepair(handle); }

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;
let releaseIoBudget: (() => void) | null = null;
let savepointId = 0;
let startupMarked = false; // cold-start marks fire for the first open only

export function database(): DatabaseSync {
  const file = join(DATA_DIR, "messages.db");
  // (inside a synchronous pass the file cannot be swapped, so the existence check is not repeated for each of its thousands of statements)
  if (handle && handlePath === file && (inStatementReusePass() || existsSync(file))) return handle;
  closeDatabase();
  const firstOpen = !startupMarked; startupMarked = true;
  if (firstOpen) startupMark("database.begin");
  const freshInstallation = !existsSync(file);
  closeSync(openSync(file, "a", 0o600));
  try { chmodSync(file, 0o600); } catch { /* matches existing platform behavior */ }
  const db = new DatabaseSync(file);
  const release = instrumentDatabase(db);
  try {
    // secure_delete: a deleted conversation's words are overwritten in the
    // file, not left in free space for anyone reading the raw bytes.
    // A new file frees pages back to the disk in small steps (incremental
    // vacuum, root-set-compaction.ts); it can only be chosen before the first table.
    if (freshInstallation) db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;"); // (the wait first: a checkpointer still leaving the file may hold it for a moment)
    // The write-ahead log keeps the size of the largest transaction it ever
    // held unless told otherwise (a 3.6 GB log after the 1.0.0 upgrade). Zero:
    // the first commit after a checkpoint has copied the whole log restarts it
    // and cuts the file back to its own frames, inside an ordinary write, so no
    // second connection ever has to take the writer lock to shrink it
    // (wal-maintenance.ts).
    db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=1000;`);
    busyNow.set(db, DEFAULT_BUSY_MS);
    // Backstop for the Inbox disk burn: a sort that outgrows the page cache must
    // spill into memory, not into a temp file opened and closed per statement.
    // cache_size is negative = KiB (32 MiB).
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;");
    const upgrade = reporterFactory(DATA_DIR, basename);
    // Everything below that can read the whole history on a used installation runs AFTER the note is published and
    // keeps it fresh: the open-card index (a scan of every message row on a file from before it existed), memory
    // validation that has to read whole tables, the schema upgrade, the output-lineage repair (on EVERY start while
    // it is unfinished, not only the first) and the pending-note index. The shell extends its boot budget only while
    // a note says the upgrade is running, so none of these may run before it.
    try { initializeMessageTables(db, { onStart: progress => upgrade.indexing(progress), onChunk: progress => upgrade.indexing(progress) }); }
    catch (error) { upgrade.done(); throw error; }
    try {
      migrateMemorySchema(db, freshInstallation ? "active" : "off", { snapshotPath: join(DATA_DIR, MEMORY_PRE_V2_SNAPSHOT), snapshotV2Path: join(DATA_DIR, MEMORY_PRE_V3_SNAPSHOT), snapshotV3Path: join(DATA_DIR, MEMORY_PRE_V4_SNAPSHOT), onPhase: event => upgrade.phase(event), onValidating: () => upgrade.checking(), onBlocking: (first, from) => upgrade.blocking(first, from) });
      // After a v7 -> v8 upgrade the revocation index is filled in the background once
      // the server listens (startRevocationIndexBackfill, started from index.ts); until it
      // is ready, revocation reads every receipt's JSON, so startup never waits on it.
      // A v6 file's root sets are converted, and their space handed back,
      // here, before the server takes traffic: never on the request path.
      // Resumable; a failure here leaves memory whole and is retried next start.
      // Legacy replies backfilled by an earlier build of this branch by row order are widened to what their parent chain proves (once per file).
      // A failure does not stop startup for other features, but replay of outputs stays withheld (fail closed) until a retry succeeds.
      if (lineageRepairPending(db)) upgrade.repairing({ done: 0, total: 0 });
      runRepair(db, progress => upgrade.repairing(progress));
      try { finishLineageStorageAtStartup(db, { onProgress: event => upgrade.storage(event) }); }
      catch (error) { console.warn(`[memory] lineage storage: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }
      // The pending-note index reads every message row once on an existing
      // installation, so it is built here, under the start-up screen and the
      // shell's extended boot clock, never before the reporter starts. The
      // index itself is the done marker. A failure leaves it absent; boot
      // recovery then waits for the next start (store.ts, reconcile).
      try {
        if (!browserCheckIndexExists(db)) { upgrade.indexing(); ensureBrowserCheckIndex(db); }
      } catch (error) { console.warn(`[messages] browser-check index: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }
      upgrade.done();
    } catch (error) { upgrade.blocked(error); throw error; }
    // After the memory upgrade, so its pre-migration copy never carries the index.
    // A restored/older/interrupted database is brought up to date here; until it
    // is, searchMessages() scans instead of trusting the index.
    backfillMessageSearchIndex(db);
    initializeInbox(db);
    initializeThreadSnooze(db);
    initializeArtifacts(db);
    initializeProjectTables(db); initializeTeamIdentityTables(db); initializeMobilePush(db); initializeSharedRequestProvenance(db); initializeProjectCardDelivery(db); initializeOwnerSends(db);
  } catch (error) { try { db.close(); } finally { release(); } throw error; }
  connectionId(db);
  handle = db; handlePath = file; releaseIoBudget = release;
  // After migration and before traffic: one TRUNCATE gives back a high-water WAL, then the sizes are logged.
  startupStorage(db, file, firstOpen);
  // From here the checkpoints run in a worker thread (PASSIVE only; it never takes the writer lock). The connection keeps
  // wal_autocheckpoint=1000 until the worker is ready, and goes back to it if the worker ever fails.
  startWalMaintenance(file, {
    setAutocheckpoint: pages => { if (handle === db) db.exec(`PRAGMA wal_autocheckpoint=${Math.trunc(pages)}`); },
    nudge: async () => {
      if (handle !== db || db.isTransaction) return false;
      await awaitWriterGate();
      if (handle !== db) return false;
      try {
        withBusyBudget(BACKGROUND_BUSY_MS, "wal-scrub", d => {
          // the same version written again: one page-1 frame, which restarts a fully copied log
          const version = Number((d.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
          d.exec(`PRAGMA user_version=${Math.trunc(version)}`);
        });
        return true;
      } catch { return false; }
    },
  });
  // The derived transcript tables of an older database fill in the background
  // (bounded chunks, event loop free between them), never on the request path.
  startTranscriptBackfill(db, () => handle === db);
  if (firstOpen) startupMark("database.open");
  bumpMessagesVersion(); // a different file (restore, data-dir switch) invalidates every memoised Inbox answer
  return db;
}

/** Zero: see the comment at the pragma above. */
export const JOURNAL_SIZE_LIMIT_BYTES = 0;
/** Owner actions wait this long, then answer 409 "Busy for a moment, try again" (never a 500). */
export const OWNER_BUSY_MS = 1000;
/** What every handle opens with and what a call with no budget waits: the owner budget (it was 5 s). */
export const DEFAULT_BUSY_MS = OWNER_BUSY_MS;
/** Background memory work gives up after this and tries later: no error state, no attempt spent. */
export const BACKGROUND_BUSY_MS = 50;
/** Work that runs on behalf of the memory worker takes the background budget without asking. */
const BACKGROUND_SOURCES: ReadonlySet<string> = new Set(["memory-worker", "memory-idle"]);
const busyNow = new WeakMap<object, number>();

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
/** Wrap a background writer (a timer tick, a sweep, a retry loop): it waits ASYNCHRONOUSLY for the revocation index build
 * to release the writer lock, then runs. A lock failure that still gets through (the build started mid-run, or another
 * process) is skipped quietly for the next tick, and any other error is logged: a background writer never becomes an
 * unhandled rejection, which would end the server. Work is not lost: periodic writers run again on their next tick and
 * one-shot callers use `requeueBusy`. */
export function guardedWriter(op: string, run: () => unknown): () => Promise<void> {
  let running = false; // a tick that is still waiting or running is not stacked on by the next one
  return async () => {
    if (running) return;
    running = true;
    try { await awaitWriterGate(); await run(); }
    catch (error) {
      if (isDatabaseBusy(error)) noteBusy(op, 0);
      else console.error(`[background] ${op} failed:`, error);
    } finally { running = false; }
  };
}
function setBusy(db: DatabaseSync, requested: number) {
  if (busyNow.get(db) === requested) return;
  db.exec(`PRAGMA busy_timeout=${requested}`);
  busyNow.set(db, requested);
}
function noteBusy(op: string, waited: number) {
  rateLimited(`sqlite-busy:${op}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${Math.round(waited)} holder=${oldestLongOp() ?? "other-process"}${suppressed ? ` more=${suppressed}` : ""}`);
}
export interface TransactionOptions {
  /** A fixed word naming the operation in `[sqlite]` lines. */
  op?: string;
  /** Lock wait for this call. Omitted: the handle's usual wait (1 s; background memory work takes 50 ms). With a value, a lock past it throws DatabaseBusyError. */
  busyMs?: number;
}
/** Run a statement-level write (no transaction of its own) under a lock budget. */
export function withBusyBudget<T>(busyMs: number, op: string, run: (db: DatabaseSync) => T): T {
  const db = database();
  setBusy(db, busyMs);
  const started = performance.now();
  try { return run(db); }
  catch (error) {
    if (isDatabaseBusy(error)) { const waited = performance.now() - started; noteBusy(op, waited); throw new DatabaseBusyError(op, waited); }
    throw error;
  } finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
}

/** Synchronous callbacks only; no transaction may remain open across a promise. */
export function transaction<T>(operation: (db: DatabaseSync) => T, options: TransactionOptions = {}): T {
  const db = database();
  const nested = db.isTransaction;
  const point = `memory_tx_${++savepointId}`;
  if (!nested) noteIdentityEpoch(db);
  const busyMs = options.busyMs ?? (BACKGROUND_SOURCES.has(ioBudget.currentSource() ?? "") ? BACKGROUND_BUSY_MS : undefined);
  const budgeted = !nested && busyMs !== undefined;
  if (budgeted) setBusy(db, busyMs!);
  const waitStart = performance.now();
  try {
    try { db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE"); }
    catch (error) {
      if (budgeted && isDatabaseBusy(error)) {
        const waited = performance.now() - waitStart, op = options.op ?? "transaction";
        noteBusy(op, waited);
        throw new DatabaseBusyError(op, waited);
      }
      throw error;
    }
    if (budgeted) { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* restored by the finally */ } }
    try {
      const result = operation(db);
      if (result && typeof (result as {then?: unknown}).then === "function") throw new Error("ASYNC_DATABASE_TRANSACTION");
      db.exec(nested ? `RELEASE ${point}` : "COMMIT"); return result;
    } catch (error) { db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK"); throw error; }
  } finally {
    if (budgeted) { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
  }
}

function megabytes(bytes: number) { return Math.round(bytes / 1048576); }
function fileBytes(path: string) { try { return statSync(path).size; } catch { return 0; } }
/** `[sqlite] storage file= wal= freelist=` (megabytes). */
export function storageLine(db: DatabaseSync, file: string): string {
  let freelist = 0;
  try {
    const pages = Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0), size = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 4096);
    freelist = pages * size;
  } catch { /* closed or busy: report 0 */ }
  return `[sqlite] storage file=${megabytes(fileBytes(file))} wal=${megabytes(fileBytes(`${file}-wal`))} freelist=${megabytes(freelist)}`;
}
let storageTimer: ReturnType<typeof setInterval> | undefined;
const WAL_REPORT_BYTES = 256 * 1024 * 1024;
function startupStorage(db: DatabaseSync, file: string, log: boolean) {
  try {
    setBusy(db, OWNER_BUSY_MS);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { setBusy(db, DEFAULT_BUSY_MS); }
  } catch (error) { observeLine(`[sqlite] start checkpoint skipped: ${isDatabaseBusy(error) ? "busy" : "error"}`); }
  if (log) observeLine(storageLine(db, file));
  if (storageTimer) clearInterval(storageTimer);
  storageTimer = setInterval(() => {
    if (handle !== db || fileBytes(`${file}-wal`) <= WAL_REPORT_BYTES) return;
    observeLine(storageLine(db, file));
  }, 3_600_000);
  storageTimer.unref();
}

export function closeDatabase() {
  if (storageTimer) { clearInterval(storageTimer); storageTimer = undefined; }
  if (handle) { const state = unrepaired.get(handle); if (state?.timer) clearTimeout(state.timer); unrepaired.delete(handle); }
  for (const hook of closeHooks) { try { hook(); } catch { /* idempotent shutdown */ } }
  try { handle?.close(); } catch { /* idempotent shutdown */ }
  // After the server connection has closed, so the checkpointer's is the last one and not this one.
  void stopWalMaintenance();
  // After the handle closes, so dropping the shm descriptor cannot release a lock SQLite still holds.
  try { releaseIoBudget?.(); } catch { /* idempotent shutdown */ }
  handle = null; handlePath = null; releaseIoBudget = null;
}
