import { initializeTeamIdentityTables } from "./team-identities.ts";
import { chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { MEMORY_PRE_V2_SNAPSHOT, MEMORY_PRE_V3_SNAPSHOT, MEMORY_PRE_V4_SNAPSHOT, migrateMemorySchema } from "./memory/schema.ts";
import { memoryUpgradeReporter } from "./memory/upgrade-status.ts";
import { initializeInbox } from "./inbox.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";
import { instrumentDatabase, ioBudget } from "./io-budget.ts";
import { noteIdentityEpoch } from "./memory/provenance-stamp.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { backfillMessageSearchIndex } from "./message-search-index.ts";
import { startupMark } from "./startup-trace.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { observeLine, oldestLongOp, rateLimited } from "./observe.ts";

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;
let releaseIoBudget: (() => void) | null = null;
let savepointId = 0;
let startupMarked = false; // cold-start marks fire for the first open only

export function database(): DatabaseSync {
  const file = join(DATA_DIR, "messages.db");
  if (handle && handlePath === file && existsSync(file)) return handle;
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
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON;");
    // A WAL file never shrinks after a checkpoint resets it; this caps what stays on disk (PROPOSAL-v2 10.3).
    db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES};`);
    busyNow.set(db, DEFAULT_BUSY_MS);
    // Backstop for the Inbox disk burn: a sort that outgrows the page cache must
    // spill into memory, not into a temp file opened and closed per statement.
    // cache_size is negative = KiB (32 MiB).
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;");
    initializeMessageTables(db);
    // The desktop shell watches this note while the (synchronous) upgrade runs,
    // and shows why it stopped if it does; see memory/upgrade-status.ts.
    const upgrade = memoryUpgradeReporter(DATA_DIR, basename);
    try {
      migrateMemorySchema(db, freshInstallation ? "active" : "off", { snapshotPath: join(DATA_DIR, MEMORY_PRE_V2_SNAPSHOT), snapshotV2Path: join(DATA_DIR, MEMORY_PRE_V3_SNAPSHOT), snapshotV3Path: join(DATA_DIR, MEMORY_PRE_V4_SNAPSHOT), onPhase: event => upgrade.phase(event) });
      upgrade.done();
    } catch (error) { upgrade.blocked(error); throw error; }
    // After the memory upgrade, so its pre-migration copy never carries the index.
    // A restored/older/interrupted database is brought up to date here; until it
    // is, searchMessages() scans instead of trusting the index.
    backfillMessageSearchIndex(db);
    initializeInbox(db);
    initializeThreadSnooze(db);
    initializeArtifacts(db);
    initializeProjectTables(db); initializeTeamIdentityTables(db); initializeMobilePush(db); initializeSharedRequestProvenance(db);
  } catch (error) { try { db.close(); } finally { release(); } throw error; }
  handle = db; handlePath = file; releaseIoBudget = release;
  // After migration and before traffic: one TRUNCATE gives back a high-water WAL, then the sizes are logged.
  startupStorage(db, file, firstOpen);
  if (firstOpen) startupMark("database.open");
  bumpMessagesVersion(); // a different file (restore, data-dir switch) invalidates every memoised Inbox answer
  return db;
}

export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
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
 * spent); owner actions surface it as a 409 with a plain sentence, never a 500. */
export class DatabaseBusyError extends Error {
  readonly status = 409;
  readonly code = "DATABASE_BUSY";
  readonly op: string;
  readonly waitedMs: number;
  // (no parameter properties: the server runs as TypeScript with types stripped, which cannot express them)
  constructor(op: string, waitedMs: number) { super("Busy for a moment, try again"); this.op = op; this.waitedMs = waitedMs; }
}
export function isDatabaseBusy(error: unknown): boolean {
  if (error instanceof DatabaseBusyError) return true;
  const e = error as { errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  // SQLITE_BUSY is 5; its extended codes (517 snapshot, 261 recovery) keep 5 in the low byte.
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  return typeof e.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
}
function setBusy(db: DatabaseSync, ms: number) {
  if (busyNow.get(db) === ms) return;
  db.exec(`PRAGMA busy_timeout=${ms}`);
  busyNow.set(db, ms);
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
  try { handle?.close(); } catch { /* idempotent shutdown */ }
  // After the handle closes, so dropping the shm descriptor cannot release a lock SQLite still holds.
  try { releaseIoBudget?.(); } catch { /* idempotent shutdown */ }
  handle = null; handlePath = null; releaseIoBudget = null;
}
