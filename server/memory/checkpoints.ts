import { createHash } from "node:crypto";

/** One checkpoint per (scope, thread): consolidate.ts publishes it under this id
 * and the dispatch path recognizes a thread's own checkpoint by it. */
export function threadCheckpointId(scopeId: string, threadId: string) {
  return `checkpoint:${createHash("sha256").update(JSON.stringify([scopeId,threadId])).digest("hex")}`;
}

/** A checkpoint is a bounded index of evidence, not replacement factual authority. */
export function checkpointReferences(records: Array<{id:string;version:number;text:string}>, maximumBytes=1536) {
  const selected: Array<{id:string;version:number;text:string}>=[];let bytes=0;
  for(const record of records){const size=Buffer.byteLength(record.text);if(bytes+size>maximumBytes)continue;selected.push(record);bytes+=size;}
  return {records:selected,omitted:records.length-selected.length,bytes};
}
