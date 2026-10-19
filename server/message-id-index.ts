// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The message-id index (1.0.3 lineage S6, the read lane's copy ancestry): `messages(id)`. The table's key is (thread_id, id), so a source
// named by its id alone (a copy whose original thread the caller does not know) was a scan of every message; with this index it is one
// seek, whatever the history holds. Same life as the sequence index (transcript-seq.ts): made with the schema on an empty table, else an
// optional index built in an idle window off the serving thread (memory/optional-index.ts); 1.0.2 does not know it, so the downgrade drops it.
// It imports nothing that opens the database.
import type { DatabaseSync } from "node:sqlite";

import { registerOptionalIndex } from "./memory/optional-index.ts";

export const MESSAGE_ID_INDEX = "messages_id";
export const MESSAGE_ID_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${MESSAGE_ID_INDEX} ON messages(id)`;
export const MESSAGE_ID_OPTIONAL_INDEX = registerOptionalIndex({ name: MESSAGE_ID_INDEX, table: "messages", minSchemaVersion: 0, sql: MESSAGE_ID_INDEX_SQL, logTag: "message-id" });
/** The objects only 1.0.3 adds for it (the 1.0.2 downgrade's own step removes them). */
export const MESSAGE_ID_103_OBJECTS: readonly string[] = Object.freeze([MESSAGE_ID_INDEX]);

export function messageIdIndexReady(db: DatabaseSync): boolean {
  try { return db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'index' AND name = ?").get(MESSAGE_ID_INDEX) !== undefined; } catch { return false; }
}
/** Every build before 1.0.3 lacks the index: it leaves first, whatever the downgrade target. */
export function downgradeMessageIdIndexTo102(db: DatabaseSync): { dropped: boolean } {
  if (!messageIdIndexReady(db)) return { dropped: false };
  db.exec(`DROP INDEX IF EXISTS ${MESSAGE_ID_INDEX}`);
  return { dropped: true };
}
