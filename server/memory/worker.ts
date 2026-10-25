import { MemoryEligibility } from "./eligibility.ts";
import { captureWork } from "./chunks.ts";
import { workSchema,indexBatchSchema,searchInputSchema,scopePartSchema,type MemorySearchInput } from "./worker-protocol.ts";
import { ScopeAssembler } from "./scope-set.ts";
import { MemoryIndex,type IndexedMemory } from "./index.ts";
import { isSegmentLimitError } from "./segment-limit.ts";
import { answerQuery } from "./worker-query.ts";
import { MemoryEmbeddings,type ModelManifest } from "./embeddings.ts";
import { MAINTENANCE_POLL_MS,maintenanceMayRun,maintenanceRetryDelayMs,type MaintenanceClock } from "./maintenance-schedule.ts";
import { DatabaseSync } from "node:sqlite";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";

let index:MemoryIndex|null=null, embeddings:MemoryEmbeddings|null=null, eligibility:MemoryEligibility|null=null, busy=false;
const queries:Array<{requestId:string;input:MemorySearchInput;enqueuedAt:number}>=[];
const batches:Array<{requestId:string;records:IndexedMemory[]}>=[];
/** Capture work waits behind queries: a waiting search is read and answered before the capture in hand starts. */
const captures:Array<ReturnType<typeof workSchema.parse>>=[];
/** An error's name and message only (never the work it was handling): the parent forwards stderr to a rate-limited log. */
const describe=(error:unknown)=>error instanceof Error?`${error.name}: ${error.message.slice(0,160)}`:"unknown";
const yieldToMessages=()=>new Promise<void>(resolve=>setImmediate(resolve));
/** What this process has written so far, as the parent reads its own writes (io-budget.ts readProcess): the index lives in this
 * process, so its writes are reported to the parent, which charges them to the io-budget under "memory-worker" and paces index
 * work like any other writer. Every index acknowledgement carries the count; idle maintenance reports it on its own
 * (reportIo), at most once per IO_REPORT_MS while it runs and once when a loop ends, so a merge paid between batches is budgeted. */
const writtenBlocks=()=>process.resourceUsage().fsWrite;
const IO_REPORT_MS=10_000;
let ioReportedAt=0,ioReportedBlocks=0;
function reportIo(force=false){
  const now=Date.now();
  if(!force&&now-ioReportedAt<IO_REPORT_MS)return;
  const blocks=writtenBlocks();
  if(blocks===ioReportedBlocks&&!force)return;
  ioReportedAt=now;ioReportedBlocks=blocks;
  process.send?.({type:"io",fsWriteBlocks:blocks});
}
const cancelled=new Set<string>();
const scopeParts=new ScopeAssembler();
/** Index records embedded per model call: a waiting query is served between slices. On ONNX Runtime WebAssembly
 * (Intel macOS, or a native binding that failed to load) each call is several times slower, so a slice is one record:
 * a turn's search then waits behind at most one record's model work, never the batch. */
const INDEX_SLICE=4;
const WASM_INDEX_SLICE=1;
const indexSlice=()=>embeddings?.backend==="wasm"?WASM_INDEX_SLICE:INDEX_SLICE;
/** A query whose deadline has passed has no one waiting: the parent already degraded the turn. */
const expired=(q:{input:MemorySearchInput})=>q.input.deadlineAt!==undefined&&Date.now()>=q.input.deadlineAt;
async function serveQueries(){
  const batch=queries.splice(0,16).filter(q=>!cancelled.delete(q.requestId)&&!expired(q));
  if(!batch.length)return;
  const batchStarted=performance.now();
  let vectors:number[][]|null=null,degradedReason:string|undefined;
  try {if(batch.some(q=>q.input.semantic))vectors=await embeddings!.embed(batch.map(q=>q.input.query));}
  catch{degradedReason="local-model-unavailable";}
  const embeddingMs=performance.now()-batchStarted;
  for(let i=0;i<batch.length;i++){
    const q=batch[i];if(cancelled.delete(q.requestId)||expired(q))continue;
    index!.wantScopes?.(q.input.scopeIds);
    const answered=answerQuery(index!,eligibility!,q.input,vectors?.[i]??null,embeddings!.identity,degradedReason);
    process.send?.({type:"query-result",requestId:q.requestId,result:{...answered.result,workerPeakRssBytes:process.resourceUsage().maxRSS*1024,timings:answered.timings,...q.input.profile?{profile:{queueMs:batchStarted-q.enqueuedAt,embeddingMs,batchSize:batch.length,eligibilityMs:answered.eligibilityMs,...answered.timings,workerTotalMs:performance.now()-q.enqueuedAt}}:{}}});
  }
}
async function drain(){
  if(busy||!index||!embeddings||!eligibility)return;busy=true;
  let queryBatchServed=false;
  try {
    while(queries.length||batches.length||captures.length){
      // Queries lead each drain. Sustained arrivals must still leave one slot
      // for a waiting index batch, then immediately return priority to queries.
      if(queries.length&&((!batches.length&&!captures.length)||!queryBatchServed)){
        await serveQueries();
        queryBatchServed=true;
      } else if(captures.length){
        // A capture is synchronous CPU: let the loop read any query that arrived since the last one, then answer it first.
        await yieldToMessages();
        if(queries.length){await serveQueries();continue;}
        const work=captures.shift()!;
        try{process.send?.({type:"result",result:captureWork(work)});}
        catch(error){console.error(`capture rejected: ${describe(error)}`);process.send?.({type:"error",reason:"INVALID_MEMORY_WORK"});}
        queryBatchServed=false;
      } else {
        const batch=batches.shift()!;
        // At FTS5's segment limit every write fails: compact once (here, in the helper), then write again.
        try{index.upsert(batch.records);}
        catch(error){if(!isSegmentLimitError(error)||!index.recoverSegments||index.recoverSegments()==="none")throw error;index.upsert(batch.records);}
        // Deletions (forgets and rolled checkpoint versions) were removed without whole-index work: the stepped maintenance
        // merges them out of the word index when idle. While a failed pass waits out its back-off (purgeFailures), a batch must
        // not restart maintenance or cancel that timer; the back-off resets only when a pass completes.
        if(index.maintenanceOwed()&&!purgeFailures)void purgeRolledCheckpoints();
        const alive=batch.records.filter(r=>!r.deleted&&!r.archived);let embeddingStatus="indexed";
        try {
          for(let at=0,step=indexSlice();at<alive.length;at+=step,step=indexSlice()){
            const slice=alive.slice(at,at+step);
            const vectors=await embeddings.embed(slice.map(r=>r.text));slice.forEach((record,i)=>index!.vector(record,embeddings!.identity,0,vectors[i]));
            // a turn's search jumps ahead of the rest of this batch
            while(queries.length&&at+step<alive.length)await serveQueries();
          }
        }
        catch {embeddingStatus="unavailable";}
        eligibility.warm([...new Set(alive.map(record=>record.scopeId))]);
        // the batch's writes, charged by the parent to the io-budget (fsWriteBlocks: see reportIo)
        process.send?.({type:"index-result",requestId:batch.requestId,embeddingStatus,records:batch.records.map(r=>({id:r.id,version:r.version,deleted:r.deleted})),fsWriteBlocks:writtenBlocks()});
        queryBatchServed=false;
      }
    }
  }catch(error){console.error(`index drain failed: ${describe(error)}`);process.send?.({type:"index-error",reason:"MEMORY_INDEX_FAILED"});}
  finally{busy=false;lastActivity=Date.now();}
}
/** Entries one purge step examines, at most; each step also stops at ROLLED_CHECKPOINT_STEP_MS. */
const ROLLED_CHECKPOINT_EXAMINED=2048;
const ROLLED_CHECKPOINT_STEP_MS=10;
/** How often the purge walks the index again after a pass found nothing left: a safety net behind the fenced
 * acknowledgements (worker-controller.ts), so a version a race left behind does not stay for the life of the helper. */
const ROLLED_CHECKPOINT_PASS_MS=5*60_000;
/** Longest wait between passes after repeated failures. */
const ROLLED_CHECKPOINT_RETRY_MAX_MS=60*60_000;
let purgeFailures=0;
let purging=false;
let passTimer:ReturnType<typeof setTimeout>|undefined;
/** Removes old checkpoint versions left in the index (MemoryIndex.purgeRolledCheckpoints), one bounded step at a time,
 * only while the helper has nothing else to do, until a pass finds none left; then again every ROLLED_CHECKPOINT_PASS_MS. */
async function purgeRolledCheckpoints(){
  if(purging)return;
  purging=true;
  if(passTimer){clearTimeout(passTimer);passTimer=undefined;}
  const clock:MaintenanceClock={deferredSince:null};
  try{
    for(;;){
      const working=()=>busy||queries.length>0||batches.length>0||captures.length>0;
      await new Promise<void>(resolve=>setTimeout(resolve,working()?MAINTENANCE_POLL_MS:0));
      if(!index)return;
      // Quiet: run. Busy: wait, but not past MAINTENANCE_MAX_DEFER_MS since the step was first put off, so sustained load
      // cannot starve the merge a deletion owes (the step is bounded and synchronous, so it cannot interleave with a search).
      if(!maintenanceMayRun(clock,working(),Date.now()))continue;
      try{if(index.purgeRolledCheckpoints({maxExamined:ROLLED_CHECKPOINT_EXAMINED,maxMs:ROLLED_CHECKPOINT_STEP_MS}).done){purgeFailures=0;break;}reportIo();}
      catch(error){
        console.error(`rolled checkpoint purge failed: ${describe(error)}`);
        // At the segment limit one compaction frees the index; every other failure backs off (below).
        let recovered=false;
        if(isSegmentLimitError(error))try{recovered=Boolean(index.recoverSegments)&&index.recoverSegments()!=="none";}catch(again){console.error(`index compaction failed: ${describe(again)}`);}
        if(!recovered)purgeFailures++;
        break;
      }
    }
  }finally{purging=false;reportIo(true);}
  // Deletions that arrived while the last merge ran are owed their own pass at once; otherwise the safety-net pass.
  // A failed pass waits (doubling), never 0: the owed merge is durable, so an immediate retry would fail the same way for ever.
  if(index)passTimer=setTimeout(()=>void purgeRolledCheckpoints(),purgeFailures?maintenanceRetryDelayMs(purgeFailures,ROLLED_CHECKPOINT_PASS_MS,ROLLED_CHECKPOINT_RETRY_MAX_MS):index.maintenanceOwed()?0:ROLLED_CHECKPOINT_PASS_MS);
  passTimer?.unref();
}
/** The postings of entries an earlier build indexed (postings.ts), filled newest first in steps of at most POSTINGS_STEP_MS, only while
 * the helper has nothing else to do (and never put off past MAINTENANCE_MAX_DEFER_MS). Each step commits where it got to. */
const POSTINGS_STEP_MS=10;
const POSTINGS_BUSY_RETRY_MS=1000;
let filling=false;
async function fillPostings(){
  if(filling)return;
  filling=true;
  const clock:MaintenanceClock={deferredSince:null};
  try{
    for(;;){
      const working=()=>busy||queries.length>0||batches.length>0||captures.length>0;
      await new Promise<void>(resolve=>setTimeout(resolve,working()?MAINTENANCE_POLL_MS:0));
      if(!index)return;
      if(!maintenanceMayRun(clock,working(),Date.now()))continue;
      try{
        const step=index.fillPostings({maxMs:POSTINGS_STEP_MS});
        index.settlePostings?.();
        reportIo();
        if(step.done)break;
        // The write lock was taken: never wait for it here (the busy wait is synchronous); try again in a second.
        if(step.busy)await new Promise<void>(resolve=>setTimeout(resolve,POSTINGS_BUSY_RETRY_MS));
      }
      catch(error){console.error(`postings fill failed: ${describe(error)}`);break;}
    }
  }finally{filling=false;reportIo(true);}
}
/** The word table in age order (age-index.ts, 1.0.3 lane 2): once every record has its key (the main database's build row), the helper
 * copies the index newest first into the second word table in steps of at most AGE_FILL_STEP_MS, only while it has nothing else to do,
 * and cuts over by rename when the walk ends; afterwards one sweep per start puts any row an older binary wrote at its key. The main
 * database is read through a handle of its own, read-only (never attached to the index connection: BEGIN IMMEDIATE would take its
 * write lock for every index write). Below the space it needs plus the reserve the fill waits and says so. */
const AGE_FILL_STEP_MS=10;
const AGE_FILL_BUSY_RETRY_MS=1000;
const AGE_FILL_KEYS_POLL_MS=5000;
const AGE_FILL_DISK_POLL_MS=30_000;
let authority:DatabaseSync|null=null,authorityPath="",agingIndex=false,ageNote="";
function openAuthority():DatabaseSync|null{
  if(authority)return authority;
  try{authority=new DatabaseSync(authorityPath,{readOnly:true});authority.exec("PRAGMA busy_timeout=250");return authority;}
  catch{authority=null;return null;}
}
const recordKeysReady=(db:DatabaseSync)=>{try{return Number(db.prepare("SELECT ready FROM memory_record_keys_build WHERE id=1").get()?.ready??0)===1;}catch{return false;}};
function indexFreeBytes():number|null{try{const stat=statfsSync(dirname(indexPath));return Number(stat.bavail)*Number(stat.bsize);}catch{return null;}}
let indexPath="";
async function fillAgeIndex(){
  // (optional methods: tests stand a stub index in for the real one)
  if(agingIndex||typeof (index as Partial<MemoryIndex>|null)?.fillAgeIndex!=="function"||typeof (index as Partial<MemoryIndex>|null)?.sweepAgeRowids!=="function")return;
  agingIndex=true;
  const clock:MaintenanceClock={deferredSince:null};
  try{
    let sweeping=false;
    for(;;){
      const working=()=>busy||queries.length>0||batches.length>0||captures.length>0;
      await new Promise<void>(resolve=>setTimeout(resolve,working()?MAINTENANCE_POLL_MS:0));
      if(!index)return;
      if(!maintenanceMayRun(clock,working(),Date.now()))continue;
      const main=openAuthority();
      if(!main){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_KEYS_POLL_MS));continue;}
      try{
        if(index.ageFillOwed()&&!sweeping){
          // every record keyed first: the fill walks the key table
          if(!recordKeysReady(main)){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_KEYS_POLL_MS));continue;}
          const step=index.fillAgeIndex(main,{maxMs:AGE_FILL_STEP_MS,freeBytes:indexFreeBytes});
          reportIo();
          if(step.waiting==="disk"){if(ageNote!=="disk"){ageNote="disk";console.error("age fill waiting for disk space");process.send?.({type:"index-note",note:"waiting for disk space"});}await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_DISK_POLL_MS));continue;}
          if(ageNote){ageNote="";process.send?.({type:"index-note",note:""});}
          if(step.busy){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_BUSY_RETRY_MS));continue;}
          if(step.done){sweeping=true;process.send?.({type:"index-aged"});}
          continue;
        }
        // in age order: the sweep of the copied-binary case, once per start
        const swept=index.sweepAgeRowids(main,{});
        reportIo();
        if(swept.busy){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_BUSY_RETRY_MS));continue;}
        if(swept.done)break;
      }
      catch(error){console.error(`age fill failed: ${describe(error)}`);break;}
    }
  }finally{agingIndex=false;reportIo(true);}
}
/** ONNX Runtime WebAssembly keeps about a gigabyte of linear memory for as long as the process lives, and that memory
 * cannot be handed back to the system. After this long without work the helper asks its parent for leave to exit; the
 * parent starts a new one when the next search or record arrives. Native ONNX Runtime is not affected. */
const DEFAULT_WASM_IDLE_EXIT_MS=5*60_000;
let warming=false, wasmIdleExitMs=DEFAULT_WASM_IDLE_EXIT_MS, lastActivity=Date.now(), exitRequested=false;
let idleTimer:NodeJS.Timeout|undefined;
const idleCheck=()=>{
  idleTimer=setTimeout(idleCheck,Math.min(15_000,Math.max(20,Math.floor(wasmIdleExitMs/4))));idleTimer.unref();
  if(exitRequested||!embeddings?.wasmResident||warming||busy||purging||filling||queries.length||batches.length||captures.length)return;
  if(Date.now()-lastActivity<wasmIdleExitMs)return;
  exitRequested=true;process.send?.({type:"idle-exit-request"});
};
const startIdleCheck=()=>{if(idleTimer)clearTimeout(idleTimer);idleTimer=setTimeout(idleCheck,Math.min(15_000,Math.max(20,Math.floor(wasmIdleExitMs/4))));idleTimer.unref();};
process.on("message",input=>{
  lastActivity=Date.now();
  if((input as {type?:string}|null)?.type!=="idle-exit")exitRequested=false;
  try {
    const message=input as {type?:string;requestId?:string;input?:unknown;records?:unknown;indexPath?:string;modelDirectory?:string;fallbackModelDirectory?:string;strictModelRoot?:boolean;manifest?:ModelManifest;authorityPath?:string;wasmIdleExitMs?:number};
    if(message.type==="idle-exit"){
      if(busy||queries.length||batches.length||captures.length){exitRequested=false;return;}
      index?.close();eligibility?.close();process.exit(0);return;
    }
    if(message.type==="init"){
      if(typeof message.wasmIdleExitMs==="number"&&message.wasmIdleExitMs>=50)wasmIdleExitMs=message.wasmIdleExitMs;
      startIdleCheck();
      if(index||typeof message.indexPath!=="string"||typeof message.modelDirectory!=="string"||(!message.manifest||typeof message.authorityPath!=="string"))throw new Error("invalid initialization");
      eligibility=new MemoryEligibility(message.authorityPath!);index=new MemoryIndex(message.indexPath);
      authorityPath=message.authorityPath!;indexPath=message.indexPath;
      // An index an earlier build left at FTS5's segment limit takes no writes at all: compact it before anything else writes.
      try{index.recoverSegments?.();}catch(error){console.error(`index compaction failed: ${describe(error)}`);}
      // Owner-authored continuity is never part of the shared index: drop any an earlier build wrote.
      try{index.purgeRecords(eligibility.pipRecordIds());}catch{/* retried at the next open */}
      void purgeRolledCheckpoints();
      // (optional call: tests stand a stub index in for the real one)
      if(index.postingsOwed?.())void fillPostings();
      // (optional call, as above) the age order of the word table, and the sweep that follows it
      void fillAgeIndex();
      embeddings=new MemoryEmbeddings(message.modelDirectory,message.manifest,{fallbackDirectory:typeof message.fallbackModelDirectory==="string"?message.fallbackModelDirectory:undefined,strictRoot:message.strictModelRoot===true});
      try{index.prepareModel(embeddings.identity);}catch{/* capacity remains an explicit lexical degradation */}
      process.send?.({type:"initialised",reset:index.rebuilt,wasm:embeddings.backend==="wasm"});return;
    }
    // WebAssembly only: load the model and run one small inference, then say so. Until "model-ready" a search still gets its
    // words (the parent's cutoffs); nothing waits on this. Native helpers ignore it.
    if(message.type==="warm"){
      if(embeddings&&embeddings.backend==="wasm"&&!warming){
        warming=true;
        void embeddings.warm().then(()=>{lastActivity=Date.now();process.send?.({type:"model-ready"});},error=>{console.error(`model warm-up failed: ${describe(error)}`);}).finally(()=>{warming=false;});
      }
      return;
    }
    // The reader asks for a checkpoint when the log is over its threshold and no scan snapshot is open (index-reader.ts).
    // The number scrub's settle (scrub-pass.ts) asks once for the end of its rewrite: one merge of the word index and a truncated log.
    if(message.type==="checkpoint"&&message.requestId&&(message as {finishRewrite?:boolean}).finishRewrite===true){
      let ok=false;try{ok=index?.finishRewrite?.()??false;}catch(error){console.error(`rewrite finish failed: ${describe(error)}`);}
      process.send?.({type:"checkpoint-result",requestId:message.requestId,ok});return;
    }
    if(message.type==="checkpoint"&&message.requestId){
      let ok=false;try{ok=index?.checkpointNow()??false;}catch(error){console.error(`checkpoint failed: ${describe(error)}`);}
      process.send?.({type:"checkpoint-result",requestId:message.requestId,ok});return;
    }
    if(message.type==="cancel"&&message.requestId){scopeParts.drop(message.requestId);cancelled.add(message.requestId);if(cancelled.size>128)cancelled.delete(cancelled.values().next().value!);return;}
    if(message.type==="scopes"&&message.requestId){const parsed=scopePartSchema.parse(message);scopeParts.add(message.requestId,parsed.part,parsed.ids);return;}
    if(message.type==="query"&&message.requestId){
      if(queries.length>=64){scopeParts.drop(message.requestId);throw new Error("queue full");}
      queries.push({requestId:message.requestId,input:scopeParts.resolve(message.requestId,searchInputSchema.parse(message.input)),enqueuedAt:performance.now()});void drain();return;
    }
    if(message.type==="index"&&message.requestId){if(batches.length>=2)throw new Error("index queue full");batches.push({requestId:message.requestId,records:indexBatchSchema.parse(message.records)});void drain();return;}
    if(captures.length>=2)throw new Error("capture queue full");
    captures.push(workSchema.parse(input));void drain();
  } catch(error) {
    console.error(`message rejected: ${describe(error)}`);
    // A refused search names itself, so the parent fails that search and logs it as recall, not as a capture result (1.0.4).
    const sent=input as {type?:string;requestId?:unknown}|null;
    const search=(sent?.type==="query"||sent?.type==="scopes")&&typeof sent.requestId==="string"?sent.requestId:undefined;
    if(search){scopeParts.drop(search);process.send?.({type:"error",reason:"INVALID_MEMORY_SEARCH",requestId:search});}
    else process.send?.({type:"error",reason:"INVALID_MEMORY_WORK"});
  }
});
process.on("disconnect",()=>{index?.close();eligibility?.close();try{authority?.close();}catch{/* already closed */}process.exit(0);});
process.send?.({type:"ready"});
