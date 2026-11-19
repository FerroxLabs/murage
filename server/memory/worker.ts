// Capture producer owner: recall-fix-c. Controller consumer owner: recall-fix-c; native grant owner: scperf-p1.
import "../../shared/win-hide-child-process.mjs";
import { RecallPreparationPending } from './recall-recovery.ts';
import { configureHelperAdmission, acceptHelperTicket, admissionPurpose, setAdmissionPurpose, helperAwaitingGrant, finishModuleBoot, stopHelperAdmission, settleHelperAdmission, type HelperTicket } from "./helper-admission.ts";
import { isBgDeferred } from "../bg-admission.ts";
import { MemoryEligibility } from "./eligibility.ts";
import { captureWork } from "./chunks.ts";
import { workSchema,indexBatchSchema,searchInputSchema,scopePartSchema,type MemorySearchInput } from "./worker-protocol.ts";
import { ScopeAssembler } from "./scope-set.ts";
import { MemoryIndex,type IndexedMemory } from "./index.ts";
import { answerQuery } from "./worker-query.ts";
import { MemoryEmbeddings,type ModelManifest } from "./embeddings.ts";
import { MAINTENANCE_POLL_MS,maintenanceMayRun,maintenanceRetryDelayMs,type MaintenanceClock } from "./maintenance-schedule.ts";
import {ioMeterActive,ioMeterTotal,ioMeterSnapshot,ioGrantSnapshot} from "../io-meter.ts";
import { osWriteBlocks } from "../io-written.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { stopMarkerPresent } from "./index-quarantine.ts";
import { writeSidecar } from "./index-wal.ts";

configureHelperAdmission({
 request:(ceiling,replan,purpose)=>process.send?.({type:"bg-grant-request",ceiling,purpose,...replan?{replan:true}:{}}),
 settle:(ticket,used)=>process.send?.({type:"bg-grant-settle",id:ticket.id,used}),
});
let index:MemoryIndex|null=null, embeddings:MemoryEmbeddings|null=null, eligibility:MemoryEligibility|null=null, busy=false;
let resetHoldPath:string|null=null, maintenanceBusy=false, exiting=false;
function resetHeld():boolean{
  if(resetHoldPath===null)return false;
  if(stopMarkerPresent(resetHoldPath))return true;
  resetHoldPath=null;
  return false;
}
const queries:Array<{requestId:string;input:MemorySearchInput;enqueuedAt:number}>=[];
let activeQueries: typeof queries = [];
const batches:Array<{requestId:string;records:IndexedMemory[]}>=[];
/** Capture work waits behind queries: a waiting search is read and answered before the capture in hand starts. */
const captures:Array<ReturnType<typeof workSchema.parse>>=[];
/** An error's name and message only (never the work it was handling): the parent forwards stderr to a rate-limited log. */
const describe=(error:unknown)=>error instanceof Error?`${error.name}: ${error.message.slice(0,160)}`:"unknown";
const yieldToMessages=()=>new Promise<void>(resolve=>setImmediate(resolve));
/** What this process has written so far, as the parent reads its own writes (io-budget.ts readProcess): the index lives in this
 * process, so its writes are reported to the parent, which charges them to the io-budget under "memory-worker" and paces index
 * work like any other writer. Every index acknowledgement carries the count; idle maintenance reports it on its own
 * (reportIo), at most once per IO_REPORT_MS while it runs and once when a loop ends, so a merge paid between batches is budgeted.
 * Two counts ride together: fsWriteBlocks (the OS floor; 0 on win32, where fsWrite counts pipe and IPC writes too) and ioBytes, the
 * index's WAL frames (cumulative, this process). The parent charges the larger growth of the two, so Windows still sees index writes. */
const writtenBlocks=()=>osWriteBlocks();
/** The index's own log reader (MemoryIndex.ioBytes): it is opened after the index handle and closed only after db.close(), so the
 * worker never opens or closes a descriptor on the shm itself (closing one drops the process's locks on it, io-written.ts). */
const walBytes=()=>{if(ioMeterActive())return ioMeterTotal()??ioMeterSnapshot()?.total??0;try{return index?.ioBytes?.()??0;}catch{return 0;}};
const IO_REPORT_MS=10_000;
let ioReportedAt=0,ioReportedBlocks=0,ioReportedBytes=0;
let ioSequence=0,ioFinalSequence:number|null=null,ioFinalAck:(()=>void)|null=null;
const ioGeneration=process.env.MURAGE_IO_GENERATION;
function ioReceipt(blocks:number,bytes:number,final=false){
  return {type:"io",fsWriteBlocks:blocks,ioBytes:bytes,...ioGeneration?{
    ioProtocol:1,generation:ioGeneration,sequence:++ioSequence,
    ...(process.env.MURAGE_BG_BOOT?{grantBytes:ioGrantSnapshot().chargedBytes,refusedWrites:ioGrantSnapshot().refusedWrites,ceilingMiss:ioGrantSnapshot().ceilingMiss}:{}),
    known:ioMeterTotal()!==null&&ioMeterSnapshot()?.known===true,final,
  }:{}};
}
const withIo=<T extends {type:string}>(message:T)=>ioGeneration?({...message,...ioReceipt(writtenBlocks(),walBytes()),type:message.type}):message;
function reportIo(force=false){
  if(ioFinalSequence!==null)return;
  const now=Date.now();
  const bytes=walBytes();// sampled on every call, before the throttle: a checkpoint between reports must not drop frames
  if(!force&&now-ioReportedAt<IO_REPORT_MS)return;
  const blocks=writtenBlocks();
  if(blocks===ioReportedBlocks&&bytes===ioReportedBytes&&!force)return;
  ioReportedAt=now;ioReportedBlocks=blocks;ioReportedBytes=bytes;
  process.send?.(ioReceipt(blocks,bytes));
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
  activeQueries=batch;
  try {
  const batchStarted=performance.now();
  let vectors:number[][]|null=null,degradedReason:string|undefined;
  try {if(batch.some(q=>q.input.semantic))vectors=await embeddings!.embed(batch.map(q=>q.input.query));}
  catch{degradedReason="local-model-unavailable";}
  const embeddingMs=performance.now()-batchStarted;
  for(let i=0;i<batch.length;i++){
    const q=batch[i];if(cancelled.delete(q.requestId)||expired(q))continue;
    if(!q.input.view)throw new RecallPreparationPending();
    const answered=answerQuery(index!,eligibility!,q.input,vectors?.[i]??null,embeddings!.identity,degradedReason);
    process.send?.({type:"query-result",requestId:q.requestId,result:{...answered.result,workerPeakRssBytes:process.resourceUsage().maxRSS*1024,timings:answered.timings,...q.input.profile?{profile:{queueMs:batchStarted-q.enqueuedAt,embeddingMs,batchSize:batch.length,eligibilityMs:answered.eligibilityMs,...answered.timings,workerTotalMs:performance.now()-q.enqueuedAt}}:{}}});
  }
  }finally{activeQueries=[];if(captures.length)wakeCaptures();}
}
/** The helper's charge carrier: ask the parent to charge the log growth to the io-budget and wait for its ack (2 s, then refused). */
// r3.2.6 A2' (frozen surface): the charge is {helperRunId, fileId, attempt, bytes}; the ack names the same three and says granted. An ack
// that names another run, file or attempt is ignored. One charge is in flight at a time (a new one settles an older wait as refused).
let chargeWaiting:{helperRunId:string;fileId:string;attempt:number;resolve:(granted:boolean)=>void;timer:ReturnType<typeof setTimeout>}|null=null;
function sendCharge(charge:{helperRunId:string;fileId:string;attempt:number;bytes:number;opening?:boolean}):Promise<boolean>{
  if(chargeWaiting){clearTimeout(chargeWaiting.timer);chargeWaiting.resolve(false);chargeWaiting=null;}
  return new Promise<boolean>(resolve=>{
    const waiting={helperRunId:charge.helperRunId,fileId:charge.fileId,attempt:charge.attempt,resolve,timer:setTimeout(()=>{if(chargeWaiting===waiting)chargeWaiting=null;resolve(false);},2000)};
    chargeWaiting=waiting;
    try{process.send?.({type:"charge",purpose:admissionPurpose(),helperRunId:charge.helperRunId,fileId:charge.fileId,attempt:charge.attempt,bytes:charge.bytes,opening:charge.opening===true});}
    catch{clearTimeout(waiting.timer);if(chargeWaiting===waiting)chargeWaiting=null;resolve(false);}
  });
}
function chargeAcked(ack:{helperRunId?:unknown;fileId?:unknown;attempt?:unknown;granted?:unknown}){
  const waiting=chargeWaiting;
  if(!waiting||ack.helperRunId!==waiting.helperRunId||ack.fileId!==waiting.fileId||ack.attempt!==waiting.attempt)return;
  clearTimeout(waiting.timer);chargeWaiting=null;waiting.resolve(ack.granted===true);
}
/** The writer's drain (1.11): while a step wants the log emptied (a tier at L = 32 B, a seal that did not truncate) the helper tells the
 * parent to hold readers off ({type:"wal-drain",on:true}), seals and truncates once per tick until the log is empty, then lifts it. The
 * hold is lifted on every path. An unanswered ack never wedges the helper: the parent logs MEMORY_INDEX_DRAIN_UNACKNOWLEDGED. */
const DRAIN_ACK_MS=5000;
const DRAIN_SEAL_TRIES=100;
let drainSeq=0;
const drainWaiters=new Map<number,()=>void>();
function sendDrain(on:boolean):Promise<void>{
  const requestId=++drainSeq;
  return new Promise<void>(resolve=>{
    const timer=setTimeout(()=>{drainWaiters.delete(requestId);resolve();},DRAIN_ACK_MS);
    drainWaiters.set(requestId,()=>{clearTimeout(timer);drainWaiters.delete(requestId);resolve();});
    try{process.send?.({type:"wal-drain",requestId,on});}catch{clearTimeout(timer);drainWaiters.delete(requestId);resolve();}
  });
}
/** The deletion scrub's own drain asks a few times only: a reader that pins the log is a block the scrub timer backs off on (1 s to
 * 60 s), not something to poll. A grant still on its way is waited for inside those tries; one still refused at the end is rethrown. */
const SCRUB_DRAIN_TRIES=8;
async function holdAndSeal(target:MemoryIndex,scrub=false):Promise<boolean>{
  let truncated=false,deferred:unknown;
  await sendDrain(true);
  try{
    for(let tries=0;tries<(scrub?SCRUB_DRAIN_TRIES:DRAIN_SEAL_TRIES);tries++){
      try{deferred=undefined;if((await target.sealAndTruncate()).truncated){truncated=true;break;}}
      catch(error){if(!scrub||!isBgDeferred(error))throw error;deferred=error;}
      await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));
    }
  }finally{await sendDrain(false);}
  if(deferred!==undefined)throw deferred;
  return truncated;
}
/** The durable stop this file holds, sent once per (file, seq) so the parent can run its overrun backoff and reset. */
let stopSentKey="";
function reportStop(target:MemoryIndex){
  const stop=target.stopInfo?.();if(!stop)return;
  const key=`${stop.fileId}:${stop.seq}`;if(key===stopSentKey)return;
  stopSentKey=key;process.send?.({type:"index-stop",...stop});
}
/** One maintenance step, then the drain it asks for and the stop report. Every caller goes through here. */
async function maintain(target:MemoryIndex){
  const step=await target.maintenanceStep();
  if(step.drain)await holdAndSeal(target);
  reportStop(target);
  if(!target.writerCheckOwed?.())stopHelperAdmission();
  return step;
}
/** A refused group can leave a live check, and vector work can leave a commit check. Neither may cross a batch acknowledgement. */
async function finishBatchAdmission(target:MemoryIndex):Promise<boolean>{
  while(!exiting&&target.writerCheckOwed?.()){
    try{await maintain(target);}catch(error){if(!isBgDeferred(error))throw error;}
    if(target.writerCheckOwed?.())await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));
    // Reads need no write check: a search queued while the log is checked is answered between the steps (T4).
    while(!exiting&&queries.length&&index&&embeddings&&eligibility)await serveQueries();
  }
  if(exiting)return false;
  await settleHelperAdmission();
  return !exiting;
}
function answerCapture(){
  if(exiting)return;
  const work=captures.shift();
  if(!work)return;
  try{process.send?.({type:"result",result:captureWork(work)});}
  catch(error){console.error(`capture rejected: ${describe(error)}`);process.send?.({type:"error",reason:"INVALID_MEMORY_WORK"});}
  lastActivity=Date.now();
}
// Capture is pure CPU work; index I/O and inference need not hold its result.
function wakeCaptures(){
  setImmediate(()=>{
    const waiting=(q:typeof queries[number])=>!cancelled.has(q.requestId)&&!expired(q);
    if((busy||maintenanceBusy)&&!queries.some(waiting)&&!activeQueries.some(waiting))answerCapture();
    else void drain();
  });
}
async function drain(){
  if(exiting||busy||maintenanceBusy)return;
  if((!index||!embeddings||!eligibility)&&!captures.length)return;
  if(!queries.length&&!captures.length&&(!batches.length||resetHeld()))return;
  busy=true;
  let queryBatchServed=false;
  try {
    for(;;){
      const readable=Boolean(index&&embeddings&&eligibility);
      const batchReady=readable&&batches.length>0&&!resetHeld();
      if(!(readable&&queries.length)&&!captures.length&&!batchReady)break;
      if(!batchReady)queryBatchServed=false;
      // Queries lead each drain. Sustained arrivals must still leave one slot
      // for a waiting index batch, then immediately return priority to queries.
      if(readable&&queries.length&&((!batchReady&&!captures.length)||!queryBatchServed)){
        await serveQueries();
        queryBatchServed=true;
      } else if(captures.length){
        // A capture is synchronous CPU: let the loop read any query that arrived since the last one, then answer it first.
        await yieldToMessages();
        if(readable&&queries.length){await serveQueries();continue;}
        answerCapture();
        queryBatchServed=false;
      } else if(index&&embeddings&&eligibility) {
        const batch=batches.shift()!;
        // The checked writer commits groups; a refusal (segment gate, merge floor, log over its cap, check owed) leaves the
        // unwritten remainder queued, runs one maintenance step, and waits one poll before the next try so the loop never spins.
        let written:Awaited<ReturnType<MemoryIndex["applyBatch"]>>;
        try{
          const restore=setAdmissionPurpose(batch.records.length>0&&batch.records.every(record=>record.deleted&&!record.rolled)?"owner-delete":"bg");
          try{written=await index.applyBatch(batch.records);}finally{restore();}
        }
        // A refused batch is retried after the wait; a turn's search queued meanwhile goes first (fablehunt-1020q T4: recall waited behind
        // the retries of a refused batch, past RECALL_WAIT_MS, and the turn went out with no memory).
        catch(error){if(isBgDeferred(error)){batches.unshift(batch);await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));queryBatchServed=false;continue;}throw error;}
        if(written.status!=="done"){
          if(written.reason==="segment-gate"||written.reason==="merge-floor"||written.reason==="age-blocked"){
            // These need the controller's durable/paced hold, not an internal
            // retry with busy held. Only the checked committed prefix gets a
            // receipt; the parent retains every remaining pending record.
            const scrubOwed=Boolean(index.deletionScrubPending?.());
            if(scrubOwed&&!scrubTimer)armDeletionScrub(SCRUB_STEP_GAP_MS);
            reportStop(index);
            if(!await finishBatchAdmission(index))return;
            process.send?.(withIo({type:"index-result",requestId:batch.requestId,failed:written.reason,committed:written.committed,
              embeddingStatus:"unavailable",scrubOwed,records:batch.records.slice(0,written.committed).map(r=>({id:r.id,version:r.version,deleted:r.deleted})),
              fsWriteBlocks:writtenBlocks(),ioBytes:walBytes(),
            }));
            queryBatchServed=false;
            continue;
          }
          batches.unshift({...batch,records:batch.records.slice(written.committed)});
          // r4.1 D10a: a group admission refused for the log's size drains it first (the maintenance step may have nothing to run).
          if(written.reason==="drain"){try{await holdAndSeal(index);}catch(error){console.error(`index drain failed: ${describe(error)}`);}}
          try{await maintain(index);}catch(error){console.error(`index maintenance failed: ${describe(error)}`);}
          reportIo();
          await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));
          queryBatchServed=false;
          continue;
        }
        // Return checked lexical-write reservations before awaiting model inference.
        if(!await finishBatchAdmission(index))return;
        // Rolled checkpoint versions use stepped maintenance; owner forgets owe the deletion scrub below.
        // While a failed pass waits out its back-off (purgeFailures), a batch must
        // not restart maintenance or cancel that timer; the back-off resets only when a pass completes.
        if(index.maintenanceOwed()&&!index.deletionScrubPending?.()&&!purgeFailures)void purgeRolledCheckpoints();
        const alive=batch.records.filter(r=>!r.deleted&&!r.archived);let embeddingStatus="indexed";
        try {
          for(let at=0,step=indexSlice();at<alive.length;at+=step,step=indexSlice()){
            const slice=alive.slice(at,at+step);
            const vectors=await embeddings.embed(slice.map(r=>r.text));
            for(let i=0;i<slice.length;){
              try{await index.vector(slice[i],embeddings.identity,0,vectors[i]);i++;}
              catch(error){
                if(!isBgDeferred(error))throw error;
                // WAL debt also defers writes; busy holds off the tick that would recover it.
                try{await index.sealAndTruncate();}catch(error){if(!isBgDeferred(error))throw error;}
                await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));
                if(exiting)return;
                while(queries.length)await serveQueries();
              }
            }
            // a turn's search jumps ahead of the rest of this batch
            while(queries.length&&at+step<alive.length)await serveQueries();
          }
        }
        catch {embeddingStatus="unavailable";}
        eligibility.warm([...new Set(alive.map(record=>record.scopeId))]);
        // Acknowledged at once: an owner forget's physical scrub was made a durable debt in the same index transaction as its removal
        // (index.ts upsert) and is drained by the scrub timer, one merge for every deletion so far; no batch waits on it (MEMDEL-SIMPLIFY-109).
        const scrubOwed=Boolean(index.deletionScrubPending?.());
        if(scrubOwed&&!scrubTimer)armDeletionScrub(SCRUB_STEP_GAP_MS);
        // the batch's writes, charged by the parent to the io-budget (fsWriteBlocks and ioBytes: see reportIo)
        if(!await finishBatchAdmission(index))return;
        process.send?.(withIo({type:"index-result",requestId:batch.requestId,embeddingStatus,scrubOwed,records:batch.records.map(r=>({id:r.id,version:r.version,deleted:r.deleted})),fsWriteBlocks:writtenBlocks(),ioBytes:walBytes()}));
        queryBatchServed=false;
      }
    }
  }catch(error){console.error(`index drain failed: ${describe(error)}`);process.send?.({type:"index-error",reason:"MEMORY_INDEX_FAILED"});}
  finally{busy=false;lastActivity=Date.now();}
}
/** The deletion scrub (index.ts scrubDeleted) runs on its own timer, apart from projection batches and after a restart with only the
 * durable debt: one merge command per step, 50 ms apart, deferring to searches, batches and captures for at most
 * MAINTENANCE_MAX_DEFER_MS; a lock backs off 1 s doubling to 60 s. The parent hears `scrub-done` when no debt is left. */
const SCRUB_STEP_GAP_MS=50, SCRUB_RETRY_MS=1000, SCRUB_RETRY_MAX_MS=60_000;
let scrubTimer:ReturnType<typeof setTimeout>|undefined,scrubFailures=0;
// Admission owes a permit, not a failed scrub attempt. Its delivery must
// wake this timer even when the requested retry crosses a minute boundary.
let scrubAwaitingGrant=false;
const scrubClock:MaintenanceClock={deferredSince:null};
function armDeletionScrub(delay:number){
  if(scrubTimer)clearTimeout(scrubTimer);
  scrubTimer=setTimeout(async ()=>{
    scrubTimer=undefined;
    if(exiting||!index?.deletionScrubPending?.())return;
    if(resetHeld()||busy||maintenanceBusy){armDeletionScrub(MAINTENANCE_POLL_MS);return;}
    if(!maintenanceMayRun(scrubClock,busy||queries.length>0||batches.length>0||captures.length>0,Date.now())){
      armDeletionScrub(MAINTENANCE_POLL_MS);return;
    }
    let done=false,blocked=true,admissionDelay:number|undefined;
    scrubAwaitingGrant=false;
    maintenanceBusy=true;
    try{
      // The drain a refused scrub step asks for is the same owner deletion: under the BG purpose its grant was dropped by the next
      // scrub pass and the debt never moved again (MAIN RULING 1114-MEMDEL-FIXTURE test). The ticket is returned when the pass ends.
      const restorePurpose=setAdmissionPurpose("owner-delete");
      try{
      done=await index.scrubDeleted();blocked=index.scrubBlocked;
      if(!done&&helperAwaitingGrant()){blocked=false;scrubAwaitingGrant=true;}
      // r4.1 D10b: a debt step the log's size refused is drained before the timer re-arms; a completed debt of a listed seq restarts the backfill.
      if(index.scrubDrain&&!(await holdAndSeal(index,true)))blocked=true;
      }finally{restorePurpose();}
      if(index.takeFillKick?.())void fillPostings();
    }
    catch(error){
      if(isBgDeferred(error)){blocked=false;scrubAwaitingGrant=true;admissionDelay=Math.max(SCRUB_STEP_GAP_MS,error.retryInMs);}
      else console.error(`deletion scrub failed: ${describe(error)}`);
    }
    finally{maintenanceBusy=false;void drain();}
    reportIo();
    if(done){scrubFailures=0;process.send?.({type:"scrub-done"});return;}
    if(!blocked)scrubFailures=0;
    armDeletionScrub(admissionDelay??(blocked?maintenanceRetryDelayMs(++scrubFailures,SCRUB_RETRY_MS,SCRUB_RETRY_MAX_MS):SCRUB_STEP_GAP_MS));
  },delay);
  scrubTimer.unref();
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
      if(exiting||!index)return;
      if(resetHeld()||busy||maintenanceBusy){await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));continue;}
      // The dedicated scrub timer owns pacing and lock backoff; this pass must not bypass it.
      if(index.deletionScrubPending?.())break;
      // Quiet: run. Busy: wait, but not past MAINTENANCE_MAX_DEFER_MS since the step was first put off, so sustained load
      // cannot starve the merge a deletion owes (the step is bounded and synchronous, so it cannot interleave with a search).
      if(!maintenanceMayRun(clock,working(),Date.now()))continue;
      maintenanceBusy=true;
      try{if((await index.purgeRolledCheckpoints({maxExamined:ROLLED_CHECKPOINT_EXAMINED,maxMs:ROLLED_CHECKPOINT_STEP_MS})).done){purgeFailures=0;break;}reportIo();}
      catch(error){
        if(isBgDeferred(error)){await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));continue;}
        console.error(`rolled checkpoint purge failed: ${describe(error)}`);
        // The segment limit is a stop of the checked writer now (maintenanceStep merges it clear); every failure backs off.
        purgeFailures++;
        break;
      }finally{maintenanceBusy=false;void drain();}
    }
  }finally{purging=false;reportIo(true);}
  // Deletions that arrived while the last merge ran are owed their own pass at once; otherwise the safety-net pass.
  // A failed pass waits (doubling), never 0: the owed merge is durable, so an immediate retry would fail the same way for ever.
  if(index)passTimer=setTimeout(()=>void purgeRolledCheckpoints(),purgeFailures?maintenanceRetryDelayMs(purgeFailures,ROLLED_CHECKPOINT_PASS_MS,ROLLED_CHECKPOINT_RETRY_MAX_MS):index.maintenanceOwed()&&!index.deletionScrubPending?.()?0:ROLLED_CHECKPOINT_PASS_MS);
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
      if(exiting||!index)return;
      if(resetHeld()||busy||maintenanceBusy){await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));continue;}
      if(!maintenanceMayRun(clock,working(),Date.now()))continue;
      maintenanceBusy=true;
      try{
        const step=await index.fillPostings({maxMs:POSTINGS_STEP_MS});
        reportIo();
        if(step.drain&&index)await holdAndSeal(index); // r4.1: an oversize fill step the log's size refused
        if(step.done)break;
        // The write lock was taken: never wait for it here (the busy wait is synchronous); try again in a second.
        if(step.busy)await new Promise<void>(resolve=>setTimeout(resolve,POSTINGS_BUSY_RETRY_MS));
      }
      catch(error){if(isBgDeferred(error)){await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));continue;}console.error(`postings fill failed: ${describe(error)}`);break;}
      finally{maintenanceBusy=false;void drain();}
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
      if(exiting||!index)return;
      if(resetHeld()||busy||maintenanceBusy){await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));continue;}
      if(!maintenanceMayRun(clock,working(),Date.now()))continue;
      // The scrub's durable table cursor must stay attached to the same word tables until completion.
      if(index.deletionScrubPending?.()){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_BUSY_RETRY_MS));continue;}
      const main=openAuthority();
      if(!main){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_KEYS_POLL_MS));continue;}
      // The age fill and sweep are checked writes. They run only after a maintenance step that had nothing to do (ran === null) on a
      // writer that is neither stopped nor owing a check, with the segment gate clear; a missing gateClear is not clear.
      if(typeof index.maintenanceStep==="function"){
        // Exclusive with the batch loop (drain() returns while busy): one writer step at a time. Work that arrived meanwhile is picked up after.
        if(busy)continue;
        busy=true;let step:Awaited<ReturnType<typeof maintain>>;
        try{step=await maintain(index);}
        catch(error){console.error(`index maintenance failed: ${describe(error)}`);step={ran:null} as Awaited<ReturnType<typeof maintain>>;}// a failed pass waits one poll like a refused one (the hold was released by holdAndSeal)
        finally{busy=false;lastActivity=Date.now();if(queries.length||batches.length||captures.length)void drain();}
        if(step.ran!==null||step.gateClear!==true||index.writerStopped()||index.writerCheckOwed()){await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));continue;}
      }
      try{
        if(index.ageFillOwed()&&!sweeping){
          // every record keyed first: the fill walks the key table
          if(!recordKeysReady(main)){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_KEYS_POLL_MS));continue;}
          const step=index.fillAgeIndex(main,{maxMs:AGE_FILL_STEP_MS,freeBytes:indexFreeBytes});
          reportIo();
          if(step.waiting==="disk"){if(ageNote!=="disk"){ageNote="disk";console.error("age fill waiting for disk space");process.send?.({type:"index-note",note:"waiting for disk space"});}await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_DISK_POLL_MS));continue;}
          if(ageNote){ageNote="";process.send?.({type:"index-note",note:""});}
          if(step.busy||(step as {waiting?:string}).waiting==="gate"){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_BUSY_RETRY_MS));continue;}
          if(step.done){sweeping=true;process.send?.({type:"index-aged"});}
          continue;
        }
        // in age order: the sweep of the copied-binary case, once per start
        const swept=index.sweepAgeRowids(main,{});
        reportIo();
        if(swept.busy||(swept as {waiting?:string}).waiting==="gate"){await new Promise<void>(resolve=>setTimeout(resolve,AGE_FILL_BUSY_RETRY_MS));continue;}
        if(swept.done)break;
      }
      catch(error){if(isBgDeferred(error)){await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));continue;}console.error(`age fill failed: ${describe(error)}`);break;}
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
  if(exiting||resetHeld()||maintenanceBusy||exitRequested||!embeddings?.wasmResident||warming||busy||purging||filling||index?.deletionScrubPending?.()||queries.length||batches.length||captures.length)return;
  if(Date.now()-lastActivity<wasmIdleExitMs)return;
  exitRequested=true;process.send?.({type:"idle-exit-request"});
};
const startIdleCheck=()=>{if(idleTimer)clearTimeout(idleTimer);idleTimer=setTimeout(idleCheck,Math.min(15_000,Math.max(20,Math.floor(wasmIdleExitMs/4))));idleTimer.unref();};
process.on("message",async input=>{
  lastActivity=Date.now();
  if((input as {type?:string}|null)?.type!=="idle-exit")exitRequested=false;
  try {
    const message=input as {type?:string;requestId?:string;input?:unknown;records?:unknown;indexPath?:string;modelDirectory?:string;fallbackModelDirectory?:string;strictModelRoot?:boolean;manifest?:ModelManifest;authorityPath?:string;wasmIdleExitMs?:number};
    if(message.type==="bg-grant"){
      const reply=input as {ticket:HelperTicket|null;retryInMs?:number};
      acceptHelperTicket(reply.ticket,reply.retryInMs);
      if(scrubAwaitingGrant&&index?.deletionScrubPending?.())armDeletionScrub(reply.ticket?SCRUB_STEP_GAP_MS:Math.max(SCRUB_STEP_GAP_MS,reply.retryInMs??SCRUB_STEP_GAP_MS));
      void drain();return;
    }
    if(message.type==="io-final-ack"){
      const ack=input as {generation?:unknown;sequence?:unknown};
      if(ack.generation===ioGeneration&&ack.sequence===ioFinalSequence)ioFinalAck?.();
      return;
    }
    if(message.type==="io-stop"){await exitPrepared();return;}
    if(exiting&&message.type!=="charge-ack"&&message.type!=="wal-drain-ack")return;
    if(message.type==="idle-exit"){
      if(busy||queries.length||batches.length||captures.length){exitRequested=false;return;}
      await exitPrepared();return;
    }
    if(message.type==="wal-drain-ack"){drainWaiters.get(Number((message as {requestId?:unknown}).requestId))?.();return;}
    // r3.2.8 3.1: the parent drained its readers and wants this helper gone so a new one can start with R. Exit at once with NO close
    // (as exitNow, spec 1.7: no sqlite3_close, so no close checkpoint), whatever the helper is doing.
    if(message.type==="reset-exit"){exiting=true;process.exit(0);return;}
    if(message.type==="charge-ack"){chargeAcked(message as Record<string,unknown>);return;}
    if(message.type==="init"){
      if(typeof message.wasmIdleExitMs==="number"&&message.wasmIdleExitMs>=50)wasmIdleExitMs=message.wasmIdleExitMs;
      startIdleCheck();
      if(index||typeof message.indexPath!=="string"||typeof message.modelDirectory!=="string"||(!message.manifest||typeof message.authorityPath!=="string"))throw new Error("invalid initialization");
      eligibility=new MemoryEligibility(message.authorityPath!);
      // r3.2.8 3.2: an init that carries R ({resetId, resets, kind}) opens through trigger A / ignoreMarker / trigger B and writes reset_done = R.
      const sentReset=(message as {reset?:{resetId?:unknown;resets?:unknown;kind?:unknown}}).reset;
      const reset=sentReset&&typeof sentReset.resetId==="number"&&typeof sentReset.resets==="number"&&typeof sentReset.kind==="string"
        ?{resetId:sentReset.resetId,resets:sentReset.resets,kind:sentReset.kind as NonNullable<Parameters<typeof MemoryIndex.create>[1]["reset"]>["kind"]}:undefined;
      // r3.2.8-H.1 6: the open is announced first (the controller's streak counts an exit between this message and `initialised`).
      // MemoryIndex.create runs only in the send's callback: a closed channel (stop's disconnect) fails the callback and the helper exits 0.
      await new Promise<void>(resolve=>{
        if(!process.send){resolve();return;}
        try{process.send({type:"index-opening"},(error:Error|null)=>{if(error){process.exit(0);return;}resolve();});}
        catch{process.exit(0);}
      });
      index=await MemoryIndex.create(message.indexPath,{charge:sendCharge,...reset?{reset}:{}});// the index owns its log reader (opened after its handle, closed after it)
      // A fresh file can be waiting for its first admitted schema transaction. Never expose absent tables as initialized.
      while(!exiting&&typeof index.opened==="function"&&!index.opened()&&!index.writerStopped()){
        try{await index.init();}catch(error){if(!isBgDeferred(error))throw error;}
        if(!index.opened())await new Promise<void>(resolve=>setTimeout(resolve,MAINTENANCE_POLL_MS));
      }
      if(exiting)return;
      // The 50 ms tick (1.11): seal and truncate whenever the log is over its tick line.
      const tickTimer=setInterval(()=>{
        // A waiting search goes first: the tick starts again 50 ms after the queue is empty (T4).
        if(exiting||resetHeld()||busy||maintenanceBusy)return;
        if(queries.length>0){void drain();return;}
        maintenanceBusy=true;
        void (async()=>{try{await index?.tick?.();if(index?.writerCheckOwed?.()&&!agingIndex)await maintain(index);}catch(error){console.error(`index tick failed: ${describe(error)}`);}finally{maintenanceBusy=false;void drain();}})();
      },MAINTENANCE_POLL_MS);tickTimer.unref();
      authorityPath=message.authorityPath!;indexPath=message.indexPath;
      // Owner-authored continuity is never part of the shared index: drop any an earlier build wrote.
      try{await index.purgeRecords(eligibility.pipRecordIds());}catch{/* retried at the next open */}
      void purgeRolledCheckpoints();
      // (optional call: tests stand a stub index in for the real one)
      if(index.postingsOwed?.())void fillPostings();
      // (optional call, as above) the age order of the word table, and the sweep that follows it
      void fillAgeIndex();
      embeddings=new MemoryEmbeddings(message.modelDirectory,message.manifest,{fallbackDirectory:typeof message.fallbackModelDirectory==="string"?message.fallbackModelDirectory:undefined,strictRoot:message.strictModelRoot===true});
      try{index.prepareModel(embeddings.identity);}catch{/* capacity remains an explicit lexical degradation */}
      const scrubOwed=Boolean(index.deletionScrubPending?.());
      if(scrubOwed)armDeletionScrub(0);
      reportStop(index);
      if(reset){
        try{if(!stopMarkerPresent(message.indexPath))writeSidecar(message.indexPath,"-walstop",{kind:"unknown"},true);}
        catch{exiting=true;process.exit(1);return;}
        resetHoldPath=message.indexPath;
      }
      process.send?.(withIo({type:"initialised",reset:index.rebuilt,resetDone:index.resetDone(),walOverStop:index.stopInfo(),stop:index.stopInfo(),wasm:embeddings.backend==="wasm",scrubOwed}));return;
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
      let ok=false;try{if(!resetHeld()&&!busy&&!maintenanceBusy){maintenanceBusy=true;try{ok=(await index?.finishRewrite?.())??false;}finally{maintenanceBusy=false;}}}catch(error){console.error(`rewrite finish failed: ${describe(error)}`);}
      process.send?.(withIo({type:"checkpoint-result",requestId:message.requestId,ok}));return;
    }
    if(message.type==="checkpoint"&&message.requestId){
      let ok=false;try{if(!resetHeld()&&!busy&&!maintenanceBusy){maintenanceBusy=true;try{ok=(await index?.sealAndTruncate())?.truncated??false;}finally{maintenanceBusy=false;}}}catch(error){console.error(`checkpoint failed: ${describe(error)}`);}
      process.send?.(withIo({type:"checkpoint-result",requestId:message.requestId,ok}));return;
    }
    if(message.type==="cancel"&&message.requestId){scopeParts.drop(message.requestId);cancelled.add(message.requestId);if(cancelled.size>128)cancelled.delete(cancelled.values().next().value!);if(captures.length)wakeCaptures();return;}
    if(message.type==="scopes"&&message.requestId){const parsed=scopePartSchema.parse(message);scopeParts.add(message.requestId,parsed.part,parsed.ids);return;}
    if(message.type==="query"&&message.requestId){
      if(queries.length>=64){scopeParts.drop(message.requestId);throw new Error("queue full");}
      queries.push({requestId:message.requestId,input:scopeParts.resolve(message.requestId,searchInputSchema.parse(message.input)),enqueuedAt:performance.now()});void drain();return;
    }
    if(message.type==="index"&&message.requestId){if((input as {grant?:HelperTicket}).grant)acceptHelperTicket((input as {grant:HelperTicket}).grant);if(batches.length>=2)throw new Error("index queue full");batches.push({requestId:message.requestId,records:indexBatchSchema.parse(message.records)});void drain();return;}
    if(captures.length>=2)throw new Error("capture queue full");
    captures.push(workSchema.parse(input));wakeCaptures();void drain();
  } catch(error) {
    console.error(`message rejected: ${describe(error)}`);
    // A refused search names itself, so the parent fails that search and logs it as recall, not as a capture result (1.0.4).
    const sent=input as {type?:string;requestId?:unknown}|null;
    const search=(sent?.type==="query"||sent?.type==="scopes")&&typeof sent.requestId==="string"?sent.requestId:undefined;
    if(search){scopeParts.drop(search);process.send?.({type:"error",reason:"INVALID_MEMORY_SEARCH",requestId:search});}
    else process.send?.({type:"error",reason:"INVALID_MEMORY_WORK"});
  }
});
// A send with no callback reports its failure as an "error" event on process, and with no listener that event ends the helper with
// code 1 before the close below. Murage closing the channel can land between two turns of this loop, so a report sent in that gap
// fails with EPIPE; the channel's end of file follows on the next turn and "disconnect" closes the index as usual.
process.on("error",error=>{
  const code=(error as NodeJS.ErrnoException).code;
  if(code!=="EPIPE"&&code!=="ECONNRESET"&&code!=="ERR_IPC_CHANNEL_CLOSED")console.error(`message send failed: ${describe(error)}`);
});
async function exitPrepared(){
  if(exiting)return;
  exiting=true;
  stopHelperAdmission();
  // Only a quiescent, sealed index can promise that the receipt is final.
  // A busy/disconnected/crashed helper retains a measured floor, but its
  // unconfirmed tail invalidates the parent's coverage instead of reading zero.
  let sealed=Boolean(index)&&!resetHeld()&&!busy&&!maintenanceBusy;
  if(sealed)try{await index?.prepareExit();}catch{sealed=false;}
  eligibility?.close();try{authority?.close();}catch{/* already closed */}
  if(sealed&&ioGeneration&&process.connected&&process.send){
    const receipt=ioReceipt(writtenBlocks(),walBytes(),true);
    ioFinalSequence=ioSequence;
    await new Promise<void>(resolve=>{
      const timer=setTimeout(done,500);
      function done(){clearTimeout(timer);ioFinalAck=null;resolve();}
      ioFinalAck=done;
      try{process.send!(receipt,(error:Error|null)=>{if(error)done();});}catch{done();}
    });
  }else reportIo(true);
  process.exit(0);
}
process.on("disconnect",()=>exitPrepared());
process.on("uncaughtException",()=>{reportIo(true);process.exit(1);});
process.on("unhandledRejection",()=>{reportIo(true);process.exit(1);});
finishModuleBoot();
process.send?.({type:"ready"});
if(ioGeneration)reportIo(true);
