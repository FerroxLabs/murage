import { z } from "zod";
import { Buffer } from "node:buffer";
import { database,transaction } from "../database.ts";
import { assertMemoryAccess,type MemoryAccess } from "./policy.ts";
import { searchMemory,type MemorySearchBridge } from "./search.ts";
import { hydrateMemoryRecord } from "./bundle.ts";
import { memoryState } from "./repository.ts";
import { saveMemoryCandidate } from "./authority.ts";

const id=z.string().min(1).max(256);
const version=z.number().int().min(1);
const evidence=z.array(z.object({sourceId:id,revision:version,startByte:z.number().int().nonnegative(),endByte:z.number().int().positive()}).strict()).min(1).max(20);
const key=z.string().regex(/^[\w-]{1,160}$/);
const search=z.object({query:z.string().min(1).refine(s=>Buffer.byteLength(s)<=4096),limit:z.number().int().min(1).max(20).optional(),historical:z.boolean().optional(),cursor:z.string().min(1).max(160).optional()}).strict();
const get=z.object({handles:z.array(z.object({id,version}).strict()).min(1).max(20)}).strict();
const save=z.object({text:z.string().min(1).max(4096),evidence,idempotencyKey:key}).strict();
const correction=z.object({id,version,replacement:z.string().min(1).max(4096),evidence,idempotencyKey:key}).strict();

function bounded<T>(result:T):T {
  if(Buffer.byteLength(JSON.stringify(result))>32768)throw Object.assign(new Error("MEMORY_RESPONSE_LIMIT: request fewer records"),{status:413});
  return result;
}

/** Called only after the harness binds a live memory capability to this context. */
export async function memoryAgentRoute(path:string,body:unknown,access:MemoryAccess,bridge:MemorySearchBridge) {
  assertMemoryAccess(access);
  if(memoryState().mode!=="active")throw Object.assign(new Error("MEMORY_NOT_ACTIVE"),{status:409});
  try {
    if(path==="/api/internal/memory/search"){
      const input=search.parse(body);
      return bounded(await searchMemory(input.query,access,bridge,input));
    }
    if(path==="/api/internal/memory/get"){
      const input=get.parse(body);
      const records=input.handles.map(handle=>hydrateMemoryRecord(handle.id,handle.version,access));
      assertMemoryAccess(access);return bounded({records});
    }
    if(path==="/api/internal/memory/save"){
      const input=save.parse(body);
      return {candidateId:saveMemoryCandidate(input.text,input.evidence,input.idempotencyKey,access),state:"candidate",pendingReview:true};
    }
    if(path==="/api/internal/memory/propose-correction"){
      const input=correction.parse(body);
      hydrateMemoryRecord(input.id,input.version,access);
      return transaction(db=>{
        const latest=database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(input.id);
        if(latest?.version!==input.version)throw new Error("MEMORY_VERSION_CONFLICT");
        const candidateId=saveMemoryCandidate(input.replacement,input.evidence,input.idempotencyKey,access);
        const previous=db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=1").get(candidateId);
        if(previous?.supersedes_id && previous.supersedes_id!==input.id)throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
        // One proposal names exactly one target version. A replay against a
        // later version must not add a second derivation: owner approval reads
        // this row to validate the exact revision that was reviewed.
        const recorded=db.prepare("SELECT parent_version FROM memory_derivations WHERE parent_id=? AND child_id=? AND child_version=1").all(input.id,candidateId);
        if(recorded.some(row=>Number(row.parent_version)!==input.version))throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
        db.prepare("UPDATE memory_records SET supersedes_id=? WHERE id=? AND state='candidate'").run(input.id,candidateId);
        db.prepare("INSERT OR IGNORE INTO memory_derivations VALUES(?,?,?,1)").run(input.id,input.version,candidateId);
        return {candidateId,state:"candidate",pendingReview:true,record:{id:input.id,version:input.version}};
      });
    }
    throw Object.assign(new Error("MEMORY_ROUTE_UNAVAILABLE"),{status:404});
  }catch(error){
    if(error instanceof z.ZodError)throw Object.assign(new Error("INVALID_MEMORY_ARGUMENTS"),{status:400});
    throw error;
  }
}
