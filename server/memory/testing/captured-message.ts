import type { DatabaseSync } from "node:sqlite";
import type { Message } from "../../store.ts";
import { captureMessage } from "../capture.ts";

/** Seed a captured message in a legacy fixture without introducing modern line lineage.
 * Production writeMessage stores this same anchor before captureMessage runs. */
export function captureStoredMessage(db: DatabaseSync, threadId: string, message: Message): void {
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  captureMessage(db, threadId, message);
}
