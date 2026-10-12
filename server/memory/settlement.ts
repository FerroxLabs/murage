import { database, transaction } from "../database.ts";
import { readIndexState, writeIndexState } from "../transcript-backfill.ts";
import { captureSource } from "./capture.ts";
import { coldLineageIndexPresent, SOURCE_KIND_INDEX } from "./schema.ts";

export type MemoryTurnOutcome = "working" | "completed" | "failed" | "cancelled" | "interrupted" | "setup-failed";
export function recordMemorySettlement(threadId: string, turnId: string, outcome: MemoryTurnOutcome) {
  transaction(db => {
    if (outcome !== "working") {
      for (const row of db.prepare("SELECT id,turn_id FROM memory_sources WHERE thread_id=? AND kind='turn' AND outcome='working'").all(threadId)) {
        captureSource(db,{id:String(row.id),threadId,turnId:String(row.turn_id),kind:"turn",speaker:"harness",outcome,text:`Turn ${outcome}.`});
      }
    }
    captureSource(db,{id:`turn:${threadId}:${turnId}`,threadId,turnId,kind:"turn",speaker:"harness",outcome,text:`Turn ${outcome}.`});
  });
}
export function reconcileInterruptedMemoryTurns() {
  transaction(db => {
    // Served by memory_sources_kind_outcome (memory schema v9) once it is built: only the sources still `working` are read, however many
    // turns the history holds (a full read of the sources took 36 s at start on the scale rig; the index answers in under a millisecond).
    // The index is built in the background after an upgrade (cold-index-build.ts); until then a turn's source is found through the primary
    // key's range (its id is `turn:<thread>:<turn>`), which does not read the other sources.
    const sql = coldLineageIndexPresent(db, SOURCE_KIND_INDEX)
      ? "SELECT id,thread_id,turn_id FROM memory_sources WHERE kind='turn' AND outcome='working'"
      : "SELECT id,thread_id,turn_id FROM memory_sources WHERE id>='turn:' AND id<'turn;' AND kind='turn' AND outcome='working'";
    for (const row of db.prepare(sql).all()) {
      captureSource(db,{id:String(row.id),threadId:String(row.thread_id),turnId:String(row.turn_id),kind:"turn",speaker:"harness",outcome:"interrupted",text:"Turn interrupted by process restart."});
    }
  });
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
