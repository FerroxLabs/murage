import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { migrateMemorySchema } from "./memory/schema.ts";
import { initializeInbox } from "./inbox.ts";
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
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    initializeMessageTables(db);
    migrateMemorySchema(db, freshInstallation ? "active" : "off");
    initializeInbox(db);
    initializeArtifacts(db);
  } catch (error) { db.close(); throw error; }
  handle = db; handlePath = file;
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
