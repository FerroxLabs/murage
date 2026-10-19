// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The durable half of the connected-app operation ledger
// (server/connected-app-operations.ts).
//
// An action's intent is written here, and flushed (synchronous=FULL), BEFORE
// anything is sent to the app. If Murage stops while an action is on its way,
// the record is still here at the next start, and that action is treated as
// "not known whether it finished" until the bot checks the app. Only small
// identity records are kept: never the request, never the app's answer.
//
// It lives in its own small file beside messages.db so the transcript
// database and its backup shape are untouched.
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConnectedAppRequirement } from "../shared/connected-app-calls.ts";
import { InstallationSnapshotError } from "./installation-snapshot-error.ts";

/** Owner part of a scope whose account is not known until it is reconnected (see detachRestoredLedgerAccounts). */
export const RESTORED_ACCOUNT_OWNER = "*";
/** Whether a stored scope matches the live scope: equal, or a restored scope for the same bot that matches any account. */
export function scopeMatches(stored: string, live: string): boolean {
  if (stored === live) return true;
  const tail = `|${RESTORED_ACCOUNT_OWNER}`;
  return stored.endsWith(tail) && live.startsWith(`${stored.slice(0, -tail.length)}|`);
}

export interface JournalRecord {
  handle: string;
  scope: string;
  key: string;
  label: string | undefined;
  startedAt: number;
  /** pending: on its way. unknown: left, no answer known. answered: the app answered. */
  state: "pending" | "unknown" | "answered";
  /** Why an unknown outcome is unknown. */
  cause?: "no-answer" | "interrupted" | "result-gone";
  deliveredAt?: number;
  requirements: ConnectedAppRequirement[];
  /** Whether `requirements` names everything the action used. False reads as "unknown" to a restricted bot. */
  requirementsComplete: boolean;
}

export interface OperationJournal {
  load(): JournalRecord[];
  /** Insert or replace; must be durable when it returns, or throw. */
  put(record: JournalRecord): void;
  remove(handle: string): void;
  /** Several writes and removals in ONE transaction: all of them or none. */
  apply(changes: { put: JournalRecord[]; remove: string[] }): void;
  /** Tests only. */
  clear(): void;
}

interface Row {
  handle: string; scope: string; key: string; label: string | null; started_at: number;
  state: string; cause: string | null; delivered_at: number | null; requirements: string; requirements_complete: number | null;
}

function recordOfRow(row: Row): JournalRecord {
  return {
    handle: row.handle, scope: row.scope, key: row.key, label: row.label ?? undefined, startedAt: row.started_at,
    state: row.state as JournalRecord["state"],
    ...(row.cause ? { cause: row.cause as NonNullable<JournalRecord["cause"]> } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    requirements: JSON.parse(row.requirements) as ConnectedAppRequirement[],
    // A row written before completeness was recorded never says it was whole (the old extractor
    // silently left out unnamed rows), so it is incomplete until proven otherwise.
    requirementsComplete: row.requirements_complete === 1,
  };
}

/** A SQLite file at `file`, opened on first use. */
export class SqliteOperationJournal implements OperationJournal {
  private readonly file: string;
  private db: DatabaseSync | null = null;

  constructor(file: string) {
    this.file = file;
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.file, "a", 0o600));
    try { chmodSync(this.file, 0o600); } catch { /* platform without modes */ }
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
      db.exec(`CREATE TABLE IF NOT EXISTS connected_app_ops (
        handle TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, label TEXT, started_at INTEGER NOT NULL,
        state TEXT NOT NULL, cause TEXT, delivered_at INTEGER, requirements TEXT NOT NULL, requirements_complete INTEGER)`);
      // A ledger written before provenance was recorded: add the column (NULL reads as "complete if it names anything").
      const columns = db.prepare("PRAGMA table_info(connected_app_ops)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "requirements_complete")) db.exec("ALTER TABLE connected_app_ops ADD COLUMN requirements_complete INTEGER");
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  load(): JournalRecord[] {
    const rows = this.run((db) => db.prepare("SELECT * FROM connected_app_ops ORDER BY started_at").all()) as unknown as Row[];
    return rows.map(recordOfRow);
  }

  /** One retry on a fresh handle: the file may have been removed or replaced under an open one. */
  private run<T>(work: (db: DatabaseSync) => T): T {
    try {
      return work(this.open());
    } catch (error) {
      try { this.db?.close(); } catch { /* already closed */ }
      this.db = null;
      return work(this.open());
    }
  }

  private static write(db: DatabaseSync, record: JournalRecord): void {
    db.prepare(
      "INSERT OR REPLACE INTO connected_app_ops (handle,scope,key,label,started_at,state,cause,delivered_at,requirements,requirements_complete) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(record.handle, record.scope, record.key, record.label ?? null, record.startedAt, record.state, record.cause ?? null, record.deliveredAt ?? null, JSON.stringify(record.requirements), record.requirementsComplete ? 1 : 0);
  }

  put(record: JournalRecord): void {
    this.run((db) => SqliteOperationJournal.write(db, record));
  }

  remove(handle: string): void {
    this.run((db) => db.prepare("DELETE FROM connected_app_ops WHERE handle = ?").run(handle));
  }

  apply(changes: { put: JournalRecord[]; remove: string[] }): void {
    if (!changes.put.length && !changes.remove.length) return;
    this.run((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const record of changes.put) SqliteOperationJournal.write(db, record);
        const drop = db.prepare("DELETE FROM connected_app_ops WHERE handle = ?");
        for (const handle of changes.remove) drop.run(handle);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* the handle is closed and retried by run() */ }
        throw error;
      }
    });
  }

  clear(): void {
    this.run((db) => db.exec("DELETE FROM connected_app_ops"));
  }

  /** Release the file (a restore merges into a ledger that must be closed before it is moved). */
  close(): void {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }
}

/** What the relay saw the app complete for a turn (server/connected-app-receipts.ts), kept beside the operation ledger so a
 * restart between a send and the end of its turn still finds the receipt. Identity only: thread, bot, turn, action classes. */
export interface StoredReceipt { threadId: string; botId: string; generation: string; classes: string[]; at: number; key?: string; dispatchedAt?: number; turnId?: string }

export class SqliteReceiptStore {
  private readonly file: string;
  constructor(file: string) { this.file = file; }

  /** Opened for one piece of work and closed again: receipts are rare, and the ledger file may be moved by a restore, so no handle is held. */
  private run<T>(work: (db: DatabaseSync) => T): T {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.file, "a", 0o600));
    try { chmodSync(this.file, 0o600); } catch { /* platform without modes */ }
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA busy_timeout=1000;");
      db.exec(`CREATE TABLE IF NOT EXISTS connected_app_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, generation TEXT NOT NULL, classes TEXT NOT NULL, at INTEGER NOT NULL)`);
      const columns = (db.prepare("PRAGMA table_info(connected_app_receipts)").all() as Array<{ name: string }>).map((column) => column.name);
      if (!columns.includes("op_key")) db.exec("ALTER TABLE connected_app_receipts ADD COLUMN op_key TEXT");
      if (!columns.includes("dispatched_at")) db.exec("ALTER TABLE connected_app_receipts ADD COLUMN dispatched_at INTEGER");
      // The provider turn that owns the receipt; the reply check matches on it and nothing else survives a restart.
      // Rows written before this column (dev builds of this lane only; no release carries the table) keep turn_id
      // NULL and so never match any turn. That is intended: a receipt with no known owner is nobody's. Do not add a
      // data migration that fills it from a timestamp; a time says when, never whose.
      if (!columns.includes("turn_id")) db.exec("ALTER TABLE connected_app_receipts ADD COLUMN turn_id TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS connected_app_receipts_op_key ON connected_app_receipts(op_key)");
      db.exec("CREATE INDEX IF NOT EXISTS connected_app_receipts_turn ON connected_app_receipts(thread_id, turn_id)");
      return work(db);
    } finally { db.close(); }
  }

  /** Receipts newer than `cutoff`, oldest first; older ones are dropped. */
  load(cutoff: number): StoredReceipt[] {
    return this.run((db) => {
      db.prepare("DELETE FROM connected_app_receipts WHERE at < ?").run(cutoff);
      const rows = db.prepare("SELECT thread_id, bot_id, generation, classes, at, op_key, dispatched_at, turn_id FROM connected_app_receipts ORDER BY id").all() as unknown as Array<{ thread_id: string; bot_id: string; generation: string; classes: string; at: number; op_key: string | null; dispatched_at: number | null; turn_id: string | null }>;
      return rows.map((row) => ({
        threadId: row.thread_id, botId: row.bot_id, generation: row.generation, classes: JSON.parse(row.classes) as string[], at: row.at,
        ...(row.op_key ? { key: row.op_key } : {}), ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
        ...(row.turn_id ? { turnId: row.turn_id } : {}),
      }));
    });
  }

  /** Keep one receipt (a receipt with the same key is already kept), drop those older than `cutoff`, and keep at most `max`, the newest. */
  add(receipt: StoredReceipt, cutoff: number, max: number): void {
    this.run((db) => {
      db.prepare("INSERT OR IGNORE INTO connected_app_receipts (thread_id,bot_id,generation,classes,at,op_key,dispatched_at,turn_id) VALUES (?,?,?,?,?,?,?,?)")
        .run(receipt.threadId, receipt.botId, receipt.generation, JSON.stringify(receipt.classes), receipt.at, receipt.key ?? null, receipt.dispatchedAt ?? null, receipt.turnId ?? null);
      db.prepare("DELETE FROM connected_app_receipts WHERE at < ?").run(cutoff);
      db.prepare("DELETE FROM connected_app_receipts WHERE id <= (SELECT id FROM connected_app_receipts ORDER BY id DESC LIMIT 1 OFFSET ?)").run(max);
    });
  }

  /** Name the turn of a receipt kept before its turn was known (the call reached the relay before the turn was bound). Never renames one. */
  bindTurn(key: string, turnId: string): void {
    this.run((db) => { db.prepare("UPDATE connected_app_receipts SET turn_id=? WHERE op_key=? AND turn_id IS NULL").run(turnId, key); });
  }
}

/** Every record of a ledger file without opening it for writing. A missing file or a file with no ledger table holds none. */
export function readJournalFile(file: string): JournalRecord[] {
  if (!existsSync(file)) return [];
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("UNSAFE_CONNECTED_APP_LEDGER");
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='connected_app_ops'").get()) return [];
    const rows = db.prepare("SELECT * FROM connected_app_ops ORDER BY started_at").all() as unknown as Row[];
    return rows.map(recordOfRow);
  } finally { db.close(); }
}

/** Whether a record still guards against repeating its action. */
const unresolved = (record: JournalRecord) => record.state === "pending" || record.state === "unknown";

/**
 * Restoring over an installation that already has a ledger: bring that
 * installation's records into the restored one, so no unresolved action is
 * ever forgotten. A pending record becomes unknown (it was on its way when
 * the computer stopped). When both sides hold the same handle the unresolved
 * one wins; the restored side wins a tie. Returns how many records were added.
 */
export function mergeDestinationConnectedLedger(destination: string, candidate: string): { merged: number; history: "backup-only" | "destination-ledger-preserved" } {
  let theirs: JournalRecord[];
  // A ledger that cannot be read cannot be carried over, and replacing the installation without
  // its records would drop the guards against repeating an unresolved action: the restore stops
  // and the current installation stays as it is.
  try { theirs = readJournalFile(join(destination, "connected-app-ledger.db")); }
  catch (error) { throw new InstallationSnapshotError("CONNECTED_APP_LEDGER_UNREADABLE", { cause: error, path: "connected-app-ledger.db" }); }
  if (!theirs.length) return { merged: 0, history: "backup-only" };
  const target = new SqliteOperationJournal(join(candidate, "connected-app-ledger.db"));
  try {
    const mine = new Map(target.load().map((record) => [record.handle, record]));
    const put: JournalRecord[] = [];
    for (const record of theirs) {
      const held = mine.get(record.handle);
      if (held && (unresolved(held) || !unresolved(record))) continue;
      put.push(record.state === "pending" ? { ...record, state: "unknown", cause: "interrupted" } : record);
    }
    target.apply({ put, remove: [] });
    return { merged: put.length, history: "destination-ledger-preserved" };
  } finally { target.close(); }
}

/**
 * A restore creates fresh credentials, so the account a record was made under cannot be
 * recognised afterwards (scopes carry a credential hash that changes). Every record of
 * the restored ledger (pending, unknown, or answered and still guarding) is therefore bound to its bot alone: it keeps blocking the
 * same app action with the same arguments for whichever account is connected, until it is
 * resolved or ages out.
 */
export function detachRestoredLedgerAccounts(candidate: string): number {
  const file = join(candidate, "connected-app-ledger.db");
  if (!existsSync(file)) return 0;
  const journal = new SqliteOperationJournal(file);
  try {
    const put: JournalRecord[] = [];
    for (const record of journal.load()) {
      const cut = record.scope.lastIndexOf("|");
      if (cut < 0 || record.scope.slice(cut + 1) === RESTORED_ACCOUNT_OWNER) continue;
      put.push({ ...record, scope: `${record.scope.slice(0, cut)}|${RESTORED_ACCOUNT_OWNER}` });
    }
    journal.apply({ put, remove: [] });
    return put.length;
  } finally { journal.close(); }
}

export function defaultJournalFile(dataDir: string): string {
  return join(dataDir, "connected-app-ledger.db");
}
