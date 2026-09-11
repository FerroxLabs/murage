import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync,existsSync } from "node:fs";
import { join } from "node:path";
import { SPAWNED_PROXIES,SERVER_ROOT } from "../proxy-paths.ts";
import { DATA_DIR } from "../config.ts";
import { database,transaction } from "../database.ts";
import { claimMemoryJob, deferStaleMemoryWork, heartbeatMemoryJob, isStaleMemoryPublication, publishMemoryWork, requeueStaleMemoryWork, STALE_MEMORY_REQUEUE_LIMIT } from "./jobs.ts";
import { memoryState } from "./repository.ts";
import { resultSchema, type MemoryWork,type MemorySearchInput } from "./worker-protocol.ts";
import type { IndexHit } from "./index.ts";

export class MemoryWorkerController {
  private child: ChildProcess | null=null;
  private work: MemoryWork | null=null;
  private owner=randomUUID();
  private timer: ReturnType<typeof setInterval> | null=null;
  private deadline=0;
  private ready=false;
  private stopping=false;
  private indexing=false;
  private indexDeadline=0;
  private indexRequestId:string|null=null;
  private queries=new Map<string,{resolve:(value:{hits:IndexHit[];vectorRows:number;degradedReason?:string})=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
  error: string | null=null;
  /** Stale requeues so far per job (id:source revision), since its last
   * publication or deferral (RED2K). In memory: a restart resets the leases
   * too, and an entry lives only between a refused publication and the
   * job's next settle. Bounded in size in case a requeued job is cancelled by
   * a newer source revision before it is claimed again. */
  private staleRequeues=new Map<string,number>();
  private consolidationAbort=new AbortController();
  private consolidationTasks=new Set<Promise<void>>();
  private nextConsolidationPoll=0;
  private options:{modelDirectory?:string;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>};
  constructor(options:{modelDirectory?:string;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>}={}){this.options=options;}

  status() {
    return {running:this.child!==null,ready:this.ready,indexing:this.indexing,queryCount:this.queries.size,error:this.error};
  }

  start() {
    if(this.timer) return;
    this.stopping=false;
    if(this.consolidationAbort.signal.aborted)this.consolidationAbort=new AbortController();
    this.timer=setInterval(()=>this.tick(),250);this.timer.unref();
  }
  private tick() {
    if(this.stopping) return;
    try {
      if(!["capture","active"].includes(memoryState().mode)) return;
      if(this.options.onIdleConsolidation && !this.consolidationTasks.size && Date.now()>=this.nextConsolidationPoll){
        this.nextConsolidationPoll=Date.now()+1000;
        const task=this.options.onIdleConsolidation(this.consolidationAbort.signal).then(()=>{})
          .catch(()=>{if(!this.stopping)this.error="MEMORY_CONSOLIDATION_FAILED";})
          .finally(()=>this.consolidationTasks.delete(task));
        this.consolidationTasks.add(task);
      }

      if(this.indexing){if(Date.now()>this.indexDeadline){this.error="MEMORY_INDEX_TIMEOUT";this.child?.kill("SIGKILL");}return;}
      if(this.work) {
        if(Date.now()>this.deadline) { this.failWork("MEMORY_WORKER_TIMEOUT");this.child?.kill("SIGKILL"); }
        return;
      }
      if(!this.child) { this.spawn(); return; }
      if(!this.ready) return;
      const records=database().prepare(`SELECT r.id,r.version,r.scope_id AS scopeId,r.text,r.state FROM memory_projection_receipts p
        JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version
        WHERE p.lexical_status IN ('pending','pending-archive','delete-pending')
        ORDER BY p.lexical_status,p.record_id,p.record_version LIMIT 16`).all();
      if(records.length){
        this.indexing=true;this.indexDeadline=Date.now()+60000;
        this.indexRequestId=randomUUID();
        this.child.send({type:"index",requestId:this.indexRequestId,records:records.map(r=>({id:String(r.id),version:Number(r.version),scopeId:String(r.scopeId),text:r.state==="deleted"?"":String(r.text),deleted:r.state==="deleted",archived:r.state!=="active"}))});return;
      }
      const work=claimMemoryJob(this.owner);
      if(work) {this.work=work;this.deadline=Date.now()+60000;this.child.send(work);}
    } catch {this.error="MEMORY_WORKER_UNAVAILABLE";}
  }
  private spawn() {
    const child=fork(SPAWNED_PROXIES.memoryWorker,[],{execArgv:["--experimental-strip-types"],stdio:["ignore","ignore","ignore","ipc"],
      env:{ELECTRON_RUN_AS_NODE:"1",...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})}});
    this.child=child;
    const heartbeat=setInterval(()=>{if(this.work&&!heartbeatMemoryJob(this.work,this.owner)) child.kill("SIGKILL");},10000);heartbeat.unref();
    child.on("message", (message: unknown)=>{
      if(!message||typeof message!=="object")return;
      const event=message as {type?:string;result?:unknown;requestId?:string;reset?:boolean;records?:Array<{id:string;version:number;deleted:boolean}>;embeddingStatus?:string};
      if(event.type==="ready"){
        const manifest=join(SERVER_ROOT,"memory-model-manifest.json");
        child.send({type:"init",authorityPath:join(DATA_DIR,"messages.db"),indexPath:join(DATA_DIR,"memory-index.db"),modelDirectory:this.options.modelDirectory??join(DATA_DIR,"memory-model"),
          manifest:JSON.parse(readFileSync(existsSync(manifest)?manifest:join(SERVER_ROOT,"..","shared","memory-model-manifest.json"),"utf8"))});return;
      }
      if(event.type==="initialised"){
        if(event.reset)database().prepare("UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending' AND lexical_status!='deleted'").run();
        this.ready=true;setImmediate(()=>this.tick());return;
      }
      if(event.type==="query-result"&&event.requestId){const pending=this.queries.get(event.requestId);if(pending){this.queries.delete(event.requestId);pending.cleanup();pending.resolve(event.result as {hits:IndexHit[];vectorRows:number;degradedReason?:string});}return;}
      if(event.type==="index-result"){
        if(event.requestId!==this.indexRequestId)return;
        transaction(()=>{for(const row of event.records??[]){
          if(row.deleted) database().prepare("UPDATE memory_projection_receipts SET lexical_status='deleted',embedding_status='deleted' WHERE record_id=? AND record_version=? AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND r.state='deleted')").run(row.id,row.version);
          else database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status=? WHERE record_id=? AND record_version=? AND lexical_status!='delete-pending' AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND r.state!='deleted')").run(event.embeddingStatus==="indexed"?"indexed":"unavailable",row.id,row.version);
        }});
        this.indexing=false;this.indexRequestId=null;setImmediate(()=>this.tick());return;
      }
      if(event.type==="index-error"){this.error="MEMORY_INDEX_FAILED";this.indexing=false;return;}
      if(!this.work)return;
      try {
        const result=resultSchema.parse(event.result);
        try { publishMemoryWork(this.work,this.owner,result); }
        catch(error) {
          // The authority moved while the worker held the job (a bot, room or
          // task changed the policy revision; a deletion; a newer source
          // revision). The result is discarded, not the job: it is requeued
          // now and runs again under the current authority on the next tick.
          // Not a worker failure, so no attempt is spent and no error is
          // reported for it.
          if(!isStaleMemoryPublication(error))throw error;
          this.settleStale(error);this.work=null;setImmediate(()=>this.tick());return;
        }
        this.error=null;
        this.staleRequeues.delete(this.staleKey(this.work));
        if(result.status==="complete") {
          // Capture is already durable. A failed derived checkpoint must not
          // recast that committed source job as a failed capture.
          try { refreshMemoryCheckpoint(this.work.id); }
          catch { this.error="MEMORY_CHECKPOINT_FAILED"; }
          if(this.options.onCompletedSource){
            const task=this.options.onCompletedSource(this.work.id,this.consolidationAbort.signal)
              .then(()=>{}).catch(()=>{if(!this.stopping)this.error="MEMORY_CONSOLIDATION_FAILED";})
              .finally(()=>this.consolidationTasks.delete(task));
            this.consolidationTasks.add(task);
          }
        }
      } catch {this.failWork("MEMORY_RESULT_REJECTED");}
      this.work=null;
      setImmediate(()=>this.tick());
    });
    child.on("error",()=>{this.error="MEMORY_WORKER_START_FAILED";});
    child.on("exit",()=>{clearInterval(heartbeat);if(this.child===child){this.failWork("MEMORY_WORKER_EXITED");this.child=null;this.ready=false;this.indexing=false;for(const pending of this.queries.values()){pending.cleanup();pending.reject(new Error("MEMORY_WORKER_EXITED"));}this.queries.clear();}});
  }
  private failWork(reason: string) {
    if(!this.work)return;
    this.error=reason;
    try {publishMemoryWork(this.work,this.owner,{id:this.work.id,leaseGeneration:this.work.leaseGeneration,status:"deferred",nextCursor:this.work.cursor,chunks:[],reason});}
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
    this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;
    this.consolidationAbort.abort();
    await Promise.allSettled([...this.consolidationTasks]);
    const child=this.child;if(!child)return;
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error("MEMORY_WORKER_STOP_TIMEOUT")),5000);
      child.once("exit",()=>{clearTimeout(timeout);resolve();});
      child.disconnect();
    });
  }
  search(input:MemorySearchInput,signal:AbortSignal):Promise<{hits:IndexHit[];vectorRows:number;degradedReason?:string}>{
    if(!this.child||!this.ready||this.queries.size>=64)return Promise.reject(new Error("MEMORY_WORKER_NOT_READY"));
    if(signal.aborted)return Promise.reject(new Error("MEMORY_QUERY_CANCELLED"));
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.queries.delete(requestId);this.child?.send({type:"cancel",requestId});reject(new Error("MEMORY_QUERY_DEADLINE"));};
      signal.addEventListener("abort",abort,{once:true});
      this.queries.set(requestId,{resolve,reject,cleanup:()=>signal.removeEventListener("abort",abort)});
      this.child!.send({type:"query",requestId,input});
    });
  }
}
