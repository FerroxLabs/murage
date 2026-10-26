import { dropLegacyUpgradeTables, ensureDirectTurnInflight } from "./memory/upgrade-app-tables.ts";
import type { DatabaseSync } from "node:sqlite";
import { beginBackground } from "./db-busy.ts";
import { BROWSER_CHECKING_REASON, browserUnavailableActivityName } from "../shared/browser-unavailable.ts";

/** The tool name of a "Checking the browser" note that is still pending. The
 * note is rewritten when the check settles, so a row carries this name exactly
 * while it is pending. Inlined as a SQL literal (an index predicate and the
 * query that relies on it must spell it identically). */
export const PENDING_BROWSER_CHECK_SQL = `'${browserUnavailableActivityName(BROWSER_CHECKING_REASON).replace(/'/g, "''")}'`;
export const PENDING_BROWSER_CHECK_WHERE = `kind = 'activity' AND json_extract(json, '$.tool.name') = ${PENDING_BROWSER_CHECK_SQL}`;

import { BRANCH_TABLES_SQL } from "./branch-index.ts";
import { SEQ_INDEX_SQL, SEQ_STATE, seqIndexReady } from "./transcript-seq.ts";
import { MESSAGE_ID_INDEX_SQL, messageIdIndexReady } from "./message-id-index.ts";
import { ensureKeyedCardIndex, ensureOpenCardIndex, isOpenCardJson, newestRowid, readIndexState, writeIndexState, type EnsureIndexHooks } from "./transcript-backfill.ts";

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
  // The per-thread storage sequence (transcript-seq.ts, ROOM-ORDER-DESIGN r7 R1): appended by ALTER TABLE on every file, a fresh one
  // included, so a migrated and a fresh messages table keep one definition text. Metadata only: no row is read or rewritten.
  ensureSeqColumn(db);
  // Substring-search candidate index (server/message-search-index.ts):
  // contentless, keyed by messages.rowid, so it holds trigrams and no text;
  // detail=none drops positions (about 7x smaller), so a query is an AND of
  // its trigrams and the LIKE check in searchMessages() decides adjacency.
  // Its shadow tables (_data, _idx, _docsize, _config) are allowlisted by name
  // in installation-database-snapshot.ts.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none)`);
  // message_image: which rows of a thread name an image attachment, by path, so a
  // send that names an image finds the rows that bound it without reading the
  // thread (TurnImages.promote). Written with the row; filled for older rows by
  // the background backfill, and not read until that has finished.
  // Open request cards and each turn's first row, kept by the writers
  // (message-db.ts) in tables of their own rather than in indexes over the
  // message JSON: an index over json_extract() would make a row with damaged
  // JSON refuse every later write to it. Derived from messages; a missing row is
  // never trusted blind. (card_branch, branch_walk and branch_jump of the first
  // 1.0.2 builds are dropped: the branch index answers what they did, exactly.)
  db.exec(`CREATE TABLE IF NOT EXISTS open_card(thread_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread_id, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS turn_first(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, first_rowid INTEGER NOT NULL, PRIMARY KEY(thread_id, turn_id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS browser_check_pending(thread_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread_id, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS message_image(thread_id TEXT NOT NULL, path TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread_id, path, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS attachment_name(name TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(name, thread_id, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS keyed_card(thread_id TEXT NOT NULL, family TEXT NOT NULL, key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread_id, family, key, id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS keyed_card_id ON keyed_card(thread_id, id);
      CREATE INDEX IF NOT EXISTS keyed_card_family ON keyed_card(family, thread_id);
      DROP TABLE IF EXISTS card_branch; DROP TABLE IF EXISTS branch_walk; DROP TABLE IF EXISTS branch_jump;`);
  // The Flux Memory number hold of a thread (flux-capture-hold.ts): one row per thread that holds a bank, card or id number.
  db.exec("CREATE TABLE IF NOT EXISTS flux_capture_hold(thread_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID");
  // The branch index and the line index (branch-index.ts): small integer-keyed tables the writers keep, filled for older threads per thread (branch-store.ts).
  db.exec(BRANCH_TABLES_SQL);
  // The threads whose visible end is the person's own message (a direct turn that was admitted and has not settled), kept by the writers (message-db.ts
  // writeActiveLeaf). A start after a crash reads this table, never the history; a file from before it is walked once (store.ts) and then marked.
  ensureDirectTurnInflight(db);
  // what an earlier 1.0.2 preview kept and this build no longer reads (the kept proofs of large root sets) goes on every open
  dropLegacyUpgradeTables(db);
  if (readIndexState(db, "direct_turns_walk").done !== 1 && db.prepare("SELECT 1 AS present FROM messages LIMIT 1").get() === undefined) writeIndexState(db, "direct_turns_walk", { done: 1, cursor: 0, skipped: 0 });
  // Existing options rows are indexed chunk by chunk (transcript-backfill.ts),
  // each chunk committed with its position. Completion is the recorded marker,
  // never the table's existence, so an interrupted pass resumes on the next
  // start; a write failure propagates instead of passing for done. turn_first,
  // message_image and the branch and line indexes are filled thread by thread.
  // A history with no message has nothing to fill: the table of pending notes is complete from the first write.
  // The sequence index is made with the schema only on an empty table (a fresh file: every thread numbered from its first row, the walk
  // has nothing to do). On a file with history it is an optional index built in an idle window (transcript-seq.ts SEQ_OPTIONAL_INDEX);
  // a file whose index was dropped (a downgrade that kept the column) walks again from the start once it is rebuilt.
  if (db.prepare("SELECT 1 AS present FROM messages LIMIT 1").get() === undefined) {
    if (!seqIndexReady(db)) db.exec(SEQ_INDEX_SQL);
    // the message-id index likewise (message-id-index.ts): empty table now, else built in an idle window
    if (!messageIdIndexReady(db)) db.exec(MESSAGE_ID_INDEX_SQL);
    if (readIndexState(db, SEQ_STATE).done !== 1) writeIndexState(db, SEQ_STATE, { done: 1, cursor: 0, skipped: 0 });
  } else if (!seqIndexReady(db)) {
    const state = readIndexState(db, SEQ_STATE);
    if (state.done !== 0 || state.cursor !== 0) writeIndexState(db, SEQ_STATE, { done: 0, cursor: 0, skipped: 0 });
  }
  if (!browserCheckIndexExists(db) && db.prepare("SELECT 1 AS present FROM messages LIMIT 1").get() === undefined) writeIndexState(db, "browser_check", { done: 1, cursor: 0, skipped: 0 });
  // Cards that carry no request id (a first-run flow card, an intake question, a
  // browser-setup offer, a learned-skill proposal) and the setup flow's own lines
  // and unconfirmed steers are kept by (family, key) in keyed_card, so finding one
  // is a keyed read and never a look through the thread.
  if (indexHooks.defer) {
    // Until the background job has filled the card indexes, readers of them read the thread's own newest rows (message-db.ts openRequestCards, keyedCardRows).
    for (const name of ["open_card", "keyed_card"]) {
      if (readIndexState(db, name).done !== 1 && db.prepare("SELECT 1 AS present FROM messages LIMIT 1").get() === undefined) writeIndexState(db, name, { done: 1, cursor: 0, skipped: 0 });
    }
  } else {
    ensureOpenCardIndex(db, indexHooks);
    ensureKeyedCardIndex(db, indexHooks);
  }
}

/** `messages.seq` (nullable: a row written before its thread is numbered holds NULL until the walk reaches it). */
export function ensureSeqColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "seq")) db.exec("ALTER TABLE messages ADD COLUMN seq INTEGER");
}

/** The partial index an earlier build of 1.0.2 made over the pending notes. It is no longer made (building it read every message row
 * before the app opened); the table browser_check_pending replaces it. The definition stays here because an archive from such a build
 * may carry it, and the archive inspector must still accept it. */
export const PENDING_BROWSER_CHECK_INDEX = "messages_pending_browser_check";

/** Whether a stored message is a "Checking the browser" note that is still pending. */
export function isPendingBrowserCheck(message: { kind?: unknown; tool?: { name?: unknown } | null }): boolean {
  return message.kind === "activity" && message.tool?.name === browserUnavailableActivityName(BROWSER_CHECKING_REASON);
}

/** True once the table of pending notes holds every pending note of the history: until then boot recovery waits (pendingBrowserCheckRows
 * answers null) and the notes keep their old wording. The writers keep the table current from the first open (message-db.ts), the
 * background fill (indexBrowserCheckChunk) adds the notes written before it existed, and the fill's recorded end is the done marker. */
export function browserCheckIndexExists(db: DatabaseSync): boolean {
  return readIndexState(db, "browser_check").done === 1;
}
/** True while the fill still has history to read. */
export function browserCheckFillPending(db: DatabaseSync): boolean {
  return !browserCheckIndexExists(db);
}

/** One chunk of the fill of browser_check_pending: the next `rows` storage positions (a rowid range, so a history with few notes still
 * costs a bounded read per chunk), committed with its cursor so a stopped server resumes. A file that has the partial index an earlier
 * build made is filled from it in one statement. Returns whether more remain. */
export function indexBrowserCheckChunk(db: DatabaseSync, rows = 5_000): boolean {
  const state = readIndexState(db, "browser_check");
  if (state.done) return false;
  const newest = newestRowid(db);
  beginBackground(db, "browser-check-fill");
  try {
    if (state.cursor === 0 && db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'index' AND name = ?").get(PENDING_BROWSER_CHECK_INDEX) !== undefined) {
      db.exec(`INSERT OR IGNORE INTO browser_check_pending(thread_id, id) SELECT thread_id, id FROM messages INDEXED BY ${PENDING_BROWSER_CHECK_INDEX} WHERE ${PENDING_BROWSER_CHECK_WHERE}`);
      writeIndexState(db, "browser_check", { done: 1, cursor: newest, skipped: 0 });
      db.exec("COMMIT");
      return false;
    }
    const upper = Math.min(newest, state.cursor + rows);
    db.prepare(`INSERT OR IGNORE INTO browser_check_pending(thread_id, id) SELECT thread_id, id FROM messages WHERE rowid > ? AND rowid <= ? AND ${PENDING_BROWSER_CHECK_WHERE}`).run(state.cursor, upper);
    const done = upper >= newest;
    writeIndexState(db, "browser_check", { done: done ? 1 : 0, cursor: Math.max(state.cursor, upper), skipped: state.skipped });
    db.exec("COMMIT");
    return !done;
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
}

/** Builds the partial index (an archive inspector's reference only: nothing at run time makes it any more). */
export function ensureBrowserCheckIndex(db: DatabaseSync): void {
  db.exec(`CREATE INDEX IF NOT EXISTS ${PENDING_BROWSER_CHECK_INDEX} ON messages(thread_id) WHERE ${PENDING_BROWSER_CHECK_WHERE}`);
}
