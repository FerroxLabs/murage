// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One walker over the message history for every derived structure that needs the whole of it: the open-card index, the table of pending browser
// checks and the first row of each turn. They used to be three passes (each its own statement stream over `messages`, each parsing the same JSON);
// here the rows of a window are read once and each structure takes what it needs from them. Every structure keeps its own cursor and its own
// completion marker (transcript_index_state), so one can already be complete (a file from a build that kept it) while another is not, and a
// stopped server carries on from the markers. Each chunk is one transaction.
import type { DatabaseSync } from "node:sqlite";
import { invalidateCardWalk, isOpenCardJson, newestRowid, readIndexState, writeIndexState, BACKFILL_CHUNK_ROWS } from "./transcript-backfill.ts";
import { isPendingBrowserCheck } from "./message-tables.ts";

export const WALKED = ["open_card", "browser_check", "turn_first"] as const;
type Walked = (typeof WALKED)[number];

/** The structures whose completion marker is not yet written. */
export function walkerPending(db: DatabaseSync): Walked[] {
  try {
    if (db.prepare("SELECT 1 AS present FROM messages LIMIT 1").get() === undefined) {
      // nothing to walk: every structure is complete from the first write
      return [];
    }
    return WALKED.filter(name => !readIndexState(db, name).done);
  } catch { return []; }
}
export interface WalkStep { more: boolean; done: number; total: number; /** the structures this chunk completed */ completed: Walked[];
  /** Rows of messages actually read since this walk began (committed with the cursor), or null when the walk began before the count was kept. `done` and `total` are rowids, which are not a count of messages. */
  rowsWalked: number | null }
/** The row that keeps the count of rows walked, beside the cursors in transcript_index_state (no new column, no new table). */
const WALK_ROWS = "walk_rows";

/** One window of the walk: the rows past the least advanced cursor, read once. */
export function walkMessagesChunk(db: DatabaseSync, rows = BACKFILL_CHUNK_ROWS): WalkStep {
  const pending = walkerPending(db);
  const newest = newestRowid(db);
  if (!pending.length) return { more: false, done: newest, total: newest, completed: [], rowsWalked: null };
  const states = new Map(pending.map(name => [name, readIndexState(db, name)]));
  const lo = Math.min(...pending.map(name => states.get(name)!.cursor));
  // The count of rows walked starts at zero with the walk; a walk that began before the count was kept (a cursor past zero and no count) has none.
  const kept = readIndexState(db, WALK_ROWS);
  const counting = lo === 0 || kept.done === 1;
  let rowsWalked = lo === 0 ? 0 : counting ? kept.cursor : 0;
  const upper = Math.min(newest, lo + rows);
  const needsJson = pending.includes("turn_first");
  const batch = db.prepare(`SELECT rowid AS position, thread_id, id, kind, ${needsJson ? "json" : "CASE WHEN kind IN ('options','activity') THEN json END AS json"} FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid`)
    .all(lo, upper) as Array<{ position: number; thread_id: string; id: string; kind: string; json: string | null }>;
  const addCard = db.prepare("INSERT OR IGNORE INTO open_card(thread_id, id) VALUES (?, ?)");
  const addNote = db.prepare("INSERT OR IGNORE INTO browser_check_pending(thread_id, id) VALUES (?, ?)");
  const putTurn = db.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES (?, ?, ?) ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid)");
  const completed: Walked[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const skipped = new Map<Walked, number>(pending.map(name => [name, states.get(name)!.skipped]));
    for (const row of batch) {
      if (row.json === null) continue;
      let parsed: Record<string, unknown> | null | undefined;
      const message = () => { if (parsed === undefined) { try { parsed = JSON.parse(row.json!) as Record<string, unknown>; } catch { parsed = null; } } return parsed; };
      for (const name of pending) {
        if (row.position <= states.get(name)!.cursor) continue;
        if (name === "open_card") {
          if (row.kind !== "options") continue;
          const m = message();
          if (!m) { skipped.set(name, skipped.get(name)! + 1); continue; }
          if (isOpenCardJson(m as never) && Number(addCard.run(row.thread_id, row.id).changes) > 0) invalidateCardWalk(db, row.thread_id, row.id);
        } else if (name === "browser_check") {
          if (row.kind !== "activity") continue;
          const m = message();
          if (m && isPendingBrowserCheck(m as never)) addNote.run(row.thread_id, row.id);
        } else {
          const m = message();
          if (!m) { skipped.set(name, skipped.get(name)! + 1); continue; }
          const turnId = (m as { turnId?: unknown }).turnId;
          if (typeof turnId === "string" && turnId) putTurn.run(row.thread_id, turnId, row.position);
        }
      }
    }
    const finished = upper >= newest;
    rowsWalked += batch.length;
    writeIndexState(db, WALK_ROWS, { done: counting ? 1 : 0, cursor: rowsWalked, skipped: 0 });
    for (const name of pending) {
      const state = states.get(name)!;
      writeIndexState(db, name, { done: finished ? 1 : 0, cursor: Math.max(state.cursor, upper), skipped: skipped.get(name)! });
      if (finished) completed.push(name);
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return { more: upper < newest, done: upper, total: newest, completed, rowsWalked: counting ? rowsWalked : null };
}
