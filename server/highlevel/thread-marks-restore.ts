// Offline restore helper: both installations are held by the restore/selection
// leases. No runtime Store or configuration imports belong here.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "../message-tables.ts";
import { initializeHighLevelThreadMarks } from "./thread-marks.ts";

function databaseExists(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("UNSAFE_HIGHLEVEL_MARK_LEDGER");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Marks are permanent even when a backup predates them. Any inability to
 * preserve them throws before installation replacement or selection. */
export function mergeDestinationHighLevelMarks(destination: string, candidate: string): number {
  const original = join(destination, "messages.db"), target = join(candidate, "messages.db");
  if (!databaseExists(original)) return 0;
  const source = new DatabaseSync(original, { readOnly: true });
  let rows: Array<{ thread_id: string; marked_at: number }>;
  try {
    // A readable pre-HighLevel installation has no marks; an unreadable DB
    // cannot prove that and must never be treated as an empty ledger.
    if (!source.prepare("SELECT 1 FROM sqlite_schema WHERE name='highlevel_thread_marks'").get()) return 0;
    const columns = source.prepare("PRAGMA table_info(highlevel_thread_marks)").all();
    if (columns.length !== 2 || columns[0].name !== "thread_id" || columns[0].type !== "TEXT" || columns[0].pk !== 1
      || columns[1].name !== "marked_at" || columns[1].type !== "INTEGER" || columns[1].notnull !== 1) throw new Error("INVALID_HIGHLEVEL_MARK_LEDGER");
    const values = source.prepare("SELECT thread_id, marked_at FROM highlevel_thread_marks").all();
    rows = values.map(row => {
      if (typeof row.thread_id !== "string" || !row.thread_id || typeof row.marked_at !== "number" || !Number.isSafeInteger(row.marked_at)) throw new Error("INVALID_HIGHLEVEL_MARK_LEDGER");
      return { thread_id: row.thread_id, marked_at: row.marked_at };
    });
  } finally { source.close(); }
  if (!rows.length) return 0;
  const existed = databaseExists(target);
  const db = new DatabaseSync(target);
  try {
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    if (!existed) initializeMessageTables(db);
    initializeHighLevelThreadMarks(db);
    const insert = db.prepare("INSERT OR IGNORE INTO highlevel_thread_marks(thread_id, marked_at) VALUES (?, ?)");
    const retained = db.prepare("SELECT 1 FROM highlevel_thread_marks WHERE thread_id=?");
    for (const row of rows) {
      insert.run(row.thread_id, row.marked_at);
      if (!retained.get(row.thread_id)) throw new Error("HIGHLEVEL_MARK_PRESERVATION_FAILED");
    }
    db.exec("COMMIT");
    return rows.length;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
    throw error;
  } finally { db.close(); }
}
