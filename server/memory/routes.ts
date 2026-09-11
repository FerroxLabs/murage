import { z } from "zod";
import { Buffer } from "node:buffer";
import { database,transaction } from "../database.ts";
import { assertMemoryAccess,type MemoryAccess } from "./policy.ts";
import { searchMemory,type MemorySearchBridge } from "./search.ts";
import { hydrateDisclosedMemoryRecord, hydrateMemoryRecord } from "./bundle.ts";
import { memoryState } from "./repository.ts";
import { saveMemoryCandidate } from "./authority.ts";
import { MEMORY_HANDLE_PATTERN } from "../../shared/memory.ts";

/** Resolves the turn-local handles of the dispatch this capability belongs to
 * (MemoryDispatchReceipt.resolveHandle). Absent when no dispatch is live. */
export interface MemoryHandleResolver { resolveHandle(handle:string,access:MemoryAccess):{id:string;version:number}|undefined }

const id=z.string().min(1).max(256);
const version=z.number().int().min(1);
const evidence=z.array(z.object({sourceId:id,revision:version,startByte:z.number().int().nonnegative(),endByte:z.number().int().positive()}).strict()).min(1).max(20);
const key=z.string().regex(/^[\w-]{1,160}$/);
const search=z.object({query:z.string().min(1).refine(s=>Buffer.byteLength(s)<=4096),limit:z.number().int().min(1).max(20).optional(),historical:z.boolean().optional(),cursor:z.string().min(1).max(160).optional()}).strict();
const turnHandle=z.string().regex(MEMORY_HANDLE_PATTERN);
// A remembered line is addressed by its turn-local handle (m1, m2, …) or by
// the exact id/version memory_search returned; never by a mix of the two.
const reference=z.union([z.object({id,version}).strict(),z.object({handle:turnHandle}).strict()]);
const get=z.object({handles:z.array(reference).min(1).max(20)}).strict();
const save=z.object({text:z.string().min(1).max(4096),evidence,idempotencyKey:key}).strict();
const proposal={replacement:z.string().min(1).max(4096),evidence,idempotencyKey:key};
const correction=z.union([z.object({id,version,...proposal}).strict(),z.object({handle:turnHandle,...proposal}).strict()]);

function bounded<T>(result:T):T {
  if(Buffer.byteLength(JSON.stringify(result))>32768)throw Object.assign(new Error("MEMORY_RESPONSE_LIMIT: request fewer records"),{status:413});
  return result;
}

/** Called only after the harness binds a live memory capability to this context. */
export async function memoryAgentRoute(path:string,body:unknown,access:MemoryAccess,bridge:MemorySearchBridge,handles?:MemoryHandleResolver) {
  assertMemoryAccess(access);
  if(memoryState().mode!=="active")throw Object.assign(new Error("MEMORY_NOT_ACTIVE"),{status:409});
  /** A handle names a line of this turn's frame; anything else is unknown, not
   * a guessable record. The record it names is the one the turn was shown. */
  const resolve=(handle:string)=>{
    const record=handles?.resolveHandle(handle,access);
    if(!record)throw Object.assign(new Error(`MEMORY_HANDLE_UNKNOWN: ${handle} is not a remembered line of this request`),{status:404});
    return record;
  };
  try {
    if(path==="/api/internal/memory/search"){
      const input=search.parse(body);
      return bounded(await searchMemory(input.query,access,bridge,input));
    }
    if(path==="/api/internal/memory/get"){
      const input=get.parse(body);
      const records=input.handles.map(item=>{
        if(!("handle" in item))return hydrateMemoryRecord(item.id,item.version,access);
        const {id:recordId,version:recordVersion}=resolve(item.handle);
        return {handle:item.handle,...hydrateDisclosedMemoryRecord(recordId,recordVersion,access)};
      });
      assertMemoryAccess(access);return bounded({records});
    }
    if(path==="/api/internal/memory/save"){
      const input=save.parse(body);
      return {candidateId:saveMemoryCandidate(input.text,input.evidence,input.idempotencyKey,access),state:"candidate",pendingReview:true};
    }
    if(path==="/api/internal/memory/propose-correction"){
      const input=correction.parse(body);
      const target="handle" in input?resolve(input.handle):{id:input.id,version:input.version};
      hydrateMemoryRecord(target.id,target.version,access);
      return transaction(db=>{
        const latest=database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(target.id);
        if(latest?.version!==target.version)throw new Error("MEMORY_VERSION_CONFLICT");
        const candidateId=saveMemoryCandidate(input.replacement,input.evidence,input.idempotencyKey,access);
        const previous=db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=1").get(candidateId);
        if(previous?.supersedes_id && previous.supersedes_id!==target.id)throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
        // One proposal names exactly one target version. A replay against a
        // later version must not add a second derivation: owner approval reads
        // this row to validate the exact revision that was reviewed.
        const recorded=db.prepare("SELECT parent_version FROM memory_derivations WHERE parent_id=? AND child_id=? AND child_version=1").all(target.id,candidateId);
        if(recorded.some(row=>Number(row.parent_version)!==target.version))throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
        db.prepare("UPDATE memory_records SET supersedes_id=? WHERE id=? AND state='candidate'").run(target.id,candidateId);
        db.prepare("INSERT OR IGNORE INTO memory_derivations VALUES(?,?,?,1)").run(target.id,target.version,candidateId);
        return {candidateId,state:"candidate",pendingReview:true,record:{id:target.id,version:target.version},...("handle" in input?{handle:input.handle}:{})};
      });
    }
    throw Object.assign(new Error("MEMORY_ROUTE_UNAVAILABLE"),{status:404});
  }catch(error){
    if(error instanceof z.ZodError)throw Object.assign(new Error("INVALID_MEMORY_ARGUMENTS"),{status:400});
    throw error;
  }
}
