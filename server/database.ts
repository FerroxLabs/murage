import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { MEMORY_PRE_V2_SNAPSHOT, migrateMemorySchema } from "./memory/schema.ts";
import { initializeInbox } from "./inbox.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";
import { instrumentDatabase } from "./io-budget.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeMessageTables } from "./message-tables.ts";

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;
let savepointId = 0;

export function database(): DatabaseSync {
  const file = join(DATA_DIR, "messages.db");
  if (handle && handlePath === file && existsSync(file)) return handle;
  closeDatabase();
  const freshInstallation = !existsSync(file);
  closeSync(openSync(file, "a", 0o600));
  try { chmodSync(file, 0o600); } catch { /* matches existing platform behavior */ }
  const db = new DatabaseSync(file);
  instrumentDatabase(db);
  try {
    // secure_delete: a deleted conversation's words are overwritten in the
    // file, not left in free space for anyone reading the raw bytes.
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
    // Backstop for the Inbox disk burn: a sort that outgrows the page cache must
    // spill into memory, not into a temp file opened and closed per statement.
    // cache_size is negative = KiB (32 MiB).
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;");
    initializeMessageTables(db);
    migrateMemorySchema(db, freshInstallation ? "active" : "off", { snapshotPath: join(DATA_DIR, MEMORY_PRE_V2_SNAPSHOT) });
    initializeInbox(db);
    initializeThreadSnooze(db);
    initializeArtifacts(db);
  } catch (error) { db.close(); throw error; }
  handle = db; handlePath = file;
  bumpMessagesVersion(); // a different file (restore, data-dir switch) invalidates every memoised Inbox answer
  return db;
}

/** Synchronous callbacks only; no transaction may remain open across a promise. */
export function transaction<T>(operation: (db: DatabaseSync) => T): T {
  const db = database();
  const nested = db.isTransaction;
  const point = `memory_tx_${++savepointId}`;
  db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
  try {
    const result = operation(db);
    if (result && typeof (result as {then?: unknown}).then === "function") throw new Error("ASYNC_DATABASE_TRANSACTION");
    db.exec(nested ? `RELEASE ${point}` : "COMMIT"); return result;
  } catch (error) { db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK"); throw error; }
}

export function closeDatabase() {
  try { handle?.close(); } catch { /* idempotent shutdown */ }
  handle = null; handlePath = null;
}
