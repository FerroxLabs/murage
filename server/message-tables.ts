import type { DatabaseSync } from "node:sqlite";
import { BROWSER_CHECKING_REASON, browserUnavailableActivityName } from "../shared/browser-unavailable.ts";

/** The tool name of a "Checking the browser" note that is still pending. The
 * note is rewritten when the check settles, so a row carries this name exactly
 * while it is pending. Inlined as a SQL literal (an index predicate and the
 * query that relies on it must spell it identically). */
export const PENDING_BROWSER_CHECK_SQL = `'${browserUnavailableActivityName(BROWSER_CHECKING_REASON).replace(/'/g, "''")}'`;
export const PENDING_BROWSER_CHECK_WHERE = `kind = 'activity' AND json_extract(json, '$.tool.name') = ${PENDING_BROWSER_CHECK_SQL}`;

import { ensureOpenCardIndex, isOpenCardJson, type EnsureIndexHooks } from "./transcript-backfill.ts";

export { isOpenCardJson };

/** The transcript tables every installation's messages.db carries. Owned here,
 * without DATA_DIR or any other import-time state, so the offline archive
 * inspector (installation-database-snapshot.ts) can build its reference schema
 * from the exact DDL server/database.ts runs instead of a hand-copied list. */
export function initializeMessageTables(db: DatabaseSync, indexHooks: EnsureIndexHooks = {}) {
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
  // Open request cards and each turn's first row, kept by the writers
  // (message-db.ts) in tables of their own rather than in indexes over the
  // message JSON: an index over json_extract() would make a row with damaged
  // JSON refuse every later write to it. card_branch keeps which of those cards
  // the active branch passes through. All three are derived from messages; a
  // missing row is read the long way, never trusted blind.
  db.exec(`CREATE TABLE IF NOT EXISTS open_card(thread_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread_id, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS turn_first(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, first_rowid INTEGER NOT NULL, PRIMARY KEY(thread_id, turn_id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS card_branch(thread_id TEXT NOT NULL, card_id TEXT NOT NULL, leaf_id TEXT NOT NULL, on_branch INTEGER NOT NULL, PRIMARY KEY(thread_id, card_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS card_branch_leaf ON card_branch(thread_id, leaf_id);
      CREATE TABLE IF NOT EXISTS branch_walk(thread_id TEXT PRIMARY KEY, leaf_id TEXT NOT NULL, cursor_id TEXT, pos INTEGER, found TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID;`);
  // Existing options rows are indexed chunk by chunk (transcript-backfill.ts),
  // each chunk committed with its position. Completion is the recorded marker,
  // never the table's existence, so an interrupted pass resumes on the next
  // start; a write failure propagates instead of passing for done. turn_first
  // and card_branch are filled in the background after start.
  ensureOpenCardIndex(db, indexHooks);
}

export const PENDING_BROWSER_CHECK_INDEX = "messages_pending_browser_check";

/** True once the pending-note index exists. The index is also the done marker of
 * its own build: a second start finds it and does nothing. */
export function browserCheckIndexExists(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'index' AND name = ?").get(PENDING_BROWSER_CHECK_INDEX) !== undefined;
}

/** Pending "Checking the browser" notes: a partial index that holds a row only
 * while a note is pending (SQLite adds it on insert and drops it when the note
 * is rewritten to its settled wording). Boot recovery reads it, so its cost
 * follows the pending notes, never the activity history. Building it on an
 * existing installation reads every message row once, so it is NOT part of
 * initializeMessageTables: server/database.ts runs it inside the reported
 * upgrade work (the start-up screen is up and the shell's boot clock is
 * extended), and the notes an older build left behind are indexed with it, so
 * no separate backfill exists. Idempotent. */
export function ensureBrowserCheckIndex(db: DatabaseSync): void {
  db.exec(`CREATE INDEX IF NOT EXISTS ${PENDING_BROWSER_CHECK_INDEX} ON messages(thread_id) WHERE ${PENDING_BROWSER_CHECK_WHERE}`);
}
