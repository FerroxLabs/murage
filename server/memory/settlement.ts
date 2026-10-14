import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { readIndexState, writeIndexState } from "../transcript-backfill.ts";
import { captureSource } from "./capture.ts";
import { bumpOpenTurnsBoot, openTurnsStep } from "./open-turns.ts";

/** The turns still working in one thread (bound: the thread). Served by the open-turns table's thread index; it never reads the sources. */
export const OPEN_TURNS_OF_THREAD_SQL = "SELECT source_id AS id,turn_id FROM memory_open_turns WHERE thread_id=?";
export type MemoryTurnOutcome = "working" | "completed" | "failed" | "cancelled" | "interrupted" | "setup-failed";
export function recordMemorySettlement(threadId: string, turnId: string, outcome: MemoryTurnOutcome) {
  transaction(db => {
    if (outcome !== "working") {
      // The turns still working in this thread are read from the open-turns table (memory schema v9), which holds only the turns in
      // flight: a settlement never reads the thread's history of sources (memory_open_turns is kept by triggers on memory_sources).
      for (const row of db.prepare(OPEN_TURNS_OF_THREAD_SQL).all(threadId)) {
        captureSource(db,{id:String(row.id),threadId,turnId:String(row.turn_id),kind:"turn",speaker:"harness",outcome,text:`Turn ${outcome}.`});
      }
    }
    captureSource(db,{id:`turn:${threadId}:${turnId}`,threadId,turnId,kind:"turn",speaker:"harness",outcome,text:`Turn ${outcome}.`});
  });
}
/** Settles one turn a stopped process left working (open-turns.ts calls this inside its slice's transaction). */
export function interruptOpenTurn(db: DatabaseSync, turn: { id: string; threadId: string; turnId: string }): void {
  captureSource(db,{id:turn.id,threadId:turn.threadId,turnId:turn.turnId,kind:"turn",speaker:"harness",outcome:"interrupted",text:"Turn interrupted by process restart."});
}
/** Counts a start and settles every turn the previous starts left working, to the end, in one call (tests, and a tool that has no server to
 * listen: the server itself does the same work in short slices after it listens, startOpenTurnsReconcile). */
export function reconcileInterruptedMemoryTurns() {
  const db = database();
  bumpOpenTurnsBoot(db);
  while (!openTurnsStep(db, interruptOpenTurn).ready);
}

/** The highest rowid of memory_sources now. A turn that was working when the process ended has a row at or below it; a turn of this process has a
 * row above it. Taken before the server listens (a seek), so the sweep below can run after it without ever touching a live turn. */
export function interruptedTurnsHighWater(): number {
  return transaction(db => Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM memory_sources").get()?.n ?? 0));
}
/** One slice of reconcileInterruptedMemoryTurns: the "working" turn rows between two rowids. Returns the rowid reached. */
export function reconcileInterruptedMemoryTurnsSlice(after: number, high: number, rows = 20_000): number {
  const upper = Math.min(high, after + rows);
  if (upper <= after) return high;
  transaction(db => {
    for (const row of db.prepare("SELECT id,thread_id,turn_id FROM memory_sources WHERE rowid>? AND rowid<=? AND kind='turn' AND outcome='working'").all(after, upper)) {
      captureSource(db,{id:String(row.id),threadId:String(row.thread_id),turnId:String(row.turn_id),kind:"turn",speaker:"harness",outcome:"interrupted",text:"Turn interrupted by process restart."});
    }
  });
  return upper;
}
/** reconcileInterruptedMemoryTurns in slices with the loop handed back between them: a heavy history has millions of source rows and no index on
 * turn rows, so the one statement held the start 20 s. Resumes nothing (it is idempotent): a stopped process simply does it again next start. */
export async function reconcileInterruptedMemoryTurnsInBackground(high: number, options: { rows?: number; pause?: () => Promise<void>; stillOpen?: () => boolean; from?: number } = {}): Promise<void> {
  const pause = options.pause ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
  // Only the rows written since the last start finished this sweep: the place it reached is kept, and an ordinary start reads the few turn rows
  // of the last session, never the history. (A file whose rowids moved below the kept place, a rewrite of the file, starts again from the first row.)
  const from = options.from ?? interruptedTurnsThrough(high);
  for (let at = from; at < high && (options.stillOpen?.() ?? true);) {
    at = reconcileInterruptedMemoryTurnsSlice(at, high, options.rows);
    keepInterruptedTurnsThrough(at);
    await pause();
  }
  if (options.stillOpen?.() ?? true) keepInterruptedTurnsThrough(high);
}
const INTERRUPTED_TURNS_MARK = "interrupted_turns_through";
/** The rowid of memory_sources the last sweep reached (0 when none); a mark above the newest row means the rows were renumbered, so it is ignored. */
export function interruptedTurnsThrough(high: number): number {
  try {
    const state = readIndexState(database(), INTERRUPTED_TURNS_MARK);
    return state.done === 1 && state.cursor <= high ? state.cursor : 0;
  } catch { return 0; }
}
function keepInterruptedTurnsThrough(rowid: number): void {
  try { transaction(db => writeIndexState(db, INTERRUPTED_TURNS_MARK, { done: 1, cursor: rowid, skipped: 0 })); } catch { /* the sweep is idempotent: a mark that was not kept just repeats it */ }
}
