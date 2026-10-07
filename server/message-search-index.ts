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

const BACKFILL_CHUNK = 500;
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
 * transaction per BACKFILL_CHUNK rows. Marks the handle ready when done;
 * on failure leaves it not ready (searches scan) rather than throwing.
 *
 * @returns how many rows were indexed by this call. */
export function backfillMessageSearchIndex(db: DatabaseSync): number {
  let indexed = 0;
  try {
    let cursor = Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS top FROM ${MESSAGE_SEARCH_TABLE}_docsize`).get() as { top: number }).top);
    const read = db.prepare(
      "SELECT rowid AS r, CASE kind WHEN 'activity' THEN json_extract(json, '$.tool.name') ELSE text END AS t " +
        "FROM messages WHERE rowid > ? AND kind IN ('text', 'activity') ORDER BY rowid LIMIT ?",
    );
    const add = db.prepare(`INSERT INTO ${MESSAGE_SEARCH_TABLE}(rowid, t) VALUES (?, ?)`);
    for (;;) {
      const rows = read.all(cursor, BACKFILL_CHUNK) as Array<{ r: number; t: unknown }>;
      if (!rows.length) break;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) if (typeof row.t === "string" && row.t !== "") { add.run(row.r, row.t); indexed++; }
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw error; }
      cursor = rows[rows.length - 1]!.r;
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
