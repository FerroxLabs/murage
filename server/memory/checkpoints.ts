import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** One checkpoint per (scope, thread): consolidate.ts publishes it under this id
 * and the dispatch path recognizes a thread's own checkpoint by it. */
export function threadCheckpointId(scopeId: string, threadId: string) {
  return `checkpoint:${createHash("sha256").update(JSON.stringify([scopeId,threadId])).digest("hex")}`;
}

/** A cancelled intention is not a completed effect. A non-owner statement from a
 * turn that settled other than completed is not current evidence; an owner
 * statement or an independently completed tool result survives the settlement. */
export function unsettledIntention(db: DatabaseSync, source: Record<string, unknown>) {
  if (!source.turn_id || source.speaker === "owner" || (source.speaker === "tool" && source.outcome === "completed")) return false;
  const settlement = db.prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND turn_id=? AND kind='turn' AND state='active' LIMIT 1").get(String(source.thread_id), String(source.turn_id));
  return Boolean(settlement && settlement.outcome !== "completed");
}

/** A checkpoint is a bounded index of evidence, not replacement factual authority. */
export function checkpointReferences(records: Array<{id:string;version:number;text:string}>, maximumBytes=1536) {
  const selected: Array<{id:string;version:number;text:string}>=[];let bytes=0;
  for(const record of records){const size=Buffer.byteLength(record.text);if(bytes+size>maximumBytes)continue;selected.push(record);bytes+=size;}
  return {records:selected,omitted:records.length-selected.length,bytes};
}
