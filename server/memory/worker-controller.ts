// Owed-capture idle admission producer and controller consumer owner: warm-capture.
// Grant producer owner: scperf-p1. Helper and WM grant consumers owner: scperf-p1.
import { checkpointCeiling, commitCeiling, ioMeterPageSize, ioMeterWallTime } from "../io-meter.ts";
import { indexStepFrames, META_ENVELOPE_FRAMES } from "./index-wal.ts";
import { isBgDeferred, type BgDeferred } from "../bg-admission.ts";
import type { AdmissionTicket } from "../io-budget.ts";
import { waitForMemoryInferenceIdle } from "./extract.ts";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import { bundledModelDirectory, resolveMemoryModelDirectory } from "./model-location.ts";
import { setScrubRewriteFinisher } from "./scrub-pass.ts";
import "./model-adoption.ts";
import { checkpointDebtCount } from "./checkpoint-debt.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync,existsSync,unlinkSync } from "node:fs";
import { join } from "node:path";
import { SPAWNED_PROXIES,SERVER_ROOT } from "../proxy-paths.ts";
import { DATA_DIR } from "../config.ts";
import { BACKGROUND_BUSY_MS, awaitWriterGate, database,isDatabaseBusy,transaction,withBusyBudget,writersHeldForIndexBuild } from "../database.ts";
import { BLOCK_BYTES, IO_BUDGET_BYTES_PER_MINUTE, ioBudget, withStatementReuse } from "../io-budget.ts";
import { claimMemoryJob, deferStaleMemoryWork, hasClaimableCaptureJob, hasClaimableMemoryJob, heartbeatMemoryJob, isStaleMemoryPublication, nextMemoryJobDelay, notifyMemoryWork, onMemoryWork, publishMemoryWork, redriveTransientFailedJobs, releaseDeadProcessLeases, requeueStaleMemoryWork, STALE_MEMORY_REQUEUE_LIMIT } from "./jobs.ts";
import { memoryState } from "./repository.ts";
import { sendSearch } from "./scope-set.ts";
import { resultSchema, type MemoryWork,type MemorySearchInput,type MemorySearchResult } from "./worker-protocol.ts";
import { hasPendingProjection, pendingProjectionRecords, rolledCheckpointSql } from "./projection.ts";
import type { ModelManifest } from "./embeddings.ts";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import { claimSettleSweepPending, parkMaintenancePending, parkMaintenanceStep } from "./park.ts";
import { memoryTickGapMs, traceBacklog, traceIndexSlice, traceSlowStep } from "./claim-trace.ts";
import { turnTraceEnabled } from "../turn-trace.ts";
import { logSwallowed, makeStderrForwarder, type WorkerSubsystem } from "./worker-log.ts";
import { flushMemoryCounters, stepHealthScan } from "./health.ts";
import { stepRetentionScan } from "./retention.ts";
import { blockMemoryIndexReader, closeMemoryIndexReader, drainMemoryIndexReaders, indexScrubOwed, memoryIndexScansActive, RESET_DRAIN_MAX_MS, setIndexWriterDrain, setWalCheckpointRequester, unblockMemoryIndexReader } from "./index-reader.ts";
import { ownerFirst } from "../owner-first.ts";
import { scrubWalAfterDelete } from "../wal-maintenance.ts";
import { forgetTurnCaptureJob, turnCaptureJobId } from "./turn-capture-jobs.ts";
import { CATCH_UP_WINDOW_MS } from "./recent.ts";
import { OVERRUN_K_UNKNOWN } from "./memw-steps.ts";
import { heldStep } from "../observe.ts";
import { removeIndexQuarantines, probeIndexFile, type IndexProbe } from "./index-quarantine.ts";
import * as indexQuarantine from "./index-quarantine.ts";
import { ensureIndexOverrun, INDEX_OVERRUN_TABLE } from "./schema.ts";
import type { DatabaseSync } from "node:sqlite";
import { ChildIoReceipts } from "../io-child-receipts.ts";
import { markIoMeterUnknown } from "../io-meter.ts";
import { coverReceiptChanges } from "./recall-view-schema.ts";

/** MEMW 1.13: the index's durable stop and the reset that answers it, one row in the main database (schema.ts index_overrun). A stop the
 * helper reports is seen once per (file_id, seq); the k-th stop within INDEX_RESET_WINDOW_MS waits indexResetWaitMs(k) (the first at once,
 * then 1 h doubling to 24 h), fixed when the stop is seen; then the reset is requested, and resent at each helper start until a helper says
 * reset_done = R, which owes every receipt to the new index and completes the row in one transaction. No freeze: nothing clears `resets`
 * but the 7-day rule. While a reset waits or runs no index batch is formed. */
const HOUR_MS=3_600_000;
export const INDEX_RESET_WINDOW_MS=7*24*HOUR_MS;
export const INDEX_RESET_MAX_WAIT_MS=24*HOUR_MS;
/** A batch refused at the merge floor is asked again at the next helper start, and hourly. */
export const INDEX_MERGE_FLOOR_REASK_MS=HOUR_MS;
export function indexResetWaitMs(k:number):number{return k<=1?0:Math.min(2**(k-2)*HOUR_MS,INDEX_RESET_MAX_WAIT_MS);}
export interface IndexStopReport{fileId:string;seq:number;kind:string;reason?:string}
export interface IndexResetRequest{resetId:number;resets:number;kind:string}
const overrunReady=new WeakSet<DatabaseSync>();
function overrunRow():Record<string,unknown>|null{
  const db=database();
  if(!overrunReady.has(db)){ensureIndexOverrun(db);overrunReady.add(db);}
  return (db.prepare(`SELECT resets,reset_id,state,due_at,kind,stop_file_id,stop_seq,last_stop_at FROM ${INDEX_OVERRUN_TABLE} WHERE id=1`).get() as Record<string,unknown>|undefined)??null;
}
function randomResetId():number{const [hi,lo]=crypto.getRandomValues(new Uint32Array(2));return ((hi!&0x1fffff)*2**32+lo!)||1;}
/** (1') A stop the helper reported. False when it is the stop already seen (it never counts twice). */
export function noteIndexStop(stop:IndexStopReport,now=Date.now()):boolean{
  return transaction(db=>{
    const row=overrunRow();
    if(row&&String(row.stop_file_id)===String(stop.fileId)&&Number(row.stop_seq)===stop.seq)return false;
    const recent=row!==null&&row.last_stop_at!==null&&now-Number(row.last_stop_at)<=INDEX_RESET_WINDOW_MS;
    // A missing row is an unknown history (a fresh table after a downgrade dropped it and an upgrade came back, or a fresh install: the two
    // look alike), never "no overruns": it fails closed at OVERRUN_K_UNKNOWN, the k of the largest multiplier (WP2's rule for a missing or bad
    // overrun_k). That first reset is still at once: an unknown history is no evidence of thrash, and the rebuild is already conservative.
    const k=row===null?OVERRUN_K_UNKNOWN:recent?Number(row.resets)+1:1;
    db.prepare(`INSERT INTO ${INDEX_OVERRUN_TABLE}(id,resets,reset_id,state,due_at,kind,stop_file_id,stop_seq,last_stop_at) VALUES(1,?,?,'waiting',?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET resets=excluded.resets,reset_id=excluded.reset_id,state='waiting',due_at=excluded.due_at,kind=excluded.kind,stop_file_id=excluded.stop_file_id,stop_seq=excluded.stop_seq,last_stop_at=excluded.last_stop_at`)
      .run(k,randomResetId(),now+(row===null?0:indexResetWaitMs(k)),stop.kind,stop.fileId,stop.seq,now);
    return true;
  });
}
/** MEMW r3.2.8 H.1 6: the helper's index would not open twice in a row and the file reads damaged or unsafe: ask for a reset of kind "open",
 * due now, in one transaction. A row already 'requested' is kept byte for byte (never a new reset id, due time or kind). `resets` is left as
 * it was; an absent row takes OVERRUN_K_UNKNOWN (as noteIndexStop). True when a row was written. */
export function requestIndexOpenReset(now=Date.now()):boolean{
  return transaction(db=>{
    const row=overrunRow();
    if(row&&row.state==="requested")return false;
    db.prepare(`INSERT INTO ${INDEX_OVERRUN_TABLE}(id,resets,reset_id,state,due_at,kind) VALUES(1,?,?,'requested',?,'open')
      ON CONFLICT(id) DO UPDATE SET reset_id=excluded.reset_id,state='requested',due_at=excluded.due_at,kind='open'`)
      .run(row===null?OVERRUN_K_UNKNOWN:Number(row.resets),randomResetId(),now);
    return true;
  });
}
/** (1b) The reset to send now, or null. A waiting row whose due_at has passed becomes requested (one transaction); due_at is never recomputed. */
export function indexResetDue(now=Date.now()):IndexResetRequest|null{
  const row=overrunRow();
  if(!row||(row.state!=="waiting"&&row.state!=="requested"))return null;
  if(row.state==="waiting"){
    if(now<Number(row.due_at))return null;
    transaction(db=>db.prepare(`UPDATE ${INDEX_OVERRUN_TABLE} SET state='requested' WHERE id=1 AND state='waiting' AND reset_id=?`).run(Number(row.reset_id)));
  }
  return {resetId:Number(row.reset_id),resets:Number(row.resets),kind:String(row.kind)};
}
/** A reset waits or runs: no index batch is formed. */
export function indexResetPending():boolean{const state=overrunRow()?.state;return state==="waiting"||state==="requested";}
/** When a waiting reset falls due (the tick wakes then), or null. */
export function indexResetWakeAt():number|null{const row=overrunRow();return row?.state==="waiting"?Number(row.due_at):null;}
/** Every receipt owed to a rebuilt index (the receipts stay the durable truth; the index holds no memory rows of its own). */
const receiptResetCursors=new WeakMap<DatabaseSync,{tag:string;after:number;through:number}>();
function oweReceiptsToNewIndex(db:DatabaseSync,tag="rebuilt"):boolean {
  const sql="UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending' AND lexical_status!='deleted'";
  if(!ioBudget.currentSource()?.startsWith("memory-")){db.prepare(sql).run();return true;}
  let cursor=receiptResetCursors.get(db);
  if(!cursor||cursor.tag!==tag){cursor={tag,after:0,through:Number(db.prepare("SELECT max(rowid) n FROM memory_projection_receipts").get()?.n??0)};receiptResetCursors.set(db,cursor);}
  const rows=db.prepare("SELECT rowid FROM memory_projection_receipts WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 8").all(cursor.after,cursor.through);
  if(rows.length){
    transaction(()=>{const update=db.prepare(sql+" AND rowid=?");for(const row of rows)update.run(row.rowid!);});
    cursor.after=Number(rows.at(-1)!.rowid);
  }
  if(!rows.length||cursor.after>=cursor.through){receiptResetCursors.delete(db);return true;}
  return false;
}
/** (4) MEMW r3.2.8b rule 1: a helper whose start carried R said reset_done = R. ONE transaction: only a 'requested' row with reset_id = R
 * owes every receipt again and turns 'complete' ("done"); every other row (complete, waiting, another reset, none) is "none" and nothing
 * is written. Only "done" lets the caller remove the stop marker. A busy database throws (the caller keeps R and the tick tries again). */
export function completeIndexReset(resetDone:number):"done"|"none"|"pending"{
  const background=ioBudget.currentSource()?.startsWith("memory-")===true;
  if(background){
    const row=overrunRow();
    if(!row||Number(row.reset_id)!==resetDone||row.state!=="requested")return "none";
    if(!oweReceiptsToNewIndex(database(),`reset:${resetDone}`))return "pending";
  }
  return transaction(db=>{
    const row=overrunRow();
    if(!row||Number(row.reset_id)!==resetDone||row.state!=="requested")return "none";
    if(!background)oweReceiptsToNewIndex(db);
    db.prepare(`UPDATE ${INDEX_OVERRUN_TABLE} SET state='complete' WHERE id=1`).run();
    return "done";
  });
}
/** MEMW r3.2.8 3.1.4: the reset a new helper's `init` carries: the durable row while it is 'requested', else null. */
export function indexResetRequested():IndexResetRequest|null{
  const row=overrunRow();
  return row?.state==="requested"?{resetId:Number(row.reset_id),resets:Number(row.resets),kind:String(row.kind)}:null;
}
/** MEMW r3.2.8 point 4: after a drain that answered "stuck", the next drain waits at least this long. */
export const RESET_DRAIN_RETRY_MS=60_000;
/** Tests only: the stop marker's unlink and the directory fsync after "done" (index-quarantine.ts removeStopMarker does both; these
 * replace its file operations so a test can fail either one). Undefined = the real ones. */
export const resetCompletionIo:{unlink?:(file:string)=>void;fsyncDir?:(dir:string)=>void}={};

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
/** After start(), when the helper is started for recall if nothing has started it yet. */
export const MEMORY_BOOT_WARM_MS=5_000;
/** While parking maintenance is still pending, an idle controller comes back this soon for its next bounded step. */
const PARK_STEP_MS=250;
/** A turn from acceptance to the prompt keeps the worker's claims, receipts and consolidation steps off the main thread for at most this long. */
export const TURN_HOLD_MAX_MS=3_000;
/** Most row work one slice of a worker message applies on the main thread before it yields (its commit comes on top). */
export const WORKER_SLICE_MS=10;
// Test-only: when `rowWorkCpuMs` is set, each receipt slice reports the CPU time of this thread for its row work (thread time, so a GC or
// helper thread of the same process never counts) (the loop WORKER_SLICE_MS
// bounds, not the commit). Null in production, where nothing is measured.
/**
 * Rows of a receipt slice that fit `cap` bytes, from committed slices measured all-in (copy debt included). A commit costs
 * a fixed part plus a per-row part; two different sizes separate them. With one size only, the fixed share is taken
 * as a quarter of that measurement (a per-commit cost seen at about a fifth of a full slice) and the result keeps a 10% margin.
 */
function receiptRowsThatFit(points:ReadonlyArray<{rows:number;bytes:number}>,cap:number):number{
  const small=points.reduce((a,b)=>b.rows<a.rows?b:a),large=points.reduce((a,b)=>b.rows>a.rows?b:a);
  let slope:number,fixed:number;
  if(large.rows-small.rows>=256&&large.bytes>small.bytes){
    slope=(large.bytes-small.bytes)/(large.rows-small.rows);
    fixed=Math.max(...points.map(p=>p.bytes-slope*p.rows),0);
  }else{
    const worst=points.reduce((a,b)=>b.bytes/b.rows>a.bytes/a.rows?b:a);
    fixed=worst.bytes*0.25;slope=(worst.bytes-fixed)/worst.rows;
  }
  return Math.floor((cap/1.1-4096-fixed)/Math.max(1,slope));
}
export const workerSliceTestHooks:{rowWorkCpuMs:((ms:number)=>void)|null}={rowWorkCpuMs:null};
/** How soon a step that met a held write lock tries again. */
const BUSY_RETRY_MS=250;
/** One full checked parent statement plus its WAL copy reserve. */
const HELPER_PARENT_WRITE_ROOM=2*1_048_576;
/** SEAN 1114-MEM-DELETE-IDLE-WINDOW: how long after an owner forget (or the debt marker read at boot) the physical erase counts as
 * non-idle work. A very large index can outlast it: the scrub then continues at the next forget, the next boot, or whenever the app
 * is active. Nothing here promises completion inside the window. */
const OWNER_DELETE_WINDOW_MS=60*60_000;
/** Helper messages whose handling writes nothing to messages.db: never held back by a writer hold. */
const HOLD_EXEMPT_MESSAGES:ReadonlySet<string>=new Set(["bg-grant-request","bg-grant-settle","ready","model-ready","checkpoint-result","query-result","index-error","charge","wal-drain","index-opening"]);
/** Durable checkpoint debt is revisited by one bounded controller tick. */
const CHECKPOINT_CHECK_RETRY_MS=500;
/** A capture's own checkpoint that its publication could not finish (evidence still being checked, or a restart lost the in-process
 * retry) keeps capture admission, so an idle minute drains it without another owner turn. The wait is bounded: past it the debt is
 * left to ordinary recovery (the next admitted active minute), never published unchecked. At most this many are carried at once. */
const CAPTURE_CHECKPOINT_OWED_MS=5*60_000, CAPTURE_CHECKPOINT_OWED_MAX=16;

const MEMORY_WORKER_STOP_GRACE_MS=5000, MEMORY_WORKER_KILL_WAIT_MS=500;
/** r3.2.2 D1 conservative start: for the first T11 window after the controller starts, no checkpoint charge is granted (the helper runs no
 * checkpoint and its admission refuses writes at the bound; nothing is lost and no OVERRUN fires). */
export const CHARGE_START_HOLD_MS=60_000;
/** MEMW r3.2.8 H.1: inside the start hold only a charge flagged `opening` (the index open's own check, open txns, seal and TRUNCATE) is
 * granted, 0 B at any time, a nonzero one only once the controller is OPEN_RESERVE_MIN_AGE_MS old, and at most OPEN_START_RESERVE bytes in
 * total per controller instance (memory only, as D1). Controllers are sequential per data dir (one per server, server/index.ts), so at most
 * 7 x 1 MiB reserve bytes fall in any 60 s window at any restart rate: below the T11 50 MiB line. */
export const OPEN_START_RESERVE=1_048_576;
export const OPEN_RESERVE_MIN_AGE_MS=10_000;
/** r3.2.4 A2.2 (owner G1): bytes granted to a charge and not yet matched by the helper's reported growth are a credit for this long, then
 * they expire (an expired credit only debits more: the fail-closed direction). */
export const CHARGE_CREDIT_MS=60_000;
/** Charge keys remembered per helper (each answered once); the oldest is forgotten past this, and a forgotten duplicate debits again. */
const CHARGE_KEYS_MAX=4096;
export class MemoryWorkerController {
  /** r3.2.4 A2.3: the conservative start is ONE synthetic full-window entry (the T11 window budget), stamped at controller start. It
   * ages out after CHARGE_START_HOLD_MS; nothing re-stamps it (a refused charge spends nothing and never extends the stall). After it the
   * grant follows spec section 4's charge rule (PARTA-BUILD-SPEC.md:272), which has no window rule beyond this start hold. */
  private readonly chargeStartEntry:{readonly at:number;readonly bytes:number}={at:performance.now(),bytes:IO_BUDGET_BYTES_PER_MINUTE};
  /** r3.2.6 A2': the current helper's first-seen run id and the charges it sent, keyed (helperRunId, fileId, attempt), each answered once. */
  private chargeRun:{child:unknown;runId:string|null;keys:Map<string,boolean>}={child:null,runId:null,keys:new Map()};
  /** Granted bytes not yet matched by reported growth, oldest first (r3.2.4 A2.2: the attempt is debited max(granted, actual)). */
  private chargeCredit:Array<{at:number;bytes:number}>=[];
  /** H.1 1: reserve bytes granted in this controller's start hold (never reset: one controller instance, one reserve). */
  private holdGranted=0;
  /** H.1 4: the helper that got a charge refused inside the hold; its failed start is not backed off, it is respawned at the hold's end. */
  private holdRefusedChild:unknown=null;
  private exactRespawn=false;
  /** H.1 6: what the current helper did, for the open-exit streak. `own`: the controller ended it (never a qualifying exit). */
  private life:{child:ChildProcess;opening:boolean;charged:boolean;initialised:boolean;own:boolean}|null=null;
  /** CPU-only capture needs the loaded helper, independently of index-open admission. */
  private captureReadyChild:ChildProcess|null=null;
  private childIo:{child:ChildProcess;receipts:ChildIoReceipts}|null=null;
  private openExitStreak=0;
  private killOwn(child:ChildProcess|null){if(child&&this.life?.child===child)this.life.own=true;child?.kill("SIGKILL");}
  /** Reported growth, less the unexpired credit it uses up (oldest first): what is left is debited. */
  private spendChargeCredit(growth:number):number{
    const now=performance.now();
    while(this.chargeCredit.length&&now-this.chargeCredit[0]!.at>=CHARGE_CREDIT_MS)this.chargeCredit.shift();
    let left=growth;
    while(left>0&&this.chargeCredit.length){
      const credit=this.chargeCredit[0]!,used=Math.min(credit.bytes,left);
      credit.bytes-=used;left-=used;
      if(credit.bytes<=0)this.chargeCredit.shift();
    }
    return left;
  }
  /** A charge, answered in the handler turn (r3.2.2 D1, r3.2.4 A2, r3.2.6 A2'): granted only for the current helper's first-seen run id,
   * a usable byte count and identity, after the start entry aged out; a granted charge is debited its bytes at grant, once per key; a
   * refused one debits nothing. The ack echoes the charge's three ids. */
  private answerCharge(child:unknown,charge:{fileId?:unknown;attempt?:unknown;bytes?:unknown;helperRunId?:unknown;opening?:unknown;purpose?:unknown}):boolean{
    const bytes=typeof charge.bytes==="number"&&Number.isFinite(charge.bytes)&&charge.bytes>=0?charge.bytes:null;
    const runId=typeof charge.helperRunId==="string"&&charge.helperRunId.length>0&&charge.helperRunId.length<=64?charge.helperRunId:null;
    if(this.chargeRun.child!==child)this.chargeRun={child,runId:null,keys:new Map()};
    if(this.chargeRun.runId===null&&runId!==null)this.chargeRun.runId=runId;
    const key=`${runId}\u0000${String(charge.fileId)}\u0000${String(charge.attempt)}`;
    const known=this.chargeRun.keys.get(key);
    if(known!==undefined)return known;
    const age=performance.now()-this.chargeStartEntry.at,inHold=age<(this.options.startHoldMs??CHARGE_START_HOLD_MS);
    const valid=bytes!==null&&runId!==null&&runId===this.chargeRun.runId&&typeof charge.fileId==="string"&&Number.isSafeInteger(charge.attempt);
    // After the hold every valid charge is granted; inside it only an opening charge of the current helper, within the age-gated reserve.
    let granted=valid&&(!inHold||(child===this.child&&charge.opening===true&&(bytes===0||(age>=OPEN_RESERVE_MIN_AGE_MS&&this.holdGranted+bytes!<=OPEN_START_RESERVE))));
    if(granted&&charge.purpose==="owner-delete"){
      const copy=ioBudget.admit("FGCOPY",bytes!,0,{ownerDeletion:this.ownerDeleteWindowOpen()});
      granted=copy!==null;
      // The helper's native ticket settlement accounts the physical copy; this is its charge authorization only.
      if(copy)ioBudget.settle(copy,0);
    }
    if(inHold&&!granted)this.holdRefusedChild=child;
    if(granted&&inHold)this.holdGranted+=bytes!;
    if(granted){this.workerBytes+=bytes!;this.chargeCredit.push({at:performance.now(),bytes:bytes!});}
    this.chargeRun.keys.set(key,granted);
    if(this.chargeRun.keys.size>CHARGE_KEYS_MAX)this.chargeRun.keys.delete(this.chargeRun.keys.keys().next().value!);
    return granted;
  }
  /** MEMW 1.13: a stop or reset_done a helper reported, kept until its main-database write lands (a locked database: the tick tries again). */
  private stopSeen:IndexStopReport|null=null;
  private resetDoneSeen:number|null=null;
  /** MEMW r3.2.8 3.1.4: the helper whose `init` carried reset R (only that helper's `initialised` can complete R). */
  private startReset:{child:ChildProcess;resetId:number}|null=null;
  /** MEMW r3.2.8 point 4: a reader drain before a reset-exit (or before a spawn with R) is running; a stuck one is retried no sooner than this. */
  private resetDraining=false;
  private resetDrainRetryAt=0;
  /** A batch answered `segment-gate` or `age-blocked` (held until gate-clear, or a helper start that says the gate is clear; owner 20:25Z:
   * age-blocked is held and retried like segment-gate and never starts a wal-drain) or `merge-floor` (asked again at the next helper start,
   * and hourly). */
  private batchHold:{reason:"segment-gate"|"age-blocked"|"merge-floor";until:number}|null=null;
  /** The status note while a reset waits or runs, or at the scale freeze: a code Settings says in words (memory-words.ts), never an error. */
  private overrunNote="";
  /** Writes what the helper reported (a finished reset first, then a stop), starts the drain before a due reset's reset-exit for a helper
   * whose start did not carry it, and says whether index batches are held. MEMW r3.2.8/8b/8c: a reset runs only at a helper start. */
  private settleOverrun(child:ChildProcess|null):boolean{
    let pending=true;
    try{
      if(this.resetDoneSeen!==null){
        const resetId=this.resetDoneSeen;
        const result=completeIndexReset(resetId);
        // r3.2.8d D5: cleared once the transaction answered, before the unlink: a failed unlink never runs the transaction again.
        if(result==="pending")return true;
        this.resetDoneSeen=null;
        if(result==="done"){this.resetPending=false;if(!this.removeResetMarker(child??this.child))return true;}
      }
      if(this.stopSeen){noteIndexStop(this.stopSeen);this.stopSeen=null;}
      const due=indexResetDue();
      if(due&&child&&this.child===child&&this.ready&&this.idleExit!==child&&this.startReset?.child!==child)this.drainThenResetExit(child);
      pending=indexResetPending();
    }catch(error){logSwallowed("index",error,isDatabaseBusy(error)?BUSY_RETRY_MS:undefined);}// fail closed: no batch until the row reads
    if(this.batchHold?.reason==="merge-floor"&&Date.now()>=this.batchHold.until)this.batchHold=null;
    this.overrunNote=pending?"MEMORY_INDEX_CHECKING":this.batchHold?.reason==="merge-floor"?"MEMORY_INDEX_SCALE_FREEZE":"";
    return pending||this.batchHold!==null;
  }
  /** MEMW r3.2.8b rule 1 / section 3, after "done" committed: unlink the marker (ENOENT is done), then fsync the directory, then unblock
   * the readers. An unlink failure (r3.2.8c M1): MEMORY_INDEX_RESET_UNLINK_FAILED, the planned-exit fields, reset-exit, readers left as they
   * are, and false (held). A directory fsync failure after the unlink IS done (the marker is gone from the namespace): logged, readers unblock. */
  private removeResetMarker(child:ChildProcess|null):boolean{
    let unlinked=false;
    try{
      indexQuarantine.removeStopMarker(join(DATA_DIR,"memory-index.db"),{
        unlink:file=>{try{(resetCompletionIo.unlink??unlinkSync)(file);}catch(error){if((error as {code?:unknown})?.code!=="ENOENT")throw error;}unlinked=true;},
        ...resetCompletionIo.fsyncDir?{fsyncDir:resetCompletionIo.fsyncDir}:{},
      });
    }catch(error){
      if(!unlinked){
        logSwallowed("index","MEMORY_INDEX_RESET_UNLINK_FAILED");
        if(child&&this.child===child)this.plannedResetExit(child);
        return false;
      }
      logSwallowed("index","MEMORY_INDEX_RESET_DIR_FSYNC_FAILED");
    }
    unblockMemoryIndexReader();
    return true;
  }
  /** The existing planned-exit fields (the idle exit's), then reset-exit: the helper exits at once with no close. */
  private plannedResetExit(child:ChildProcess){
    this.idleExit=child;this.captureReadyChild=null;this.ready=false;this.modelReady=false;this.initDeadline=Date.now()+MEMORY_WORKER_INIT_MS;
    try{child.send({type:"reset-exit"});}catch{this.killOwn(child);}
  }
  /** MEMW r3.2.8 3.1.2 / point 4: the main-process readers are drained (cancelled by the epoch move) before reset-exit; only "drained"
   * sends it. "stuck": MEMORY_INDEX_READER_STUCK, no reset-exit, readers stay blocked, tried again no sooner than RESET_DRAIN_RETRY_MS. */
  private drainThenResetExit(child:ChildProcess){
    this.runResetDrain(()=>{if(this.child===child&&this.ready&&this.idleExit!==child&&!this.stopping)this.plannedResetExit(child);});
  }
  private runResetDrain(then:()=>void){
    if(this.resetDraining||Date.now()<this.resetDrainRetryAt)return;
    this.resetDraining=true;
    void drainMemoryIndexReaders(RESET_DRAIN_MAX_MS).then(verdict=>{
      this.resetDraining=false;
      if(this.stopping)return;
      if(verdict==="drained"){then();return;}
      logSwallowed("index","MEMORY_INDEX_READER_STUCK");
      this.resetDrainRetryAt=Date.now()+RESET_DRAIN_RETRY_MS;this.schedule(RESET_DRAIN_RETRY_MS);
    },error=>{this.resetDraining=false;logSwallowed("index",error);});
  }
  /** Readers stay blocked while the row is 'requested' (r3.2.8 3.1.5); a row that cannot be read keeps them blocked (fail closed). */
  private unblockUnlessResetRequested(){
    let requested=true;
    try{requested=indexResetRequested()!==null;}catch(error){logSwallowed("index",error,isDatabaseBusy(error)?BUSY_RETRY_MS:undefined);}
    if(!requested)unblockMemoryIndexReader();
  }
  /** A reset is due now: a helper is owed even with nothing to project. */
  private resetDueNow():boolean{try{return indexResetDue()!==null;}catch{return false;}}
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
  private bootWarmTimer:ReturnType<typeof setTimeout>|null=null;
  /** The helper warmForIntent started, until it is ready or real work needs it: if it fails with no search waiting on it, only the log hears about it. */
  private warmStart:ChildProcess|null=null;
  private initWatch:ReturnType<typeof setTimeout>|null=null;
  /** The next time a warm may start a helper that never left on purpose, so one that keeps dying is not restarted by every key press. */
  private nextWarmAt=0;
  /** The helper that was allowed to exit because it held a WebAssembly model and had been idle (worker.ts). */
  private idleExit:ChildProcess|null=null;
  /** True from a planned idle exit until the next helper starts. */
  private idleExited=false;
  private stopping=false;
  private indexing=false;
  private indexDeadline=0;
  private indexRequestId:string|null=null;
  /** The batch in flight: each record's projected state when it was sent ("id\u0000version" -> state). */
  /** Checkpoint requests the index reader sent to the helper and has not seen answered. */
  private checkpoints=new Map<string,(ok:boolean)=>void>();
  private indexSent=new Map<string,string>();
  /** Records the batch in flight sent as rollovers: their deleted acknowledgement never clears an owner forget's receipt. */
  private indexRolled=new Set<string>();
  /** The index owes a deletion scrub (index.ts scrubDeleted): a helper is kept running for it with nothing else to do. Read at start,
   * then told by the helper (initialised, index-result, scrub-done); the durable debt itself is the index's own marker. */
  private scrubOwed=false;
  /** The owner-deletion idle window: opened only by an owner forget batch or the marker read at start, closed at CLEAN or after
   * OWNER_DELETE_WINDOW_MS. A retried batch does not extend it; a new forget re-opens it. */
  private ownerDeleteWindowUntil=0;
  private ownerDeleteWindowBatch="";
  private openOwnerDeleteWindow():void{this.ownerDeleteWindowUntil=Date.now()+OWNER_DELETE_WINDOW_MS;}
  private closeOwnerDeleteWindow():void{this.ownerDeleteWindowUntil=0;}
  private ownerDeleteWindowOpen():boolean{return Date.now()<this.ownerDeleteWindowUntil;}
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
      if(!oweReceiptsToNewIndex(database(),this.childIo?.receipts.generation??"rebuilt"))return false;
      this.resetPending=false;return true;
    }catch(error){this.swallowed("capture","helper","MEMORY_INDEX_RESET_FAILED",error);return false;}
  }
  private bgRetryAt=0;
  private deferredCheckpoint:Promise<boolean>|null=null;
  private bgRetryDelay(error:BgDeferred):number{return error.reservationWait?error.retryInMs:Math.max(error.retryInMs,ioBudget.nextAdmissionMs());}
  private bgRetryMs(error:BgDeferred):number{
    const delay=this.bgRetryDelay(error);
    this.bgRetryAt=Math.max(this.bgRetryAt,performance.now()+delay);
    this.nextEligibleWorkAt=Math.max(this.nextEligibleWorkAt,this.bgRetryAt);
    // A byte grant alone cannot clear retained WAL debt; the helper's checkpoint still needs its own admission.
    if(ioBudget.backgroundRoom()>0&&!this.deferredCheckpoint){
      this.deferredCheckpoint=this.requestCheckpoint();
      void this.deferredCheckpoint.then(()=>{this.deferredCheckpoint=null;});
    }
    return delay;
  }
  /** The start's two recovery steps, each run once per start. Failed jobs whose cause says nothing about the conversation (the helper
   * died, a timeout) get their attempts back; C6: leases a dead process held are claimable now, not after their lease_until (bounded
   * pages; a live lease is never taken). A refused step (BgDeferred, C4) or a held write lock is retried by ONE timer at its named
   * time, replaced by a later refusal, never left for lease_until (the W13 restart stall: the release refused at boot, logged
   * next=later, and the dead lease held the thread's capture past the poll window). An arrival (wake) moves that one timer to now:
   * a restarted server is idle until its first turn, and the idle rule refuses BG writes until the roll. A retry that ran wakes the queue. */
  private bootSteps={redrive:true,release:true};
  private bootRecoveryTimer:ReturnType<typeof setTimeout>|null=null;
  private bootRecoveryNow=false;
  private bootRecovery(retry=true){
    if(this.bootRecoveryTimer)clearTimeout(this.bootRecoveryTimer);this.bootRecoveryTimer=null;this.bootRecoveryNow=false;
    if(!this.started||this.stopping)return;
    let retryMs:number|null=null,ran=0;
    const step=(key:"redrive"|"release",what:string,run:()=>number)=>{
      if(this.bootSteps[key])return;
      try{ioBudget.withSource("memory-worker",()=>{const n=run();this.bootSteps[key]=true;ran+=n;if(n)console.log(`[memory-worker] subsystem=capture ${what}=${n}`);});}
      catch(error){
        // its own delay, not bgRetryMs: an idle refusal names the roll, and pacing every claim to it would hold the owner's next
        // capture back after the owner's action has cleared idle (the arrival below retries this step at once instead)
        if(isBgDeferred(error)){const delay=Math.max(error.retryInMs,ioBudget.nextAdmissionMs());logSwallowed("capture",error,delay);retryMs=Math.min(retryMs??delay,delay);}
        else if(isDatabaseBusy(error)){logSwallowed("capture",error,BUSY_RETRY_MS);retryMs=Math.min(retryMs??BUSY_RETRY_MS,BUSY_RETRY_MS);}
        else{logSwallowed("capture",error);this.bootSteps[key]=true;}
      }
    };
    step("redrive","redriven",()=>redriveTransientFailedJobs());
    step("release","released",()=>releaseDeadProcessLeases());
    if(retryMs!==null){this.bootRecoveryTimer=setTimeout(()=>{this.bootRecoveryTimer=null;this.bootRecovery();},Math.max(1,retryMs));this.bootRecoveryTimer.unref?.();}
    // a retry that ran wakes the queue; at start the start's own tail does (it wakes when a job is claimable)
    if(ran&&retry)this.wake();
  }
  private swallowed(log:WorkerSubsystem,subsystem:string,code:string,error:unknown){
    if(this.stopping)return;
    if(isBgDeferred(error)){const delay=this.bgRetryMs(error);logSwallowed(log,error,delay);this.schedule(delay);return;}
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
    return ()=>{if(released)return;released=true;if(--this.turnHolds<=0){this.turnHolds=0;this.wake();}};
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
   * loaded and warm before recall asks. With memory active, a helper that is not running is started first; a live WebAssembly
   * helper whose model is not loaded yet is asked to load it. A warm failing is never the owner's problem: it logs, waits, and shows nothing. */
  warmForIntent(){
    if(this.stopping||!this.started)return;
    if(this.child){if(this.ready)this.requestWarm(this.child);else if(this.wasmHelper||this.idleExited)this.warmOwed=true;return;}
    // No helper at all counts too: one that never started (no job was owed at boot) is forked by the first search, and that cold
    // start outlasts the query deadline, so the first turn after a restart goes out with no recall (ALL.eld250 real legs).
    const now=Date.now();
    if(now<this.respawnAt||(!this.idleExited&&now<this.nextWarmAt))return;
    // A helper that left on its planned idle exit comes back as it always has. One that never ran starts only with memory active.
    // This also runs at every turn's start, so a locked database means no warm this time: never a failed turn, and no back-off, which would refuse the next search.
    try{if(!this.idleExited&&memoryState().mode!=="active")return;}
    catch(error){logSwallowed("recall",error,BUSY_RETRY_MS);return;}
    try{
      this.nextWarmAt=now+MEMORY_IDLE_SWEEP_MS;
      this.warmOwed=true;
      this.spawn();
      this.warmStart=this.child;
    }catch(error){
      logSwallowed("recall",error);this.warmOwed=false;
      // spawn() shuts the index reader before it forks: a fork that threw must not leave recall shut out.
      if(!this.child){unblockMemoryIndexReader();this.waitBeforeNextStart();}
    }
  }
  private warmAfterIdleExit(){this.warmForIntent();}
  /** Sources whose capture was published while a turn held the worker: their derived work (extraction, consolidation) starts once the hold ends,
   * so the main thread does not begin it in the turn's setup window. The capture and its checkpoint are not delayed. */
  private heldCompletions=new Set<string>();
  private flushHeldCompletions(){
    let count=0;
    for(const id of this.heldCompletions){this.completedSource(id);this.heldCompletions.delete(id);if(++count===2)break;}
  }
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
  private notebookTimer: ReturnType<typeof setInterval> | null=null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null=null;
  private maintenanceTask: Promise<void> | null=null;
  private continuityTask: Promise<void> | null=null;
  private nextBacklogTrace=0;
  /** The one pacing deadline (performance.now() ms, monotonic: a wall-clock change cannot move it): no cycle of new work starts before it, whichever
   * entry point asks (a wake on arrival, a scheduled sweep, a worker message). Timeouts do not wait for it. */
  private nextEligibleWorkAt=0;
  private workCyclesSinceMaintenance=0;
  private options:{onNotebookSync?:()=>unknown;onMaintenance?:(startup:boolean,signal?:AbortSignal)=>Promise<unknown>;continuityEligible?:()=>boolean;onContinuity?:(signal:AbortSignal)=>Promise<unknown>;modelDirectory?:string;wasmIdleExitMs?:number;manifest?:ModelManifest;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>;onLineageWarm?:(yieldNow:()=>boolean)=>boolean;upgradeRunning?:()=>boolean;startHoldMs?:number};
  constructor(options:{onNotebookSync?:()=>unknown;onMaintenance?:(startup:boolean,signal?:AbortSignal)=>Promise<unknown>;continuityEligible?:()=>boolean;onContinuity?:(signal:AbortSignal)=>Promise<unknown>;modelDirectory?:string;wasmIdleExitMs?:number;manifest?:ModelManifest;onCompletedSource?:(jobId:string,signal:AbortSignal)=>Promise<unknown>;onIdleConsolidation?:(signal:AbortSignal)=>Promise<unknown>;onLineageWarm?:(yieldNow:()=>boolean)=>boolean;upgradeRunning?:()=>boolean;startHoldMs?:number}={}){this.options=options;}
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
  private readonly resumeNotebook=()=>this.syncNotebooks();
  private readonly resumeStatusScan=()=>this.scheduleStatusScan(0);
  private readonly resumeLineageWarm=()=>this.scheduleLineageWarm(0);
  /** Worker messages that arrived during a writer hold, in arrival order: dispatched once it is released (bounded: the in-flight messages of one helper). */
  private heldMessages:Array<{child:ChildProcess;message:unknown}>=[];

  /** What the helper last said about the age order of the word table (1.0.3 lane 2, worker.ts fillAgeIndex): "" when nothing is in the way. */
  private indexNote="";
  status() {
    return {checkpointPending:checkpointDebtCount(database())>0,running:this.child!==null,ready:this.ready,indexing:this.indexing,queryCount:this.queries.size,error:this.error,errors:Object.fromEntries(this.errors),indexNote:this.overrunNote||this.indexNote};
  }

  private inferenceDeferred(jobId: string, signal: AbortSignal, result: unknown): void {
    if (!result || typeof result !== "object" || !("waitingFor" in result) || result.waitingFor !== "inference-slot") return;
    const waiter: Promise<void> = waitForMemoryInferenceIdle(signal).then(() => {
      if (!this.stopping && !signal.aborted) this.completedSource(jobId);
    }).catch(error => { if (!signal.aborted) this.swallowed("learning", "consolidation", "MEMORY_CONSOLIDATION_FAILED", error); })
      .finally(() => { this.admissionWaiters.delete(waiter); });
    this.admissionWaiters.add(waiter);
  }

  /** Notify the same derived-work hook after either capture publication path. */
  completedSource(jobId:string){
    if(this.stopping||!this.options.onCompletedSource)return;
    const signal=this.consolidationAbort.signal;
    // Extraction is an engine call: it waits for the owner's turn, typing and an overloaded computer (owner-first.ts), never past the bound.
    const run=()=>ioBudget.withSource("memory-worker",()=>this.options.onCompletedSource!(jobId,signal));
    const finish=(set:Set<Promise<void>>,task:Promise<void>)=>{set.delete(task);this.wake();};
    if(ownerFirst.admit("memory-extract").admitted){
      const task:Promise<void>=new Promise<void>(resolve=>resolve(run().then(result=>{this.inferenceDeferred(jobId,signal,result);})))
        .then(()=>{this.clearError("consolidation");}).catch(error=>this.swallowed("learning","consolidation","MEMORY_CONSOLIDATION_FAILED",error))
        .finally(()=>finish(this.consolidationTasks,task));
      this.consolidationTasks.add(task);
      return;
    }
    // Waiting for the owner: tracked apart from running work. It moves into the running set only once admitted.
    const waiter:Promise<void>=ownerFirst.wait("memory-extract",signal).then(()=>{
      if(this.stopping)return;
      const task:Promise<void>=Promise.resolve().then(run)
        .then(result=>{this.inferenceDeferred(jobId,signal,result);this.clearError("consolidation");}).catch(error=>this.swallowed("learning","consolidation","MEMORY_CONSOLIDATION_FAILED",error))
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
    if(this.options.onMaintenance&&!this.maintenanceTask&&(startup||(!ioBudget.shouldDefer("memory-idle")&&ownerFirst.admit("memory-maintenance").admitted))){
      this.maintenanceTask=Promise.resolve().then(()=>ioBudget.withSource("memory-idle",()=>this.options.onMaintenance!(startup,this.consolidationAbort.signal)))
        .then(()=>{this.clearError("maintenance");}).catch(error=>this.swallowed("capture","maintenance","MEMORY_MAINTENANCE_FAILED",error))
        .finally(()=>{this.maintenanceTask=null;});
    }
    if(this.options.onContinuity&&!this.continuityTask&&(this.options.continuityEligible?.()??true)&&["capture","active"].includes(memoryState().mode)&&!(ioBudget.backgroundRoom()<=0)&&!this.upgradeYield()&&ownerFirst.admit("memory-continuity").admitted){
      // under its own source: every statement of the pass (the sliced pending check included) is named on a slow line and a stall
      this.continuityTask=Promise.resolve().then(()=>{if(!this.stopping)return ioBudget.withSource("memory-continuity",()=>this.options.onContinuity!(this.consolidationAbort.signal));})
        .then(()=>{this.clearError("continuity");}).catch(error=>this.swallowed("reflection","continuity","MEMORY_CONTINUITY_FAILED",error))
        .finally(()=>{this.continuityTask=null;});
    }
  }

  /** Tracking was requested by the owner. It shares foreground priority and the
   * watchdog, but never waits for unrelated idle-learning byte debt. Each pass
   * stats at most four due links and writes only when a selected file changed. */
  private syncNotebooks() {
    if(this.stopping||!this.options.onNotebookSync)return;
    if(writersHeldForIndexBuild()){this.deferForHold(this.resumeNotebook);return;}
    if(this.turnHeld()||!ownerFirst.admit("owner-notebook").admitted||ioBudget.shouldDefer("owner-notebook"))return;
    try { ioBudget.withSource("owner-notebook",()=>this.options.onNotebookSync!()); this.clearError("notebook"); }
    catch(error){this.swallowed("maintenance","notebook","MEMORY_NOTEBOOK_SYNC_FAILED",error);}
  }

  start() {
    if(this.started) return;
    this.started=true;
    this.stopping=false;
    // Set-aside index copies go at start, before any wait: with nothing owed the first tick is a full idle sweep away (MEMINDEX-BUSY-109).
    this.quarantineSweepAt=0;this.sweepIndexQuarantines();
    // unknown (the index could not be read just now) is owed: the helper reads the marker itself and says (memdel r2 High #3)
    this.scrubOwed=indexScrubOwed()!==false;
    if(this.scrubOwed)this.openOwnerDeleteWindow();
    if(this.consolidationAbort.signal.aborted)this.consolidationAbort=new AbortController();
    this.bootSteps={redrive:false,release:false};this.bootRecovery(false);
    // Debt found at start lost its capture's in-process retry with the previous run: it keeps capture admission for the bounded wait.
    try{
      for(const row of database().prepare("SELECT id FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' ORDER BY rowid LIMIT ?").all(CAPTURE_CHECKPOINT_OWED_MAX)){
        const id=String(row.id);if(id.startsWith('checkpoint-debt:'))this.oweCaptureCheckpoint(id.slice('checkpoint-debt:'.length));
      }
    }catch(error){logSwallowed("capture",error);}
    this.independentWork(true);
    this.maintenanceTimer=setInterval(()=>this.independentWork(),MEMORY_IDLE_SWEEP_MS);
    this.maintenanceTimer.unref();
    if(this.options.onNotebookSync){
      this.notebookTimer=setInterval(()=>this.syncNotebooks(),10_000);
      this.notebookTimer.unref();
    }

    // Recall finds a helper ready on the first turn after a restart; a few seconds' wait lets the app's own startup work finish first.
    this.bootWarmTimer=setTimeout(()=>{this.bootWarmTimer=null;try{this.warmForIntent();}catch(error){logSwallowed("recall",error);}},MEMORY_BOOT_WARM_MS);
    this.bootWarmTimer.unref?.();
    ioBudget.setOnMemoryWork(notifyMemoryWork);
    this.unsubscribe=onMemoryWork(()=>this.wake());
    try {
      if(checkpointDebtCount(database())||hasClaimableMemoryJob()||this.pendingProjection()||this.scrubOwed||this.resetDueNow())this.wake();
      else this.schedule(Math.min(MEMORY_IDLE_SWEEP_MS,nextMemoryJobDelay()??MEMORY_IDLE_SWEEP_MS));
    }catch{this.schedule(MEMORY_IDLE_SWEEP_MS);}
  }
  /** Arrivals coalesce into the next macrotask. Capture can run beside an index
   * check, so indexing must not consume notifications for the capture queue. */
  wake() {
    if(!this.started||this.stopping)return;
    // An owed start recovery was refused (the restarted server was idle, so the budget named the minute roll): an arrival is the
    // server turning active, so its one timer is moved to now instead of waiting for the roll with the dead lease in the queue.
    if(this.bootRecoveryTimer&&!this.bootRecoveryNow){clearTimeout(this.bootRecoveryTimer);this.bootRecoveryNow=true;this.bootRecoveryTimer=setTimeout(()=>{this.bootRecoveryTimer=null;this.bootRecovery();},0);this.bootRecoveryTimer.unref?.();}
    // the same for a refused failWork deferral (D5): its one timer moves to now, it does not wait for the roll with the lease held
    if(this.deferredFailureTimer&&!this.deferredFailureNow&&this.deferredFailure)this.armDeferredFailure(this.deferredFailure,0);
    if(this.ticking){this.wakeOwed=true;return;}
    if(this.work)return;
    this.requested=true;
    // An arrival owes the idle pass a look: during a run it continues after the drain gap; otherwise
    // it is due at the one-second consolidation deadline (at once if that has passed), never left for the idle sweep.
    if(this.consolidationTasks.size||this.idleTask)this.consolidationWake=true;
    else if(this.options.onIdleConsolidation)this.consolidationDue=true;
    this.schedule(Math.max(0,this.nextEligibleWorkAt-performance.now()));
  }
  private schedule(delay:number) {
    if(!this.started||this.stopping)return;
    delay=Math.max(delay,this.bgRetryAt-performance.now());
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
  private checkpointCursor=0n;
  private startingCheckpointCursor=0;
  /** Capture-owed checkpoint debt (job id -> performance.now() deadline), see CAPTURE_CHECKPOINT_OWED_MS. */
  private captureOwedCheckpoints=new Map<string,number>();
  private captureOwedTimer:ReturnType<typeof setTimeout>|null=null;
  private oweCaptureCheckpoint(jobId:string){
    if(!this.captureOwedCheckpoints.has(jobId)&&this.captureOwedCheckpoints.size<CAPTURE_CHECKPOINT_OWED_MAX)this.captureOwedCheckpoints.set(jobId,performance.now()+CAPTURE_CHECKPOINT_OWED_MS);
    this.armCaptureOwed();
  }
  /** One timer drives the capture-owed entries while the server is idle; an active minute leaves them to ordinary recovery. */
  private armCaptureOwed(){
    if(this.captureOwedTimer||this.stopping||!this.captureOwedCheckpoints.size)return;
    this.captureOwedTimer=setTimeout(()=>{
      this.captureOwedTimer=null;
      if(this.stopping)return;
      try{
        // The capture queue owns an idle slice: a queued or leased capture goes first.
        if(ioBudget.admissionIdle()&&!this.work&&!hasClaimableMemoryJob())this.recoverCaptureOwedCheckpoints();
        else for(const [jobId,until] of [...this.captureOwedCheckpoints])if(performance.now()>until)this.captureOwedCheckpoints.delete(jobId);
      }catch(error){logSwallowed("capture",error);}
      this.armCaptureOwed();
    },CHECKPOINT_CHECK_RETRY_MS);
    this.captureOwedTimer.unref?.();
  }
  /** Up to two capture-owed checkpoints per pass, under capture admission. An evidence-checking result or a refusal keeps the entry
   * until its deadline; every other outcome (published, disposed, the marker gone or invalid) ends it. */
  private recoverCaptureOwedCheckpoints(){
    let visited=0;
    for(const [jobId,until] of [...this.captureOwedCheckpoints]){
      if(performance.now()>until){this.captureOwedCheckpoints.delete(jobId);continue;}
      if(visited++===2)return;
      try{
        const outcome=this.refreshCheckpoint(jobId,false,"memory-capture");
        // null is a current gate (mode, writer hold, turn hold) unless the marker itself is gone
        const owed=outcome===null?Boolean(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND subject_id='checkpoint-pending'").get('checkpoint-debt:'+jobId)):outcome.reason==="evidence-checking";
        if(!owed)this.captureOwedCheckpoints.delete(jobId);
      }catch(error){
        if(isBgDeferred(error)||isDatabaseBusy(error)){logSwallowed("capture",error);return;}
        this.captureOwedCheckpoints.delete(jobId);this.swallowed("capture","checkpoint","MEMORY_CHECKPOINT_FAILED",error);
      }
    }
  }
  /** Exact point revalidation: the marker is owed data, never permission to run it. */
  private refreshCheckpoint(jobId:string,startingOnly=false,source:"memory-worker"|"memory-capture"="memory-worker"):ReturnType<typeof refreshMemoryCheckpoint>|null {
    return ioBudget.withSource(source,()=>{
      if(!["capture","active"].includes(memoryState().mode)||writersHeldForIndexBuild()||(!startingOnly&&this.turnHeld()))return null;
      const db=database();
      const marker=db.prepare("SELECT scope_id,CASE WHEN octet_length(intent)<=4096 THEN intent END AS intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='checkpoint-pending' AND state='granted'").get('checkpoint-debt:'+jobId);
      if(!marker)return null;
      const intent=JSON.parse(String(marker.intent));
      if(!intent||intent.jobId!==jobId||typeof intent.sourceId!=="string"||!Number.isSafeInteger(intent.revision))throw new Error("MEMORY_CHECKPOINT_DEBT_INVALID");
      const source=db.prepare("SELECT j.source_id,j.source_revision,j.status,j.stage,s.revision,s.scope_id,s.state,s.thread_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?").get(jobId);
      if(!source||source.status!=="complete"||source.stage!=="capture"||source.source_id!==intent.sourceId||source.source_revision!==intent.revision||source.revision!==intent.revision||source.scope_id!==marker.scope_id||source.state!=="active")throw new Error("MEMORY_CHECKPOINT_SOURCE_UNAVAILABLE");
      if(startingOnly&&!ownerFirst.startingThreads().includes(String(source.thread_id)))return null;
      // The shared refresh rechecks policy, deletion, branch and lineage; its writes acquire fresh checked BG admission.
      const outcome=refreshMemoryCheckpoint(jobId);
      if(outcome.status!=="deferred"){
        this.clearError("checkpoint");
        if(startingOnly||this.turnHeld())this.heldCompletions.add(jobId);else this.completedSource(jobId);
      }else if(outcome.reason!=="evidence-checking")this.clearError("checkpoint");
      return outcome;
    });
  }
  private recoverCheckpoints(startingOnly=false){
    // The capture queue owns an idle slice: owed derived work must not take it while a capture is queued or leased.
    if(!startingOnly&&ioBudget.admissionIdle()&&(this.work||hasClaimableMemoryJob()))return;
    const statement=database().prepare(startingOnly
      ? "SELECT rowid,id FROM memory_scope_bindings WHERE id IN (SELECT 'checkpoint-debt:'||value FROM json_each(?)) AND subject_type='system' AND subject_id='checkpoint-pending' LIMIT 2"
      : "SELECT rowid,id FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' AND rowid>? ORDER BY rowid LIMIT 2");
    statement.setReadBigInts(true);
    const starts=startingOnly?ownerFirst.startingThreads().flatMap(thread=>turnCaptureJobId(thread)??[]):[];
    const offset=this.startingCheckpointCursor%Math.max(1,starts.length);
    const page=starts.slice(offset).concat(starts.slice(0,offset)).slice(0,2);
    if(startingOnly)this.startingCheckpointCursor=(offset+page.length)%Math.max(1,starts.length);
    const rows=statement.all(startingOnly?JSON.stringify(page):this.checkpointCursor);
    if(!rows.length){if(!startingOnly)this.checkpointCursor=0n;return;}
    for(const row of rows){
      if(!startingOnly)this.checkpointCursor=row.rowid as bigint;
      try{
        const id=String(row.id);
        if(!id.startsWith('checkpoint-debt:'))throw new Error("MEMORY_CHECKPOINT_DEBT_INVALID");
        this.refreshCheckpoint(id.slice('checkpoint-debt:'.length),startingOnly);
      }catch(error){this.swallowed("capture","checkpoint","MEMORY_CHECKPOINT_FAILED",error);if(isBgDeferred(error))return;}
    }
  }
  private tick(requested=false) {
    if(this.stopping) return;
    if(this.heldCompletions.size&&!this.turnHeld())this.flushHeldCompletions();
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
    const paced=performance.now()<Math.max(this.nextEligibleWorkAt,this.bgRetryAt);
    const cycleStart=performance.now();
    const cycle={busy:0};
    let cycleWork:MemoryWork|null=null;
    let clean=true,busy=false,ownerRetryMs:number|null=null,captureRetryMs:number|null=null,admissionRetryMs:number|null=null;
    try {
      this.sweepIndexQuarantines();
      // Timeouts are independent of the pacing deadline.
      if(this.indexing){
        if(this.indexDeadline>0&&Date.now()>this.indexDeadline){this.setError("index","MEMORY_INDEX_TIMEOUT");logSwallowed("index","MEMORY_INDEX_TIMEOUT");this.killOwn(this.child);return;}
        // An index batch can wait on its checked writer throughout the start
        // hold. Capture is CPU work on a separate queue in the helper; keeping
        // it behind that batch stranded new messages and their checkpoints.
        // Keep its normal owner, writer and pacing gates while allowing one
        // capture lease beside the independently acknowledged index batch.
        if(!this.work&&this.ready&&this.child&&!this.turnHeld()&&!writersHeldForIndexBuild()
          &&["capture","active"].includes(memoryState().mode)){
          const waiting=hasClaimableMemoryJob();
          const admission=ownerFirst.admit("memory-worker",{only:["owner-typing","work-starting"]});
          if(waiting&&admission.admitted&&!paced){
            if(ioBudget.backgroundRoom()<=0){captureRetryMs=ioBudget.claimRetryMs(hasClaimableCaptureJob());return;}
            const work=ioBudget.withSource("memory-capture",()=>claimMemoryJob(this.owner));
            if(work){this.work=work;this.deadline=Date.now()+60000;this.child.send(work);this.scheduleHeartbeat(this.child);}
          }else if(waiting)captureRetryMs=admission.admitted?Math.max(1,this.nextEligibleWorkAt-performance.now()):(admission.retryInMs??BUSY_RETRY_MS);
          else captureRetryMs=nextMemoryJobDelay()??null;
        }
        return;
      }
      if(this.work) {
        if(Date.now()>this.deadline) { this.failWork("MEMORY_WORKER_TIMEOUT");this.killOwn(this.child); }
        return;
      }
      // Memory off or paused: no consolidation, claim or capture projection is owed (the next wake or idle sweep looks again), but an owner
      // deletion still is: its index removals and the scrub the index owes run in every mode (memdel r2 High #2).
      const memoryOn=["capture","active"].includes(memoryState().mode);
      if(!memoryOn){this.consolidationDue=false;if(!this.scrubOwed&&!hasPendingProjection(database(),true))return;}
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
      // (a delegated reply waiting on a check is admitted past this hold too: hurryLineage)
      const ownerHold=this.hurrying()?null:ownerFirst.admit("memory-worker",{only:["owner-typing","work-starting"]});
      if(ownerHold&&!ownerHold.admitted){
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
      if(memoryOn && !ioBudget.shouldDefer("memory-idle") && this.options.onIdleConsolidation && !this.idleTask && Date.now()>=this.nextConsolidationPoll && !(ioBudget.backgroundRoom()<=0) && !this.idleHeld() && !this.idleUpgradeHeld() && this.idleTurn() && this.idleAdmitted()){
        this.nextConsolidationPoll=Date.now()+1000;
        this.consolidationWake=false;this.consolidationDue=false;this.idleBlockedSince=null;
        let worked=false;
        const task=Promise.resolve().then(()=>{
          if(this.turnHeld()||(this.work&&this.work!==cycleWork))return;
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
      if(ioBudget.backgroundRoom()<=0){this.schedule(ioBudget.claimRetryMs(hasClaimableCaptureJob()));return;}
      if(this.resetPending&&!this.applyIndexReset()){this.schedule(BUSY_RETRY_MS);return;}
      if(memoryOn)this.recoverCheckpoints();
      if(performance.now()<this.bgRetryAt)return;
      const projection=memoryOn?this.pendingProjection():hasPendingProjection(database(),true),job=memoryOn&&hasClaimableMemoryJob();
      // Nothing else to do: one bounded parking maintenance step (no helper is needed for it, unless the index owes a scrub).
      if(!projection&&!job&&!this.scrubOwed&&!this.resetDueNow()){if(memoryOn)this.maintain(false);return;}
      // Owed work makes a helper failure visible in status.
      this.warmStart=null;
      if(!this.child) { if(Date.now()>=this.respawnAt)this.spawnWithReset();else if(this.exactRespawn)this.schedule(Math.max(50,this.respawnAt-Date.now()+5)); return; }
      if(!this.ready) {
        if(Date.now()>this.initDeadline)this.failInit("MEMORY_WORKER_INIT_TIMEOUT");
        else if(job&&this.idleExit!==this.child&&this.captureReadyChild===this.child){
          // Opening the search index may wait for its age-gated copy reserve.
          // Capture is pure CPU over the leased text; its publication remains
          // fenced on this process's authority and native write admission.
          const work=ioBudget.withSource("memory-capture",()=>claimMemoryJob(this.owner));
          if(work){this.work=cycleWork=work;this.deadline=Date.now()+60000;this.child.send(work);this.scheduleHeartbeat(this.child);}
        }
        return;
      }
      // No cursor: every batch is read from the durable receipts, delete-pending first. Each batch is acknowledged when its rows are
      // written or removed (the scrub a forget owes is the index's own durable debt), so a batch never reselects the one before it.
      // MEMW: while a reset waits or runs, or a gate/floor answer holds, no index batch is formed (receipts stay pending).
      const child=this.child;
      const held=this.settleOverrun(child);
      // r3.2.8c M1 / r3.2.8d D5: settleOverrun may have started a planned exit (reset-exit): no batch, job or maintenance goes to that helper.
      if(!(this.child===child&&this.ready&&this.idleExit!==child))return;
      // Index/consolidation stays closed idle. A turn's durable capture debt
      // gets one bounded claim/publication slice under the idle byte ceiling.
      if(job&&ioBudget.admissionIdle()){
        const work=ioBudget.withSource("memory-capture",()=>claimMemoryJob(this.owner));
        if(work){this.work=work;this.deadline=Date.now()+60000;this.child.send(work);this.scheduleHeartbeat(this.child);}
        return;
      }
      const pendingRecords=projection&&!held?pendingProjectionRecords(database(),16,!memoryOn):[];
      // Ordinary indexing cannot settle its copy checks during the startup hold; leave that pool free for captures.
      const records=performance.now()-this.chargeStartEntry.at<(this.options.startHoldMs??CHARGE_START_HOLD_MS)
        ?pendingRecords.filter(row=>row.state==="deleted"&&Number(row.rolled)!==1):pendingRecords;
      let indexWaitMs:number|null=null;
      if(records.length){
        const page=ioMeterPageSize(),frames=indexStepFrames(4096,page),maximum=commitCeiling(frames,4096,page)+checkpointCeiling(frames,4096,page)+4*page;
        // Keep the parent's receipt/lease writes runnable while the helper
        // holds its pool, including when earlier work spent part of the minute.
        const ownerDelete=records.every(row=>row.state==="deleted"&&Number(row.rolled)!==1);
        if(ownerDelete){
          const key=records.map(row=>`${String(row.id)}:${Number(row.version)}`).join(",");
          if(key!==this.ownerDeleteWindowBatch){this.ownerDeleteWindowBatch=key;this.openOwnerDeleteWindow();}
        }
        const exempt=ownerDelete&&this.ownerDeleteWindowOpen();
        const ceiling=Math.min(maximum,ownerDelete?ioBudget.copyRoom(exempt):Math.max(0,ioBudget.backgroundRoom()-HELPER_PARENT_WRITE_ROOM));
        const minimum=commitCeiling(META_ENVELOPE_FRAMES+32,4096,page)+checkpointCeiling(META_ENVELOPE_FRAMES+32,4096,page)+4*page;
        // The helper retains a paid pool across batch acknowledgements and its owed copy-back.
        // Reuse that reservation; a second maximum reservation would strand the next batch.
        const pool=[...this.helperGrants.values()].some(ticket=>ticket.bytes>=minimum&&ticket.expiresAt>ioMeterWallTime());
        const admitted=pool||ceiling<minimum?null:ioBudget.admit(ownerDelete?"FGCOPY":"BG",ceiling,0,{ownerDeletion:exempt});
        if(!pool&&!admitted){
          // No room for an index batch this minute. A claimable capture is a turn's durable debt and needs far less than a
          // batch: it is claimed below under its own write admission, not parked behind the index until the next minute.
          if(!job){this.schedule(ioBudget.nextAdmissionMs());return;}
          indexWaitMs=ioBudget.nextAdmissionMs();
        }else{
          const grantId=admitted?randomUUID():null;if(admitted)this.helperGrants.set(grantId!,admitted);
          this.indexing=true;this.indexDeadline=Date.now()+60000;
          this.indexRequestId=randomUUID();
          // What each record was projected as, so its acknowledgement can be fenced against what it is when the ack lands.
          this.indexSent=new Map(records.map(r=>[`${String(r.id)}\u0000${Number(r.version)}`,String(r.state)]));
          this.indexRolled=new Set(records.filter(r=>Number(r.rolled)===1).map(r=>`${r.id}\u0000${r.version}`));
          this.child.send({type:"index",...(admitted?{grant:{...admitted,id:grantId,stepBytes:ceiling,purpose:ownerDelete?"owner-delete":"bg"}}:{}),requestId:this.indexRequestId,records:records.map(r=>({id:String(r.id),version:Number(r.version),scopeId:String(r.scopeId),text:r.state==="deleted"?"":String(r.text),deleted:r.state==="deleted",archived:r.state!=="active",...Number(r.rolled)===1?{rolled:true}:{},ageKey:r.ageKey===null||r.ageKey===undefined?null:Number(r.ageKey)}))});
          // A queued capture predating this batch has no later arrival to wake
          // it. Revisit it after this tick's normal pacing gap.
          if(job)this.wakeOwed=true;
          if(memoryOn)this.maintain(true);return;
        }
      }
      const work=job?ioBudget.withSource("memory-capture",()=>claimMemoryJob(this.owner)):null;
      if(work) {this.work=cycleWork=work;this.deadline=Date.now()+60000;this.child.send(work);this.scheduleHeartbeat(this.child);}
      else if(indexWaitMs!==null)admissionRetryMs=indexWaitMs;
      if(memoryOn)this.maintain(!!work);
    } catch(error) {
      clean=false;
      // A held write lock is "try again shortly": no error state, no attempt spent.
      if(isBgDeferred(error))admissionRetryMs=this.bgRetryDelay(error);
      else if(isDatabaseBusy(error)){busy=true;logSwallowed("capture",error,BUSY_RETRY_MS);}
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
      if(this.work||this.indexing){
        delay=Math.min(delay,Math.max(1,Math.min(this.work?this.deadline:Infinity,this.indexing&&this.indexDeadline>0?this.indexDeadline:Infinity)-Date.now()+1));
        if(captureRetryMs!==null)delay=Math.min(delay,Math.max(1,captureRetryMs));
      }
      else if(busy)delay=BUSY_RETRY_MS;
      else {
        try{
          delay=Math.min(delay,nextMemoryJobDelay()??delay);
          if(this.heldCompletions.size||checkpointDebtCount(database()))delay=Math.min(delay,Math.max(CHECKPOINT_CHECK_RETRY_MS,ioBudget.deferredForMs("memory-worker"),this.nextEligibleWorkAt-performance.now()));
        }catch{/* the fallback also covers a temporarily unavailable database */}
        if(paced)delay=Math.min(delay,Math.max(1,this.nextEligibleWorkAt-performance.now()));
        else if(parkMaintenancePending())delay=Math.min(delay,Math.max(PARK_STEP_MS,this.nextEligibleWorkAt-performance.now()));
        if(this.turnHeld())delay=Math.min(delay,Math.max(50,TURN_HOLD_MAX_MS-(performance.now()-this.turnHoldSince)));
        if(ownerRetryMs!==null)delay=Math.min(delay,Math.max(50,ownerRetryMs));
        // An earlier wake may have replaced the continuation timer: keep the owed consolidation on its deadline.
        // Once overdue, the continuation is only waiting on a deferral (the I/O budget, a run still in flight):
        // retry at the budget's next window, never sooner than PARK_STEP_MS, so the wait is not a tick storm.
        try{const wakeAt=indexResetWakeAt();if(wakeAt!==null)delay=Math.min(delay,Math.max(PARK_STEP_MS,wakeAt-Date.now()));}catch{/* the next sweep reads it */}
        if(this.consolidationDue){
          const until=this.nextConsolidationPoll-Date.now();
          delay=Math.min(delay,until>0?until:Math.max(PARK_STEP_MS,ioBudget.deferredForMs("memory-idle")));
        }
      }
      this.schedule(admissionRetryMs??delay);
      if(this.wakeOwed){this.wakeOwed=false;this.wake();}
    }
  }
  /** While the owner-first gate holds background work: claim only the newest recent capture of the threads whose turns are
   * starting (owner-first.ts startingThreads), the same recent-scopes claim a turn's own catch-up uses. Nothing to claim, no
   * helper ready yet, or no starting turn: nothing happens and the hold stands. Returns whether a job was sent. */
  private claimTurnCritical():boolean{
    if(ioBudget.backgroundRoom()<=0)return false;
    const threads=ownerFirst.startingThreads();
    if(!threads.length)return false;
    // Only the starting threads may publish checkpoints through the bounded debt driver while background work is held.
    if(performance.now()>=Math.max(this.nextEligibleWorkAt,this.bgRetryAt))this.recoverCheckpoints(true);
    if(!this.child||this.idleExit===this.child||(!this.ready&&this.captureReadyChild!==this.child))return false;
    // The starting turn's own capture, claimed by its job id (a primary-key write: no scope search, no claim-index read, whatever
    // else is queued). A thread with no noted capture (memory off, an excluded thread, already claimed) has nothing to claim here.
    for(const thread of threads){
      const jobId=turnCaptureJobId(thread);
      if(!jobId)continue;
      if(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND subject_id='checkpoint-pending'").get('checkpoint-debt:'+jobId))continue;
      // No lock wait: a busy file means "try at the next tick", never a 50 ms stall of the loop inside a held tick.
      let work:MemoryWork|null;
      try{work=ioBudget.withSource("memory-capture",()=>claimMemoryJob(this.owner,Date.now(),undefined,{recentWithinMs:CATCH_UP_WINDOW_MS,busyMs:0,jobId}));}
      catch(error){if(isDatabaseBusy(error))return false;throw error;}
      // Retain a claimed prompt's point hint until the durable driver has acknowledged its checkpoint.
      if(!work){forgetTurnCaptureJob(thread,jobId);continue;}
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
  /** When the pending lineage-warm timer fires (Date.now() ms; Infinity: none pending). */
  private lineageWarmDue=Infinity;
  /** Asks for a slice of lineage warming soon (lineage-warm.ts): after a start, and when a turn reaches a thread that is not warm.
   * Idle-only like the status scan: it waits for the owner's turn, typing and load, and each slice is short. */
  wakeLineageWarm(delay=0){this.scheduleLineageWarm(delay);}
  private hurryUntil=0;
  /** A delegated reply is waiting on this memory's checks (DELEGATED-REPLY-WITHHELD.md section 4): for `ms`, lineage warming and the
   * worker's tick are admitted past owner-first (the turn hold, io budget and upgrade yield still apply, so slices stay short). */
  hurryLineage(ms:number){
    this.hurryUntil=Math.max(this.hurryUntil,performance.now()+Math.max(0,ms));
    this.scheduleLineageWarm(0);this.wake();
  }
  /** Whether a hurry is in force now. */
  hurrying():boolean{return performance.now()<this.hurryUntil;}
  private scheduleLineageWarm(delay:number){
    if(this.stopping||!this.started||!this.options.onLineageWarm)return;
    const due=Date.now()+Math.max(0,delay);
    // 1.0.18 TURNSTART r14 EARLIEST WINS: a wake sooner than the pending timer replaces it (a turn's wake is never parked behind a
    // 500 ms backoff or an admission retry); a later one never postpones an earlier. One timer at most.
    if(this.lineageWarmTimer){
      // MUTANT:earliest-wins-noop
      if(due < this.lineageWarmDue){clearTimeout(this.lineageWarmTimer);this.lineageWarmTimer=null;}
      else return;
    }
    this.lineageWarmDue=due;
    this.lineageWarmTimer=setTimeout(()=>{
      this.lineageWarmTimer=null;this.lineageWarmDue=Infinity;
      if(this.stopping)return;
      if(writersHeldForIndexBuild()){this.deferForHold(this.resumeLineageWarm);return;}
      if(this.turnHeld()||(ioBudget.backgroundRoom()<=0)){this.scheduleLineageWarm(500);return;}
      if(this.upgradeYield()){this.scheduleLineageWarm(UPGRADE_RECHECK_MS);return;}
      // a delegated reply waiting on this thread's lineage is admitted past owner-first (hurryLineage)
      const admission=this.hurrying()?{admitted:true as const}:ownerFirst.admit("memory-lineage");
      if(!admission.admitted){this.scheduleLineageWarm(Math.max(500,admission.retryInMs));return;}
      let more=false;
      try{
        more=ioBudget.withSource("memory-idle",()=>{
          const started=performance.now();
          const result=this.options.onLineageWarm!(()=>this.turnHeld()||(ioBudget.backgroundRoom()<=0)||this.upgradeYield());
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
      if(this.turnHeld()||(ioBudget.backgroundRoom()<=0)){this.scheduleStatusScan(500);return;}
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
      catch(error){if(isBgDeferred(error)){setTimeout(run,this.bgRetryMs(error)).unref();return;}this.swallowed("capture","helper","MEMORY_WORKER_MESSAGE_FAILED",error);}
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
      try{alive=ioBudget.withSource("memory-capture",()=>withBusyBudget(BACKGROUND_BUSY_MS,"heartbeat",()=>heartbeatMemoryJob(this.work!,this.owner)));}
      catch(error){
        // A held lock only delays the beat: the lease has 30 s and beats every 10.
        if(!isDatabaseBusy(error)&&!isBgDeferred(error))throw error;
        logSwallowed("capture",error,10_000);
      }
      if(!alive)this.killOwn(child);
      else this.scheduleHeartbeat(child);
    };
    this.heartbeat=setTimeout(beat,10000);
    this.heartbeat.unref();
  }
  /** When the next look for set-aside copies of the memory index is due (0: at the next tick). */
  private quarantineSweepAt=0;
  private quarantineSweepFailures=0;
  /** A set-aside copy of the memory index (index-quarantine.ts) still holds the words of deleted conversations. The helper removes
   * them when it opens the index, but a start with nothing owed never runs a helper, and a removal can fail (a file held open on
   * Windows): so start looks too, in every memory mode, and one left behind is tried again (30 s doubling to
   * 30 min) until it is gone. A helper's start ("initialised") looks again. Never touches anything but those names (MEMINDEX-BUSY-109). */
  private sweepIndexQuarantines(){
    if(Date.now()<this.quarantineSweepAt)return;
    const {left}=removeIndexQuarantines(join(DATA_DIR,"memory-index.db"));
    if(!left.length){this.quarantineSweepFailures=0;this.quarantineSweepAt=Number.POSITIVE_INFINITY;return;}
    this.quarantineSweepFailures++;
    const wait=Math.min(30*60_000,MEMORY_IDLE_SWEEP_MS*2**Math.min(16,this.quarantineSweepFailures-1));
    logSwallowed("capture","MEMORY_INDEX_QUARANTINE_LEFT",wait);
    this.quarantineSweepAt=Date.now()+wait;this.schedule(wait);
  }
  private clearInitWatch(){if(this.initWatch)clearTimeout(this.initWatch);this.initWatch=null;}
  private failInit(reason:string){
    this.clearInitWatch();
    this.failedStart=this.child;this.backOffStart(reason);
    this.killOwn(this.child);
  }
  /** H.1 5-6: the open-exit streak. A qualifying exit: the helper said `index-opening`, exited with a nonzero code, sent no charge and no
   * `initialised`, and was not ended by the controller, planned, or stopping. Every other exit, and `initialised`, breaks the streak. The
   * second one asks the helper-independent probe (synchronous, never waits, a read-only open of the index); only `damaged` or `unsafe`
   * writes the overrun row (the next start then carries R, kind "open"). No await anywhere: the stop path is untouched. */
  private noteHelperExit(child:ChildProcess,code:number|null){
    const life=this.life?.child===child?this.life:null;
    const qualifying=!this.stopping&&life!==null&&life.opening&&!life.charged&&!life.initialised&&!life.own&&this.idleExit!==child&&typeof code==="number"&&code!==0;
    if(!qualifying){this.openExitStreak=0;return;}
    if(++this.openExitStreak<2)return;
    const started=performance.now();
    let probe:IndexProbe="busy";
    try{probe=probeIndexFile(join(DATA_DIR,"memory-index.db"));}
    catch(error){logSwallowed("index",error,isDatabaseBusy(error)?BUSY_RETRY_MS:undefined);}
    finally{traceSlowStep("memory.index-probe",performance.now()-started);}
    if(probe!=="damaged"&&probe!=="unsafe"){this.openExitStreak=0;logSwallowed("index","MEMORY_INDEX_OPEN_NOT_DAMAGE",MEMORY_IDLE_SWEEP_MS);return;}
    try{requestIndexOpenReset();this.openExitStreak=0;}
    catch(error){logSwallowed("index",error,isDatabaseBusy(error)?BUSY_RETRY_MS:undefined);/* the streak stays at 2: the next open exit asks again */}
  }
  /** A helper that never became ready: the status shows why, and the next start waits (30 s, doubling to 30 min). */
  private backOffStart(reason:string){
    if(!this.quietWarmFailure(this.child))this.setError("helper",reason);
    logSwallowed("capture",reason);this.waitBeforeNextStart();
  }
  private waitBeforeNextStart(){
    // H.1 4: a start that was refused inside the hold failed for the hold's sake, not its own: no doubling, back at the hold's end.
    if(this.child&&this.holdRefusedChild===this.child){
      const holdEnd=this.chargeStartEntry.at+(this.options.startHoldMs??CHARGE_START_HOLD_MS);
      this.respawnAt=Date.now()+Math.max(0,holdEnd-performance.now());this.exactRespawn=true;
      this.schedule(Math.max(50,this.respawnAt-Date.now()));
      return;
    }
    this.initFailures++;
    this.respawnAt=Date.now()+Math.min(30*60_000,MEMORY_IDLE_SWEEP_MS*2**(this.initFailures-1));
  }
  /** A helper only a warm asked for, with no search waiting on it: its failure goes to the log, not the status. */
  private quietWarmFailure(child:ChildProcess|null){return child!==null&&child===this.warmStart&&this.queries.size===0;}
  private clearHeartbeat(){if(this.heartbeat)clearTimeout(this.heartbeat);this.heartbeat=null;}
  /** The helper's writes as an io-budget source, from the counts it reports (noteWorkerIo). Earlier builds read the index file
   * and its log from here, which missed every write cycle that ended between two samples: a merge, then a truncation, leaves the
   * log at zero and the file the same size (1.0.3 rehearsal 2, 240 MB/min unseen). */
  private registerWorkerBytes(){
    if(!this.unregisterBytes)this.unregisterBytes=ioBudget.registerByteSource("memory-worker",()=>this.workerBytes,{child:true});
  }
  /** A helper's cumulative counts, fsWrite blocks and index WAL bytes (worker.ts reportIo): the larger growth of the two since the last
   * report is charged (the same writes, seen twice; on win32 the blocks read 0 and the WAL bytes decide). Each helper counts from zero,
   * so its first report is charged whole: the baseline is the reporting helper's own (a new one starts at zero), and a count that fell
   * is a new process's too. A count that is missing or not finite is left out; a report with neither charges nothing. */
  private noteWorkerIo(child:unknown,blocks:unknown,bytes:unknown){
    const valid=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>=0;
    const b=valid(blocks)?blocks:undefined,w=valid(bytes)?bytes:undefined;
    if(b===undefined&&w===undefined)return;
    if(child!==this.workerBlocksChild||(b!==undefined&&b<this.workerBlocks)||(w!==undefined&&w<this.workerWalBytes)){this.workerBlocksChild=child;this.workerBlocks=0;this.workerWalBytes=0;}
    this.workerBytes+=this.spendChargeCredit(Math.max(b===undefined?0:(b-this.workerBlocks)*BLOCK_BYTES,w===undefined?0:w-this.workerWalBytes));
    if(b!==undefined)this.workerBlocks=b;
    if(w!==undefined)this.workerWalBytes=w;
    // IPC reports are transaction boundaries too: periodic writers share the
    // allowance now, rather than discovering a helper's storm at the minute tick.
    ioBudget.sampleByteSource("memory-worker");
  }
  private workerBlocksChild:unknown=null;
  private workerWalBytes=0;
  private acceptChildIo(child:ChildProcess,message:Record<string,unknown>):void{
    if(this.childIo?.child!==child)return;
    const receipt=this.childIo.receipts.accept(message);
    if(!receipt)return;
    this.noteWorkerIo(child,receipt.blocks,receipt.bytes);
    if(receipt.final)try{child.send({type:"io-final-ack",generation:this.childIo.receipts.generation,sequence:message.sequence});}catch{markIoMeterUnknown();}
  }
  /** MEMW r3.2.8 3.1.4: while the row is 'requested' the readers are drained before the helper that carries R starts (a scan of the old
   * set must not hold the file through trigger A's rename). */
  private spawnWithReset(){
    let requested=false;
    try{requested=indexResetRequested()!==null;}catch(error){logSwallowed("index",error,isDatabaseBusy(error)?BUSY_RETRY_MS:undefined);this.schedule(BUSY_RETRY_MS);return;}
    if(!requested||memoryIndexScansActive()===0){this.spawn();return;}
    this.runResetDrain(()=>{if(!this.child&&!this.stopping)this.spawn();});
  }
  /** H.1 4 / H.2 3: a start that carries R waits until the controller is OPEN_RESERVE_MIN_AGE_MS old, so its open can use the reserve; only
   * while the hold is in force (past it, or at startHoldMs 0, it starts at once). 0 when no wait is owed. */
  private resetSpawnWaitMs():number{
    const age=performance.now()-this.chargeStartEntry.at;
    if(age>=OPEN_RESERVE_MIN_AGE_MS||age>=(this.options.startHoldMs??CHARGE_START_HOLD_MS))return 0;
    try{if(indexResetRequested()===null)return 0;}catch{return 0;}
    return OPEN_RESERVE_MIN_AGE_MS-age+1;
  }
  private spawn() {
    const boot=ioBudget.admit("BG",1024*1024);
    if(!boot){this.schedule(ioBudget.nextAdmissionMs());return;}
    const bootId=randomUUID();this.helperGrants.set(bootId,boot);
    const wait=this.resetSpawnWaitMs();
    if(wait>0){ioBudget.settle(boot,0);this.helperGrants.delete(bootId);this.schedule(wait);return;}
    this.exactRespawn=false;
    this.registerWorkerBytes();
    this.initDeadline=Date.now()+MEMORY_WORKER_INIT_MS;this.captureReadyChild=null;this.idleExited=false;this.modelReady=false;this.wasmHelper=false;this.warmSent=false;
    // The helper may rebuild or rename a damaged index while it starts: the main process holds no handle until it says it is ready.
    blockMemoryIndexReader();
    const generation=randomUUID();
    let child:ChildProcess;
    try{child=fork(SPAWNED_PROXIES.memoryWorker,[],withHideInherit({execArgv:["--experimental-strip-types"],stdio:["ignore","ignore","pipe","ipc"],
      env:{ELECTRON_RUN_AS_NODE:"1",
        MURAGE_IO_GENERATION:generation,
        MURAGE_BG_BOOT:JSON.stringify({...boot,id:bootId}),
        ...(process.env.NODE_ENV==="test"?{NODE_ENV:"test",MURAGE_ENGINE_EXCLUSION_PATH:process.env.MURAGE_ENGINE_EXCLUSION_PATH}:{}),
        ...(process.env.MURAGE_RESOURCES_PATH?{MURAGE_RESOURCES_PATH:process.env.MURAGE_RESOURCES_PATH}:{}),
        ...(process.env.OMB_RESOURCES_PATH?{OMB_RESOURCES_PATH:process.env.OMB_RESOURCES_PATH}:{}),
        ...(process.env.MURAGE_PACKAGED?{MURAGE_PACKAGED:process.env.MURAGE_PACKAGED}:{}),
        // The helper loads the server's config, which reads the home directory as it loads: it gets the server's own data
        // directory and home, or an account with no home entry cannot start a helper at all (RED2C).
        MURAGE_DATA_DIR:DATA_DIR,...(process.env.HOME?{HOME:process.env.HOME}:{}),...(process.env.USERPROFILE?{USERPROFILE:process.env.USERPROFILE}:{}),...(process.env.MURAGE_MEMORY_BACKEND==="wasm"?{MURAGE_MEMORY_BACKEND:"wasm"}:{}),...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})}}));
    }catch(error){ioBudget.settle(boot,0);this.helperGrants.delete(bootId);throw error;}
    this.child=child;this.life={child,opening:false,charged:false,initialised:false,own:false};
    this.childIo={child,receipts:new ChildIoReceipts(generation,markIoMeterUnknown)};
    // The tick checks this deadline only when work is owed. With nothing owed (a warm at boot) a helper stuck starting would leave recall shut out for good.
    // One sweep later than the deadline, so when work is owed the tick still decides, on its own timing.
    this.clearInitWatch();
    this.initWatch=setTimeout(()=>{this.initWatch=null;if(this.child===child&&!this.ready&&!this.stopping)this.failInit("MEMORY_WORKER_INIT_TIMEOUT");},MEMORY_WORKER_INIT_MS+MEMORY_IDLE_SWEEP_MS);
    this.initWatch.unref?.();
    // What the helper prints when it swallows a failure reaches the log (rate limited), not the void.
    const forward=makeStderrForwarder();
    child.stderr?.setEncoding("utf8");child.stderr?.on("data",chunk=>forward(String(chunk)));
    child.on("message", (message: unknown)=>this.receiveWorkerMessage(child,message));
    const gone=(code:number|null=null)=>{if(this.child===child){
      if(this.childIo?.child===child){this.childIo.receipts.exit();this.childIo=null;}
      // An exit before "ready" that nothing asked for (failInit already counted its own kill) is a failed start, never a silent respawn.
      if(!this.ready&&!this.stopping&&this.idleExit!==child&&this.failedStart!==child)this.backOffStart("MEMORY_WORKER_START_FAILED");
      for(const ticket of this.helperGrants.values())ioBudget.settle(ticket,ticket.bytes);
      this.helperGrants.clear();
      this.failedStart=null;this.warmStart=null;this.clearInitWatch();
      this.noteHelperExit(child,code);
      this.unblockUnlessResetRequested();setIndexWriterDrain(false);setWalCheckpointRequester(null);setScrubRewriteFinisher(null);this.settleCheckpoints(false);
      if(this.startReset?.child===child)this.startReset=null;
      // A helper that goes away because Murage is quitting says nothing about the job it held: it reschedules without spending an attempt.
      this.modelReady=false;const planned=this.idleExit===child;this.idleExit=null;if(planned&&!this.stopping)this.idleExited=true;
      this.clearHeartbeat();this.failWork(this.stopping?"MEMORY_WORKER_STOPPED":"MEMORY_WORKER_EXITED");this.child=null;this.ready=false;this.indexing=false;
      // A planned exit (idle or reset-exit) loses no search that was never sent: it waits for the next helper. One already sent to this
      // helper is rejected now (r3.2.8c M3), so the search's own fallback answers inside its deadline.
      if(planned&&!this.stopping)for(const [requestId,pending] of this.queries)if(pending.sent){this.queries.delete(requestId);pending.cleanup();pending.reject(new Error("MEMORY_WORKER_EXITED"));}
      if(planned&&!this.stopping&&this.queries.size)this.spawnWithReset();
      else{for(const pending of this.queries.values()){pending.cleanup();pending.reject(new Error("MEMORY_WORKER_EXITED"));}this.queries.clear();}
      let delay=MEMORY_IDLE_SWEEP_MS;
      if(!this.stopping)try{delay=Math.min(delay,nextMemoryJobDelay()??delay);}catch{/* the lease remains recoverable by the fallback */}
      // A record that arrived while the helper was leaving was seen by a tick that found no ready helper and did nothing: look again now.
      if(planned&&!this.stopping)delay=0;
      this.schedule(delay);
    }};
    child.on("exit",gone);
    // A process that never started has no exit to wait for.
    child.on("error",error=>{if(!this.quietWarmFailure(child))this.setError("helper","MEMORY_WORKER_START_FAILED");logSwallowed("capture",error);if(child.pid===undefined)gone();});
  }
  /** A message from the helper. While a writer hold is in force, a message whose handling writes is queued (in order) and dispatched once
   * the hold is released; the read-only ones (search results, checkpoint answers, the hello) are not held, so a search never waits on a VACUUM. */
  private settleHelperGrant(message:unknown):void {
    const receipt=message as {id?:string;used?:unknown};
    const ticket=typeof receipt.id==="string"?this.helperGrants.get(receipt.id):undefined;
    if(ticket&&Number.isSafeInteger(receipt.used)&&Number(receipt.used)>=0&&Number(receipt.used)<=ticket.bytes){
      ioBudget.settle(ticket,Number(receipt.used));this.helperGrants.delete(receipt.id!);
    }
  }
  private receiveWorkerMessage(child:ChildProcess,message:unknown){
    if(this.child!==child)return;
    const type=(message as {type?:unknown}|null)?.type;
    if(type==="bg-grant-settle"){this.settleHelperGrant(message);return;}
    // A final byte receipt has no database writes. It must pass a writer hold
    // and stop(), which is waiting for this exact child's final receipt/exit.
    if((message as {ioProtocol?:unknown}|null)?.ioProtocol===1){
      this.acceptChildIo(child,message as Record<string,unknown>);
      if(type==="io")return;
    }
    if(this.stopping)return;
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
  private helperGrants=new Map<string,AdmissionTicket>();
  private onWorkerMessage(child:ChildProcess,message:unknown){
    const handlerStart=performance.now();
    {
      if(!message||typeof message!=="object")return;
      const event=message as {type?:string;result?:unknown;requestId?:string;reset?:boolean;records?:Array<{id:string;version:number;deleted:boolean}>;embeddingStatus?:string;scrubOwed?:boolean;fsWriteBlocks?:unknown;ioBytes?:unknown};
      const versioned=(message as {ioProtocol?:unknown}).ioProtocol===1;
      if(versioned)this.acceptChildIo(child,message as Record<string,unknown>);
      // the helper's own write counts ride on its index acknowledgements and its maintenance reports (worker.ts reportIo)
      if(!versioned&&("fsWriteBlocks" in event||"ioBytes" in event))this.noteWorkerIo(child,event.fsWriteBlocks,event.ioBytes);
      if(event.type==="bg-grant-request"){
        const ceiling=Number((message as {ceiling?:unknown}).ceiling);
        const valid=Number.isSafeInteger(ceiling)&&ceiling>=0;
        let ticket:ReturnType<typeof ioBudget.admit>=null;
        let stepBytes:number|undefined;
        // Replanning producer/consumer owner: c3-memory; native caps owner: scperf-p1.
        // An adaptive write may resize to the available pool. Fixed copies
        // still require their full ceiling, and no operation runs on an offer
        // until the helper has rebuilt its step for that pool.
        if(valid){
          const adaptive=(message as {replan?:unknown}).replan===true;
          const ownerDelete=(message as {purpose?:unknown}).purpose==="owner-delete";
          const page=ioMeterPageSize(),exempt=ownerDelete&&this.ownerDeleteWindowOpen();
          const minimum=commitCeiling(META_ENVELOPE_FRAMES+32,4096,page)+checkpointCeiling(META_ENVELOPE_FRAMES+32,4096,page)+4*page;
          let room=adaptive?Math.min(ceiling,ownerDelete?ioBudget.copyRoom(exempt):Math.max(0,ioBudget.backgroundRoom()-HELPER_PARENT_WRITE_ROOM)):ceiling;
          // Startup maintenance cannot finish its copy yet; offer one checked metadata step instead of retaining the minute's pool.
          if(adaptive&&!ownerDelete&&performance.now()-this.chargeStartEntry.at<(this.options.startHoldMs??CHARGE_START_HOLD_MS))room=Math.min(room,minimum);
          if(room===ceiling||room>=minimum){ticket=ioBudget.admit(ownerDelete?"FGCOPY":"BG",room,0,{ownerDeletion:exempt});if(ticket&&room<ceiling)stepBytes=room;}
        }
        // A helper explicitly waiting for a refused byte permit is alive.
        // Keep its CPU capture queue available through the next admission window.
        if(!ticket&&this.indexing)this.indexDeadline=Date.now()+ioBudget.nextAdmissionMs()+60000;
        if(!ticket&&!this.ready){
          const delay=ioBudget.nextAdmissionMs()+MEMORY_WORKER_INIT_MS;
          this.initDeadline=Date.now()+delay;this.clearInitWatch();
          this.initWatch=setTimeout(()=>{this.initWatch=null;if(this.child===child&&!this.ready&&!this.stopping)this.failInit("MEMORY_WORKER_INIT_TIMEOUT");},delay+MEMORY_IDLE_SWEEP_MS);this.initWatch.unref();
        }
        const id=randomUUID();if(ticket)this.helperGrants.set(id,ticket);
        child.send({type:"bg-grant",ticket:ticket?{...ticket,id,purpose:(message as {purpose?:unknown}).purpose==="owner-delete"?"owner-delete":"bg",...stepBytes!==undefined?{stepBytes}:{}}:null,retryInMs:ioBudget.nextAdmissionMs()});return;
      }
      if(event.type==="bg-grant-settle"){this.settleHelperGrant(message);return;}
      if(event.type==="io")return;
      // r3.2.2 D1: a checkpoint charge, granted or refused in this handler turn; the helper runs the checkpoint only on a grant. The ack
      // names the charge's (helperRunId, fileId, attempt) (r3.2.6 A2'): the helper accepts an ack only for its outstanding charge.
      if(event.type==="charge"){
        const charge=event as {fileId?:unknown;attempt?:unknown;bytes?:unknown;helperRunId?:unknown;opening?:unknown;purpose?:unknown};
        if(this.life?.child===child)this.life.charged=true;
        const granted=this.answerCharge(child,charge);
        try{child.send({type:"charge-ack",fileId:charge.fileId,attempt:charge.attempt,granted,helperRunId:charge.helperRunId});}catch{/* the helper is gone; a grant stays debited */}
        return;
      }
      // H.1 6: the helper is about to open the index (a no-op marker; the streak reads it at exit)
      if(event.type==="index-opening"){if(this.life?.child===child)this.life.opening=true;return;}
      if(event.type==="ready"){
        if(this.idleExit===child)return;
        this.captureReadyChild=child;
        this.wake();
        const manifestFile=join(SERVER_ROOT,"memory-model-manifest.json");
        const manifest=this.options.manifest??JSON.parse(readFileSync(existsSync(manifestFile)?manifestFile:join(SERVER_ROOT,"..","shared","memory-model-manifest.json"),"utf8"));
        const init=(modelDirectory:string,extra:{fallbackModelDirectory?:string;strictModelRoot?:boolean}={})=>{if(child.connected===false)return;
          // r3.2.8 3.1.4: R is read from the durable row before the helper's first open; a row that cannot be read is a failed start.
          let reset:IndexResetRequest|null;
          try{reset=indexResetRequested();}catch(error){logSwallowed("index",error);this.failInit("MEMORY_WORKER_START_FAILED");return;}
          this.startReset=reset?{child,resetId:reset.resetId}:null;
          child.send({type:"init",...reset?{reset}:{},authorityPath:join(DATA_DIR,"messages.db"),indexPath:join(DATA_DIR,"memory-index.db"),modelDirectory,manifest,...this.options.wasmIdleExitMs!==undefined?{wasmIdleExitMs:this.options.wasmIdleExitMs}:{},...extra});};
        // The app's own verified copy wins; otherwise the user's downloaded copy path (never modified here).
        if(this.options.modelDirectory||!bundledModelDirectory()){init(this.options.modelDirectory??join(DATA_DIR,"memory-model"));return;}
        void resolveMemoryModelDirectory(manifest,{dataDir:DATA_DIR}).then(resolved=>init(resolved.directory,resolved.source==="bundled"?{fallbackModelDirectory:resolved.fallback,strictModelRoot:true}:{}),()=>init(join(DATA_DIR,"memory-model")));
        return;
      }
      // MEMW: the helper's durable stop (index-stop), its gate clearing, and its drain of every reader snapshot (1.11)
      if(event.type==="index-stop"){const stop=(event as {stop?:IndexStopReport}).stop;if(stop&&typeof stop.fileId==="string"&&typeof stop.seq==="number")this.stopSeen=stop;this.settleOverrun(child);return;}
      if(event.type==="gate-clear"){if(this.batchHold?.reason==="segment-gate"||this.batchHold?.reason==="age-blocked")this.batchHold=null;this.scheduleTick(handlerStart);return;}
      if(event.type==="wal-drain"){setIndexWriterDrain((event as {on?:unknown}).on===true);try{child.send({type:"wal-drain-ack"});}catch{/* the helper is gone; its exit clears the drain */}return;}
      if(event.type==="model-ready"){if(this.child===child)this.modelReady=true;return;}
      // The helper's own deletion-scrub debt: messages arrive in order, so the newest says whether any is left.
      if(event.type==="scrub-done"){this.scrubOwed=false;this.closeOwnerDeleteWindow();return;}
      if(event.type==="initialised"){
        if(this.life?.child===child)this.life.initialised=true;
        this.openExitStreak=0;
        this.wasmHelper=(event as {wasm?:boolean}).wasm===true;
        // MEMW: every initialised carries the helper's stop and the reset it finished (R10 fields)
        const init=event as {resetDone?:unknown;walOverStop?:IndexStopReport|null;gateClear?:unknown};
        const carried=this.startReset?.child===child?this.startReset.resetId:null;
        // r3.2.8 3.3.1: only an initialised from the start that carried R, with resetDone = R and no stop, completes R.
        const finished=carried!==null&&init.resetDone===carried&&!init.walOverStop;
        if(finished)this.resetDoneSeen=carried;
        if(init.walOverStop&&typeof init.walOverStop.fileId==="string"&&typeof init.walOverStop.seq==="number")this.stopSeen=init.walOverStop;
        if(this.batchHold?.reason==="merge-floor"||((this.batchHold?.reason==="segment-gate"||this.batchHold?.reason==="age-blocked")&&init.gateClear===true))this.batchHold=null;
        this.scrubOwed=event.scrubOwed===true;if(!this.scrubOwed)this.closeOwnerDeleteWindow();
        // The index was rebuilt: every record is owed to it again. If the database is locked just now the owing is kept and applied by the next tick
        // (before any indexing starts), not lost and not thrown into the message handler.
        if(event.reset&&carried===null)this.resetPending=true;
        // r3.2.8 3.1.6: a start that carried R and did not finish it is a failed start (backoff; the respawn carries R; readers stay blocked).
        if(carried!==null&&!finished){this.failInit("MEMORY_INDEX_RESET_FAILED");return;}
        this.settleOverrun(child);
        // r3.2.8c M1: the marker unlink failed and this helper was sent reset-exit: it never becomes ready.
        if(this.idleExit===child)return;
        // A turn on its way to the engine comes first: the next tick applies the owing (resetPending) instead.
        if(!this.turnHeld())this.applyIndexReset();
        // The helper removed the copies it could when it opened the index; any it could not are looked for again from the next tick.
        this.quarantineSweepAt=0;
        this.ready=true;this.initFailures=0;this.warmStart=null;this.clearInitWatch();this.clearError("helper");this.unblockUnlessResetRequested();setWalCheckpointRequester(()=>this.requestCheckpoint());setScrubRewriteFinisher(()=>this.requestFinishRewrite());
        for(const [requestId,pending] of this.queries)if(!pending.sent){pending.sent=true;try{sendSearch(m=>child.send(m),requestId,pending.input);}catch{this.queries.delete(requestId);pending.cleanup();pending.reject(new Error("MEMORY_QUERY_REFUSED"));logSwallowed("recall","MEMORY_QUERY_REFUSED");}}
        if(this.warmOwed){this.warmOwed=false;this.requestWarm(child);}
        this.scheduleTick(handlerStart);return;
      }
      if(event.type==="idle-exit-request"){
        // Granted only when nothing is owed to or by this helper; from then on the controller treats it as gone (searches wait, nothing is sent).
        if(this.child===child&&this.ready&&!this.queries.size&&!this.indexing&&!this.work&&!this.checkpoints.size){
          this.idleExit=child;this.captureReadyChild=null;this.ready=false;this.modelReady=false;this.initDeadline=Date.now()+MEMORY_WORKER_INIT_MS;
          try{child.send({type:"idle-exit"});}catch{this.killOwn(child);}
        }
        return;
      }
      if(event.type==="checkpoint-result"&&event.requestId){const done=this.checkpoints.get(event.requestId);if(done){this.checkpoints.delete(event.requestId);done((event as {ok?:boolean}).ok===true);}return;}
      if(event.type==="query-result"&&event.requestId){const pending=this.queries.get(event.requestId);if(pending){this.queries.delete(event.requestId);pending.cleanup();pending.resolve(event.result as MemorySearchResult);}return;}
      if(event.type==="index-result"){
        if(typeof event.scrubOwed==="boolean"){this.scrubOwed=event.scrubOwed;if(!event.scrubOwed)this.closeOwnerDeleteWindow();}
        if(event.requestId!==this.indexRequestId)return;
        // The helper has answered; its deadline cannot expire while our checked receipts wait for admission.
        this.indexDeadline=0;
        // A batch the helper answered failed lists only its committed records; the rest keep their pending receipts (1.8 R2, R3).
        const failed=(event as {failed?:unknown}).failed;
        if(failed==="segment-gate"||failed==="age-blocked"||failed==="merge-floor")this.batchHold={reason:failed,until:failed==="merge-floor"?Date.now()+INDEX_MERGE_FLOOR_REASK_MS:Number.POSITIVE_INFINITY};
        // The receipt writes (a synchronous transaction, one fsync) run on the next turn of the event loop, not
        // inside the IPC handler: `indexing` stays set until they are done, so no tick starts other work meanwhile.
        // They are written in slices of at most WORKER_SLICE_MS of row work, each its own transaction (every row's update is
        // fenced on its own), with a turn of the event loop between slices, so a large batch never holds the loop.
        // Receipt updates commute; key order keeps the pending index pages together and avoids repeated dirtying.
        const records=[...(event.records??[])].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.version-b.version),embeddingStatus=event.embeddingStatus,requestId=event.requestId,sent=this.indexSent,rolled=this.indexRolled;
        let next=0,receiptRows=2048;const points:Array<{rows:number;bytes:number}>=[];
        const writeReceipts=()=>{
          if(this.indexRequestId!==requestId)return;
          const started=performance.now(),from=next;
          // This fixed-size transaction can need the full statement allowance and its copy reserve.
          // The checked transaction sizes its grant to the room that remains
          // and rolls back/shrinks a refused slice. A fixed 2 MiB floor can
          // strand a small final slice despite enough admitted byte room.
          // The owner thread never waits for the admission ledger lock: a reading taken while the checkpointer thread holds it
          // comes back closed (no room). That is contention, not a spent minute: the same checked write is asked again a moment later.
          const lockMisses=ioBudget.admissionHealth().lockTimeouts;
          const room=ioBudget.backgroundRoom();
          if(room<=0){this.later(writeReceipts,ioBudget.admissionHealth().lockTimeouts>lockMisses?BUSY_RETRY_MS:ioBudget.nextAdmissionMs());return;}
          // Once a slice has committed, its measured all-in bytes per row (copy debt included) size the next one to the grant
          // the checked transaction will offer (half the room, at most 1 MiB), so a slice that cannot fit is never attempted.
          if(points.length){
            const grant=Math.min(Math.floor(room/2),1024*1024);
            // The two-size fit errs high on a tail of mixed sizes. When it finds no room, the single-size estimate (a quarter of the worst
            // slice as the fixed share) still gets one slice of the grant, so the drain does not wait while one fits; a refusal halves it.
            const worst=points.reduce((a,b)=>b.bytes/b.rows>a.bytes/a.rows?b:a);
            let fit=receiptRowsThatFit(points,grant);
            if(fit<1)fit=receiptRowsThatFit([worst],grant);
            if(fit<1){this.later(writeReceipts,ioBudget.nextAdmissionMs());return;}
            // A refusal's halved size stays in force until a commit restores 2048: the fit can only lower it.
            receiptRows=Math.min(receiptRows,fit);
          }
          const spentBefore=ioBudget.admissionState();
          let rowsDoneAt=started,rowCpuMs=0;
          const reportCpu=workerSliceTestHooks.rowWorkCpuMs;
          try{
            withStatementReuse(()=>{
              try{
                transaction(()=>{
                  const cpuStart=reportCpu?process.threadCpuUsage():null;
                  try{
                    while(next<records.length){
                      const chunkStarted=performance.now(),chunk=records.slice(next,Math.min(next+256,from+receiptRows));
                      const deleted:Array<[string,number,number]>=[],live:Array<[string,number,unknown]>=[];
                      for(const row of chunk){
                        const key=`${row.id}\u0000${row.version}`;
                        if(row.deleted)deleted.push([row.id,row.version,rolled.has(key)?0:1]);
                        else{const was=sent.get(key);if(was!==undefined)live.push([row.id,row.version,was]);}
                      }
                      next+=chunk.length;
                      // Bound JSON pages keep the same point fences without a prepare/run for every row.
                      // One recall change row stands for the chunk's receipt range when it holds at most 256 receipts: FIX3-DESIGN, recall-view-schema.ts coverReceiptChanges.
                      coverReceiptChanges(database(),[...deleted,...live].map(m=>[String(m[0]),Number(m[1])] as const),()=>{
                      if(deleted.length)database().prepare(`UPDATE memory_projection_receipts SET lexical_status='deleted',embedding_status='deleted' FROM json_each(?) j WHERE record_id=json_extract(j.value,'$[0]') AND record_version=json_extract(j.value,'$[1]') AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND ((r.state='deleted' AND json_extract(j.value,'$[2]')=1) OR (r.state!='deleted' AND lexical_status!='delete-pending' AND ${rolledCheckpointSql("r")})))`).run(JSON.stringify(deleted));
                      if(live.length)database().prepare(`UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status=? FROM json_each(?) j WHERE record_id=json_extract(j.value,'$[0]') AND record_version=json_extract(j.value,'$[1]') AND lexical_status!='delete-pending' AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=record_id AND r.version=record_version AND r.state=json_extract(j.value,'$[2]') AND r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND NOT ${rolledCheckpointSql("r")})`).run(embeddingStatus==="indexed"?"indexed":"unavailable",JSON.stringify(live));
                      });
                      const now=performance.now();
                      if(next-from>=receiptRows||now-started+(now-chunkStarted)>=WORKER_SLICE_MS)break;
                    }
                  }finally{
                    rowsDoneAt=performance.now();
                    if(cpuStart){const used=process.threadCpuUsage(cpuStart);rowCpuMs=(used.user+used.system)/1000;}
                  }
                });
              }
              // BEGIN can refuse before row work starts; that attempt still gets its zero sample.
              finally{reportCpu?.(rowCpuMs);}
            });
            // After the commit (its fsync included): one numbers-only line when the turn trace is on.
            traceIndexSlice(performance.now()-started,rowsDoneAt-started,next-from);
            const spentAfter=ioBudget.admissionState(),spent=spentAfter.bg+spentAfter.debt-spentBefore.bg-spentBefore.debt;
            if(next>from&&spent>0){points.push({rows:next-from,bytes:spent});if(points.length>8)points.shift();}
            receiptRows=2048;
            this.clearError("index");
          }catch(error){
            const attempted=next-from;
            next=from; // the slice rolled back
            // Row work exceeded this transaction's allowance: a smaller slice can still fit the current minute.
            if(isBgDeferred(error)&&attempted>1&&ioBudget.backgroundRoom()>0){receiptRows=Math.max(1,Math.floor(attempted/2));this.later(writeReceipts);return;}
            // The grant was refused while the ledger lock was held (nothing was admitted without it): asked again a moment later, not at the next minute.
            if(isBgDeferred(error)&&ioBudget.admissionHealth().lockTimeouts>lockMisses){logSwallowed("index",error,BUSY_RETRY_MS);this.later(writeReceipts,BUSY_RETRY_MS);return;}
            // The write lock is held elsewhere: the receipts are written a moment later, the job is not failed and nothing is shown.
            if(isBgDeferred(error)){const delay=this.bgRetryMs(error);logSwallowed("index",error,delay);this.later(writeReceipts,delay);return;}
            if(isDatabaseBusy(error)){logSwallowed("index",error,BUSY_RETRY_MS);this.later(writeReceipts,BUSY_RETRY_MS);return;}
            this.swallowed("index","index","MEMORY_INDEX_FAILED",error);
            next=records.length;
          }
          if(next<records.length){this.later(writeReceipts);return;}
          // Revocation erased these records' text in the main database after the chat's own log scrub: its log cleanup is owed again,
          // with its own bounded retries, apart from this batch.
          if(records.some(row=>row.deleted&&!rolled.has(`${row.id}\u0000${row.version}`)))void scrubWalAfterDelete().catch(()=>{});
          this.indexing=false;this.indexRequestId=null;this.indexSent=new Map();this.indexRolled=new Set();this.scheduleTick(started);
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
      // Publication runs after the handler returns, with the lease held until its durable debt commits.
      const deliver=()=>{
        if(this.work!==work)return;  // the work timed out or the worker exited in between
        this.clearHeartbeat();
        const started=performance.now();
        try {
          const result=resultSchema.parse(event.result);
          try { heldStep("memory.publish",()=>ioBudget.withSource("memory-capture",()=>publishMemoryWork(work,this.owner,result))); }
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
          // Capture is already durable and owes its checkpoint (the debt marker, which recoverCheckpoints also drives). Try it now
          // under the capture source; a refused byte permit or busy file retries at the next admission, never as a failed capture.
          if(result.status==="complete"){
            const refresh=(id:string,retry=false)=>{
              try{
                // The capture queue owns the next idle slice: a deferred derived refresh must not take it while a capture is queued or leased.
                if(retry&&(this.work||hasClaimableMemoryJob())){this.later(()=>refresh(id,true),ioBudget.nextAdmissionMs());return;}
                // Evidence still being checked: retried under capture admission for a bounded wait, not only on an active minute.
                if(this.refreshCheckpoint(id,false,"memory-capture")?.reason==="evidence-checking")this.oweCaptureCheckpoint(id);
              }catch(error){
                if(isBgDeferred(error)){this.later(()=>refresh(id,true),this.bgRetryDelay(error));return;}
                if(isDatabaseBusy(error)){this.later(()=>refresh(id,true),BUSY_RETRY_MS);return;}
                this.swallowed("capture","checkpoint","MEMORY_CHECKPOINT_FAILED",error);
              }
            };
            refresh(work.id);
          }
        } catch(error) {
          // The write lock is held elsewhere: publish a moment later. The lease is kept alive; no attempt is spent.
          // An acknowledged byte-permit wait is not a hung helper: the lease deadline covers the wait.
          if(isBgDeferred(error)){const delay=this.bgRetryMs(error);logSwallowed("capture",error,delay);this.deadline=Date.now()+delay+60000;this.scheduleHeartbeat(child);this.later(deliver,delay);return;}
          if(isDatabaseBusy(error)){logSwallowed("capture",error,BUSY_RETRY_MS);this.scheduleHeartbeat(child);this.later(deliver,BUSY_RETRY_MS);return;}
          logSwallowed("capture",error);this.failWork("MEMORY_RESULT_REJECTED");
        }
        this.work=null;
        // The one coalesced wake also drives the debt publication committed.
        this.scheduleTick(started);
      };
      // Publication runs after the handler returns, with the lease held until its durable debt commits.
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
      ioBudget.withSource("memory-worker",()=>withBusyBudget(BACKGROUND_BUSY_MS,"fail-work",()=>publishMemoryWork(failing,this.owner,{id:failing.id,leaseGeneration:failing.leaseGeneration,status:"deferred",nextCursor:failing.cursor,chunks:[],reason})));
      // The deferral ends this lease cycle as a publication does: the next
      // claim starts its stale count afresh (RED2L).
      this.staleRequeues.delete(this.staleKey(this.work));
    }
    catch(error) {
      // Superseded work is deliberately not acknowledged as a deferral, but
      // the job must not sit leased with nobody working it: release the
      // holder's own lease so the next claim picks it up at once.
      if(isStaleMemoryPublication(error))this.settleStale(error,reason);
      // C4: a refused deferral is retried by ONE timer at the budget's named time (a later refusal replaces it), never left for
      // lease_until; the retry is fenced by the lease generation, so a lease that moved on in between is left alone.
      // Its own delay, not bgRetryMs (D5, as the start steps): an idle refusal names the roll, and pacing every claim to it would hold
      // the idle capture drain and the owner's next message to the roll (re-armed each minute while idle). An arrival (wake) moves
      // this one timer to now, as it does the start steps'.
      else if(isBgDeferred(error)&&!this.stopping){
        const failing=this.work,delay=this.bgRetryDelay(error);logSwallowed("capture",error,delay);
        const retry=()=>{
          if(this.deferredFailure!==retry)return;
          // a second refusal re-arms this one timer at its own named time (never later()'s bgRetryMs catch); anything else ends it
          try{withBusyBudget(BACKGROUND_BUSY_MS,"fail-work",()=>publishMemoryWork(failing,this.owner,{id:failing.id,leaseGeneration:failing.leaseGeneration,status:"deferred",nextCursor:failing.cursor,chunks:[],reason}));}
          catch(again){
            if(isBgDeferred(again)&&!this.stopping){const next=this.bgRetryDelay(again);logSwallowed("capture",again,next);this.armDeferredFailure(retry,next);return;}
            this.deferredFailure=null;if(isStaleMemoryPublication(again))return;throw again;
          }
          this.deferredFailure=null;this.staleRequeues.delete(this.staleKey(failing));this.wake();
        };
        this.deferredFailure=retry;this.armDeferredFailure(retry,delay);
      }
      // A held write lock: the lease runs out by itself and the job is claimed again with its attempts untouched.
      else logSwallowed("capture",error);
    }
    this.work=null;
  }
  private deferredFailure:(()=>void)|null=null;
  private deferredFailureTimer:ReturnType<typeof setTimeout>|null=null;
  private deferredFailureNow=false;
  /** The one timer of a refused failWork deferral (replaced, never added to); it runs the retry through later() (turn and writer holds). */
  private armDeferredFailure(retry:()=>void,delayMs:number){
    if(this.deferredFailureTimer)clearTimeout(this.deferredFailureTimer);this.deferredFailureNow=delayMs<=0;
    this.deferredFailureTimer=setTimeout(()=>{this.deferredFailureTimer=null;this.deferredFailureNow=false;if(this.deferredFailure===retry)this.later(retry);},Math.max(1,delayMs));
    this.deferredFailureTimer.unref?.();
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
    this.deferredFailure=null;if(this.deferredFailureTimer)clearTimeout(this.deferredFailureTimer);this.deferredFailureTimer=null;this.deferredFailureNow=false;
    this.requested=false;this.consolidationWake=false;this.captureOwedCheckpoints.clear();
    if(this.captureOwedTimer)clearTimeout(this.captureOwedTimer);this.captureOwedTimer=null;
    if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);this.maintenanceTimer=null;
    if(this.notebookTimer)clearInterval(this.notebookTimer);this.notebookTimer=null;
    if(this.bootWarmTimer)clearTimeout(this.bootWarmTimer);this.bootWarmTimer=null;
    if(this.bootRecoveryTimer)clearTimeout(this.bootRecoveryTimer);this.bootRecoveryTimer=null;
    this.clearInitWatch();
    this.clearHeartbeat();
    this.unsubscribe?.();this.unsubscribe=null;
    for(const pending of this.queries.values()){pending.cleanup();pending.reject(new Error("MEMORY_WORKER_NOT_READY"));}this.queries.clear();
    this.consolidationAbort.abort();
    await Promise.allSettled([...this.consolidationTasks,...this.admissionWaiters,this.idleTask,this.maintenanceTask,this.continuityTask]);
    const child=this.child;
    // Past the grace the helper is ended: what it owes is durable, its index survives a kill (SQLite WAL), and every caller goes on
    // to work that must not depend on one busy helper (the rest of this stop, a change of memory mode, a Cloud home's drain).
    if(child)await new Promise<void>(resolve=>{
      let killed:ReturnType<typeof setTimeout>|undefined;
      // A kill not seen to land by the wait: the helper is let go, so the next start gets a new one and its late exit changes nothing.
      const letGo=()=>{if(this.child===child){if(this.childIo?.child===child){this.childIo.receipts.exit();this.childIo=null;}this.clearHeartbeat();this.failWork("MEMORY_WORKER_STOPPED");this.child=null;this.ready=false;this.indexing=false;this.modelReady=false;this.idleExit=null;this.warmStart=null;this.clearInitWatch();}resolve();};
      const grace=setTimeout(()=>{child.kill("SIGKILL");killed=setTimeout(letGo,MEMORY_WORKER_KILL_WAIT_MS);},MEMORY_WORKER_STOP_GRACE_MS);
      child.once("exit",()=>{clearTimeout(grace);if(killed)clearTimeout(killed);resolve();});
      if(this.childIo?.child===child&&this.childIo.receipts.negotiated){
        try{child.send({type:"io-stop"});}catch{markIoMeterUnknown();child.disconnect();}
      }else child.disconnect();
    });
    for(const ticket of this.helperGrants.values())ioBudget.settle(ticket,ticket.bytes);this.helperGrants.clear();
    ioBudget.sampleByteSource("memory-worker");this.unregisterBytes?.();this.unregisterBytes=null;
    if(this.statusScanTimer)clearTimeout(this.statusScanTimer);this.statusScanTimer=null;
    if(this.lineageWarmTimer)clearTimeout(this.lineageWarmTimer);this.lineageWarmTimer=null;this.lineageWarmDue=Infinity;
    try{ioBudget.withSource("memory-idle",()=>flushMemoryCounters(Date.now(),true));}catch{/* counters are advisory */}
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
        if(!this.child){if(Date.now()<this.respawnAt)throw new Error("MEMORY_WORKER_START_BACKOFF");this.spawnWithReset();}
        if(this.ready){pending.sent=true;sendSearch(m=>this.child!.send(m),requestId,input);}
      }catch{this.queries.delete(requestId);pending.cleanup();this.setError("helper","MEMORY_WORKER_START_FAILED");logSwallowed("recall","MEMORY_WORKER_START_FAILED");reject(new Error("MEMORY_WORKER_START_FAILED"));}
    });
  }
}
