import { readMemoryEvolutionPolicy, type MemoryEvolutionPolicy } from "./evolution-policy.ts";
import { humanMayReadRecord } from "../human-principals.ts";
import { database } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import type { IndexHit } from "./index.ts";
import { createHash } from "node:crypto";
import { MemoryQueryCache } from "./cache.ts";
import { selectMemoryEvidence } from "./relevance.ts";
import { materializeRecentMemory, recentMemoryHits } from "./recent.ts";
import { recordMemoryRetrieval } from "./health.ts";
import { unsettledIntention } from "./checkpoints.ts";
const queryCache=new MemoryQueryCache<{hits:IndexHit[];degradedReason?:string;vectorRows:number;nextCursor?:string;coverageComplete?:boolean}>();

import { CURRENT_MEMORY,HISTORICAL_MEMORY } from "./eligibility.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";
export { CURRENT_MEMORY } from "./eligibility.ts";
export interface MemorySearchBridge {
  search(input:MemorySearchInput,signal:AbortSignal):Promise<{hits:IndexHit[];degradedReason?:string;vectorRows:number;nextCursor?:string;coverageComplete?:boolean}>;
  completedSource?(jobId:string):void;
}
export async function searchMemory(query:string,access:MemoryAccess,bridge:MemorySearchBridge,options:{limit?:number;historical?:boolean;cursor?:string;signal?:AbortSignal;profile?:boolean;evolutionPolicy?:MemoryEvolutionPolicy}={}){
  const evolutionPolicy=options.evolutionPolicy??readMemoryEvolutionPolicy();
  const serviceStarted=performance.now();
  assertMemoryAccess(access);
  if(!query.trim()||Buffer.byteLength(query)>4096)throw new Error("INVALID_MEMORY_QUERY");
  const limit=Math.min(20,Math.max(1,options.limit??10));
  const historical=HISTORICAL_MEMORY;
  if(!options.historical)materializeRecentMemory(access,options.signal,jobId=>bridge.completedSource?.(jobId));
  const meta=database().prepare("SELECT data_revision FROM memory_meta WHERE id=1").get()!;
  const signal=AbortSignal.any([options.signal??new AbortController().signal,AbortSignal.timeout(500)]);
  const cacheKey=createHash("sha256").update(JSON.stringify([query,limit,access.scopeIds,access.policyRevision,access.deletionEpoch,meta.data_revision,options.historical??false,options.cursor??""])).digest("hex");
  const cached=queryCache.get(cacheKey);
  const bridgeStarted=performance.now();
  let result;
  try{result=cached??await bridge.search({query,scopeIds:[...access.scopeIds],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:options.historical??false,cursor:options.cursor??"",limit,semantic:true,...options.profile?{profile:true}:{}},signal);}
  catch{options.signal?.throwIfAborted();assertMemoryAccess(access);result={hits:[] as IndexHit[],vectorRows:0,degradedReason:"MEMORY_RECALL_UNAVAILABLE",coverageComplete:false};}
  const bridgeDone=performance.now();
  if(!result.degradedReason && result.coverageComplete && result.vectorRows>0)queryCache.set(cacheKey,result);
  assertMemoryAccess(access);
  const recent=options.historical?[]:recentMemoryHits(query,access);
  const combined=[...result.hits,...recent.filter(hit=>!result.hits.some(previous=>previous.id===hit.id&&previous.version===hit.version))];
  // Hydration is synchronous: validate each distinct audience once, while
  // retaining the authoritative current record/source check for every hit.
  const checkedScopes=new Set<string>();
  const hits=combined.map(hit=>{
    const record=database().prepare(`SELECT * FROM memory_records r WHERE id=? AND version=? AND ${options.historical?historical:CURRENT_MEMORY}`).get(hit.id,hit.version);
    if(!record || !humanMayReadRecord(database(),hit.id,hit.version,access.humanPrincipal))return null;
    const scopeId=String(record.scope_id);
    if(!checkedScopes.has(scopeId)){assertMemoryAccess(access,scopeId);checkedScopes.add(scopeId);}
    // A captured chunk keeps its source's settlement: an unsettled intention is not
    // current evidence, and a failed tool output is recallable only as a failure.
    const outcome:{sourceOutcome?:"failed"}={};
    if(record.kind==="source"){
      const sources=database().prepare("SELECT s.speaker,s.outcome,s.turn_id,s.thread_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?").all(hit.id,hit.version);
      if(!options.historical&&record.owner_pinned!==1&&sources.some(source=>unsettledIntention(database(),source)))return null;
      if(sources.some(source=>source.speaker==="tool"&&source.outcome==="failed"))outcome.sourceOutcome="failed";
    }
    return {...hit,text:String(record.text),scopeId:String(record.scope_id),assertion:String(record.assertion),state:String(record.state),pinned:record.owner_pinned===1,...outcome,
      validFrom:Number(record.valid_from),validTo:record.valid_to===null?null:Number(record.valid_to),recordedAt:Number(record.created_at),
      evidence:database().prepare("SELECT e.source_id AS sourceId,e.source_revision AS revision,e.start_byte AS startByte,e.end_byte AS endByte,json_extract(v.payload,'$.occurredAt') AS occurredAt FROM memory_evidence e JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE e.record_id=? AND e.record_version=?").all(hit.id,hit.version)};
  }).filter((row):row is NonNullable<typeof row>=>row!==null);
  assertMemoryAccess(access);
  const optional=new Set(selectMemoryEvidence(query,hits.filter(hit=>!hit.pinned),evolutionPolicy));
  const selected=hits.filter(hit=>hit.pinned||optional.has(hit)).slice(0,limit);
  recordMemoryRetrieval(selected.length);
  return {...result,evolutionPolicyRevision:evolutionPolicy.revision,...recent.length?{coverageComplete:false,recentFallback:true}:{},hits:selected,...options.profile?{profileCacheHit:Boolean(cached),serviceProfile:{preparationMs:bridgeStarted-serviceStarted,bridgeMs:bridgeDone-bridgeStarted,hydrationMs:performance.now()-bridgeDone}}:{}};
}
