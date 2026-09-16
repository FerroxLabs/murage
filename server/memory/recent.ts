import { randomUUID } from "node:crypto";
import { database } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { CURRENT_MEMORY } from "./eligibility.ts";
import type { IndexHit } from "./index.ts";

/** A small authorized catch-up uses the same durable leases as the worker.
 * At most two 64KiB source chunks; no synthesis/model work on this path. */
export function materializeRecentMemory(access: MemoryAccess, signal?: AbortSignal, onCompleted?: (jobId:string)=>void) {
  const owner=`recall-${randomUUID()}`,start=performance.now();let completed=0;
  for(let n=0;n<2&&performance.now()-start<25;n++){
    signal?.throwIfAborted();assertMemoryAccess(access);
    const work=claimMemoryJob(owner,Date.now(),access.scopeIds);
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
    WHERE r.rowid IN (SELECT rowid FROM memory_records ORDER BY rowid DESC LIMIT 256)
    AND r.scope_id IN (SELECT value FROM json_each(?)) AND ${CURRENT_MEMORY}
    AND NOT EXISTS (SELECT 1 FROM memory_projection_receipts p WHERE p.record_id=r.id AND p.record_version=r.version AND p.lexical_status='indexed')
    ORDER BY r.rowid DESC LIMIT 128`).all(JSON.stringify(access.scopeIds));
  return rows.flatMap(row=>{
    const text=String(row.text).normalize("NFKC").toLowerCase();
    const matches=terms.filter(term=>text.includes(term)).length;
    return matches?[{id:String(row.id),version:Number(row.version),score:matches/terms.length,lexical:true}]:[];
  }).slice(0,20);
}
