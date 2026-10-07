import type { DatabaseSync } from "node:sqlite";

/** The transcript tables every installation's messages.db carries. Owned here,
 * without DATA_DIR or any other import-time state, so the offline archive
 * inspector (installation-database-snapshot.ts) can build its reference schema
 * from the exact DDL server/database.ts runs instead of a hand-copied list. */
export function initializeMessageTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY(thread_id,id));
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS messages_at ON messages(at DESC);
      CREATE TABLE IF NOT EXISTS thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);`);
  // Substring-search candidate index (server/message-search-index.ts):
  // contentless, keyed by messages.rowid, so it holds trigrams and no text;
  // detail=none drops positions (about 7x smaller), so a query is an AND of
  // its trigrams and the LIKE check in searchMessages() decides adjacency.
  // Its shadow tables (_data, _idx, _docsize, _config) are allowlisted by name
  // in installation-database-snapshot.ts.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none)`);
}
