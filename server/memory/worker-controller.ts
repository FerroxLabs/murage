import { bundledModelDirectory, resolveMemoryModelDirectory } from "./model-location.ts";
import { setScrubRewriteFinisher } from "./scrub-pass.ts";
import "./model-adoption.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync,existsSync } from "node:fs";
import { join } from "node:path";
import { SPAWNED_PROXIES,SERVER_ROOT } from "../proxy-paths.ts";
import { DATA_DIR } from "../config.ts";
import { BACKGROUND_BUSY_MS, awaitWriterGate, database,isDatabaseBusy,transaction,withBusyBudget,writersHeldForIndexBuild } from "../database.ts";
import { BLOCK_BYTES, ioBudget } from "../io-budget.ts";
import { claimMemoryJob, deferStaleMemoryWork, hasClaimableMemoryJob, heartbeatMemoryJob, isStaleMemoryPublication, nextMemoryJobDelay, notifyMemoryWork, onMemoryWork, publishMemoryWork, redriveTransientFailedJobs, requeueStaleMemoryWork, STALE_MEMORY_REQUEUE_LIMIT } from "./jobs.ts";
import { memoryState } from "./repository.ts";
import { sendSearch } from "./scope-set.ts";
import { resultSchema, type MemoryWork,type MemorySearchInput,type MemorySearchResult } from "./worker-protocol.ts";
import { hasPendingProjection, pendingProjectionRecords, rolledCheckpointSql } from "./projection.ts";
import type { ModelManifest } from "./embeddings.ts";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import { claimSettleSweepPending, parkMaintenancePending, parkMaintenanceStep } from "./park.ts";
import { memoryTickGapMs, traceBacklog, traceSlowStep } from "./claim-trace.ts";
import { turnTraceEnabled } from "../turn-trace.ts";
import { logSwallowed, makeStderrForwarder, type WorkerSubsystem } from "./worker-log.ts";
import { flushMemoryCounters, stepHealthScan } from "./health.ts";
import { stepRetentionScan } from "./retention.ts";
import { blockMemoryIndexReader, closeMemoryIndexReader, setWalCheckpointRequester, unblockMemoryIndexReader } from "./index-reader.ts";
import { ownerFirst } from "../owner-first.ts";
import { forgetTurnCaptureJob, turnCaptureJobId } from "./turn-capture-jobs.ts";
import { CATCH_UP_WINDOW_MS } from "./recent.ts";
import { heldStep } from "../observe.ts";

/** The helper owns the index writer: a checkpoint the reader asks for is answered within this, or counted as not done. */
export const CHECKPOINT_ACK_MS=5_000;
export const FINISH_REWRITE_ACK_MS=120_000;
export const MEMORY_IDLE_SWEEP_MS=30_000;
/** Queued consolidation drains at most once a second, as before. */
export const MEMORY_DRAIN_GAP_MS=1_000;
/** A due idle learning pass waits this long for running extractions before it runs beside them. */
export const IDLE_FAIR_AFTER_MS=15_000;
/** While the history upgrade runs (database.ts backgroundUpgradeRunning, the transcript backfill) the idle lanes (consolidation, reveals, procedure
 * review, continuity, lineage warming, the status figures) wait and look again this often (rc13 real-data run: idle scans beside the upgrade were
 * 25 of its 44 stalls over 250 ms, each read slowed by the upgrade's own I/O). */
export const UPGRADE_RECHECK_MS=5_000;
/** The most the idle lanes yield to one upgrade, counted from when they first found it running: an upgrade that never ends cannot starve them. */
export const UPGRADE_YIELD_MAX_MS=60*60_000;
/** A helper that has not initialised by then is killed and respawned with backoff. */
export const MEMORY_WORKER_INIT_MS=120_000;
/** While parking maintenance is still pending, an idle controller comes back this soon for its next bounded step. */
const PARK_STEP_MS=250;
/** A turn from acceptance to the prompt keeps the worker's claims, receipts and consolidation steps off the main thread for at most this long. */
export const TURN_HOLD_MAX_MS=3_000;
/** Most row work one slice of a worker message applies on the main thread before it yields (its commit comes on top). */
export const WORKER_SLICE_MS=10;
/** How soon a step that met a held write lock tries again. */
const BUSY_RETRY_MS=250;
/** Helper messages whose handling writes nothing to messages.db: never held back by a writer hold. */
const HOLD_EXEMPT_MESSAGES:ReadonlySet<string>=new Set(["ready","model-ready","checkpoint-result","query-result","index-error"]);
/** A checkpoint roll whose evidence was still being checked is tried again this often, this many times (about a minute). */
const CHECKPOINT_CHECK_RETRY_MS=500, CHECKPOINT_CHECK_RETRIES=120;

export class MemoryWorkerController {
  private child: ChildProcess | null=null;
  private work: MemoryWork | null=null;
  private owner=randomUUID();
  private timer: ReturnType<typeof setTimeout> | null=null;
  private heartbeat: ReturnType<typeof setTimeout> | null=null;
  private scheduledAt=Infinity;
  private started=false;
  private ticking=false;
  /** A wake arrived while a tick ran: replayed when the tick ends, so it is not dropped (CLAIM-REDESIGN.md section 5). */
  private wakeOwed=false;
  private requested=false;
  private wakes=0;
  private unsubscribe:(()=>void)|null=null;
  private unregisterBytes:(()=>void)|null=null;
  /** The helper's writes, as it reports them (worker.ts reportIo: its process's fsWrite blocks, cumulative per process), kept as a
   * cumulative byte count across helpers for the io-budget's "memory-worker" source. A count below the last one is a new helper's. */
  private workerBytes=0;
  private workerBlocks=0;
  private deadline=0;
  private ready=false;
  private initDeadline=0;
  private initFailures=0;
  private respawnAt=0;
  /** The helper that was allowed to exit because it held a WebAssembly model and had been idle (worker.ts). */
  private idleExit:ChildProcess|null=null;
  /** True from a planned idle exit until the next helper starts: the only state in which a turn's start warms the helper (native helpers never idle-exit, so nothing changes for them). */
  private idleExited=false;
  private stopping=false;
  private indexing=false;
  private indexDeadline=0;
  private indexRequestId:string|null=null;
  /** The batch in flight: each record's projected state when it was sent ("id\u0000version" -> state). */
  /** Checkpoint requests the index reader sent to the helper and has not seen answered. */
  private checkpoints=new Map<string,(ok:boolean)=>void>();
  private indexSent=new Map<string,string>();
  private queries=new Map<string,{input:MemorySearchInput;sent:boolean;resolve:(value:MemorySearchResult)=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
  /** One entry per subsystem, so one clean tick of the capture loop cannot hide a failing index and the reverse. The
   * newest entry is what `error` reports. */
  private errors=new Map<string,string>();
  get error():string|null{let last:string|null=null;for(const value of this.errors.values())last=value;return last;}
  set error(value:string|null){if(value===null)this.errors.clear();else this.setError("worker",value);}
  private setError(subsystem:string,code:string){this.errors.delete(subsystem);this.errors.set(subsystem,code);}
  private clearError(...subsystems:string[]){for(const subsystem of subsystems)this.errors.delete(subsystem);}
  /** A failure that used to be swallowed: it is named in the log, and it sets the subsystem's error unless it was only a held write lock. */
  private resetPending=false;
  /** Mark every projection receipt as owed to a rebuilt index. False (and still owed) when the database stayed locked. */
  private applyIndexReset():boolean{
    if(!this.resetPending)return true;
    try{
      database().prepare("UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending' AND lexical_status!='deleted'").run();
      this.resetPending=false;return true;
    }catch(error){this.swallowed("capture","helper","MEMORY_INDEX_RESET_FAILED",error);return false;}
  }
  private swallowed(log:WorkerSubsystem,subsystem:string,code:string,error:unknown){
    if(this.stopping)return;
    if(isDatabaseBusy(error)){logSwallowed(log,error,BUSY_RETRY_MS);return;}
    logSwallowed(log,error);this.setError(subsystem,code);
  }
  // A turn from its acceptance until the engine has its prompt holds the worker's main-thread steps back
  // (PROPOSAL-v2 10.1 item 7; index.ts and turn-hold.ts), for at most TURN_HOLD_MAX_MS.
  private turnHolds=0;
  private turnHoldSince=0;
  /** The helper failInit killed: its exit is already counted as the failed start. */
  private failedStart:ChildProcess|null=null;
  /** Held from the turn's acceptance until the engine has the prompt; call the returned function then (or when the turn is gone). */
  holdForTurn():()=>void{
    if(this.turnHolds++===0)this.turnHoldSince=performance.now();
    this.warmAfterIdleExit();
    let released=false;
    return ()=>{if(released)return;released=true;if(--this.turnHolds<=0){this.turnHolds=0;this.flushHeldCompletions();this.wake();}};
  }
  /** True from the moment a WebAssembly helper reports its model loaded and warmed (one small inference run) until that helper ends.
   * Before it, a search is answered from words alone once its cutoff passes. Always false for a native helper, which has no such step. */
  private modelReady=false;
  /** The helper running now is on WebAssembly (it said so when it initialised). */
  private wasmHelper=false;
  /** The warm-up request has been sent to this helper, or is owed to the next one when it initialises. */
  private warmSent=false;
  private warmOwed=false;
  get modelWarm():boolean{return this.modelReady;}
  /** Asks a WebAssembly helper to load its model and warm it, in the background: nothing waits for the answer ("model-ready"). */
  private requestWarm(child:ChildProcess){
    if(this.warmSent||this.modelReady||!this.wasmHelper||child.connected===false)return;
    this.warmSent=true;
    try{child.send({type:"warm"});}catch{this.warmSent=false;}
  }
  /** The owner is about to use the bot (the window took focus, the first key of a draft) or a turn is starting: have the helper's model
   * loaded and warm before recall asks. A helper that left for being idle (WebAssembly only) is started first; a live WebAssembly
   * helper whose model is not loaded yet is asked to load it. Does nothing for a native helper, or when the model is already warm. */
  warmForIntent(){
    if(this.stopping||!this.started)return;
    if(this.child){if(this.ready)this.requestWarm(this.child);else if(this.wasmHelper||this.idleExited)this.warmOwed=true;return;}
    if(!this.idleExited||Date.now()<this.respawnAt)return;
    this.warmOwed=true;
    try{this.spawn();}catch(error){logSwallowed("recall",error);}
  }
  private warmAfterIdleExit(){this.warmForIntent();}
  /** Sources whose capture was published while a turn held the worker: their derived work (extraction, consolidation) starts once the hold ends,
   * so the main thread does not begin it in the turn's setup window. The capture and its checkpoint are not delayed. */
  private heldCompletions:string[]=[];
  private flushHeldCompletions(){for(const id of this.heldCompletions.splice(0))this.completedSource(id);}
  private turnHeld(){return this.turnHolds>0&&performance.now()-this.turnHoldSince<TURN_HOLD_MAX_MS;}
  /** Stale requeues so far per job (id:source revision), since its last
   * publication or deferral (RED2K): a publication of the worker's result,
   * the stale deferral past the bound, or the worker's own deferral in
   * failWork (RED2L): each ends the lease cycle the count belongs to. In
   * memory: a restart resets the leases too, and an entry lives only between
   * a refused publication and the job's next settle. Bounded in size in case
   * a requeued job is cancelled by a newer source revision before it is
   * claimed again; the eviction is of the oldest entry, never the live job's
   * own (it is re-inserted as the newest on every requeue, RED2L). */
  private staleRequeues=new Map<string,number>();
  private consolidationAbort=new AbortController();
  /** Extractions that are RUNNING (admitted by the owner-first gate). An extraction still waiting for admission is in
   * `admissionWaiters`, not here: waiting is not work, and a steady stream of waiters must not keep the idle learning
   * lanes (consolidation, reveals, procedure review, evolution) from ever asking the gate (1.0.2 round-2 P2-A). */
  private consolidationTasks=new Set<Promise<void>>();
  private admissionWaiters=new Set<Promise<void>>();
  /** The idle learning pass that is running, if any (one at a time). */
  private idleTask:Promise<void>|null=null;
  /** When (performance.now) a due idle pass first found extractions running; past IDLE_FAIR_AFTER_MS it runs beside them. */
  private idleBlockedSince:number|null=null;
  private consolidationWake=false;
  /** Consolidation eligibility deadline (Date.now() ms): at most one scan per second, separate from the capture pacing deadline so capture wakes stay prompt. */
  private nextConsolidationPoll=0;
  /** A consolidation continuation is owed at nextConsolidationPoll (a run did work, or work arrived during it). */
  private consolidationDue=false;
  private maintenanceTimer: ReturnType<typeof setInterval> | null=null;
  private maintenanceTask: Promise<void> | null=null;
  private continuityTask: Promise<void> | null=null;
  private nextBacklogTrace=0;
  /** The one pacing deadline (performance.now() ms, monotonic: a wall-clock change cannot move it): no cycle of new work starts before it, whichever
   * entry point asks (a wake on arrival, a scheduled sweep, a worker message). Timeouts do not wait for it. */
  private nextEligibleWorkAt=0;
  private workCyclesSinceMaintenance=0;
  private options:{onMaintenance?:(startup:boolean,signal?:AbortSignal)=>Promise<unknown>;continuityEligible?:()=>boolean;onContinuity?:(signal:AbortSignal)=>Promise<unknown>;modelDirectory?:string;wasmIdleExitMs?:number;manifest?:ModelManifest;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>;onLineageWarm?:(yieldNow:()=>boolean)=>boolean;upgradeRunning?:()=>boolean};
  constructor(options:{onMaintenance?:(startup:boolean,signal?:AbortSignal)=>Promise<unknown>;continuityEligible?:()=>boolean;onContinuity?:(signal:AbortSignal)=>Promise<unknown>;modelDirectory?:string;wasmIdleExitMs?:number;manifest?:ModelManifest;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>;onLineageWarm?:(yieldNow:()=>boolean)=>boolean;upgradeRunning?:()=>boolean}={}){this.options=options;}
  get wakeCount(){return this.wakes;}
  /** While a writer hold is in force (the root-set VACUUM, an index build: database.ts holdWritersForIndexBuild) no background writer of this
   * controller starts on the serving thread (database.ts invariant 2): each deferred piece of work is resumed once the hold is released, by
   * ONE listener on the writer gate, never a poll. A resumed piece looks at the hold again and waits again if another began meanwhile. */
  private afterHold=new Set<()=>void>();
  private holdListening=false;
  private deferForHold(resume:()=>void){
    this.afterHold.add(resume);
    if(this.holdListening)return;
    this.holdListening=true;
    void awaitWriterGate().then(()=>{
      this.holdListening=false;
      const pending=[...this.afterHold];this.afterHold.clear();
      if(this.stopping)return;
      for(const run of pending){try{run();}catch(error){logSwallowed("maintenance",error);}}
    });
  }
  private readonly resumeWake=()=>{this.consolidationDue=true;this.wake();};
  private readonly resumeIndependent=()=>this.independentWork();
  private readonly resumeStatusScan=()=>this.scheduleStatusScan(0);
  private readonly resumeLineageWarm=()=>this.scheduleLineageWarm(0);
  /** Worker messages that arrived during a writer hold, in arrival order: dispatched once it is released (bounded: the in-flight messages of one helper). */
  private heldMessages:Array<{child:ChildProcess;message:unknown}>=[];

  /** What the helper last said about the age order of the word table (1.0.3 lane 2, worker.ts fillAgeIndex): "" when nothing is in the way. */
  private indexNote="";
  status() {
    return {running:this.child!==null,ready:this.ready,indexing:this.indexing,queryCount:this.queries.size,error:this.error,errors:Object.fromEntries(this.errors),indexNote:this.indexNote};
  }

  /** Notify the same derived-work hook after either capture publication path. */
  completedSource(jobId:string){
    if(this.stopping||!this.options.onCompletedSource)return;
    const signal=this.consolidationAbort.signal;
    // Extraction is an engine call: it waits for the owner's turn, typing and an overloaded computer (owner-first.ts), never past the bound.
    const run=()=>this.options.onCompletedSource!(jobId,signal);
    const finish=(set:Set<Promise<void>>,task:Promise<void>)=>{set.delete(task);this.wake();};
    if(ownerFirst.admit("memory-extract").admitted){
      const task:Promise<void>=new Promise<void>(resolve=>resolve(run().then(()=>undefined)))
        .then(()=>{this.clearError("consolidation");}).catch(error=>this.swallowed("learning","consolidation","MEMORY_CONSOLIDATION_FAILED",error))
        .finally(()=>finish(this.consolidationTasks,task));
      this.consolidationTasks.add(task);
      return;
    }
    // Waiting for the owner: tracked apart from running work. It moves into the running set only once admitted.
    const waiter:Promise<void>=ownerFirst.wait("memory-extract",signal).then(()=>{
      if(this.stopping)return;
      const task:Promise<void>=Promise.resolve().then(run)
        .then(()=>{this.clearError("consolidation");}).catch(error=>this.swallowed("learning","consolidation","MEMORY_CONSOLIDATION_FAILED",error))
        .finally(()=>finish(this.consolidationTasks,task));
      this.consolidationTasks.add(task);
    }).catch(error=>this.swallowed("learning","consolidation","MEMORY_CONSOLIDATION_FAILED",error))
      .finally(()=>{this.admissionWaiters.delete(waiter);});
    this.admissionWaiters.add(waiter);
  }

  /** Recovery is independent of mode, indexing, and both inference tasks. */
  private independentWork(startup=false) {
    // Runs from a timer: nothing in the sweep (a busy writer lock included) may throw out of it; the next sweep looks again.
    try{this.independentWorkOnce(startup);}
    catch(error){if(isDatabaseBusy(error))logSwallowed("maintenance",error,BUSY_RETRY_MS);else logSwallowed("maintenance",error);}
  }
  private independentWorkOnce(startup:boolean) {
    if(this.stopping)return;
    // A writer hold (a VACUUM, an index build) is in force: the counters, the maintenance and continuity passes wait for its release.
    if(writersHeldForIndexBuild()){this.deferForHold(this.resumeIndependent);return;}
    // A turn on its way to the engine comes first: the sweep comes back once it has gone out.
    if(this.turnHeld()){setTimeout(()=>this.independentWork(startup),100).unref();return;}
    // Retrieval counters reach the database here, once a minute, never on the recall path.
    try{ioBudget.withSource("memory-idle",()=>flushMemoryCounters());}catch(error){logSwallowed("maintenance",error);}
    this.scheduleStatusScan(startup?5_000:0);
    // Maintenance and continuity (PIP reflection) yield to the owner (owner-first.ts); a deferred pass comes back with the next sweep.
    if(this.options.onMaintenance&&!this.maintenanceTask&&(startup||ownerFirst.admit("memory-maintenance").admitted)){
      this.maintenanceTask=Promise.resolve().then(()=>this.options.onMaintenance!(startup,this.consolidationAbort.signal))
        .then(()=>{this.clearError("maintenance");}).catch(error=>this.swallowed("capture","maintenance","MEMORY_MAINTENANCE_FAILED",error))
        .finally(()=>{this.maintenanceTask=null;});
    }
    if(this.options.onContinuity&&!this.continuityTask&&(this.options.continuityEligible?.()??true)&&["capture","active"].includes(memoryState().mode)&&!ioBudget.shouldDefer("memory-idle")&&!this.upgradeYield()&&ownerFirst.admit("memory-continuity").admitted){
      // under its own source: every statement of the pass (the sliced pending check included) is named on a slow line and a stall
      this.continuityTask=Promise.resolve().then(()=>{if(!this.stopping)return ioBudget.withSource("memory-continuity",()=>this.options.onContinuity!(this.consolidationAbort.signal));})
        .then(()=>{this.clearError("continuity");}).catch(error=>this.swallowed("reflection","continuity","MEMORY_CONTINUITY_FAILED",error))
        .finally(()=>{this.continuityTask=null;});
    }
  }

  start() {
    if(this.started) return;
    this.started=true;
    this.stopping=false;
    if(this.consolidationAbort.signal.aborted)this.consolidationAbort=new AbortController();
    // Failed jobs whose cause says nothing about the conversation (the helper died, a timeout) get their attempts back, once.
    try{ioBudget.withSource("memory-worker",()=>{const n=redriveTransientFailedJobs();if(n)console.log(`[memory-worker] subsystem=capture redriven=${n}`);});}
    catch(error){logSwallowed("capture",error);}
    this.independentWork(true);
    this.maintenanceTimer=setInterval(()=>this.independentWork(),MEMORY_IDLE_SWEEP_MS);
    this.maintenanceTimer.unref();
    ioBudget.setOnMemoryWork(notifyMemoryWork);
    this.unsubscribe=onMemoryWork(()=>this.wake());
    try {
      if(hasClaimableMemoryJob()||this.pendingProjection())this.wake();
      else this.schedule(Math.min(MEMORY_IDLE_SWEEP_MS,nextMemoryJobDelay()??MEMORY_IDLE_SWEEP_MS));
    }catch{this.schedule(MEMORY_IDLE_SWEEP_MS);}
  }
  /** Arrivals coalesce into the next macrotask; owned work already has a continuation. */
  wake() {
    if(!this.started||this.stopping)return;
    if(this.ticking){this.wakeOwed=true;return;}
    if(this.work||this.indexing)return;
    this.requested=true;
    // An arrival owes the idle pass a look: during a run it continues after the drain gap; otherwise
    // it is due at the one-second consolidation deadline (at once if that has passed), never left for the idle sweep.
    if(this.consolidationTasks.size||this.idleTask)this.consolidationWake=true;
    else if(this.options.onIdleConsolidation)this.consolidationDue=true;
    this.schedule(Math.max(0,this.nextEligibleWorkAt-performance.now()));
  }
  private schedule(delay:number) {
    if(!this.started||this.stopping)return;
    const at=performance.now()+delay;
    if(this.timer&&this.scheduledAt<=at)return;
    if(this.timer)clearTimeout(this.timer);
    this.scheduledAt=at;
    this.timer=setTimeout(()=>{
      this.timer=null;this.scheduledAt=Infinity;
      const requested=this.requested;this.requested=false;
      this.wakes++;
      ioBudget.withSource("memory-worker",()=>this.tick(requested));
    },delay);
    this.timer.unref();
  }
  private pendingProjection() {
    return hasPendingProjection(database());
  }
  private tick(requested=false) {
    if(this.stopping) return;
    if(this.heldCompletions.length&&!this.turnHeld())this.flushHeldCompletions();
    // A turn on its way to the engine comes first: a held tick reads nothing at all and comes back when the hold
    // ends (its release wakes the worker) or at its cap. Work already handed to the helper keeps its own deadline.
    if(this.turnHeld()&&!this.work&&!this.indexing){
      if(requested)this.requested=true;
      // The starting turn's own prompt capture is never held, not even by this 3 s hold (owner-first.ts startingThreads).
      // A busy writer lock is "try again next tick" (250 ms), never a throw out of this timer callback.
      let delay=Math.max(50,TURN_HOLD_MAX_MS-(performance.now()-this.turnHoldSince));
      try{this.claimTurnCritical();}
      catch(error){
        if(!isDatabaseBusy(error)){logSwallowed("capture",error);this.setError("tick","MEMORY_WORKER_UNAVAILABLE");}
        else{logSwallowed("capture",error,BUSY_RETRY_MS);delay=Math.min(delay,BUSY_RETRY_MS);}
      }
      this.schedule(delay);
      return;
    }
    this.ticking=true;
    this.wakeOwed=false;
    const paced=performance.now()<this.nextEligibleWorkAt;
    const cycleStart=performance.now();
    const cycle={busy:0};
    let clean=true,busy=false,ownerRetryMs:number|null=null;
    try {
      // Timeouts are independent of the pacing deadline.
      if(this.indexing){if(Date.now()>this.indexDeadline){this.setError("index","MEMORY_INDEX_TIMEOUT");logSwallowed("index","MEMORY_INDEX_TIMEOUT");this.child?.kill("SIGKILL");}return;}
      if(this.work) {
        if(Date.now()>this.deadline) { this.failWork("MEMORY_WORKER_TIMEOUT");this.child?.kill("SIGKILL"); }
        return;
      }
      // Memory off: no consolidation is owed (the next wake or idle sweep looks again).
      if(!["capture","active"].includes(memoryState().mode)){this.consolidationDue=false;return;}
      // A notified tick that lands before the pacing deadline only moves to it: the arrival stays a
      // notification, so the I/O budget's deferral of unrequested polls does not strand it until the idle sweep.
      if(paced){if(requested)this.requested=true;return;}
      // A writer hold is in force: no claim, receipt write, maintenance or idle pass starts until it is released (one listener wakes the worker then).
      if(writersHeldForIndexBuild()){if(requested)this.requested=true;this.deferForHold(this.resumeWake);return;}
      // A turn between slot and send comes first: no claim, receipt write or consolidation starts until it has gone out.
      if(this.turnHeld()){if(requested)this.requested=true;
        // The starting turn's own prompt capture is never held, not even by this 3 s hold (owner-first.ts startingThreads).
        this.claimTurnCritical();return;}
      // Typing and a routine or engine start come first too (owner-first.ts; 1.0.2 bgwork): no claim, projection or idle
      // pass starts while they hold, never past the gate's bound. Running work and its deadlines are checked above.
      const ownerHold=ownerFirst.admit("memory-worker",{only:["owner-typing","work-starting"]});
      if(!ownerHold.admitted){
        if(requested)this.requested=true;ownerRetryMs=ownerHold.retryInMs;
        // Except what a starting turn itself depends on: its own thread's recent captures (its prompt's capture rolls
        // the thread checkpoint inside the dispatch window). Projection, idle passes and every other scope stay held.
        this.claimTurnCritical();
        return;
      }
      if(turnTraceEnabled()&&Date.now()>=this.nextBacklogTrace){
        this.nextBacklogTrace=Date.now()+5000;
        traceBacklog(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','deferred')").get()?.n??0));
      }
      if(this.options.onIdleConsolidation && !this.idleTask && Date.now()>=this.nextConsolidationPoll && !ioBudget.shouldDefer("memory-idle") && !this.idleHeld() && !this.idleUpgradeHeld() && this.idleTurn() && this.idleAdmitted()){
        this.nextConsolidationPoll=Date.now()+1000;
        this.consolidationWake=false;this.consolidationDue=false;this.idleBlockedSince=null;
        let worked=false;
        const task=Promise.resolve().then(()=>{
          if(this.turnHeld())return;
          if(this.stopping)return;
          // The pass's synchronous time is charged to the same pacing deadline as a cycle's.
          const started=performance.now();
          try{return ioBudget.withSource("memory-idle",()=>this.options.onIdleConsolidation!(this.consolidationAbort.signal));}
          // The cycle's own claim and this prefix are one measurement: their costs add before the pause is computed, not overlap.
          finally{this.holdTotal(cycleStart,cycle.busy+(performance.now()-started));}
        // A run that did work keeps the one-second deadline: a notification inside it waits, and the drain below continues once it passes.
        }).then(result=>{worked=result===true;this.clearError("consolidation");})
          .catch(error=>this.swallowed("learning","consolidation","MEMORY_CONSOLIDATION_FAILED",error))
          .finally(()=>{
            this.idleTask=null;
            // Arrivals during a run and a run that did work both continue after the drain gap.
            if(this.consolidationWake||worked){this.consolidationWake=false;this.consolidationDue=true;this.schedule(Math.max(MEMORY_DRAIN_GAP_MS,this.nextConsolidationPoll-Date.now(),this.nextEligibleWorkAt-performance.now()));}
          });
        this.idleTask=task;
      }
      if(!requested&&ioBudget.shouldDefer("memory-worker"))return;
      if(this.resetPending&&!this.applyIndexReset()){this.schedule(BUSY_RETRY_MS);return;}
      const projection=this.pendingProjection(),job=hasClaimableMemoryJob();
      // Nothing else to do: one bounded parking maintenance step (no helper is needed for it).
      if(!projection&&!job){this.maintain(false);return;}
      if(!this.child) { if(Date.now()>=this.respawnAt)this.spawn(); return; }
      if(!this.ready) { if(Date.now()>this.initDeadline)this.failInit("MEMORY_WORKER_INIT_TIMEOUT"); return; }
      const records=projection?pendingProjectionRecords(database(),16):[];
      if(records.length){
        this.indexing=true;this.indexDeadline=Date.now()+60000;
        this.indexRequestId=randomUUID();
        // What each record was projected as, so its acknowledgement can be fenced against what it is when the ack lands.
        this.indexSent=new Map(records.map(r=>[`${String(r.id)}\u0000${Number(r.version)}`,String(r.state)]));
        this.child.send({type:"index",requestId:this.indexRequestId,records:records.map(r=>({id:String(r.id),version:Number(r.version),scopeId:String(r.scopeId),text:r.state==="deleted"?"":String(r.text),deleted:r.state==="deleted",archived:r.state!=="active",...Number(r.rolled)===1?{rolled:true}:{},ageKey:r.ageKey===null||r.ageKey===undefined?null:Number(r.ageKey)}))});
        this.maintain(true);return;
      }
      const work=job?claimMemoryJob(this.owner):null;
      if(work) {this.work=work;this.deadline=Date.now()+60000;this.child.send(work);this.scheduleHeartbeat(this.child);}
      this.maintain(!!work);
    } catch(error) {
      clean=false;
      // A held write lock is "try again shortly": no error state, no attempt spent.
      if(isDatabaseBusy(error)){busy=true;logSwallowed("capture",error,BUSY_RETRY_MS);}
      else{logSwallowed("capture",error);this.setError("tick","MEMORY_WORKER_UNAVAILABLE");}
    }
    finally {
      this.ticking=false;
      // The tick finished without throwing: its own failure is over (a lock that has since cleared does not stay on screen).
      if(clean)this.clearError("tick");
      // This cycle's own synchronous time, counted once: claim, projection selection,
      // consolidation start and maintenance are all inside it.
      if(!paced){cycle.busy=performance.now()-cycleStart;this.holdFor(cycle.busy);}
      let delay=MEMORY_IDLE_SWEEP_MS;
      if(this.work||this.indexing)delay=Math.max(1,(this.work?this.deadline:this.indexDeadline)-Date.now()+1);
      else if(busy)delay=BUSY_RETRY_MS;
      else {
        try{delay=Math.min(delay,nextMemoryJobDelay()??delay);}catch{/* the fallback also covers a temporarily unavailable database */}
        if(paced)delay=Math.min(delay,Math.max(1,this.nextEligibleWorkAt-performance.now()));
        else if(parkMaintenancePending())delay=Math.min(delay,Math.max(PARK_STEP_MS,this.nextEligibleWorkAt-performance.now()));
        if(this.turnHeld())delay=Math.min(delay,Math.max(50,TURN_HOLD_MAX_MS-(performance.now()-this.turnHoldSince)));
        if(ownerRetryMs!==null)delay=Math.min(delay,Math.max(50,ownerRetryMs));
        // An earlier wake may have replaced the continuation timer: keep the owed consolidation on its deadline.
        // Once overdue, the continuation is only waiting on a deferral (the I/O budget, a run still in flight):
        // retry at the budget's next window, never sooner than PARK_STEP_MS, so the wait is not a tick storm.
        if(this.consolidationDue){
          const until=this.nextConsolidationPoll-Date.now();
          delay=Math.min(delay,until>0?until:Math.max(PARK_STEP_MS,ioBudget.deferredForMs("memory-idle")));
        }
      }
      this.schedule(delay);
      if(this.wakeOwed){this.wakeOwed=false;this.wake();}
    }
  }
  /** While the owner-first gate holds background work: claim only the newest recent capture of the threads whose turns are
   * starting (owner-first.ts startingThreads), the same recent-scopes claim a turn's own catch-up uses. Nothing to claim, no
   * helper ready yet, or no starting turn: nothing happens and the hold stands. Returns whether a job was sent. */
  private claimTurnCritical():boolean{
    const threads=ownerFirst.startingThreads();
    if(!threads.length||!this.child||!this.ready)return false;
    // The starting turn's own capture, claimed by its job id (a primary-key write: no scope search, no claim-index read, whatever
    // else is queued). A thread with no noted capture (memory off, an excluded thread, already claimed) has nothing to claim here.
    for(const thread of threads){
      const jobId=turnCaptureJobId(thread);
      if(!jobId)continue;
      // No lock wait: a busy file means "try at the next tick", never a 50 ms stall of the loop inside a held tick.
      let work:MemoryWork|null;
      try{work=claimMemoryJob(this.owner,Date.now(),undefined,{recentWithinMs:CATCH_UP_WINDOW_MS,busyMs:0,jobId});}
      catch(error){if(isDatabaseBusy(error))return false;throw error;}
      // Settled either way: claimed now, or not claimable (done, leased elsewhere, too old): the id is not asked for again.
      forgetTurnCaptureJob(thread,jobId);
      if(!work)continue;
      this.work=work;this.deadline=Date.now()+60000;this.child.send(work);this.scheduleHeartbeat(this.child);
      return true;
    }
    return false;
  }
  /** The idle learning lanes (consolidation, reveals, procedure review, evolution) are engine work: they yield to the
   * owner (owner-first.ts). A deferral keeps the pass owed and brings it back after the gate's jittered backoff. */
  /** Whether an idle learning pass may start now: when no extraction is running, or when extractions have kept it out
   * for IDLE_FAIR_AFTER_MS (arrivals that never leave a gap must not starve the other lanes; the pass is still gated). */
  private idleTurn(){
    if(!this.consolidationTasks.size){this.idleBlockedSince=null;return true;}
    const now=performance.now();
    this.idleBlockedSince??=now;
    if(now-this.idleBlockedSince<IDLE_FAIR_AFTER_MS){this.consolidationDue=true;return false;}
    return true;
  }
  /** A writer hold keeps the idle pass owed and brings it back when the hold is released. */
  private idleHeld(){
    if(!writersHeldForIndexBuild())return false;
    this.consolidationDue=true;this.deferForHold(this.resumeWake);
    return true;
  }
  private upgradeSince:number|null=null;
  /** Whether the idle lanes yield to the history upgrade now: while it runs, for at most UPGRADE_YIELD_MAX_MS from when they first found it. */
  private upgradeYield():boolean{
    let running=false;
    try{running=this.options.upgradeRunning?.()??false;}catch{running=false;}
    if(!running){this.upgradeSince=null;return false;}
    const now=performance.now();
    this.upgradeSince??=now;
    return now-this.upgradeSince<UPGRADE_YIELD_MAX_MS;
  }
  /** The upgrade keeps the idle pass owed and brings it back after UPGRADE_RECHECK_MS. */
  private idleUpgradeHeld(){
    if(!this.upgradeYield())return false;
    this.consolidationDue=true;this.nextConsolidationPoll=Date.now()+UPGRADE_RECHECK_MS;
    return true;
  }
  private idleAdmitted(){
    const admission=ownerFirst.admit("memory-idle");
    if(admission.admitted)return true;
    this.consolidationDue=true;
    this.nextConsolidationPoll=Date.now()+admission.retryInMs;
    return false;
  }
  private lineageWarmTimer:ReturnType<typeof setTimeout>|null=null;
  /** Asks for a slice of lineage warming soon (lineage-warm.ts): after a start, and when a turn reaches a thread that is not warm.
   * Idle-only like the status scan: it waits for the owner's turn, typing and load, and each slice is short. */
  wakeLineageWarm(delay=0){this.scheduleLineageWarm(delay);}
  private scheduleLineageWarm(delay:number){
    if(this.stopping||!this.started||this.lineageWarmTimer||!this.options.onLineageWarm)return;
    this.lineageWarmTimer=setTimeout(()=>{
      this.lineageWarmTimer=null;
      if(this.stopping)return;
      if(writersHeldForIndexBuild()){this.deferForHold(this.resumeLineageWarm);return;}
      if(this.turnHeld()||ioBudget.shouldDefer("memory-idle")){this.scheduleLineageWarm(500);return;}
      if(this.upgradeYield()){this.scheduleLineageWarm(UPGRADE_RECHECK_MS);return;}
      const admission=ownerFirst.admit("memory-lineage");
      if(!admission.admitted){this.scheduleLineageWarm(Math.max(500,admission.retryInMs));return;}
      let more=false;
      try{
        more=ioBudget.withSource("memory-idle",()=>{
          const started=performance.now();
          const result=this.options.onLineageWarm!(()=>this.turnHeld()||ioBudget.shouldDefer("memory-idle")||this.upgradeYield());
          this.holdFor(performance.now()-started);
          return result;
        });
      }catch(error){logSwallowed("maintenance",error);}
      if(more)this.scheduleLineageWarm(Math.max(50,this.nextEligibleWorkAt-performance.now()));
    },delay);
    this.lineageWarmTimer.unref();
  }
  private statusScanTimer:ReturnType<typeof setTimeout>|null=null;
  /** Health and retention figures are measured a slice at a time in the background, so opening Memory reads a stored value. */
  private scheduleStatusScan(delay:number){
    if(this.stopping||this.statusScanTimer)return;
    this.statusScanTimer=setTimeout(()=>{
      this.statusScanTimer=null;
      if(this.stopping)return;
      if(writersHeldForIndexBuild()){this.deferForHold(this.resumeStatusScan);return;}
      if(this.turnHeld()||ioBudget.shouldDefer("memory-idle")){this.scheduleStatusScan(500);return;}
      if(this.upgradeYield()){this.scheduleStatusScan(UPGRADE_RECHECK_MS);return;}
      // Idle-only (F22): the figures are for the Details line; they wait for the owner's turn, typing and load.
      const admission=ownerFirst.admit("memory-status");
      if(!admission.admitted){this.scheduleStatusScan(Math.max(500,admission.retryInMs));return;}
      let more=false;
      try{
        more=ioBudget.withSource("memory-idle",()=>{
          const started=performance.now();
          const a=stepHealthScan(10),b=stepRetentionScan(10);
          this.holdFor(performance.now()-started);
          return a||b;
        });
      }catch(error){logSwallowed("maintenance",error);}
      if(more)this.scheduleStatusScan(Math.max(50,this.nextEligibleWorkAt-performance.now()));
    },delay);
    this.statusScanTimer.unref();
  }
  /** The one place parking maintenance is decided, reached by every dispatch (projection batch,
   * capture job) and by an idle cycle: one bounded step when there was nothing else to do, and
   * on every 16th dispatch so a standing backlog of either kind cannot starve it. */
  private maintain(dispatched:boolean){
    if(dispatched)this.workCyclesSinceMaintenance++;
    if(writersHeldForIndexBuild()){this.deferForHold(this.resumeWake);return;}
    if((!dispatched||this.workCyclesSinceMaintenance>=16||claimSettleSweepPending())&&parkMaintenancePending()){
      this.workCyclesSinceMaintenance=0;
      parkMaintenanceStep(database());
    }
  }
  /** Push the pacing deadline out by the pause a cycle of `busyMs` earns (never earlier than it was). */
  private holdFor(busyMs:number){
    const gap=memoryTickGapMs(busyMs);
    if(gap)this.nextEligibleWorkAt=Math.max(this.nextEligibleWorkAt,performance.now()+gap);
  }
  /** The pause earned by `busyMs` of loop time counted from `startedAt` (a cycle's claim and its deferred idle prefix, summed). */
  private holdTotal(startedAt:number,busyMs:number){
    const gap=memoryTickGapMs(busyMs);
    if(gap)this.nextEligibleWorkAt=Math.max(this.nextEligibleWorkAt,startedAt+busyMs+gap);
  }
  /** Run `step` on the next turn of the event loop (not at all once the controller is stopped). */
  private later(step:()=>void,delayMs=0){
    const run=()=>{
      if(this.stopping)return;
      // While a turn is between slot and send the step waits (for at most TURN_HOLD_MAX_MS); the job stays leased and heartbeating.
      if(this.turnHeld()){setTimeout(run,100).unref();return;}
      // While a writer hold is in force the write waits for its release (never 50 ms busy attempts for the length of a VACUUM).
      if(writersHeldForIndexBuild()){this.deferForHold(run);return;}
      const started=performance.now();
      try{ioBudget.withSource("memory-worker",step);}
      catch(error){this.swallowed("capture","helper","MEMORY_WORKER_MESSAGE_FAILED",error);}
      finally{traceSlowStep("memory.worker-message.deferred",performance.now()-started);}
    };
    if(delayMs>0)setTimeout(run,delayMs).unref();else setImmediate(run);
  }
  /** The next tick after a worker message: this handler's own loop time (a cycle's claim and
   * selection were charged to that cycle) pushes the shared pacing deadline, and one wake-up is
   * asked for it (wakes coalesce into one timer); a cheap handler leaves no pause. */
  private scheduleTick(handlerStart:number){
    this.holdFor(performance.now()-handlerStart);
    this.wake();
  }
  private scheduleHeartbeat(child:ChildProcess) {
    if(this.heartbeat||!this.work||this.stopping)return;
    const due=performance.now()+10000;
    const beat=()=>{
      this.heartbeat=null;
      if(this.child!==child||!this.work||this.stopping)return;
      // A beat this late means the loop was stalled past the lease. The lease is fenced by generation, so it is
      // renewed all the same unless someone took the job over (A11); the log says how late, once a minute.
      // A turn on its way to the engine comes first (TURN_HOLD_MAX_MS at most, far inside the 30 s lease).
      if(this.turnHeld()){this.heartbeat=setTimeout(beat,100);this.heartbeat.unref();return;}
      const late=performance.now()-due;
      if(late>20_000)logSwallowed("capture","MEMORY_LEASE_BEAT_LATE",60_000);
      let alive=true;
      try{alive=ioBudget.withSource("memory-worker",()=>withBusyBudget(BACKGROUND_BUSY_MS,"heartbeat",()=>heartbeatMemoryJob(this.work!,this.owner)));}
      catch(error){
        // A held lock only delays the beat: the lease has 30 s and beats every 10.
        if(!isDatabaseBusy(error))throw error;
        logSwallowed("capture",error,10_000);
      }
      if(!alive)child.kill("SIGKILL");
      else this.scheduleHeartbeat(child);
    };
    this.heartbeat=setTimeout(beat,10000);
    this.heartbeat.unref();
  }
  private failInit(reason:string){
    this.failedStart=this.child;this.backOffStart(reason);
    this.child?.kill("SIGKILL");
  }
  /** A helper that never became ready: the status shows why, and the next start waits (30 s, doubling to 30 min). */
  private backOffStart(reason:string){
    this.setError("helper",reason);logSwallowed("capture",reason);this.initFailures++;
    this.respawnAt=Date.now()+Math.min(30*60_000,MEMORY_IDLE_SWEEP_MS*2**(this.initFailures-1));
  }
  private clearHeartbeat(){if(this.heartbeat)clearTimeout(this.heartbeat);this.heartbeat=null;}
  /** The helper's writes as an io-budget source, from the counts it reports (noteWorkerBlocks). Earlier builds read the index file
   * and its log from here, which missed every write cycle that ended between two samples: a merge, then a truncation, leaves the
   * log at zero and the file the same size (1.0.3 rehearsal 2, 240 MB/min unseen). */
  private registerWorkerBytes(){
    if(!this.unregisterBytes)this.unregisterBytes=ioBudget.registerByteSource("memory-worker",()=>this.workerBytes);
  }
  /** A helper's cumulative fsWrite count: its growth since the last report is charged. Each helper counts from zero, so its first
   * report is charged whole: the baseline is the reporting helper's own (a new one starts at zero), and a count that fell is a new
   * process's too. */
  private noteWorkerBlocks(child:unknown,blocks:unknown){
    if(typeof blocks!=="number"||!Number.isFinite(blocks)||blocks<0)return;
    if(child!==this.workerBlocksChild||blocks<this.workerBlocks){this.workerBlocksChild=child;this.workerBlocks=0;}
    this.workerBytes+=(blocks-this.workerBlocks)*BLOCK_BYTES;this.workerBlocks=blocks;
  }
  private workerBlocksChild:unknown=null;
  private spawn() {
    this.registerWorkerBytes();
    this.initDeadline=Date.now()+MEMORY_WORKER_INIT_MS;this.idleExited=false;this.modelReady=false;this.wasmHelper=false;this.warmSent=false;
    // The helper may rebuild or rename a damaged index while it starts: the main process holds no handle until it says it is ready.
    blockMemoryIndexReader();
    const child=fork(SPAWNED_PROXIES.memoryWorker,[],{execArgv:["--experimental-strip-types"],stdio:["ignore","ignore","pipe","ipc"],
      env:{ELECTRON_RUN_AS_NODE:"1",
        // The helper loads the server's config, which reads the home directory as it loads: it gets the server's own data
        // directory and home, or an account with no home entry cannot start a helper at all (RED2C).
        MURAGE_DATA_DIR:DATA_DIR,...(process.env.HOME?{HOME:process.env.HOME}:{}),...(process.env.USERPROFILE?{USERPROFILE:process.env.USERPROFILE}:{}),...(process.env.MURAGE_MEMORY_BACKEND==="wasm"?{MURAGE_MEMORY_BACKEND:"wasm"}:{}),...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})}});
    this.child=child;
    // What the helper prints when it swallows a failure reaches the log (rate limited), not the void.
    const forward=makeStderrForwarder();
    child.stderr?.setEncoding("utf8");child.stderr?.on("data",chunk=>forward(String(chunk)));
    child.on("message", (message: unknown)=>this.receiveWorkerMessage(child,message));
    child.on("error",error=>{this.setError("helper","MEMORY_WORKER_START_FAILED");logSwallowed("capture",error);});
    child.on("exit",()=>{if(this.child===child){
      // An exit before "ready" that nothing asked for (failInit already counted its own kill) is a failed start, never a silent respawn.
      if(!this.ready&&!this.stopping&&this.idleExit!==child&&this.failedStart!==child)this.backOffStart("MEMORY_WORKER_START_FAILED");
      this.failedStart=null;
      unblockMemoryIndexReader();setWalCheckpointRequester(null);setScrubRewriteFinisher(null);this.settleCheckpoints(false);
      // A helper that goes away because Murage is quitting says nothing about the job it held: it reschedules without spending an attempt.
      this.modelReady=false;const planned=this.idleExit===child;this.idleExit=null;if(planned&&!this.stopping)this.idleExited=true;
      this.clearHeartbeat();this.failWork(this.stopping?"MEMORY_WORKER_STOPPED":"MEMORY_WORKER_EXITED");this.child=null;this.ready=false;this.indexing=false;
      // A planned idle exit loses nothing: a search that arrived meanwhile waits for the next helper.
      if(planned&&!this.stopping&&this.queries.size)this.spawn();
      else{for(const pending of this.queries.values()){pending.cleanup();pending.reject(new Error("MEMORY_WORKER_EXITED"));}this.queries.clear();}
      let delay=MEMORY_IDLE_SWEEP_MS;
      if(!this.stopping)try{delay=Math.min(delay,nextMemoryJobDelay()??delay);}catch{/* the lease remains recoverable by the fallback */}
      // A record that arrived while the helper was leaving was seen by a tick that found no ready helper and did nothing: look again now.
      if(planned&&!this.stopping)delay=0;
      this.schedule(delay);
    }});
  }
  /** A message from the helper. While a writer hold is in force, a message whose handling writes is queued (in order) and dispatched once
   * the hold is released; the read-only ones (search results, checkpoint answers, the hello) are not held, so a search never waits on a VACUUM. */
  private receiveWorkerMessage(child:ChildProcess,message:unknown){
    if(this.stopping||this.child!==child)return;
    const type=(message as {type?:unknown}|null)?.type;
    // (a write-bearing message also queues behind earlier queued ones, so their order is kept)
    if(!HOLD_EXEMPT_MESSAGES.has(String(type))&&(this.heldMessages.length||writersHeldForIndexBuild())){
      this.heldMessages.push({child,message});
      if(this.heldMessages.length===1)this.deferForHold(this.drainHeldMessages);
      return;
    }
    this.dispatchWorkerMessage(child,message);
  }
  private readonly drainHeldMessages=()=>{
    if(writersHeldForIndexBuild()){this.deferForHold(this.drainHeldMessages);return;}
    const queued=this.heldMessages.splice(0);
    for(const {child,message} of queued)if(!this.stopping&&this.child===child)this.dispatchWorkerMessage(child,message);
  };
  private dispatchWorkerMessage(child:ChildProcess,message:unknown){
    ioBudget.withSource("memory-worker",()=>{
      if(this.stopping||this.child!==child)return;
      const handlerStart=performance.now();
      // A message handler that cannot finish (the database stayed locked past its wait) is logged and retried by the next tick; it must never
      // reach the process as an uncaught exception, which ended a whole server.
      try{this.onWorkerMessage(child,message);}
      catch(error){this.swallowed("capture","helper","MEMORY_WORKER_MESSAGE_FAILED",error);this.schedule(BUSY_RETRY_MS);}
      finally{traceSlowStep("memory.worker-message",performance.now()-handlerStart);}
    });
  }
  private onWorkerMessage(child:ChildProcess,message:unknown){
    const handlerStart=performance.now();
    {
      if(!message||typeof message!=="object")return;
      const event=message as {type?:string;result?:unknown;requestId?:string;reset?:boolean;records?:Array<{id:string;version:number;deleted:boolean}>;embeddingStatus?:string;fsWriteBlocks?:unknown};
      // the helper's own write count rides on its index acknowledgements and its maintenance reports (worker.ts reportIo)
      if("fsWriteBlocks" in event)this.noteWorkerBlocks(child,event.fsWriteBlocks);
      if(event.type==="io")return;
      if(event.type==="ready"){
        const manifestFile=join(SERVER_ROOT,"memory-model-manifest.json");
        const manifest=this.options.manifest??JSON.parse(readFileSync(existsSync(manifestFile)?manifestFile:join(SERVER_ROOT,"..","shared","memory-model-manifest.json"),"utf8"));
        const init=(modelDirectory:string,extra:{fallbackModelDirectory?:string;strictModelRoot?:boolean}={})=>{if(child.connected===false)return;child.send({type:"init",authorityPath:join(DATA_DIR,"messages.db"),indexPath:join(DATA_DIR,"memory-index.db"),modelDirectory,manifest,...this.options.wasmIdleExitMs!==undefined?{wasmIdleExitMs:this.options.wasmIdleExitMs}:{},...extra});};
        // The app's own verified copy wins; otherwise the user's downloaded copy path (never modified here).
        if(this.options.modelDirectory||!bundledModelDirectory()){init(this.options.modelDirectory??join(DATA_DIR,"memory-model"));return;}
        void resolveMemoryModelDirectory(manifest,{dataDir:DATA_DIR}).then(resolved=>init(resolved.directory,resolved.source==="bundled"?{fallbackModelDirectory:resolved.fallback,strictModelRoot:true}:{}),()=>init(join(DATA_DIR,"memory-model")));
        return;
      }
      if(event.type==="model-ready"){if(this.child===child)this.modelReady=true;return;}
      if(event.type==="initialised"){
        this.wasmHelper=(event as {wasm?:boolean}).wasm===true;
        // The index was rebuilt: every record is owed to it again. If the database is locked just now the owing is kept and applied by the next tick
        // (before any indexing starts), not lost and not thrown into the message handler.
        if(event.reset)this.resetPending=true;
        // A turn on its way to the engine comes first: the next tick applies the owing (resetPending) instead.
        if(!this.turnHeld())this.applyIndexReset();
        this.ready=true;this.initFailures=0;this.clearError("helper");unblockMemoryIndexReader();setWalCheckpointRequester(()=>this.requestCheckpoint());setScrubRewriteFinisher(()=>this.requestFinishRewrite());
        for(const [requestId,pending] of this.queries)if(!pending.sent){pending.sent=true;try{sendSearch(m=>child.send(m),requestId,pending.input);}catch{this.queries.delete(requestId);pending.cleanup();pending.reject(new Error("MEMORY_QUERY_REFUSED"));logSwallowed("recall","MEMORY_QUERY_REFUSED");}}
        if(this.warmOwed){this.warmOwed=false;this.requestWarm(child);}
        this.scheduleTick(handlerStart);return;
      }
      if(event.type==="idle-exit-request"){
        // Granted only when nothing is owed to or by this helper; from then on the controller treats it as gone (searches wait, nothing is sent).
        if(this.child===child&&this.ready&&!this.queries.size&&!this.indexing&&!this.work&&!this.checkpoints.size){
          this.idleExit=child;this.ready=false;this.modelReady=false;this.initDeadline=Date.now()+MEMORY_WORKER_INIT_MS;
          try{child.send({type:"idle-exit"});}catch{child.kill("SIGKILL");}
        }
        return;
      }
      if(event.type==="checkpoint-result"&&event.requestId){const done=this.checkpoints.get(event.requestId);if(done){this.checkpoints.delete(event.requestId);done((event as {ok?:boolean}).ok===true);}return;}
      if(event.type==="query-result"&&event.requestId){const pending=this.queries.get(event.requestId);if(pending){this.queries.delete(event.requestId);pending.cleanup();pending.resolve(event.result as MemorySearchResult);}return;}
      if(event.type==="index-result"){
        if(event.requestId!==this.indexRequestId)return;
        // The receipt writes (a synchronous transaction, one fsync) run on the next turn of the event loop, not
        // inside the IPC handler: `indexing` stays set until they are done, so no tick starts other work meanwhile.
        // They are written in slices of at most WORKER_SLICE_MS of row work, each its own transaction (every row's update is
        // fenced on its own), with a turn of the event loop between slices, so a large batch never holds the loop.
        const records=event.records??[],embeddingStatus=event.embeddingStatus,requestId=event.requestId,sent=this.indexSent;
        let next=0;
        const writeReceipts=()=>{
          if(this.indexRequestId!==requestId)return;
          const started=performance.now(),from=next;
          try{
            transaction(()=>{while(next<records.length){
              const row=records[next++]!;
              if(row.deleted) database().prepare(`UPDATE memory_projection_receipts SET lexical_status='deleted',embedding_status='deleted' WHERE record_id=? AND record_version=? AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND (r.state='deleted' OR ${rolledCheckpointSql("r")}))`).run(row.id,row.version);
              // Fenced: the receipt says "indexed" only while the record still projects as what was sent. A record that
              // changed while the batch was in flight (a checkpoint rolled over: active -> pending-archive) keeps its
              // pending receipt and is projected again; a late ack never overwrites it (msearch review round 2).
              else{
                const was=sent.get(`${row.id}\u0000${row.version}`);
                if(was!==undefined)database().prepare(`UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status=? WHERE record_id=? AND record_version=? AND lexical_status!='delete-pending' AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND r.state=? AND r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND NOT ${rolledCheckpointSql("r")})`).run(embeddingStatus==="indexed"?"indexed":"unavailable",row.id,row.version,was);
              }
              if(performance.now()-started>=WORKER_SLICE_MS)break;
            }});
            this.clearError("index");
          }catch(error){
            next=from; // the slice rolled back
            // The write lock is held elsewhere: the receipts are written a moment later, the job is not failed and nothing is shown.
            if(isDatabaseBusy(error)){logSwallowed("index",error,BUSY_RETRY_MS);this.later(writeReceipts,BUSY_RETRY_MS);return;}
            this.swallowed("index","index","MEMORY_INDEX_FAILED",error);
            next=records.length;
          }
          if(next<records.length){this.later(writeReceipts);return;}
          this.indexing=false;this.indexRequestId=null;this.indexSent=new Map();this.scheduleTick(started);
        };
        this.later(writeReceipts);
        return;
      }
      // The helper's word-table age fill (worker.ts fillAgeIndex, 1.0.3 lane 2): a note for the status line, and the cutover. Neither is a work result.
      if(event.type==="index-note"){const note=(event as {note?:unknown}).note;this.indexNote=typeof note==="string"?note.slice(0,120):"";return;}
      if(event.type==="index-aged"){this.indexNote="";console.log("[memory] search index is in age order");return;}
      if(event.type==="index-error"){this.setError("index","MEMORY_INDEX_FAILED");logSwallowed("index","MEMORY_INDEX_FAILED",MEMORY_IDLE_SWEEP_MS);this.indexing=false;this.indexRequestId=null;this.schedule(MEMORY_IDLE_SWEEP_MS);return;}
      // Work is only sent once the helper is ready, so an error before then is its initialisation failing.
      // A refused search names its request: that search fails and is logged as recall. It is not a capture result.
      // A refusal for a search that already ended (timed out, cancelled) is logged and dropped; it is never a result of the capture work.
      if(event.type==="error"&&typeof event.requestId==="string"){
        const pending=this.queries.get(event.requestId);
        logSwallowed("recall",String((event as {reason?:unknown}).reason??"INVALID_MEMORY_SEARCH"));
        if(pending){this.queries.delete(event.requestId);pending.cleanup();pending.reject(new Error("MEMORY_QUERY_REFUSED"));}
        return;
      }
      if(event.type==="error"&&!this.ready){this.failInit("MEMORY_WORKER_START_FAILED");return;}
      if(!this.work)return;
      const work=this.work;
      // Publication and the checkpoint refresh run after the handler returns, in the same order and each in its own
      // transaction as before. The job stays held (`this.work`, its heartbeat running) until they finish, so no other work is claimed meanwhile.
      const deliver=()=>{
        if(this.work!==work)return;  // the work timed out or the worker exited in between
        this.clearHeartbeat();
        const started=performance.now();
        try {
          const result=resultSchema.parse(event.result);
          try { heldStep("memory.publish",()=>publishMemoryWork(work,this.owner,result)); }
          catch(error) {
            // The authority moved while the worker held the job (a bot, room or
            // task changed the policy revision; a deletion; a newer source
            // revision). The result is discarded, not the job: it is requeued
            // now and runs again under the current authority on the next tick.
            // Not a worker failure, so no attempt is spent and no error is
            // reported for it.
            if(!isStaleMemoryPublication(error))throw error;
            this.settleStale(error);this.work=null;this.scheduleTick(started);return;
          }
          this.clearError("capture","tick");
          this.staleRequeues.delete(this.staleKey(work));
          if(result.status==="complete") {
            // Capture is already durable. A failed derived checkpoint must not
            // recast that committed source job as a failed capture.
            const refresh=(id:string,attempt:number)=>{
              try {
                const outcome=refreshMemoryCheckpoint(id);this.clearError("checkpoint");
                // evidence still being checked: the roll waits for the pending window to drain (a revoke's marker), a few short tries
                if(outcome.status==="deferred"&&"reason" in outcome&&outcome.reason==="evidence-checking"&&attempt<CHECKPOINT_CHECK_RETRIES)this.later(()=>refresh(id,attempt+1),CHECKPOINT_CHECK_RETRY_MS);
              }
              catch(error) { this.swallowed("capture","checkpoint","MEMORY_CHECKPOINT_FAILED",error); }
            };
            refresh(work.id,0);
            if(this.turnHeld())this.heldCompletions.push(work.id);else this.completedSource(work.id);
          }
        } catch(error) {
          // The write lock is held elsewhere: publish a moment later. The lease is kept alive; no attempt is spent.
          if(isDatabaseBusy(error)){logSwallowed("capture",error,BUSY_RETRY_MS);this.scheduleHeartbeat(child);this.later(deliver,BUSY_RETRY_MS);return;}
          logSwallowed("capture",error);this.failWork("MEMORY_RESULT_REJECTED");
        }
        this.work=null;
        this.scheduleTick(started);
      };
      // Publication and the checkpoint refresh run after the handler returns, in the same order and each in its own
      // transaction as before. The job stays held (`this.work`, its heartbeat running) until they finish, so no other work is claimed meanwhile.
      this.later(deliver);
    }
  }
  private failWork(reason: string) {
    if(!this.work)return;
    this.clearHeartbeat();
    // Quitting is not a failure of the work.
    if(reason!=="MEMORY_WORKER_STOPPED")this.setError("capture",reason);
    try {
      const failing=this.work;
      withBusyBudget(BACKGROUND_BUSY_MS,"fail-work",()=>publishMemoryWork(failing,this.owner,{id:failing.id,leaseGeneration:failing.leaseGeneration,status:"deferred",nextCursor:failing.cursor,chunks:[],reason}));
      // The deferral ends this lease cycle as a publication does: the next
      // claim starts its stale count afresh (RED2L).
      this.staleRequeues.delete(this.staleKey(this.work));
    }
    catch(error) {
      // Superseded work is deliberately not acknowledged as a deferral, but
      // the job must not sit leased with nobody working it: release the
      // holder's own lease so the next claim picks it up at once.
      if(isStaleMemoryPublication(error))this.settleStale(error,reason);
      // A held write lock: the lease runs out by itself and the job is claimed again with its attempts untouched.
      else logSwallowed("capture",error);
    }
    this.work=null;
  }
  private staleKey(work: MemoryWork) { return `${work.id}:${work.revision}`; }
  /** A publication refused as stale: requeue the holder's own live lease with
   * no attempt spent, up to STALE_MEMORY_REQUEUE_LIMIT times per job; past
   * that the job is deferred with one attempt spent (the reason of the
   * failure being settled, or MEMORY_STALE_REQUEUE_LIMIT for a refused
   * result), so the attempt cap ends a job the authority never stands still
   * for, and the row and the log say why (RED2K). */
  private settleStale(error: unknown, failReason?: string) {
    if(!this.work)return;
    const stale=error instanceof Error?error.message:String(error);
    const key=this.staleKey(this.work);
    const count=(this.staleRequeues.get(key)??0)+1;
    if(count<=STALE_MEMORY_REQUEUE_LIMIT){
      let requeued=false;
      try { requeued=requeueStaleMemoryWork(this.work,this.owner); } catch { /* the database is unavailable; the lease expires on its own */ }
      if(requeued){
        // Re-insert as the newest entry: Map.set on an existing key keeps its
        // insertion position, and the bound below evicts the oldest, which
        // used to be this live job's own counter once 256 cancelled entries
        // were left behind (RED2L).
        this.staleRequeues.delete(key);
        this.staleRequeues.set(key,count);
        if(this.staleRequeues.size>256)this.staleRequeues.delete(this.staleRequeues.keys().next().value!);
      } else this.staleRequeues.delete(key);
      console.warn(`[memory] worker result for job ${this.work.id} was ${stale} (the authority moved while the job was leased); ${requeued?`requeued for the next claim (stale requeue ${count} of ${STALE_MEMORY_REQUEUE_LIMIT})`:"lease no longer held, nothing to requeue"}`);
      return;
    }
    this.staleRequeues.delete(key);
    const reason=failReason??"MEMORY_STALE_REQUEUE_LIMIT";
    this.setError("capture",reason);
    let deferred=false;
    try { deferred=deferStaleMemoryWork(this.work,this.owner,reason); } catch { /* the database is unavailable; the lease expires on its own */ }
    console.warn(`[memory] worker result for job ${this.work.id} was ${stale} after ${STALE_MEMORY_REQUEUE_LIMIT} stale requeues (the authority kept moving while the job was leased); ${deferred?`deferred with an attempt spent (${reason})`:"lease no longer held, nothing to defer"}`);
  }
  async stop() {
    this.stopping=true;this.started=false;if(this.timer)clearTimeout(this.timer);this.timer=null;this.scheduledAt=Infinity;
    this.requested=false;this.consolidationWake=false;
    if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);this.maintenanceTimer=null;
    this.clearHeartbeat();
    this.unsubscribe?.();this.unsubscribe=null;
    for(const pending of this.queries.values()){pending.cleanup();pending.reject(new Error("MEMORY_WORKER_NOT_READY"));}this.queries.clear();
    this.consolidationAbort.abort();
    await Promise.allSettled([...this.consolidationTasks,...this.admissionWaiters,this.idleTask,this.maintenanceTask,this.continuityTask]);
    const child=this.child;
    if(child)await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error("MEMORY_WORKER_STOP_TIMEOUT")),5000);
      child.once("exit",()=>{clearTimeout(timeout);resolve();});
      child.disconnect();
    });
    ioBudget.sampleByteSource("memory-worker");this.unregisterBytes?.();this.unregisterBytes=null;
    if(this.statusScanTimer)clearTimeout(this.statusScanTimer);this.statusScanTimer=null;
    if(this.lineageWarmTimer)clearTimeout(this.lineageWarmTimer);this.lineageWarmTimer=null;
    try{flushMemoryCounters(Date.now(),true);}catch{/* counters are advisory */}
    setWalCheckpointRequester(null);setScrubRewriteFinisher(null);this.settleCheckpoints(false);
    unblockMemoryIndexReader();closeMemoryIndexReader();
  }
  /** Asks the helper to end the number scrub's rewrite of the index (MemoryIndex.finishRewrite); true when it acknowledges that it did. */
  requestFinishRewrite():Promise<boolean>{return this.requestCheckpoint(true);}
  /** Asks the helper (which owns the index writer) to truncate the write-ahead log; true when it acknowledges that it did. */
  requestCheckpoint(finishRewrite=false):Promise<boolean>{
    const child=this.child;
    if(!child||!this.ready||this.stopping)return Promise.resolve(false);
    const requestId=randomUUID();
    return new Promise<boolean>(resolve=>{
      // the whole-index merge of a finished rewrite takes longer than a checkpoint
      const timer=setTimeout(()=>{if(this.checkpoints.delete(requestId))resolve(false);},finishRewrite?FINISH_REWRITE_ACK_MS:CHECKPOINT_ACK_MS);
      timer.unref?.();
      this.checkpoints.set(requestId,ok=>{clearTimeout(timer);resolve(ok);});
      try{child.send({type:"checkpoint",requestId,...finishRewrite?{finishRewrite:true}:{}});}catch{this.checkpoints.delete(requestId);clearTimeout(timer);resolve(false);}
    });
  }
  private settleCheckpoints(ok:boolean){for(const done of this.checkpoints.values())done(ok);this.checkpoints.clear();}
  search(input:MemorySearchInput,signal:AbortSignal):Promise<MemorySearchResult>{
    if(this.stopping||this.queries.size>=64)return Promise.reject(new Error("MEMORY_WORKER_NOT_READY"));
    if(signal.aborted)return Promise.reject(new Error("MEMORY_QUERY_CANCELLED"));
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const abort=()=>{const pending=this.queries.get(requestId);this.queries.delete(requestId);pending?.cleanup();if(pending?.sent)this.child?.send({type:"cancel",requestId});reject(new Error("MEMORY_QUERY_DEADLINE"));};
      signal.addEventListener("abort",abort,{once:true});
      const pending={input,sent:false,resolve,reject,cleanup:()=>signal.removeEventListener("abort",abort)};
      this.queries.set(requestId,pending);
      try{
        if(!this.child){if(Date.now()<this.respawnAt)throw new Error("MEMORY_WORKER_START_BACKOFF");this.spawn();}
        if(this.ready){pending.sent=true;sendSearch(m=>this.child!.send(m),requestId,input);}
      }catch{this.queries.delete(requestId);pending.cleanup();this.setError("helper","MEMORY_WORKER_START_FAILED");logSwallowed("recall","MEMORY_WORKER_START_FAILED");reject(new Error("MEMORY_WORKER_START_FAILED"));}
    });
  }
}
