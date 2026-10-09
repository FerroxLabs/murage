import { randomUUID } from "node:crypto";
import { BACKGROUND_BUSY_MS, database, DatabaseBusyError, isDatabaseBusy, withBusyBudget } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { CURRENT_MEMORY } from "./eligibility.ts";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import type { IndexHit } from "./index.ts";

/** A small authorized catch-up uses the same durable leases as the worker.
 * At most two 64KiB source chunks; no synthesis/model work on this path.
 *
 * This WRITES (a claim, the records and a checkpoint), so it is not part of recall: searchMemory and bundle
 * assembly perform no writes at all (PROPOSAL-v2 10.1, AUDIT B1). The turn calls catchUpRecentMemory once,
 * before recall starts, so a message written a moment ago is still found while the worker is behind. */
export function materializeRecentMemory(access: MemoryAccess, signal?: AbortSignal, onCompleted?: (jobId:string)=>void, exclude?: { messageIds?: readonly string[]; withinMs?: number }) {
  const owner=`recall-${randomUUID()}`,start=performance.now();let completed=0;
  for(let n=0;n<2&&performance.now()-start<25;n++){
    signal?.throwIfAborted();assertMemoryAccess(access);
    const work=claimMemoryJob(owner,Date.now(),access.scopeIds,{...exclude?.messageIds?.length?{exclude:{threadId:access.threadId,messageIds:exclude.messageIds}}:{},...exclude?.withinMs!==undefined?{recentWithinMs:exclude.withinMs}:{}});
    if(!work)break;
    const result=captureWork(work);
    signal?.throwIfAborted();assertMemoryAccess(access,work.scopeId);
    publishMemoryWork(work,owner,result);completed++;
    if(result.status==="complete"){
      const id=work.id;
      if(onCompleted)setImmediate(()=>onCompleted(id));
      refreshMemoryCheckpoint(id);
    }
  }
  return completed;
}

/** Bounded fallback, not an alternate full archive search. Scans at most the
 * latest256 canonical rows and returns only current authorized lexical hits. */
export function recentMemoryHits(query:string,access:MemoryAccess):IndexHit[]{
  assertMemoryAccess(access);
  const terms=[...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)??[])].slice(0,20);
  if(!terms.length)return [];
  const rows=database().prepare(`SELECT r.id,r.version,r.text FROM memory_records r
    WHERE r.rowid IN (SELECT rowid FROM memory_records WHERE kind NOT IN ${PIP_ALL_KINDS_SQL} ORDER BY rowid DESC LIMIT 256)
    AND r.scope_id IN (SELECT value FROM json_each(?)) AND ${CURRENT_MEMORY}
    AND NOT EXISTS (SELECT 1 FROM memory_projection_receipts p WHERE p.record_id=r.id AND p.record_version=r.version AND p.lexical_status='indexed')
    ORDER BY r.rowid DESC LIMIT 128`).all(JSON.stringify(access.scopeIds));
  return rows.flatMap(row=>{
    const text=String(row.text).normalize("NFKC").toLowerCase();
    const matches=terms.filter(term=>text.includes(term)).length;
    return matches?[{id:String(row.id),version:Number(row.version),score:matches/terms.length,lexical:true}]:[];
  }).slice(0,20);
}

/** The turn's one catch-up step, run before recall: skips the messages the turn already holds (its own prompt: recall leaves it out, so
 * capturing it now buys nothing and costs three writes), lock-tolerant (a held write lock means "the worker will
 * get to it", not an error and not a wait), and never longer than two chunks or 25 ms of work. */
export const CATCH_UP_WINDOW_MS = 15 * 60_000;
export function catchUpRecentMemory(access: MemoryAccess, signal?: AbortSignal, onCompleted?: (jobId:string)=>void, exclude?: { messageIds: readonly string[] }): number {
  // Only what was written in the last quarter hour: a standing backlog (an upgrade, a long outage) is the worker's, not one turn's.
  try { return withBusyBudget(BACKGROUND_BUSY_MS, "recall-catchup", () => materializeRecentMemory(access, signal, onCompleted, { ...exclude, withinMs: CATCH_UP_WINDOW_MS })); }
  catch (error) {
    if (error instanceof DatabaseBusyError || isDatabaseBusy(error)) return 0;
    throw error;
  }
}
