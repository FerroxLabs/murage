import { readMemoryEvolutionPolicy, type MemoryEvolutionPolicy } from "./evolution-policy.ts";
import { database } from "../database.ts";
import { assertMemoryAccess, inMemoryAccessPass, memoryAccessIsOwnerAudience, type MemoryAccess } from "./policy.ts";
import { authorityStamp } from "./authority-epoch.ts";
import { denyGeneration } from "./deny-read.ts";
import { plausiblyReadable, readableMemoryRecord } from "./readable.ts";
import { isLineageLimit } from "./replay-lineage.ts";
import type { LineageAllowance } from "./lineage-allowance.ts";
import type { IndexHit } from "./index.ts";
import { byScore, compareRefs } from "./ref-order.ts";
import { eligibleAfter } from "./eligibility.ts";
import { createHash } from "node:crypto";
import { MemoryQueryCache } from "./cache.ts";
import { selectMemoryEvidence } from "./relevance.ts";
import { keywordMemoryHits, recentMemoryHits } from "./recent.ts";
import { lexicalPage, lexicalPageSliced, memoryIndexReaderState, RECALL_FIRST_PAGE, vectorlessAmong } from "./index-reader.ts";
import { pendingProjectionRefsAfter } from "./projection.ts";
import { causeOf, logSwallowed } from "./worker-log.ts";
import { rateLimited } from "../observe.ts";
import { noteRecallMode } from "./recall-budget.ts";
import { recordMemoryRetrieval } from "./health.ts";
import { noteMemorySearch } from "./turn-stats.ts";
const queryCache=new MemoryQueryCache<MemorySearchResult>();

import { SEARCH_LIST_DEPTH, type MemorySearchInput, type MemorySearchResult, type RankedRef } from "./worker-protocol.ts";
import { openMemoryCursor, sealMemoryCursor } from "./cursor.ts";
import { maskFinancialIdentifiers } from "../../shared/financial-ids.ts";
export { CURRENT_MEMORY } from "./eligibility.ts";
/** Who is waiting: the recall a turn makes before it starts ("turn"), or a bot's own memory_search call ("tool"). */
export type RecallCaller="turn"|"tool";
/** What a turn waits for recall. The worker is told when it ends. */
export const SEARCH_BUDGET_MS=500;
/** With the words already read in this process, the helper's embedding and vectors get this long; a miss means words only. */
export const SEMANTIC_CUTOFF_MS=150;
/** Past this much total time hydration stops and what is read so far is returned, flagged degraded. */
const HYDRATION_LIMIT_MS=SEARCH_BUDGET_MS*2;
/** A bot's explicit memory_search: the bot is already waiting for its tool result, so the helper gets 2.5 s, five times a
 * turn's budget, enough to ride out the 0.4-0.9 s (p90) event-loop stalls measured while memory work runs (perf102). The
 * memory proxy gives up at 5 s (memory-proxy.ts), so hydration stops at 3.5 s and leaves 1.5 s for the reply to travel. */
export const TOOL_SEARCH_BUDGET_MS=2500;
/** With the words in hand a tool search still gives the meaning search this long: a healthy helper answers in 0.1-0.3 s. */
export const TOOL_SEMANTIC_CUTOFF_MS=1000;
const TOOL_HYDRATION_LIMIT_MS=3500;
/** Of the hydration limit, what the keyword fallback leaves for checking the hits it found. */
const KEYWORD_HYDRATION_RESERVE_MS=100;
/** Every recall that comes back degraded says why, once a minute per caller and cause: codes and counts only, never memory text. */
const RECALL_LOG_WINDOW_MS=60_000;
export function noteRecallDegraded(caller:RecallCaller,cause:string,detail:{hits:number;ms:number;index:string;outcome:string}):void{
  rateLimited(`recall\u0000${caller}\u0000${cause}`,RECALL_LOG_WINDOW_MS,folded=>`[memory] recall caller=${caller} cause=${cause} outcome=${detail.outcome} hits=${detail.hits} ms=${Math.round(detail.ms)} index=${detail.index}${folded?` more=${folded}`:""}`);
}
/** What a bot reads alongside a partial answer (tool results only). */
const PARTIAL_NOTE="Partial results: the full memory search did not finish in time, so these come from a keyword search. Try a shorter or different query if what you need is missing.";
/** What a bot reads when the words of its query are so common that only the newest matches were read (tool results only). */
const BOUNDED_NOTE="These are the newest matches for common words, not every match. Add a more specific word to reach older notes.";
const UNAVAILABLE_NOTE="Memory search could not run just now, and nothing was found by keyword either. Say that memory could not be searched, not that nothing was recorded.";
/** What the helper measured about a search. For the process (tests, benchmarks, logs) only: it is shaped by records the reader
 * may not read, so it is never part of an answer. */
export interface SearchTelemetry { vectorRows:number; workerPeakRssBytes?:number; profile?:unknown; timings?:unknown; service?:{cacheHit:boolean;preparationMs:number;bridgeMs:number;hydrationMs:number} }
export interface MemorySearchBridge {
  search(input:MemorySearchInput,signal:AbortSignal):Promise<MemorySearchResult>;
  completedSource?(jobId:string):void;
}
/** Forget every cached helper answer (tests that compare two indexes must not compare one cached answer with itself). */
export function clearMemorySearchCache():void{queryCache.clear();}
/** One synchronous slice of authorization lasts about this long; the event loop runs between slices. */
let AUTHORIZE_SLICE_MS=8;
/** Tests only: a slice of 0 reads one record per turn, so a test can move the data between two reads. */
export function setAuthorizeSliceMsForTest(ms:number):void{AUTHORIZE_SLICE_MS=ms;}
/** Records one step of a walk past a stopped scan, or over pending projections, reads in a batch. */
const ELIGIBLE_PAGE=256;
const PENDING_PAGE=256;
/** Readable recent matches the fallback needs before it stops reading further ones. */
const RECENT_READABLE=20;
/** How often a search whose data moved under it reads its accepted records again before it answers nothing. */
const REVALIDATION_ROUNDS=3;
const yieldTurn=()=>new Promise<void>(resolve=>setImmediate(resolve));
export async function searchMemory(query:string,access:MemoryAccess,bridge:MemorySearchBridge,options:{allowance:LineageAllowance;limit?:number;historical?:boolean;cursor?:string;signal?:AbortSignal;profile?:boolean;lexical?:((...args:Parameters<typeof lexicalPage>)=>ReturnType<typeof lexicalPage>|Promise<ReturnType<typeof lexicalPage>>)|null;evolutionPolicy?:MemoryEvolutionPolicy;withheldMessage?:(threadId:string,messageId:string,allowance:LineageAllowance)=>boolean;caller?:RecallCaller;telemetry?:(facts:SearchTelemetry)=>void}){
  const serviceStarted=performance.now();
  const caller:RecallCaller=options.caller??"turn";
  const budgetMs=caller==="tool"?TOOL_SEARCH_BUDGET_MS:SEARCH_BUDGET_MS;
  const semanticCutoffMs=caller==="tool"?TOOL_SEMANTIC_CUTOFF_MS:SEMANTIC_CUTOFF_MS;
  const hydrationLimitMs=caller==="tool"?TOOL_HYDRATION_LIMIT_MS:HYDRATION_LIMIT_MS;
  // The budget starts here, before the synchronous preparation below, and the
  // worker is handed the same deadline.
  const deadlineAt=Date.now()+budgetMs;
  const signal=AbortSignal.any([options.signal??new AbortController().signal,AbortSignal.timeout(budgetMs)]);
  assertMemoryAccess(access);
  const evolutionPolicy=options.evolutionPolicy??readMemoryEvolutionPolicy();
  if(!query.trim()||Buffer.byteLength(query)>4096)throw new Error("INVALID_MEMORY_QUERY");
  const limit=Math.min(20,Math.max(1,options.limit??10));
  // The cursor a reader holds is a token only this reader can use; the helper pages by the id behind it.
  const rawCursor=openMemoryCursor(options.cursor??"",access,options.historical??false);
  const meta=database().prepare("SELECT data_revision FROM memory_meta WHERE id=1").get()!;
  const cacheKey=createHash("sha256").update(JSON.stringify([query,limit,access.scopeIds,access.policyRevision,access.deletionEpoch,meta.data_revision,options.historical??false,rawCursor])).digest("hex");
  const cached=queryCache.get(cacheKey);
  const bridgeStarted=performance.now();
  // The helper (embedding and vectors) is asked first so it works while this process reads the words; the words never wait for it.
  // With the words in hand the helper gets only SEMANTIC_CUTOFF_MS from the start of the search; a miss means words only. If the
  // index cannot be read the helper keeps the whole budget.
  const helperAbort=new AbortController();
  const helperSignal=AbortSignal.any([signal,helperAbort.signal]);
  const helper=cached?null:(()=>{
    try{return withinDeadline(bridge.search({query,scopeIds:[...access.scopeIds],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:options.historical??false,cursor:rawCursor,limit,semantic:true,deadlineAt,...options.profile?{profile:true}:{}},helperSignal),helperSignal);}
    catch(error){return Promise.reject(error);}
  })();
  helper?.catch(()=>{});
  // The word list leaves out, inside the index query and before any limit, the records no reader can read (state, forgotten,
  // evidence withdrawn, outside the reader's scopes), and stops at the search's own deadline with a page flagged partial
  // (msearch review round 6). Reader-specific refusals are still decided record by record below.
  const lexicalSource=options.lexical===undefined?((q:string,scopes:readonly string[],limit:number,offset?:number)=>lexicalPageSliced(q,scopes,limit,offset,yieldTurn,{eligible:true,historical:options.historical??false,deadlineAt,...options.signal?{signal:options.signal}:{}})):options.lexical;
  const direct=lexicalSource?await lexicalSource(query,access.scopeIds,RECALL_FIRST_PAGE):null;
  const lexicalReady=direct!==null;
  // The word scan reached its deadline: what it ranked is the best of what it read, and the answer says so.
  let scanCut=Boolean(direct?.partial);
  // The words were common and only the newest matches were read: the answer is honest about it (coverage, and a note to tools).
  let boundedScan=Boolean(direct?.bounded);
  const cutoff=lexicalReady&&helper?setTimeout(()=>helperAbort.abort(),Math.max(0,semanticCutoffMs-(performance.now()-serviceStarted))):undefined;
  let result:MemorySearchResult;
  let helperAnswered=true;
  // Why the meaning search did not answer, as a code: its own error, or SEMANTIC_CUTOFF when this search stopped waiting
  // because the words were already in hand.
  let helperCause:string|undefined;
  let keyword:IndexHit[]=[];
  // The helper's index was readable and it did not answer: whether anything the reader may read is still waiting for the
  // word index is worked out below, from the reader's own scopes and after authorization.
  let pendingScan=false;
  try{result=cached??await helper!;}
  catch(error){
    options.signal?.throwIfAborted();assertMemoryAccess(access);
    logSwallowed("recall",error);helperAnswered=false;
    helperCause=helperAbort.signal.aborted&&!signal.aborted?"SEMANTIC_CUTOFF":causeOf(error);
    // Neither the word index nor the helper answered: a bounded keyword scan of the reader's newest current records.
    // Sliced and yielding, inside what is left of the hydration limit, so the hits it finds can still be checked.
    if(!lexicalReady&&!options.historical){
      const left=hydrationLimitMs-(performance.now()-serviceStarted)-KEYWORD_HYDRATION_RESERVE_MS;
      if(left>0){
        keyword=(await keywordMemoryHits(query,access,{budgetMs:left,...options.signal?{signal:options.signal}:{}})).hits;
        options.signal?.throwIfAborted();assertMemoryAccess(access);
      }
    }
    result=lexicalReady
      ?(pendingScan=true,{hits:[] as IndexHit[],vectorRows:0,degradedReason:"semantic-skipped",coverageComplete:true})
      :{hits:keyword,vectorRows:0,degradedReason:"MEMORY_RECALL_UNAVAILABLE",coverageComplete:false};
  }
  finally{if(cutoff)clearTimeout(cutoff);}
  if(!lexicalReady&&helperAnswered&&["missing","unreadable"].includes(memoryIndexReaderState()))result={...result,coverageComplete:false};
  const bridgeDone=performance.now();
  assertMemoryAccess(access);
  const recent=options.historical?[]:recentMemoryHits(query,access);
  // Authorization comes first, and everything a reader can observe is computed from what it may read. Every candidate, on
  // every path (helper, word index, recent, keyword fallback, historical), is read through readableMemoryRecord
  // (readable.ts): the same function memory_get and bundle hydration call, so search returns a version only when memory_get
  // would. Ranks, scores, counts, coverage and cursors are worked out AFTER that, from the surviving candidates alone, so a
  // record the reader may not read leaves no trace in any of them (msearch review round 3).
  //
  // Authorization never holds the event loop (msearch review round 5): the candidates of one step are narrowed by ONE
  // batched statement that spares the certain refusals (plausiblyReadable), the rest are read in slices of AUTHORIZE_SLICE_MS
  // with the loop released between slices, and when the data, the policy or the deletion epoch moved while the loop was
  // released, every record already accepted is read again before anything is answered.
  let partial=false;
  // Hydration stops at the limit for every caller and returns what it has, flagged partial. No candidate is exempt: a
  // search that starts late (a stalled event loop) answers partial or empty, inside the proxy's wait (P1, msearch review).
  const mode=options.historical?"historical" as const:"current" as const;
  const readOptions={allowance:options.allowance,mode,agent:true,...options.withheldMessage?{withheldMessage:options.withheldMessage}:{}};
  const keyOf=(ref:{id:string;version:number})=>`${ref.id}:${ref.version}`;
  const checked=new Map<string,{ref:{id:string;version:number};value:Readable|null}>();
  const hydrate=(ref:{id:string;version:number}):Readable|null=>{
    let read:ReturnType<typeof readableMemoryRecord>;
    // a read the allowance could not finish is left out for now, and the answer says it is partial
    try{read=readableMemoryRecord(ref.id,ref.version,access,readOptions);}
    catch(error){if(isLineageLimit(error)){partial=true;return null;}throw error;}
    if(typeof read==="string")return null;
    const record=read.row;
    // masked at read like the bundle (bundle.ts hydrateInPass): an unscrubbed 1.0.3 row never hands a recall its digits
    return {text:maskFinancialIdentifiers(String(record.text)),scopeId:String(record.scope_id),assertion:String(record.assertion),state:String(record.state),pinned:record.owner_pinned===1,...read.sourceOutcome?{sourceOutcome:read.sourceOutcome}:{},
      validFrom:Number(record.valid_from),validTo:record.valid_to===null?null:Number(record.valid_to),recordedAt:Number(record.created_at),
      evidence:read.evidence.map((handle,n)=>({...handle,occurredAt:read.occurredAt[n]}))};
  };
  const overTime=()=>performance.now()-serviceStarted>hydrationLimitMs;
  // A reader whose audience is not the owner is also judged on the lines its records rest on (disclosures.ts readerWithheldMessage), and
  // a receipt revoke or a marker commit can withhold one without moving data, policy or epoch: its stamp carries the authority stamp
  // (undefined counts as moved) and the deny generation too (XTHREAD-JUDGE R5). An owner audience keeps the three-part stamp.
  const audienceReader=!memoryAccessIsOwnerAudience(access);
  let unstamped=0;
  const revisionStamp=()=>{const meta=database().prepare("SELECT data_revision,policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;const base=`${meta.data_revision}:${meta.policy_revision}:${meta.deletion_epoch}`;if(!audienceReader)return base;const authority=authorityStamp();const generation=denyGeneration(database());return `${base}|${authority===undefined||generation<0?`moved-${++unstamped}`:`${authority}|${generation}`}`;};
  let stampAtAccept:string|null=null;
  let revalidationCut=false;
  /** Read `refs` (the ones not yet read), a slice at a time. Stops, flagged partial, at the hydration limit. */
  const authorizeAll=async(refs:ReadonlyArray<{id:string;version:number}>):Promise<void>=>{
    const todo:Array<{id:string;version:number}>=[];
    for(const ref of refs){const key=keyOf(ref);if(!checked.has(key)&&!todo.some(other=>keyOf(other)===key))todo.push(ref);}
    if(!todo.length)return;
    if(partial||overTime()){partial=true;return;}
    stampAtAccept??=revisionStamp();
    const plausible=inMemoryAccessPass(()=>plausiblyReadable(todo,access.scopeIds,mode));
    const survivors:Array<{id:string;version:number}>=[];
    for(const ref of todo){if(plausible.has(keyOf(ref)))survivors.push(ref);else checked.set(keyOf(ref),{ref,value:null});}
    for(let at=0;at<survivors.length;){
      if(overTime()){partial=true;return;}
      const until=performance.now()+AUTHORIZE_SLICE_MS;
      inMemoryAccessPass(()=>{do{const ref=survivors[at++];checked.set(keyOf(ref),{ref,value:hydrate(ref)});}while(at<survivors.length&&performance.now()<until);});
      if(at<survivors.length){await yieldTurn();options.signal?.throwIfAborted();}
    }
  };
  const readableOf=(ref:{id:string;version:number}):Readable|null=>checked.get(keyOf(ref))?.value??null;
  /** When the data, the policy or the deletion epoch moved while the loop was released, read every accepted record again.
   * True when it had to (what was ranked from the old reads is ranked again). */
  const revalidate=async():Promise<boolean>=>{
    if(stampAtAccept===null)return false;
    const now=revisionStamp();
    if(now===stampAtAccept)return false;
    const accepted=[...checked.values()].filter(entry=>entry.value!==null).map(entry=>entry.ref);
    // The new stamp is committed only when EVERY accepted record has been read again. Whatever the deadline leaves unread is
    // discarded (it is not answered, and not read later against a stamp that says it was checked); the old stamp stays, so no
    // later pass takes a half-checked set for a checked one (msearch review round 6).
    let complete=true;
    for(let at=0;at<accepted.length;){
      if(overTime()){
        partial=true;complete=false;
        // Every accepted record is dropped, including the ones this pass already read again: they were read before the loop was
        // released for the rest, and their source may have moved since (msearch review round 7). Nothing is kept on a half pass.
        for(const ref of accepted)checked.set(keyOf(ref),{ref,value:null});
        break;
      }
      const until=performance.now()+AUTHORIZE_SLICE_MS;
      inMemoryAccessPass(()=>{do{const ref=accepted[at++];checked.set(keyOf(ref),{ref,value:hydrate(ref)});}while(at<accepted.length&&performance.now()<until);});
      if(at<accepted.length){await yieldTurn();options.signal?.throwIfAborted();}
    }
    if(complete)stampAtAccept=now;else revalidationCut=true;
    return true;
  };
  // Known residual (1.0.2, docs/memory.md "Search and what a reader cannot read"): the order of the word list comes from FTS5's
  // BM25, whose corpus statistics (inverse document frequency, average length) are computed over every document in the shared
  // index, readable or not. It cannot add, remove or reveal a result, count, page or cursor; it can reorder readable results
  // that score almost the same. Closing it needs a per-scope index (the retention lane).
  const candidates=candidateLists(result);
  const rankLists=async()=>{
    // The word list: the main process's own read of the index, paged on while candidates are refused (a refused record never
    // crowds a readable one out and no count of them ends the paging: only the end of the list or the hydration limit does),
    // then whatever the helper ranked that the index read did not return.
    const exhausted={lexical:false,vector:false};
    async function* wordStream():AsyncGenerator<RankedRef>{
      const seen=new Set<string>();
      let listDone=false;
      if(direct){
        let batch=direct.hits,more=direct.more,offset=0;
        for(;;){
          for(const hit of batch){seen.add(`${hit.id}:${hit.version}`);yield [hit.id,hit.version];}
          offset+=batch.length;
          if(!more){listDone=true;break;}
          await yieldTurn();
          const next=lexicalSource?await lexicalSource(query,access.scopeIds,WORD_PAGE,offset):null;
          if(!next)break;
          if(next.partial)scanCut=true;
          if(next.bounded)boundedScan=true;
          batch=next.hits;more=next.more;
        }
      }
      for(const ref of candidates.lexical)if(!seen.has(`${ref[0]}:${ref[1]}`))yield ref;
      // The helper's list is capped; a list the main process read to its end is not.
      exhausted.lexical=!listDone&&candidates.lexicalCapped;
    }
    async function* meaningStream():AsyncGenerator<RankedRef>{
      yield* candidates.vector;
      if(candidates.vectorCapped)exhausted.vector=true;
    }
    const take=async(stream:AsyncIterable<RankedRef>)=>{
      const taken:Array<{ref:RankedRef;read:Readable}>=[],seen=new Set<string>();
      let filled=false,ended=false;
      const iterator=stream[Symbol.asyncIterator]();
      while(!filled&&!ended){
        // Pull about as many candidates as the list still needs; refused ones simply make the next pull.
        const batch:RankedRef[]=[];
        while(batch.length<Math.max(8,RANK_POSITIONS-taken.length)){
          const next=await iterator.next();
          if(next.done){ended=true;break;}
          const key=keyOf({id:next.value[0],version:next.value[1]});
          if(seen.has(key))continue;seen.add(key);batch.push(next.value);
        }
        await authorizeAll(batch.map(ref=>({id:ref[0],version:ref[1]})));
        for(const ref of batch){
          if(!checked.has(keyOf({id:ref[0],version:ref[1]}))){partial=true;return {taken,filled};}
          const read=readableOf({id:ref[0],version:ref[1]});
          if(!read)continue;
          taken.push({ref,read});
          if(taken.length>=RANK_POSITIONS){filled=true;break;}
        }
        if(partial)break;
      }
      return {taken,filled};
    };
    const words=await take(wordStream()),meaning=await take(meaningStream());
    // A list that ran out of examined candidates before it found enough readable ones may have readable ones past the
    // budget: coverage is incomplete, and says so. Only the helper's capped lists can end that way: the word index is paged
    // to its end, whatever number of refused records stand in the way.
    const incomplete=(!words.filled&&exhausted.lexical)||(!meaning.filled&&exhausted.vector);
    const fused=new Map<string,{id:string;version:number;score:number;lexical:boolean;similarity?:number;read:Readable}>();
    words.taken.forEach(({ref,read},position)=>{fused.set(`${ref[0]}:${ref[1]}`,{id:ref[0],version:ref[1],score:1/(60+position+1),lexical:true,read});});
    meaning.taken.forEach(({ref,read},position)=>{
      const key=`${ref[0]}:${ref[1]}`,previous=fused.get(key),similarity=ref[2];
      fused.set(key,{id:ref[0],version:ref[1],score:(previous?.score??0)+1/(60+position+1),lexical:previous?.lexical??false,...similarity!==undefined?{similarity}:{},read});
    });
    const ranked=[...fused.values()].sort(byScore);
    // The recent fallback: matches in best-first order, read in batches until enough are readable.
    let recentReadable=0;
    const recentOrder=[...recent].sort(byScore);
    for(let at=0;at<recentOrder.length&&recentReadable<RECENT_READABLE;at+=32){
      const batch=recentOrder.slice(at,at+32);
      await authorizeAll(batch);
      for(const hit of batch){
        const read=readableOf(hit);
        if(read)recentReadable++;
        if(fused.has(`${hit.id}:${hit.version}`))continue;
        if(read)ranked.push({id:hit.id,version:hit.version,score:hit.score,lexical:hit.lexical??false,...hit.similarity!==undefined?{similarity:hit.similarity}:{},read});
      }
      if(partial)break;
    }
    // Eligible records the meaning search could not score yet (no vector): only a record the reader may read makes coverage
    // incomplete. The helper names them in its own order; the first one this reader may read settles it. When it named a
    // full list and every one of them is refused, the walk goes on past the last of them, through the reader's eligible
    // records in key order, to the first readable one (or the end): what the reader cannot read is never counted, only the
    // hydration limit ends the walk, and then coverage is called incomplete because nothing was proven.
    let unscored:boolean|undefined;
    if(result.unvectored!==undefined){
      unscored=false;
      const named=result.unvectored.map(ref=>({id:ref[0],version:ref[1]}));
      for(let at=0;at<named.length&&!unscored;at+=64){
        const batch=named.slice(at,at+64);
        await authorizeAll(batch);
        if(batch.some(ref=>readableOf(ref)!==null))unscored=true;
        if(partial)break;
      }
      if(!unscored&&result.unvectoredMore&&named.length){
        const walk=await readableAfter(JSON.stringify([named[named.length-1].id,named[named.length-1].version]),result.vectorModel);
        unscored=walk!==false;
      }
      if(!unscored&&partial)unscored=true;
    }
    // A scan that stopped short of the end of the eligible set matters only if a record this reader may READ lies past it.
    // Meaning search and the helper's own words are what that scan was for. A cursor is issued only when one is found.
    let paged=false,unproven=false;
    if(result.resumeAfter!==undefined&&(result.unvectored!==undefined||!lexicalReady)){
      const walk=await readableAfter(result.resumeAfter);
      paged=walk===true;unproven=walk==="unproven";
    }
    // Pending projections the reader's own scopes hold (the word index has not caught up): only a readable one counts.
    let pendingReadable=false;
    if(pendingScan){
      for(let after=0;;){
        const refs=pendingProjectionRefsAfter(database(),access.scopeIds,after,PENDING_PAGE);
        if(!refs.length)break;
        await authorizeAll(refs);
        if(refs.some(ref=>readableOf(ref)!==null)){pendingReadable=true;break;}
        if(partial){pendingReadable=true;break;}
        after=refs[refs.length-1].rowid;
      }
    }
    return {ranked:ranked.map(({read,...hit})=>({...hit,...read})),incomplete:incomplete||unproven,unscored,recentReadable,meaningRead:meaning.taken.length>0,paged,pendingReadable};
  };
  /** Walk the reader's eligible records after `start`, in key order, to the first one it may read (with `model`: the first one it
   * may read that has no vector under that model). true: found one; false: the end was reached with none; "unproven": the
   * hydration limit ended the walk first. Refused records are never counted. */
  async function readableAfter(start:string,model?:string):Promise<boolean|"unproven">{
    for(let cursor=start;;){
      const rows=eligibleAfter(database(),access.scopeIds,options.historical??false,cursor,ELIGIBLE_PAGE);
      if(!rows.length)return false;
      // Without a model to look under (or an index to look in) every record counts: more cautious, never less.
      const wanted=model!==undefined?vectorlessAmong(rows,model)??rows:rows;
      await authorizeAll(wanted);
      if(wanted.some(row=>readableOf(row)!==null))return true;
      if(partial)return "unproven";
      cursor=JSON.stringify([rows[rows.length-1].id,rows[rows.length-1].version]);
    }
  }
  let lists:Awaited<ReturnType<typeof rankLists>>;
  for(let attempt=0;;attempt++){
    lists=await rankLists();
    // The loop was released while this ran: if anything moved, what was accepted has been read again, and is ranked again.
    if(!await revalidate())break;
    // Out of time while reading again: what could not be read again is already discarded; rank once more from what stands.
    if(revalidationCut){lists=await rankLists();break;}
    if(attempt>=REVALIDATION_ROUNDS){
      // It will not hold still: answer nothing rather than something that may have been withdrawn.
      partial=true;
      lists={ranked:[],incomplete:true,unscored:undefined,recentReadable:0,meaningRead:false,paged:false,pendingReadable:false};
      break;
    }
  }
  const hits=lists.ranked;
  assertMemoryAccess(access);
  // Whether every readable record was counted: the helper's own flag (an older helper), or no readable record is waiting for its vector.
  let coverage:boolean|undefined=result.unvectored!==undefined?(lists.unscored===false):result.coverageComplete;
  if(pendingScan)coverage=!lists.pendingReadable;
  if(lists.incomplete||lists.paged)coverage=false;
  if(helperAnswered&&!cached&&!result.degradedReason&&coverage&&result.vectorRows>0)queryCache.set(cacheKey,result);
  const optional=new Set(selectMemoryEvidence(query,hits.filter(hit=>!hit.pinned),evolutionPolicy));
  const selected=hits.filter(hit=>hit.pinned||optional.has(hit)).slice(0,limit);
  recordMemoryRetrieval(selected.length);
  noteRecallMode(access.threadId,lists.meaningRead?"hybrid":"lexical");
  const totalMs=performance.now()-serviceStarted;
  noteMemorySearch(selected.length,totalMs,{prepMs:bridgeStarted-serviceStarted,bridgeMs:bridgeDone-bridgeStarted,hydrationMs:performance.now()-bridgeDone});
  options.telemetry?.({vectorRows:result.vectorRows,...options.profile?{service:{cacheHit:Boolean(cached),preparationMs:bridgeStarted-serviceStarted,bridgeMs:bridgeDone-bridgeStarted,hydrationMs:performance.now()-bridgeDone}}:{},...result.workerPeakRssBytes!==undefined?{workerPeakRssBytes:result.workerPeakRssBytes}:{},...result.profile!==undefined?{profile:result.profile}:{},...result.timings!==undefined?{timings:result.timings}:{}});
  // What the reader is told. Hits that came from words alone, or a hydration cut short, are partial, never "unavailable";
  // MEMORY_RECALL_UNAVAILABLE is kept for a search that found nothing at all because its sources could not answer.
  const keywordOnly=!helperAnswered&&!cached;
  const cut=partial||scanCut||(keywordOnly&&!lexicalReady);
  const degradedReason=cut?(selected.length?"MEMORY_RECALL_PARTIAL":"MEMORY_RECALL_UNAVAILABLE"):lists.paged?"semantic-capacity-paged":result.degradedReason;
  const isPartial=keywordOnly||partial||scanCut;
  const cause=partial?"MEMORY_RECALL_HYDRATION_LIMIT":scanCut?"MEMORY_RECALL_SCAN_LIMIT":helperCause??result.degradedReason;
  if(cause)noteRecallDegraded(caller,cause,{hits:selected.length,ms:totalMs,index:lexicalReady?"ready":memoryIndexReaderState(),outcome:!selected.length?"empty":isPartial?"partial":"full"});
  const note=caller==="tool"&&isPartial?(selected.length?PARTIAL_NOTE:degradedReason==="MEMORY_RECALL_UNAVAILABLE"?UNAVAILABLE_NOTE:undefined):caller==="tool"&&boundedScan?BOUNDED_NOTE:undefined;
  // The recent fallback is reported only when it found a record this reader may read.
  if(cut||boundedScan||lists.recentReadable)coverage=false;
  // Only these fields are the answer. The helper's counts, memory use and timings stay in the process (telemetry above), and
  // the helper's cursor, an id that may name a record this reader cannot read, is replaced by a token only this reader can use.
  return {hits:selected,...degradedReason!==undefined?{degradedReason}:{},...coverage!==undefined?{coverageComplete:coverage}:{},...lists.paged?{nextCursor:sealMemoryCursor(result.resumeAfter!,access,options.historical??false)}:{},
    ...isPartial?{partial:true,recallMode:"keyword" as const}:{},...note?{note}:{},evolutionPolicyRevision:evolutionPolicy.revision,...lists.recentReadable?{recentFallback:true}:{},
    };
}

/** What a reader may read of a record, as search shows it. */
type Readable={text:string;scopeId:string;assertion:string;state:string;pinned:boolean;sourceOutcome?:"failed";validFrom:number;validTo:number|null;recordedAt:number;evidence:Array<Record<string,unknown>>};
/** Ranked positions that carry score, per list, counted among the records the reader may read. */
const RANK_POSITIONS=50;
const WORD_PAGE=100;

/** The helper's two ranked lists. An older helper answers with scored hits only: those are read as the same two lists. */
function candidateLists(result:MemorySearchResult):{lexical:RankedRef[];vector:RankedRef[];lexicalCapped:boolean;vectorCapped:boolean}{
  if(result.lexicalRanked||result.vectorRanked){
    const lexical=result.lexicalRanked??[],vector=result.vectorRanked??[];
    return {lexical,vector,lexicalCapped:lexical.length>=SEARCH_LIST_DEPTH,vectorCapped:vector.length>=SEARCH_LIST_DEPTH};
  }
  const vector:RankedRef[]=result.hits.filter(hit=>typeof hit.similarity==="number").sort((a,b)=>b.similarity!-a.similarity!||compareRefs(a,b)).map(hit=>[hit.id,hit.version,hit.similarity!]);
  const lexical:RankedRef[]=result.hits.filter(hit=>typeof hit.similarity!=="number"||hit.lexical===true).map(hit=>[hit.id,hit.version]);
  return {lexical,vector,lexicalCapped:false,vectorCapped:false};
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
