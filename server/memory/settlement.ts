import { transaction } from "../database.ts";
import { captureSource } from "./capture.ts";

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
    for (const row of db.prepare("SELECT id,thread_id,turn_id FROM memory_sources WHERE kind='turn' AND outcome='working'").all()) {
      captureSource(db,{id:String(row.id),threadId:String(row.thread_id),turnId:String(row.turn_id),kind:"turn",speaker:"harness",outcome:"interrupted",text:"Turn interrupted by process restart."});
    }
  });
}
