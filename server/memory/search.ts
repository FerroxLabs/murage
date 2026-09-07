import { database } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import type { IndexHit } from "./index.ts";
import { createHash } from "node:crypto";
import { MemoryQueryCache } from "./cache.ts";
import { selectMemoryEvidence } from "./relevance.ts";
const queryCache=new MemoryQueryCache<{hits:IndexHit[];degradedReason?:string;vectorRows:number;nextCursor?:string;coverageComplete?:boolean}>();

import { CURRENT_MEMORY,HISTORICAL_MEMORY } from "./eligibility.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";
export { CURRENT_MEMORY } from "./eligibility.ts";
export interface MemorySearchBridge {
  search(input:MemorySearchInput,signal:AbortSignal):Promise<{hits:IndexHit[];degradedReason?:string;vectorRows:number;nextCursor?:string;coverageComplete?:boolean}>;
}
export async function searchMemory(query:string,access:MemoryAccess,bridge:MemorySearchBridge,options:{limit?:number;historical?:boolean;cursor?:string;signal?:AbortSignal;profile?:boolean}={}){
  const serviceStarted=performance.now();
  assertMemoryAccess(access);
  if(!query.trim()||Buffer.byteLength(query)>4096)throw new Error("INVALID_MEMORY_QUERY");
  const limit=Math.min(20,Math.max(1,options.limit??10));
  const historical=HISTORICAL_MEMORY;
  const meta=database().prepare("SELECT data_revision FROM memory_meta WHERE id=1").get()!;
  const signal=AbortSignal.any([options.signal??new AbortController().signal,AbortSignal.timeout(500)]);
  const cacheKey=createHash("sha256").update(JSON.stringify([query,limit,access.scopeIds,access.policyRevision,access.deletionEpoch,meta.data_revision,options.historical??false,options.cursor??""])).digest("hex");
  const cached=queryCache.get(cacheKey);
  const bridgeStarted=performance.now();
  const result=cached??await bridge.search({query,scopeIds:[...access.scopeIds],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:options.historical??false,cursor:options.cursor??"",limit,semantic:true,...options.profile?{profile:true}:{}},signal);
  const bridgeDone=performance.now();
  if(!result.degradedReason && result.coverageComplete && result.vectorRows>0)queryCache.set(cacheKey,result);
  assertMemoryAccess(access);
  // Hydration is synchronous: validate each distinct audience once, while
  // retaining the authoritative current record/source check for every hit.
  const checkedScopes=new Set<string>();
  const hits=result.hits.map(hit=>{
    const record=database().prepare(`SELECT * FROM memory_records r WHERE id=? AND version=? AND ${options.historical?historical:CURRENT_MEMORY}`).get(hit.id,hit.version);
    if(!record)return null;
    const scopeId=String(record.scope_id);
    if(!checkedScopes.has(scopeId)){assertMemoryAccess(access,scopeId);checkedScopes.add(scopeId);}
    return {...hit,text:String(record.text),scopeId:String(record.scope_id),assertion:String(record.assertion),state:String(record.state),pinned:record.owner_pinned===1,
      evidence:database().prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=?").all(hit.id,hit.version)};
  }).filter((row):row is NonNullable<typeof row>=>row!==null);
  assertMemoryAccess(access);
  const optional=new Set(selectMemoryEvidence(query,hits.filter(hit=>!hit.pinned)));
  return {...result,hits:hits.filter(hit=>hit.pinned||optional.has(hit)),...options.profile?{profileCacheHit:Boolean(cached),serviceProfile:{preparationMs:bridgeStarted-serviceStarted,bridgeMs:bridgeDone-bridgeStarted,hydrationMs:performance.now()-bridgeDone}}:{}};
}
