import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync,existsSync } from "node:fs";
import { join } from "node:path";
import { SPAWNED_PROXIES,SERVER_ROOT } from "../proxy-paths.ts";
import { DATA_DIR } from "../config.ts";
import { database,transaction } from "../database.ts";
import { fileGrowthReader, ioBudget, walFrameReader } from "../io-budget.ts";
import { claimMemoryJob, deferStaleMemoryWork, hasClaimableMemoryJob, heartbeatMemoryJob, isStaleMemoryPublication, nextMemoryJobDelay, notifyMemoryWork, onMemoryWork, publishMemoryWork, requeueStaleMemoryWork, STALE_MEMORY_REQUEUE_LIMIT } from "./jobs.ts";
import { memoryState } from "./repository.ts";
import { resultSchema, type MemoryWork,type MemorySearchInput } from "./worker-protocol.ts";
import type { IndexHit } from "./index.ts";
import { hasPendingProjection, pendingProjectionRecords } from "./projection.ts";
import { parkMaintenancePending, parkMaintenanceStep } from "./park.ts";
import { memoryTickGapMs, traceBacklog, traceSlowStep } from "./claim-trace.ts";
import { turnTraceEnabled } from "../turn-trace.ts";

export const MEMORY_IDLE_SWEEP_MS=30_000;
/** Queued consolidation drains at most once a second, as before. */
export const MEMORY_DRAIN_GAP_MS=1_000;
/** A helper that has not initialised by then is killed and respawned with backoff. */
export const MEMORY_WORKER_INIT_MS=120_000;
/** While parking maintenance is still pending, an idle controller comes back this soon for its next bounded step. */
const PARK_STEP_MS=250;

export class MemoryWorkerController {
  private child: ChildProcess | null=null;
  private work: MemoryWork | null=null;
  private owner=randomUUID();
  private timer: ReturnType<typeof setTimeout> | null=null;
  private heartbeat: ReturnType<typeof setTimeout> | null=null;
  private scheduledAt=Infinity;
  private started=false;
  private ticking=false;
  private requested=false;
  private wakes=0;
  private unsubscribe:(()=>void)|null=null;
  private unregisterBytes:(()=>void)|null=null;
  private deadline=0;
  private ready=false;
  private initDeadline=0;
  private initFailures=0;
  private respawnAt=0;
  private stopping=false;
  private indexing=false;
  private indexDeadline=0;
  private indexRequestId:string|null=null;
  private queries=new Map<string,{input:MemorySearchInput;sent:boolean;resolve:(value:{hits:IndexHit[];vectorRows:number;degradedReason?:string})=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
  error: string | null=null;
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
  private consolidationTasks=new Set<Promise<void>>();
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
  private options:{onMaintenance?:(startup:boolean)=>Promise<unknown>;continuityEligible?:()=>boolean;onContinuity?:(signal:AbortSignal)=>Promise<unknown>;modelDirectory?:string;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>};
  constructor(options:{onMaintenance?:(startup:boolean)=>Promise<unknown>;continuityEligible?:()=>boolean;onContinuity?:(signal:AbortSignal)=>Promise<unknown>;modelDirectory?:string;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>}={}){this.options=options;}
  get wakeCount(){return this.wakes;}

  status() {
    return {running:this.child!==null,ready:this.ready,indexing:this.indexing,queryCount:this.queries.size,error:this.error};
  }

  /** Notify the same derived-work hook after either capture publication path. */
  completedSource(jobId:string){
    if(this.stopping||!this.options.onCompletedSource)return;
    const task=this.options.onCompletedSource(jobId,this.consolidationAbort.signal)
      .then(()=>{}).catch(()=>{if(!this.stopping)this.error="MEMORY_CONSOLIDATION_FAILED";})
      .finally(()=>{this.consolidationTasks.delete(task);this.wake();});
    this.consolidationTasks.add(task);
  }

  /** Recovery is independent of mode, indexing, and both inference tasks. */
  private independentWork(startup=false) {
    if(this.stopping)return;
    if(this.options.onMaintenance&&!this.maintenanceTask){
      this.maintenanceTask=Promise.resolve().then(()=>this.options.onMaintenance!(startup))
        .then(()=>{}).catch(()=>{if(!this.stopping)this.error="MEMORY_MAINTENANCE_FAILED";})
        .finally(()=>{this.maintenanceTask=null;});
    }
    if(this.options.onContinuity&&!this.continuityTask&&(this.options.continuityEligible?.()??true)&&["capture","active"].includes(memoryState().mode)&&!ioBudget.shouldDefer("memory-idle")){
      this.continuityTask=Promise.resolve().then(()=>{if(!this.stopping)return this.options.onContinuity!(this.consolidationAbort.signal);})
        .then(()=>{}).catch(()=>{if(!this.stopping)this.error="MEMORY_CONTINUITY_FAILED";})
        .finally(()=>{this.continuityTask=null;});
    }
  }

  start() {
    if(this.started) return;
    this.started=true;
    this.stopping=false;
    if(this.consolidationAbort.signal.aborted)this.consolidationAbort=new AbortController();
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
    if(!this.started||this.stopping||this.work||this.indexing||this.ticking)return;
    this.requested=true;
    // An arrival owes the idle pass a look: during a run it continues after the drain gap; otherwise
    // it is due at the one-second consolidation deadline (at once if that has passed), never left for the idle sweep.
    if(this.consolidationTasks.size)this.consolidationWake=true;
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
    this.ticking=true;
    const paced=performance.now()<this.nextEligibleWorkAt;
    const cycleStart=performance.now();
    const cycle={busy:0};
    try {
      // Timeouts are independent of the pacing deadline.
      if(this.indexing){if(Date.now()>this.indexDeadline){this.error="MEMORY_INDEX_TIMEOUT";this.child?.kill("SIGKILL");}return;}
      if(this.work) {
        if(Date.now()>this.deadline) { this.failWork("MEMORY_WORKER_TIMEOUT");this.child?.kill("SIGKILL"); }
        return;
      }
      // Memory off: no consolidation is owed (the next wake or idle sweep looks again).
      if(!["capture","active"].includes(memoryState().mode)){this.consolidationDue=false;return;}
      // A notified tick that lands before the pacing deadline only moves to it: the arrival stays a
      // notification, so the I/O budget's deferral of unrequested polls does not strand it until the idle sweep.
      if(paced){if(requested)this.requested=true;return;}
      if(turnTraceEnabled()&&Date.now()>=this.nextBacklogTrace){
        this.nextBacklogTrace=Date.now()+5000;
        traceBacklog(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','deferred')").get()?.n??0));
      }
      if(this.options.onIdleConsolidation && !this.consolidationTasks.size && Date.now()>=this.nextConsolidationPoll && !ioBudget.shouldDefer("memory-idle")){
        this.nextConsolidationPoll=Date.now()+1000;
        this.consolidationWake=false;this.consolidationDue=false;
        let worked=false;
        const task=Promise.resolve().then(()=>{
          if(this.stopping)return;
          // The pass's synchronous time is charged to the same pacing deadline as a cycle's.
          const started=performance.now();
          try{return ioBudget.withSource("memory-idle",()=>this.options.onIdleConsolidation!(this.consolidationAbort.signal));}
          // The cycle's own claim and this prefix are one measurement: their costs add before the pause is computed, not overlap.
          finally{this.holdTotal(cycleStart,cycle.busy+(performance.now()-started));}
        // A run that did work keeps the one-second deadline: a notification inside it waits, and the drain below continues once it passes.
        }).then(result=>{worked=result===true;})
          .catch(()=>{if(!this.stopping)this.error="MEMORY_CONSOLIDATION_FAILED";})
          .finally(()=>{
            this.consolidationTasks.delete(task);
            // Arrivals during a run and a run that did work both continue after the drain gap.
            if(this.consolidationWake||worked){this.consolidationWake=false;this.consolidationDue=true;this.schedule(Math.max(MEMORY_DRAIN_GAP_MS,this.nextConsolidationPoll-Date.now(),this.nextEligibleWorkAt-performance.now()));}
          });
        this.consolidationTasks.add(task);
      }
      if(!requested&&ioBudget.shouldDefer("memory-worker"))return;
      const projection=this.pendingProjection(),job=hasClaimableMemoryJob();
      // Nothing else to do: one bounded parking maintenance step (no helper is needed for it).
      if(!projection&&!job){this.maintain(false);return;}
      if(!this.child) { if(Date.now()>=this.respawnAt)this.spawn(); return; }
      if(!this.ready) { if(Date.now()>this.initDeadline)this.failInit("MEMORY_WORKER_INIT_TIMEOUT"); return; }
      const records=projection?pendingProjectionRecords(database(),16):[];
      if(records.length){
        this.indexing=true;this.indexDeadline=Date.now()+60000;
        this.indexRequestId=randomUUID();
        this.child.send({type:"index",requestId:this.indexRequestId,records:records.map(r=>({id:String(r.id),version:Number(r.version),scopeId:String(r.scopeId),text:r.state==="deleted"?"":String(r.text),deleted:r.state==="deleted",archived:r.state!=="active"}))});
        this.maintain(true);return;
      }
      const work=job?claimMemoryJob(this.owner):null;
      if(work) {this.work=work;this.deadline=Date.now()+60000;this.child.send(work);this.scheduleHeartbeat(this.child);}
      this.maintain(!!work);
    } catch {this.error="MEMORY_WORKER_UNAVAILABLE";}
    finally {
      this.ticking=false;
      // This cycle's own synchronous time, counted once: claim, projection selection,
      // consolidation start and maintenance are all inside it.
      if(!paced){cycle.busy=performance.now()-cycleStart;this.holdFor(cycle.busy);}
      let delay=MEMORY_IDLE_SWEEP_MS;
      if(this.work||this.indexing)delay=Math.max(1,(this.work?this.deadline:this.indexDeadline)-Date.now()+1);
      else {
        try{delay=Math.min(delay,nextMemoryJobDelay()??delay);}catch{/* the fallback also covers a temporarily unavailable database */}
        if(paced)delay=Math.min(delay,Math.max(1,this.nextEligibleWorkAt-performance.now()));
        else if(parkMaintenancePending())delay=Math.min(delay,Math.max(PARK_STEP_MS,this.nextEligibleWorkAt-performance.now()));
        // An earlier wake may have replaced the continuation timer: keep the owed consolidation on its deadline.
        // Once overdue, the continuation is only waiting on a deferral (the I/O budget, a run still in flight):
        // retry at the budget's next window, never sooner than PARK_STEP_MS, so the wait is not a tick storm.
        if(this.consolidationDue){
          const until=this.nextConsolidationPoll-Date.now();
          delay=Math.min(delay,until>0?until:Math.max(PARK_STEP_MS,ioBudget.deferredForMs("memory-idle")));
        }
      }
      this.schedule(delay);
    }
  }
  /** The one place parking maintenance is decided, reached by every dispatch (projection batch,
   * capture job) and by an idle cycle: one bounded step when there was nothing else to do, and
   * on every 16th dispatch so a standing backlog of either kind cannot starve it. */
  private maintain(dispatched:boolean){
    if(dispatched)this.workCyclesSinceMaintenance++;
    if((!dispatched||this.workCyclesSinceMaintenance>=16)&&parkMaintenancePending()){
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
  private later(step:()=>void){
    setImmediate(()=>{
      if(this.stopping)return;
      const started=performance.now();
      try{ioBudget.withSource("memory-worker",step);}finally{traceSlowStep("memory.worker-message.deferred",performance.now()-started);}
    });
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
    this.heartbeat=setTimeout(()=>{
      this.heartbeat=null;
      if(this.child!==child||!this.work||this.stopping)return;
      if(!ioBudget.withSource("memory-worker",()=>heartbeatMemoryJob(this.work!,this.owner)))child.kill("SIGKILL");
      else this.scheduleHeartbeat(child);
    },10000);
    this.heartbeat.unref();
  }
  private failInit(reason:string){
    this.error=reason;this.initFailures++;
    this.respawnAt=Date.now()+Math.min(30*60_000,MEMORY_IDLE_SWEEP_MS*2**(this.initFailures-1));
    this.child?.kill("SIGKILL");
  }
  private clearHeartbeat(){if(this.heartbeat)clearTimeout(this.heartbeat);this.heartbeat=null;}
  private spawn() {
    if(!this.unregisterBytes){const index=join(DATA_DIR,"memory-index.db"),file=fileGrowthReader([index]),wal=walFrameReader(index);this.unregisterBytes=ioBudget.registerByteSource("memory-worker",()=>file()+wal());}
    this.initDeadline=Date.now()+MEMORY_WORKER_INIT_MS;
    const child=fork(SPAWNED_PROXIES.memoryWorker,[],{execArgv:["--experimental-strip-types"],stdio:["ignore","ignore","ignore","ipc"],
      env:{ELECTRON_RUN_AS_NODE:"1",...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})}});
    this.child=child;
    child.on("message", (message: unknown)=>ioBudget.withSource("memory-worker",()=>{
      if(this.stopping||this.child!==child)return;
      const handlerStart=performance.now();
      try{this.onWorkerMessage(child,message);}finally{traceSlowStep("memory.worker-message",performance.now()-handlerStart);}
    }));
    child.on("error",()=>{this.error="MEMORY_WORKER_START_FAILED";});
    child.on("exit",()=>{if(this.child===child){
      this.clearHeartbeat();this.failWork("MEMORY_WORKER_EXITED");this.child=null;this.ready=false;this.indexing=false;
      for(const pending of this.queries.values()){pending.cleanup();pending.reject(new Error("MEMORY_WORKER_EXITED"));}this.queries.clear();
      let delay=MEMORY_IDLE_SWEEP_MS;
      if(!this.stopping)try{delay=Math.min(delay,nextMemoryJobDelay()??delay);}catch{/* the lease remains recoverable by the fallback */}
      this.schedule(delay);
    }});
  }
  private onWorkerMessage(child:ChildProcess,message:unknown){
    const handlerStart=performance.now();
    {
      if(!message||typeof message!=="object")return;
      const event=message as {type?:string;result?:unknown;requestId?:string;reset?:boolean;records?:Array<{id:string;version:number;deleted:boolean}>;embeddingStatus?:string};
      if(event.type==="ready"){
        const manifest=join(SERVER_ROOT,"memory-model-manifest.json");
        child.send({type:"init",authorityPath:join(DATA_DIR,"messages.db"),indexPath:join(DATA_DIR,"memory-index.db"),modelDirectory:this.options.modelDirectory??join(DATA_DIR,"memory-model"),
          manifest:JSON.parse(readFileSync(existsSync(manifest)?manifest:join(SERVER_ROOT,"..","shared","memory-model-manifest.json"),"utf8"))});return;
      }
      if(event.type==="initialised"){
        if(event.reset)database().prepare("UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending' AND lexical_status!='deleted'").run();
        this.ready=true;this.initFailures=0;
        for(const [requestId,pending] of this.queries)if(!pending.sent){pending.sent=true;child.send({type:"query",requestId,input:pending.input});}
        this.scheduleTick(handlerStart);return;
      }
      if(event.type==="query-result"&&event.requestId){const pending=this.queries.get(event.requestId);if(pending){this.queries.delete(event.requestId);pending.cleanup();pending.resolve(event.result as {hits:IndexHit[];vectorRows:number;degradedReason?:string});}return;}
      if(event.type==="index-result"){
        if(event.requestId!==this.indexRequestId)return;
        // The receipt writes (a synchronous transaction, one fsync) run on the next turn of the event loop, not
        // inside the IPC handler: `indexing` stays set until they are done, so no tick starts other work meanwhile.
        const records=event.records??[],embeddingStatus=event.embeddingStatus,requestId=event.requestId;
        this.later(()=>{
          if(this.indexRequestId!==requestId)return;
          const started=performance.now();
          try{
            transaction(()=>{for(const row of records){
              if(row.deleted) database().prepare("UPDATE memory_projection_receipts SET lexical_status='deleted',embedding_status='deleted' WHERE record_id=? AND record_version=? AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND r.state='deleted')").run(row.id,row.version);
              else database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status=? WHERE record_id=? AND record_version=? AND lexical_status!='delete-pending' AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND r.state!='deleted')").run(embeddingStatus==="indexed"?"indexed":"unavailable",row.id,row.version);
            }});
          }catch{this.error="MEMORY_INDEX_FAILED";}
          this.indexing=false;this.indexRequestId=null;this.scheduleTick(started);
        });
        return;
      }
      if(event.type==="index-error"){this.error="MEMORY_INDEX_FAILED";this.indexing=false;this.indexRequestId=null;this.schedule(MEMORY_IDLE_SWEEP_MS);return;}
      // Work is only sent once the helper is ready, so an error before then is its initialisation failing.
      if(event.type==="error"&&!this.ready){this.failInit("MEMORY_WORKER_START_FAILED");return;}
      if(!this.work)return;
      const work=this.work;
      // Publication and the checkpoint refresh run after the handler returns, in the same order and each in its own
      // transaction as before. The job stays held (`this.work`, its heartbeat running) until they finish, so no other work is claimed meanwhile.
      this.later(()=>{
        if(this.work!==work)return;  // the work timed out or the worker exited in between
        this.clearHeartbeat();
        const started=performance.now();
        try {
          const result=resultSchema.parse(event.result);
          try { publishMemoryWork(work,this.owner,result); }
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
          this.error=null;
          this.staleRequeues.delete(this.staleKey(work));
          if(result.status==="complete") {
            // Capture is already durable. A failed derived checkpoint must not
            // recast that committed source job as a failed capture.
            try { refreshMemoryCheckpoint(work.id); }
            catch { this.error="MEMORY_CHECKPOINT_FAILED"; }
            this.completedSource(work.id);
          }
        } catch {this.failWork("MEMORY_RESULT_REJECTED");}
        this.work=null;
        this.scheduleTick(started);
      });
    }
  }
  private failWork(reason: string) {
    if(!this.work)return;
    this.clearHeartbeat();
    this.error=reason;
    try {
      publishMemoryWork(this.work,this.owner,{id:this.work.id,leaseGeneration:this.work.leaseGeneration,status:"deferred",nextCursor:this.work.cursor,chunks:[],reason});
      // The deferral ends this lease cycle as a publication does: the next
      // claim starts its stale count afresh (RED2L).
      this.staleRequeues.delete(this.staleKey(this.work));
    }
    catch(error) {
      // Superseded work is deliberately not acknowledged as a deferral, but
      // the job must not sit leased with nobody working it: release the
      // holder's own lease so the next claim picks it up at once.
      if(isStaleMemoryPublication(error))this.settleStale(error,reason);
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
    this.error=reason;
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
    await Promise.allSettled([...this.consolidationTasks,this.maintenanceTask,this.continuityTask]);
    const child=this.child;
    if(child)await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error("MEMORY_WORKER_STOP_TIMEOUT")),5000);
      child.once("exit",()=>{clearTimeout(timeout);resolve();});
      child.disconnect();
    });
    ioBudget.sampleByteSource("memory-worker");this.unregisterBytes?.();this.unregisterBytes=null;
  }
  search(input:MemorySearchInput,signal:AbortSignal):Promise<{hits:IndexHit[];vectorRows:number;degradedReason?:string}>{
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
        if(this.ready){pending.sent=true;this.child!.send({type:"query",requestId,input});}
      }catch{this.queries.delete(requestId);pending.cleanup();this.error="MEMORY_WORKER_START_FAILED";reject(new Error("MEMORY_WORKER_START_FAILED"));}
    });
  }
}
