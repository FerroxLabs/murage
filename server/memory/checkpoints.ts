import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { database } from "../database.ts";
import type { MemoryAccess } from "./policy.ts";

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

/** A thread's own checkpoint rolls on every captured message in that thread, the
 * turn's own prompt and reply included, so the version selected for a dispatch
 * is routinely archived inside the dispatch window. That supersession forgets
 * nothing: the archived version is a bounded index of evidence that is still
 * active at the same revisions, under the same policy revision and deletion
 * epoch (an owner forget, archive or policy change moves one of those and is
 * refused on its own). A disclosed version in that state is stale, not
 * revoked. Everything else stays fail-closed: the record must be the current
 * thread's checkpoint, unpinned, untombstoned, with a newer active version and
 * every evidence source intact.
 *
 * "The current thread" is the thread the turn is dispatched for
 * (access.threadId), never the bot's own thread: a room member's turn is
 * claimed for the room thread (server/index.ts runGroupMemberTurn), so the
 * room checkpoint — which rolls on every member's prompt and reply — is that
 * turn's own, while the member's own-thread checkpoint and other rooms'
 * checkpoints are not (dispatch-preparation.test.ts, RED2E). */
export function supersededThreadCheckpoint(id: string, version: number, access: Pick<MemoryAccess,"threadId">): boolean {
  const db = database();
  const row = db.prepare("SELECT scope_id,kind,state,owner_pinned FROM memory_records WHERE id=? AND version=?").get(id,version);
  if (!row || row.kind !== "checkpoint" || row.state !== "archived" || row.owner_pinned === 1 || id !== threadCheckpointId(String(row.scope_id),access.threadId)) return false;
  return Boolean(db.prepare("SELECT 1 FROM memory_records WHERE id=? AND version>? AND state='active' LIMIT 1").get(id,version));
}
