// SPDX-License-Identifier: AGPL-3.0-or-later
// Substring-search index over message text (messages_fts, FTS5 trigram).
//
// /api/search used to run `lower(text) LIKE ?` over the whole messages table,
// which reads every page of a ~200 MB database per query. A trigram index
// turns that into a posting-list intersection. The index is a CANDIDATE
// filter only: searchMessages() still checks each candidate with the same
// LIKE it always used, so a stale or over-wide index can never invent a hit.
// A stale index can only miss one, which is why every write path in
// message-db.ts keeps it in step and the startup backfill below repairs a
// restored, downgraded or interrupted one.
//
// The table is contentless (contentless_delete=1): it stores trigrams keyed
// by messages.rowid, never a second copy of the text. The DDL lives in
// message-tables.ts so the offline archive inspector builds its reference
// schema from it.
import type { DatabaseSync } from "node:sqlite";
import { readIndexState, writeIndexState } from "./transcript-backfill.ts";

export const MESSAGE_SEARCH_TABLE = "messages_fts";
/** Fewer code points than this cannot form a trigram: those queries scan. */
export const MIN_INDEXED_QUERY_CODEPOINTS = 3;

/** The MATCH expression for a needle: every distinct trigram, ANDed (capped; any
 * subset still names a superset of the true matches). The index keeps no
 * positions (detail=none), so adjacency is the LIKE check's job. Needle must
 * have at least MIN_INDEXED_QUERY_CODEPOINTS code points. */
export function trigramQuery(needle: string): string {
  const points = [...needle.toLowerCase()];
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= points.length && grams.size < 16; i++) grams.add(points.slice(i, i + 3).join(""));
  return [...grams].map((gram) => `"${gram.replace(/"/g, '""')}"`).join(" AND ");
}

/** Rowids covered by one backfill statement and its transaction (at most this many rows indexed per transaction). */
const BACKFILL_WINDOW = 500;
/** Rows read by one step of the background fill (stepMessageSearchBackfill, upgui). */
const BACKFILL_CHUNK = 500;
/** A chunk is read in pieces of this many rows and stops once it has used this long (it commits what it read). */
const BACKFILL_PIECE = 100, BACKFILL_CHUNK_MS = 25;
const ready = new WeakSet<DatabaseSync>();
let warned = false;

/** What a row contributes to the index: a text row's text, or an activity
 * chip's tool name; otherwise nothing. Mirrors the two arms of the search. */
export function searchableText(message: { kind: string; text?: string | null; tool?: { name?: unknown } }): string | null {
  if (message.kind === "text") return typeof message.text === "string" && message.text !== "" ? message.text : null;
  if (message.kind === "activity") {
    const name = message.tool?.name;
    return typeof name === "string" && name !== "" ? name : null;
  }
  return null;
}

/** True when the index may be used to answer a query on this handle. */
export function messageSearchIndexReady(db: DatabaseSync): boolean {
  return ready.has(db);
}

/** Stop trusting the index on this handle (a query against it failed). */
export function disableMessageSearchIndex(db: DatabaseSync, error: unknown): void {
  degrade(db, error);
}

function degrade(db: DatabaseSync, error: unknown): void {
  ready.delete(db);
  if (warned) return;
  warned = true;
  console.warn("[message-search] index unavailable, searching without it:", error instanceof Error ? error.message : error);
}

/** Keep one row's entry current: drop any entry, then add `text` when given.
 * Never throws: a broken index must not break saving a message; searches fall
 * back to the scan until the next start repairs it. */
export function syncMessageSearchRow(db: DatabaseSync, rowid: number, text: string | null): void {
  try {
    db.prepare(`DELETE FROM ${MESSAGE_SEARCH_TABLE} WHERE rowid = ?`).run(rowid);
    if (text !== null) db.prepare(`INSERT INTO ${MESSAGE_SEARCH_TABLE}(rowid, t) VALUES (?, ?)`).run(rowid, text);
  } catch (error) { degrade(db, error); }
}

/** Drop the entries of every row of a thread; call BEFORE deleting the rows.
 * Returns whether any entry existed, so the caller can merge the segments. */
export function dropThreadSearchRows(db: DatabaseSync, threadId: string): boolean {
  try {
    const present = db.prepare(
      `SELECT 1 AS present FROM ${MESSAGE_SEARCH_TABLE}_docsize WHERE id IN (SELECT rowid FROM messages WHERE thread_id = ?) LIMIT 1`,
    ).get(threadId) !== undefined;
    if (present) db.prepare(`DELETE FROM ${MESSAGE_SEARCH_TABLE} WHERE rowid IN (SELECT rowid FROM messages WHERE thread_id = ?)`).run(threadId);
    return present;
  } catch (error) { degrade(db, error); return false; }
}

/** Deleted entries stay in the index's segments as markers until a merge, so
 * a conversation deletion merges them away (secure_delete zeroes the freed
 * pages), the same way the Fuigo session index is scrubbed. */
export function mergeMessageSearchIndex(db: DatabaseSync): void {
  try { db.exec(`INSERT INTO ${MESSAGE_SEARCH_TABLE}(${MESSAGE_SEARCH_TABLE}) VALUES('optimize')`); }
  catch (error) { degrade(db, error); }
}

/** Index every searchable row above what the index already covers. Rows are
 * indexed in ascending rowid order, so the highest indexed rowid is a resume
 * point: a fresh/restored-from-older-release database starts at 0, an
 * interrupted run continues, and rows appended while an older release (with
 * no index) was running are picked up. Idempotent and chunked: one short
 * transaction per BACKFILL_WINDOW rowids. Marks the handle ready when done;
 * on failure leaves it not ready (searches scan) rather than throwing.
 *
 * @returns how many rows were indexed by this call. */
export function backfillMessageSearchIndex(db: DatabaseSync, options: { onProgress?: (progress: { done: number; total: number }) => void } = {}): number {
  let indexed = 0;
  try {
    let cursor = Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS top FROM ${MESSAGE_SEARCH_TABLE}_docsize`).get() as { top: number }).top);
    const last = Number((db.prepare("SELECT COALESCE(MAX(rowid), 0) AS top FROM messages").get() as { top: number }).top);
    // Each statement reads one bounded window of rowids, so a long run of rows with nothing to index (tool and
    // status rows after the last text row) is walked in slices with progress, never as one multi-second scan.
    const read = db.prepare(
      "SELECT rowid AS r, CASE kind WHEN 'activity' THEN json_extract(json, '$.tool.name') ELSE text END AS t " +
        "FROM messages WHERE rowid > ? AND rowid <= ? AND kind IN ('text', 'activity') ORDER BY rowid",
    );
    const add = db.prepare(`INSERT INTO ${MESSAGE_SEARCH_TABLE}(rowid, t) VALUES (?, ?)`);
    while (cursor < last) {
      const high = Math.min(last, cursor + BACKFILL_WINDOW);
      const rows = read.all(cursor, high) as Array<{ r: number; t: unknown }>;
      if (rows.length) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows) if (typeof row.t === "string" && row.t !== "") { add.run(row.r, row.t); indexed++; }
          db.exec("COMMIT");
        } catch (error) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw error; }
      }
      cursor = high;
      options.onProgress?.({ done: cursor, total: last });
    }
    ready.add(db);
  } catch (error) { degrade(db, error); }
  return indexed;
}

/** Throw the index away and rebuild it from messages (repair path). */
export function rebuildMessageSearchIndex(db: DatabaseSync): number {
  ready.delete(db);
  db.exec(`INSERT INTO ${MESSAGE_SEARCH_TABLE}(${MESSAGE_SEARCH_TABLE}) VALUES('delete-all')`);
  return backfillMessageSearchIndex(db);
}

/** The state row that keeps the place of the background fill (transcript_index_state): `cursor` is the highest rowid already covered at the
 * start of this run. It is taken at open, before any write of this run, because a write adds its own entry and would otherwise move the
 * "highest indexed rowid" past older rows that were never indexed. */
const SEARCH_FILL = "search_fts";

/** At open: notes where the index ends. With nothing past that point the index is complete and is trusted at once; otherwise the rows past it
 * are filled by stepMessageSearchBackfill in the background, and searches scan until it has finished. Cheap: a seek and a probe. */
export function prepareMessageSearchBackfill(db: DatabaseSync): boolean {
  try {
    // A fill that was started and not finished keeps its own place. The highest indexed rowid says nothing about it: a live write of the
    // earlier run indexed a row beyond the unfinished history, and taking that rowid as the cursor would skip everything in between for good.
    const saved = db.prepare("SELECT done FROM transcript_index_state WHERE name = ?").get(SEARCH_FILL) as { done: number } | undefined;
    if (saved && Number(saved.done) === 0) return true;
    const top = Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS top FROM ${MESSAGE_SEARCH_TABLE}_docsize`).get() as { top: number }).top);
    // A seek on the rowid alone: filtering by kind here walked every row past the index when they were all of other kinds (6 s on a 48 GB history before the server listened). A row past the index that has no text is found by the fill, which finishes at once.
    const tail = db.prepare("SELECT 1 AS present FROM messages WHERE rowid > ? LIMIT 1").get(top) !== undefined;
    writeIndexState(db, SEARCH_FILL, { done: tail ? 0 : 1, cursor: top, skipped: 0 });
    if (!tail) ready.add(db);
    return tail;
  } catch (error) { degrade(db, error); return false; }
}
/** True while the fill of the rows past the index still has work. */
export function messageSearchFillPending(db: DatabaseSync): boolean {
  try { return !ready.has(db) && readIndexState(db, SEARCH_FILL).done === 0 && db.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE name = '${MESSAGE_SEARCH_TABLE}_docsize'`).get() !== undefined; } catch { return false; }
}
/** One chunk of the fill, committed with its place. Returns whether more remain; marks the handle ready at the end. */
export function stepMessageSearchBackfill(db: DatabaseSync, rows = BACKFILL_CHUNK): { more: boolean; done: number; total: number } {
  const state = readIndexState(db, SEARCH_FILL);
  if (state.done) return { more: false, done: state.cursor, total: state.cursor };
  const newest = Number((db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM messages").get() as { n: number }).n);
  // Read in small pieces and stop once the chunk has used its time: a cold disk reads 500 long rows in 160 ms on the main thread, which holds
  // every request behind it; the cursor is committed with whatever was read, so the next chunk carries on.
  const piece = db.prepare(
    "SELECT rowid AS r, CASE kind WHEN 'activity' THEN json_extract(json, '$.tool.name') ELSE text END AS t FROM messages WHERE rowid > ? AND kind IN ('text', 'activity') ORDER BY rowid LIMIT ?",
  );
  const batch: Array<{ r: number; t: unknown }> = [];
  const began = performance.now();
  let more = true;
  while (batch.length < rows && more) {
    const limit = Math.min(BACKFILL_PIECE, rows - batch.length);
    const got = piece.all(batch.length ? batch[batch.length - 1]!.r : state.cursor, limit) as Array<{ r: number; t: unknown }>;
    batch.push(...got);
    more = got.length === limit; // a full piece: there may be rows past it
    if (performance.now() - began >= BACKFILL_CHUNK_MS) break;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of batch) {
      // a write of this run may already have added the entry: replace, never duplicate
      db.prepare(`DELETE FROM ${MESSAGE_SEARCH_TABLE} WHERE rowid = ?`).run(row.r);
      if (typeof row.t === "string" && row.t !== "") db.prepare(`INSERT INTO ${MESSAGE_SEARCH_TABLE}(rowid, t) VALUES (?, ?)`).run(row.r, row.t);
    }
    const last = batch.length ? batch[batch.length - 1]!.r : state.cursor;
    const finished = !more;
    writeIndexState(db, SEARCH_FILL, { done: finished ? 1 : 0, cursor: finished ? Math.max(last, newest) : last, skipped: 0 });
    db.exec("COMMIT");
    if (finished) ready.add(db);
    return { more: !finished, done: last, total: newest };
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* none open */ } degrade(db, error); throw error; }
}
