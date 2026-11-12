// A HighLevel backstop applies to conversations that actually mounted its
// tools. The absence of a mark is ordinary; a failed read is not.
import type { DatabaseSync } from "node:sqlite";

export function initializeHighLevelThreadMarks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS highlevel_thread_marks (
    thread_id TEXT PRIMARY KEY NOT NULL, marked_at INTEGER NOT NULL)`);
}

export function markHighLevelThread(db: DatabaseSync, threadId: string): boolean {
  try {
    db.prepare("INSERT OR IGNORE INTO highlevel_thread_marks(thread_id, marked_at) VALUES (?, ?)").run(threadId, Date.now());
    return true;
  } catch { return false; }
}

export type HighLevelThreadMarkState = "marked" | "unmarked" | "unreadable";

export function highLevelThreadMarked(db: DatabaseSync, threadId: string): HighLevelThreadMarkState {
  try { return db.prepare("SELECT 1 FROM highlevel_thread_marks WHERE thread_id=?").get(threadId) !== undefined ? "marked" : "unmarked"; }
  catch { return "unreadable"; }
}
