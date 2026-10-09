import { readMemoryEvolutionPolicy, type MemoryEvolutionPolicy } from "./evolution-policy.ts";
import { humanMayReadRecord } from "../human-principals.ts";
import { database } from "../database.ts";
import { accessIncludesRoom, assertMemoryAccess, inMemoryAccessPass, type MemoryAccess } from "./policy.ts";
import type { IndexHit } from "./index.ts";
import { createHash } from "node:crypto";
import { MemoryQueryCache } from "./cache.ts";
import { selectMemoryEvidence } from "./relevance.ts";
import { recentMemoryHits } from "./recent.ts";
import { lexicalPage, memoryIndexReaderState, RECALL_FIRST_PAGE, RECALL_MAX_HITS } from "./index-reader.ts";
import { hasPendingProjection } from "./projection.ts";
import { logSwallowed } from "./worker-log.ts";
import { noteRecallMode } from "./recall-budget.ts";
import { recordMemoryRetrieval } from "./health.ts";
import { unsettledIntention } from "./checkpoints.ts";
import { recordRestsOnWithheldMessage } from "./replay-lineage.ts";
import { noteMemorySearch } from "./turn-stats.ts";
const queryCache=new MemoryQueryCache<{hits:IndexHit[];degradedReason?:string;vectorRows:number;nextCursor?:string;coverageComplete?:boolean}>();

import { CURRENT_MEMORY,HISTORICAL_MEMORY } from "./eligibility.ts";
import { isPipKind } from "./pip-kinds.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";
export { CURRENT_MEMORY } from "./eligibility.ts";
/** What a turn waits for recall. The worker is told when it ends. */
export const SEARCH_BUDGET_MS=500;
/** With the words already read in this process, the helper's embedding and vectors get this long; a miss means words only. */
export const SEMANTIC_CUTOFF_MS=150;
/** Past this much total time hydration stops and what is read so far is returned, flagged degraded. */
const HYDRATION_LIMIT_MS=SEARCH_BUDGET_MS*2;
export interface MemorySearchBridge {
  search(input:MemorySearchInput,signal:AbortSignal):Promise<{hits:IndexHit[];degradedReason?:string;vectorRows:number;nextCursor?:string;coverageComplete?:boolean}>;
  completedSource?(jobId:string):void;
}
export async function searchMemory(query:string,access:MemoryAccess,bridge:MemorySearchBridge,options:{limit?:number;historical?:boolean;cursor?:string;signal?:AbortSignal;profile?:boolean;lexical?:typeof lexicalPage|null;evolutionPolicy?:MemoryEvolutionPolicy;withheldMessage?:(threadId:string,messageId:string)=>boolean}={}){
  const serviceStarted=performance.now();
  // The budget starts here, before the synchronous preparation below, and the
  // worker is handed the same deadline.
  const deadlineAt=Date.now()+SEARCH_BUDGET_MS;
  const signal=AbortSignal.any([options.signal??new AbortController().signal,AbortSignal.timeout(SEARCH_BUDGET_MS)]);
  assertMemoryAccess(access);
  const evolutionPolicy=options.evolutionPolicy??readMemoryEvolutionPolicy();
  if(!query.trim()||Buffer.byteLength(query)>4096)throw new Error("INVALID_MEMORY_QUERY");
  const limit=Math.min(20,Math.max(1,options.limit??10));
  const historical=HISTORICAL_MEMORY;
  const meta=database().prepare("SELECT data_revision FROM memory_meta WHERE id=1").get()!;
  const cacheKey=createHash("sha256").update(JSON.stringify([query,limit,access.scopeIds,access.policyRevision,access.deletionEpoch,meta.data_revision,options.historical??false,options.cursor??""])).digest("hex");
  const cached=queryCache.get(cacheKey);
  const bridgeStarted=performance.now();
  // The helper (embedding and vectors) is asked first so it works while this process reads the words; the words never wait for it.
  // With the words in hand the helper gets only SEMANTIC_CUTOFF_MS from the start of the search; a miss means words only. If the
  // index cannot be read the helper keeps the whole budget.
  const helperAbort=new AbortController();
  const helperSignal=AbortSignal.any([signal,helperAbort.signal]);
  const helper=cached?null:(()=>{
    try{return withinDeadline(bridge.search({query,scopeIds:[...access.scopeIds],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:options.historical??false,cursor:options.cursor??"",limit,semantic:true,deadlineAt,...options.profile?{profile:true}:{}},helperSignal),helperSignal);}
    catch(error){return Promise.reject(error);}
  })();
  helper?.catch(()=>{});
  const lexicalSource=options.lexical===undefined?lexicalPage:options.lexical;
  const direct=lexicalSource?lexicalSource(query,access.scopeIds,RECALL_FIRST_PAGE):null;
  const lexicalReady=direct!==null;
  const cutoff=lexicalReady&&helper?setTimeout(()=>helperAbort.abort(),Math.max(0,SEMANTIC_CUTOFF_MS-(performance.now()-serviceStarted))):undefined;
  let result:{hits:IndexHit[];degradedReason?:string;vectorRows:number;nextCursor?:string;coverageComplete?:boolean};
  let helperAnswered=true;
  try{result=cached??await helper!;}
  catch(error){
    options.signal?.throwIfAborted();assertMemoryAccess(access);
    logSwallowed("recall",error);helperAnswered=false;
    result=lexicalReady
      ?{hits:[] as IndexHit[],vectorRows:0,degradedReason:"semantic-skipped",coverageComplete:!hasPendingProjection(database())}
      :{hits:[] as IndexHit[],vectorRows:0,degradedReason:"MEMORY_RECALL_UNAVAILABLE",coverageComplete:false};
  }
  finally{if(cutoff)clearTimeout(cutoff);}
  if(!lexicalReady&&helperAnswered&&["missing","unreadable"].includes(memoryIndexReaderState()))result={...result,coverageComplete:false};
  const bridgeDone=performance.now();
  if(helperAnswered&&!cached&&!result.degradedReason && result.coverageComplete && result.vectorRows>0)queryCache.set(cacheKey,result);
  assertMemoryAccess(access);
  const recent=options.historical?[]:recentMemoryHits(query,access);
  const combined=mergeWordHits(result.hits,direct?.hits??[],recent);
  // Hydration is synchronous: validate each distinct audience once, while
  // retaining the authoritative current record/source check for every hit.
  const checkedScopes=new Set<string>();
  // Owner-private identity stays in direct turns; a room member's own bot
  // scope does not carry it into the room (same rule as bundle hydration).
  const room=accessIncludesRoom(access);
  let partial=false;
  const hydrate=(list:IndexHit[])=>inMemoryAccessPass(()=>list.map(hit=>{
    if(partial||performance.now()-serviceStarted>HYDRATION_LIMIT_MS){partial=true;return null;}
    const record=database().prepare(`SELECT * FROM memory_records r WHERE id=? AND version=? AND ${options.historical?historical:CURRENT_MEMORY}`).get(hit.id,hit.version);
    if(!record || isPipKind(record.kind) || !humanMayReadRecord(database(),hit.id,hit.version,access.humanPrincipal))return null;
    if(room && database().prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND record_version=? AND partition='identity'").get(hit.id,hit.version))return null;
    const scopeId=String(record.scope_id);
    if(!checkedScopes.has(scopeId)){assertMemoryAccess(access,scopeId);checkedScopes.add(scopeId);}
    // A withheld reply is not found again through search (replay-lineage.ts),
    // an owner pin resting on one included (0.1.61 third check, P1).
    if(recordRestsOnWithheldMessage(hit.id,hit.version,options.withheldMessage))return null;
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
  }).filter((row):row is NonNullable<typeof row>=>row!==null));
  const hits=hydrate(combined);
  // Fewer survivors than asked for: the first page was crowded by hits that are no longer current or not this reader's.
  // One more page, up to 200 ranked hits in all, read the same way.
  if(direct?.more&&hits.length<limit&&!partial&&lexicalSource){
    const more=lexicalSource(query,access.scopeIds,RECALL_MAX_HITS-RECALL_FIRST_PAGE,RECALL_FIRST_PAGE);
    if(more){const seen=new Set(combined.map(hit=>`${hit.id}:${hit.version}`));hits.push(...hydrate(more.hits.filter(hit=>!seen.has(`${hit.id}:${hit.version}`))));}
  }
  assertMemoryAccess(access);
  const optional=new Set(selectMemoryEvidence(query,hits.filter(hit=>!hit.pinned),evolutionPolicy));
  const selected=hits.filter(hit=>hit.pinned||optional.has(hit)).slice(0,limit);
  recordMemoryRetrieval(selected.length);
  noteRecallMode(access.threadId,result.vectorRows>0?"hybrid":"lexical");
  noteMemorySearch(selected.length,performance.now()-serviceStarted,{prepMs:bridgeStarted-serviceStarted,bridgeMs:bridgeDone-bridgeStarted,hydrationMs:performance.now()-bridgeDone});
  return {...result,...partial&&!result.degradedReason?{degradedReason:"MEMORY_RECALL_UNAVAILABLE",coverageComplete:false}:{},evolutionPolicyRevision:evolutionPolicy.revision,...recent.length?{coverageComplete:false,recentFallback:true}:{},hits:selected,...options.profile?{profileCacheHit:Boolean(cached),serviceProfile:{preparationMs:bridgeStarted-serviceStarted,bridgeMs:bridgeDone-bridgeStarted,hydrationMs:performance.now()-bridgeDone}}:{}};
}

/** A bridge that is busy with a long job (or deaf to the abort) cannot hold the turn: the
 * wait ends when the signal does, whether or not the bridge answers. */
function withinDeadline<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  work.catch(()=>{});
  return new Promise<T>((resolve,reject)=>{
    const stop=()=>reject(new Error("MEMORY_QUERY_DEADLINE"));
    if(signal.aborted)return stop();
    signal.addEventListener("abort",stop,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener("abort",stop));
  });
}

/** The helper's ranked hits (words and vectors fused), then any word hit it did not return, then the recent fallback. */
function mergeWordHits(helper:IndexHit[],words:IndexHit[],recent:IndexHit[]):IndexHit[]{
  const seen=new Set(helper.map(hit=>`${hit.id}:${hit.version}`));
  const extra=words.filter(hit=>!seen.has(`${hit.id}:${hit.version}`));
  const ranked=extra.length?[...helper,...extra].sort((a,b)=>b.score-a.score):helper;
  const known=new Set(ranked.map(hit=>`${hit.id}:${hit.version}`));
  return [...ranked,...recent.filter(hit=>!known.has(`${hit.id}:${hit.version}`))];
}
