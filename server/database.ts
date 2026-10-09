import { initializeTeamIdentityTables } from "./team-identities.ts";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { MEMORY_PRE_V2_SNAPSHOT, MEMORY_PRE_V3_SNAPSHOT, MEMORY_PRE_V4_SNAPSHOT, migrateMemorySchema } from "./memory/schema.ts";
import { memoryUpgradeReporter } from "./memory/upgrade-status.ts";
import { finishLineageStorageAtStartup } from "./memory/root-set-compaction.ts";
import { initializeInbox } from "./inbox.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";
import { instrumentDatabase } from "./io-budget.ts";
import { noteIdentityEpoch } from "./memory/provenance-stamp.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { backfillMessageSearchIndex } from "./message-search-index.ts";
import { startupMark } from "./startup-trace.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";

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
    // A new file frees pages back to the disk in small steps (incremental
    // vacuum, root-set-compaction.ts); it can only be chosen before the first table.
    if (freshInstallation) db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
    // The write-ahead log keeps the size of the largest transaction it ever
    // held unless told otherwise (a 3.6 GB log after the 1.0.0 upgrade): after
    // each checkpoint it is cut back to this.
    db.exec("PRAGMA journal_size_limit=67108864; PRAGMA wal_autocheckpoint=1000;");
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
      // A v6 file's root sets are converted, and their space handed back,
      // here, before the server takes traffic: never on the request path.
      // Resumable; a failure here leaves memory whole and is retried next start.
      try { finishLineageStorageAtStartup(db, { onProgress: event => upgrade.storage(event) }); }
      catch (error) { console.warn(`[memory] lineage storage: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }
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
  if (firstOpen) startupMark("database.open");
  bumpMessagesVersion(); // a different file (restore, data-dir switch) invalidates every memoised Inbox answer
  return db;
}

/** Synchronous callbacks only; no transaction may remain open across a promise. */
export function transaction<T>(operation: (db: DatabaseSync) => T): T {
  const db = database();
  const nested = db.isTransaction;
  const point = `memory_tx_${++savepointId}`;
  if (!nested) noteIdentityEpoch(db);
  db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
  try {
    const result = operation(db);
    if (result && typeof (result as {then?: unknown}).then === "function") throw new Error("ASYNC_DATABASE_TRANSACTION");
    db.exec(nested ? `RELEASE ${point}` : "COMMIT"); return result;
  } catch (error) { db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK"); throw error; }
}

export function closeDatabase() {
  try { handle?.close(); } catch { /* idempotent shutdown */ }
  // After the handle closes, so dropping the shm descriptor cannot release a lock SQLite still holds.
  try { releaseIoBudget?.(); } catch { /* idempotent shutdown */ }
  handle = null; handlePath = null; releaseIoBudget = null;
}
