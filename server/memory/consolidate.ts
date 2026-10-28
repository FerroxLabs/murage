import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import { isLearnableSource } from "./learnable.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { learningSourceBot,learningWriteDecision,learningEvidenceScopes } from "./learning-guard.ts";
import { readMemoryEvolutionPolicy } from "./evolution-policy.ts";
import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { extractCandidates, groundMemoryClaim, type ReservationRecord, type TextOnlyExtractor } from "./extract.ts";
import { SLICE_ATTEMPT_LIMIT, SLICE_CALL_GUARD, SLICE_CALL_LIMIT_REASON, type SkippedSlice } from "../../shared/memory-learning-contract.ts";
import type { DatabaseSync } from "node:sqlite";
import { activateGroundedMemory } from "./automatic-learning.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { threadCheckpointId, unsettledIntention } from "./checkpoints.ts";
import { LineageAllowance, prepareLineageCache, sourceIsWithheldMessage, sourceAwaitsProof } from "./replay-lineage.ts";
import { enqueueProcedureCorrectionReview } from "./procedure-review.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
import { heldStep } from "../observe.ts";
import { denyLookup, lineageLive, memoryLookup } from "./deny-read.ts";
import { memoryRefKey, type LineageVerdict } from "./lineage-types.ts";
import { inheritEdge } from "./revoke-commit.ts";
import { insertMemoryRecord } from "./record-write.ts";
import { redactSecretsInText } from "../redact.ts";
import { evidenceEmailDerived } from "./email-derived.ts";
import { fenceEmailDerived } from "../email/external-marks.ts";

type Handle={sourceId:string;revision:number;startByte:number;endByte:number};
/** Write-time (S4): what the consolidator may read of a source now. The source by its marks (deny_memory, tombstones, denied place, the
 * pending scope window); a captured message also by its line (denyLookup, content reader) once write-time lineage is written on this file.
 * "checking" defers the source (tried again later), "withheld" leaves it out; neither gives its words to the extractor. */
export function writetimeSourceState(source:Record<string,unknown>):LineageVerdict["state"]{
  const db=database();
  const ref={kind:"source" as const,id:String(source.id),version:Number(source.revision),scopeId:String(source.scope_id)};
  let state=memoryLookup(db,[ref],{audience:null}).get(memoryRefKey(ref))?.state??"checking";
  if(state==="shown"&&typeof source.thread_id==="string"&&typeof source.message_id==="string"&&lineageLive(db)){
    const line=denyLookup(db,{threadId:source.thread_id,lines:[{messageId:source.message_id,author:source.speaker==="owner"||source.speaker==="user"?"owner":"generated"}]},{audience:null}).get(source.message_id);
    state=line?.state??"checking";
  }
  return state;
}
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
function completedSource(jobId:string){
  const row=database().prepare(`SELECT j.status,j.cursor,s.*,length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS bytes
    FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE j.id=? AND j.stage='capture'`).get(jobId);
  if(!row||row.status!=="complete"||row.state!=="active"||row.cursor!==row.bytes)throw new Error("MEMORY_COMPLETED_SOURCE_REQUIRED");
  if(database().prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(row.id,row.revision))throw new Error("MEMORY_SOURCE_UNAVAILABLE");
  return row;
}
function checkpointEvidence(handle:Handle,scopeId:string,pending?:{checking:boolean}){
  const db=database();
  const source=db.prepare(`SELECT s.*,substr(CAST(json_extract(v.payload,'$.text') AS BLOB),?,?) AS excerpt
    FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.id=? AND s.revision=? AND s.state='active' AND s.scope_id=?
    AND EXISTS(SELECT 1 FROM memory_jobs j WHERE j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.status='complete'
      AND j.cursor=length(CAST(json_extract(v.payload,'$.text') AS BLOB)))`).get(handle.startByte+1,handle.endByte-handle.startByte,handle.sourceId,handle.revision,scopeId);
  if(!source||source.kind==="turn"||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.sourceId,handle.revision))return null;
  // A cancelled intention is not a completed effect; the same rule governs current recall.
  if((source.kind === "tool-outcome" || source.kind === "activity") && source.outcome === "failed")return null;
  if(unsettledIntention(db,source))return null;
  // A reply withheld from bots (replay-lineage.ts) is not carried forward
  // either: the next checkpoint is rebuilt without it.
  if(sourceIsWithheldMessage(LineageAllowance.tool(),source))return null;
  // "checking" is a revoke still being marked (a pending window), not a verdict: the roll waits for it (below) instead of dropping this evidence
  const verdict=writetimeSourceState(source);
  if(verdict!=="shown"){if(verdict==="checking"&&pending)pending.checking=true;return null;}
  const bytes=source.excerpt as Uint8Array;
  if(bytes.length!==handle.endByte-handle.startByte||bytes.length===0)return null;
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{return null;}
  return {handle,text,speaker:String(source.speaker),outcome:String(source.outcome)};
}

/** Invoke once after an accepted complete capture publication, never on raw events.
 * Maintains at most four direct original-source references; never summarizes an
 * earlier summary, deletes source evidence, promotes authority, or writes pins.
 */
export function refreshMemoryCheckpoint(completedJobId:string){ return heldStep("memory.checkpoint", () => refreshMemoryCheckpointUnheld(completedJobId)); }
function refreshMemoryCheckpointUnheld(completedJobId:string){
  // its evidence is judged inside the transaction: the lineage verdict cache can serve there once it is current
  prepareLineageCache();
  return transaction(db=>{
    const source=completedSource(completedJobId);
    if(!source.thread_id)return {status:"deferred" as const,reason:"source-has-no-thread"};
    const id=threadCheckpointId(String(source.scope_id),String(source.thread_id));
    const previous=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    if(previous?.owner_pinned===1||previous?.assertion==="owner-statement")return {status:"deferred" as const,reason:"owner-controlled-checkpoint"};
    // Notes the owner forgot are not carried into the next ones: their quotes
    // stay in the room, not in memory (forget.ts, N2).
    const forgotten=previous&&db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(id,previous.version);
    const handles:Handle[]=previous&&!forgotten?db.prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=?").all(id,previous.version) as unknown as Handle[]:[];
    if(source.kind!=="turn" && Number(source.bytes)>0){
      const raw=db.prepare("SELECT substr(CAST(json_extract(payload,'$.text') AS BLOB),1,96) AS bytes FROM memory_source_versions WHERE source_id=? AND revision=?").get(source.id,source.revision)!.bytes as Uint8Array;
      let length=raw.length;
      while(length>0){try{new TextDecoder("utf-8",{fatal:true}).decode(raw.subarray(0,length));break;}catch{length--;}}
      if(length)handles.unshift({sourceId:String(source.id),revision:Number(source.revision),startByte:0,endByte:length});
    }
    const seen=new Set<string>(),items=[],pending={checking:false};
    for(const handle of handles){
      if(seen.has(handle.sourceId))continue;seen.add(handle.sourceId);
      const item=checkpointEvidence(handle,String(source.scope_id),pending);if(item)items.push(item);
      if(items.length===4)break;
    }
    // Evidence still being checked (a revoke's pending window, 1.0.2 write-time) is neither shown nor withheld: the checkpoint is left as it
    // is, not rolled over fewer items or archived, and the caller tries again once the window has drained (worker-controller.ts).
    if(pending.checking)return {status:"deferred" as const,reason:"evidence-checking"};
    if(!items.length){
      if(previous?.state==="active"){
        db.prepare("UPDATE memory_records SET state='archived',valid_to=? WHERE id=? AND version=?").run(Date.now(),id,previous.version);
        db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(id,previous.version);
        db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
      }
      return {status:"deferred" as const,reason:"no-current-completed-evidence"};
    }
    // Built from raw payload excerpts: redacted here so the unchanged test below compares it with the stored (redacted) text.
    const text=redactSecretsInText("Working evidence; statements are not fulfilled commitments.\n"+items.map(item=>`${item.speaker==='owner'?'Owner statement':item.speaker==='tool'?'Observed tool outcome':'Assistant hypothesis'} (${item.outcome}): ${JSON.stringify(item.text)}`).join("\n"));
    const previousHandles=previous?db.prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id").all(id,previous.version):[];
    const ordered=items.map(item=>item.handle).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
    if(previous?.state==="active"&&previous.text===text&&JSON.stringify(previousHandles)===JSON.stringify(ordered))return {status:"unchanged" as const,checkpointId:id,version:Number(previous.version)};
    const version=previous?Number(previous.version)+1:1;
    if(previous){db.prepare("UPDATE memory_records SET state='archived',valid_to=? WHERE id=? AND version=? AND owner_pinned=0").run(Date.now(),id,previous.version);db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(id,previous.version);}
    insertMemoryRecord(db,{id,version,scopeId:String(source.scope_id),kind:"checkpoint",text,assertion:"assistant-inference",state:"active",validFrom:Date.now(),createdAt:Date.now()});
    for(const item of items){db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,?,?)").run(id,version,item.handle.sourceId,item.handle.revision,item.handle.startByte,item.handle.endByte);inheritEdge(db,{kind:"record",id,version},{kind:"source",id:item.handle.sourceId});}
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id,version);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    return {status:"updated" as const,checkpointId:id,version};
  });
}

const CONSOLIDATION_CHUNK_BYTES=16*1024;
interface ConsolidationIntent {
  evolutionPolicyRevision?:string;
  jobId:string;sourceId:string;revision:number;cursor:number;totalBytes:number;
  status:"running"|"partial"|"deferred"|"complete";candidateIds:string[];candidateCount:number;
  generation?:string;expiresAt?:number;retryAfter?:number|null;reason?:string;updatedAt:number;
  /** Per-slice limits (SETTINGS-REDESIGN r3.2): extraction calls and all calls charged for the slice at the cursor, written by the
   * reserve transaction only when a call is admitted (a refusal charges nothing), reset when the cursor moves. */
  extractionAttempts?:number;sliceCalls?:number;
  /** Slices given up on after SLICE_ATTEMPT_LIMIT attempts; only an explicit retry-skipped runs one again. */
  skipped?:SkippedSlice[];
  /** Retried slices waiting to run, in press order (Astra L3 r1): the head is the slice in work, and the main `cursor` never moves for
   * them, so a second press never overwrites the first and nothing past them is extracted again. */
  retries?:RetriedSlice[];
  /** Cursors of retried slices that committed: a later press on one answers "done". */
  retried?:number[];
  /** The main slice's counters, set aside while the queue runs and restored when it drains. */
  parked?:{extractionAttempts:number;sliceCalls:number};
  /** The queue's own revision (Astra L3 r2): every change to `retries`, `skipped` or `retried` goes through writeConsolidationIntent, a
   * compare-and-set on it, so a writer holding an older read (a claim that expired while a retry was queued) can never rewrite the queue. */
  queueRevision?:number;
}
const queueOf=(intent:Partial<ConsolidationIntent>|null|undefined)=>JSON.stringify([intent?.retries??[],intent?.skipped??[],intent?.retried??[]]);
/** The one writer of a consolidation intent's queue. Compare-and-set: the intent must carry the queueRevision it was read at; a queue
 * change bumps it. Caller owns the transaction. */
function writeConsolidationIntent(db:DatabaseSync,id:string,scope:unknown,intent:ConsolidationIntent){
  const row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id);
  const current=row?JSON.parse(String(row.intent)) as ConsolidationIntent:null,revision=Number(current?.queueRevision)||0;
  if((Number(intent.queueRevision)||0)!==revision)throw Object.assign(new Error("MEMORY_CONSOLIDATION_QUEUE_CHANGED"),{status:409});
  const next={...intent,queueRevision:current&&queueOf(current)!==queueOf(intent)?revision+1:revision};
  const subject=next.status==="complete"||next.retryAfter===null?"consolidation":"consolidation-pending";
  if(current)db.prepare("UPDATE memory_scope_bindings SET intent=?,subject_id=? WHERE id=?").run(JSON.stringify(next),subject,id);
  else db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)").run(id,scope as string,subject,JSON.stringify(next));
}
interface RetriedSlice{cursor:number;length:number}
/** Where the slice in work starts and how long it may be: the queue head, or the main cursor. */
function sliceInWork(state:ConsolidationIntent){
  const head=state.retries?.[0];
  return head?{at:head.cursor,size:head.length,head}:{at:state.cursor,size:CONSOLIDATION_CHUNK_BYTES,head:undefined};
}
/** The cursor, queue and counters once the slice in work commits or is skipped. */
function afterSlice(state:ConsolidationIntent,length:number):{cursor:number;extractionAttempts:number;sliceCalls:number;retries?:RetriedSlice[];parked?:ConsolidationIntent["parked"]}{
  const head=state.retries?.[0];
  if(!head)return {cursor:state.cursor+length,extractionAttempts:0,sliceCalls:0};
  const retries=state.retries!.slice(1);
  return {cursor:state.cursor,retries,parked:retries.length?state.parked:undefined,
    ...retries.length?{extractionAttempts:0,sliceCalls:0}:{extractionAttempts:state.parked?.extractionAttempts??0,sliceCalls:state.parked?.sliceCalls??0}};
}
/** The learning event text of a skipped slice. */
export const SLICE_SKIPPED_MESSAGE="Could not learn from part of this conversation. Try again";
/** Skips the slice in work: the main cursor moves past it (a retried slice leaves the queue instead), its coordinates are kept, and a learning
 * event offers the retry. Caller owns the transaction. */
function skipSlice(db:DatabaseSync,source:Record<string,unknown>,state:ConsolidationIntent,length:number,persist:(scope:unknown,intent:ConsolidationIntent)=>unknown){
  const at=Date.now(),skippedAt=sliceInWork(state).at,next=afterSlice(state,length),cursor=next.cursor;
  const status=cursor===state.totalBytes&&!next.retries?.length?"complete" as const:"partial" as const;
  const skipped=[...(state.skipped??[]).filter(entry=>entry.cursor!==skippedAt),{cursor:skippedAt,length,reason:"extraction-attempts",at}];
  persist(source.scope_id,{...state,...next,status,candidateIds:[],skipped,reason:"slice-skipped",retryAfter:status==="partial"?at:null,updatedAt:at});
  recordLearningEvent(db,{kind:"run-completed",scopeId:String(source.scope_id),sourceId:String(source.id),sourceRevision:Number(source.revision),botId:learningSourceBot(String(source.thread_id))?.id,
    detail:{outcome:"slice-skipped",message:SLICE_SKIPPED_MESSAGE,sourceId:String(source.id),cursor:skippedAt,length,retry:{action:"retry-skipped",sourceId:String(source.id),cursor:skippedAt}}});
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
  return {status,reason:"slice-skipped",candidateIds:[] as string[],cursor,candidateCount:state.candidateCount,retryAfter:status==="partial"?at:null};
}
const consolidationRows=(db:DatabaseSync,sourceId:string)=>db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('consolidation','consolidation-pending') AND json_extract(intent,'$.sourceId')=?").all(sourceId);
/** The answer to a `retry-skipped` press: `queued` (added to the source's retry queue now), `already-queued` (an earlier press is
 * waiting or running), `done` (a retry of it already committed). A cursor that was never skipped stays a 404. */
export interface RetrySkippedResult{status:"queued"|"already-queued"|"done";sourceId:string;cursor:number}
/** `retry-skipped`: one more run of SLICE_ATTEMPT_LIMIT attempts for one skipped slice. The entry leaves `skipped` and joins the end of
 * the source's retry queue; the main cursor stays where it is, so every press is kept and each retried slice runs exactly once (a retry
 * that fails three more times is skipped again, and can be pressed again). The source is due now. Caller owns the transaction. */
export function retrySkippedSlice(db:DatabaseSync,sourceId:string,cursor:number):RetrySkippedResult{
  const rows=consolidationRows(db,sourceId).map(row=>({id:String(row.id),intent:JSON.parse(String(row.intent)) as ConsolidationIntent}));
  if(rows.some(({intent})=>intent.retries?.some(entry=>entry.cursor===cursor)))return {status:"already-queued",sourceId,cursor};
  for(const {id,intent} of rows){
    const entry=intent.skipped?.find(item=>item.cursor===cursor);
    if(!entry)continue;
    // a slice in flight commits from what it read at its claim: queueing now would be overwritten by that commit
    if(intent.status==="running"&&typeof intent.expiresAt==="number"&&intent.expiresAt>Date.now())throw Object.assign(new Error("MEMORY_CONSOLIDATION_RUNNING"),{status:409});
    const now=Date.now(),queue=intent.retries??[];
    // the first queued slice becomes the slice in work: fresh counters for it, the main slice's own set aside until the queue drains
    const counters=queue.length?{}:{candidateIds:[],extractionAttempts:0,sliceCalls:0,parked:{extractionAttempts:Number(intent.extractionAttempts)||0,sliceCalls:Number(intent.sliceCalls)||0}};
    // an expired claim is revoked here (its generation goes): its later charges count nothing and its commit throws, so it can never
    // write back the queue it read before this press
    const unclaimed={...intent};delete unclaimed.generation;delete unclaimed.expiresAt;
    const next:ConsolidationIntent={...unclaimed,...counters,status:"deferred",retries:[...queue,{cursor,length:entry.length}],skipped:intent.skipped!.filter(item=>item.cursor!==cursor),
      retried:(intent.retried??[]).filter(item=>item!==cursor),reason:"retry-skipped",retryAfter:now,updatedAt:now};
    writeConsolidationIntent(db,id,null,next);
    return {status:"queued",sourceId,cursor};
  }
  if(rows.some(({intent})=>intent.retried?.includes(cursor)))return {status:"done",sourceId,cursor};
  throw Object.assign(new Error("MEMORY_SKIPPED_SLICE_UNKNOWN"),{status:404});
}
/** A raised ceiling applies now: every source waiting for next month's ceiling is due at once. Caller owns the transaction. */
export function releaseCeilingDeferrals(db:DatabaseSync,now=Date.now()){
  return Number(db.prepare(`UPDATE memory_scope_bindings SET intent=json_set(intent,'$.retryAfter',?) WHERE subject_type='system' AND subject_id='consolidation-pending'
    AND json_extract(intent,'$.status')='deferred' AND json_extract(intent,'$.reason')='spend-ceiling'`).run(now).changes);
}

/** Existing metadata supplies bounded restart discovery. The controller owns its
 * timer and global task slot; this function never invokes a model or changes caps. */
export function pendingMemoryConsolidationJobs(limit=4):string[]{
  const count=Math.min(4,Math.max(1,Math.trunc(limit)||1)),now=Date.now(),db=database();
  // Existing (subject_type,subject_id) index bounds each polling visit to 64
  // pending receipts. Completed receipts are never JSON-scanned by the timer.
  const statement=db.prepare("SELECT rowid,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='consolidation-pending' AND state='granted' AND rowid>? ORDER BY rowid LIMIT 64");
  const start=consolidationScanCursor;
  let rows=statement.all(consolidationScanCursor),wrapped=false;
  if(!rows.length){consolidationScanCursor=0;wrapped=true;rows=statement.all(0);}
  const found:string[]=[];
  const visit=(page:typeof rows)=>{for(const row of page){
    consolidationScanCursor=Number(row.rowid);
    const intent=JSON.parse(String(row.intent)) as ConsolidationIntent;
    if(!(intent.status==="partial"||intent.status==="deferred"&&typeof intent.retryAfter==="number"&&intent.retryAfter<=now||intent.status==="running"&&typeof intent.expiresAt==="number"&&intent.expiresAt<=now))continue;
    if(db.prepare("SELECT 1 FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.id=? AND j.status='complete' AND s.state='active'").get(intent.jobId))found.push(intent.jobId);
    if(found.length===count)break;
  }};
  visit(rows);
  // Nothing due after the cursor: wrap once to the rows before it, so due work there waits for no later pass.
  // Cursor rule: the cursor is the FORWARD position reached before wrapping, whether or not the prefix pass finds
  // anything. A found prefix row is returned and handled by the caller, and the forward sweep keeps advancing past
  // page two on later scans, reaching the end and only then restarting from 0; so no later page is starved.
  const forward=consolidationScanCursor;
  if(!found.length&&!wrapped&&start>0){visit(statement.all(0).filter(row=>Number(row.rowid)<=start));consolidationScanCursor=forward;}
  return found;
}
let consolidationScanCursor=0;
/** When a deferred slice is due again. `spend-ceiling`: the server-local 1st of next month (a raise moves it to now,
 * releaseCeilingDeferrals); `budget-exhausted` is pacing only, the next minute. */
export function retryAfter(reason:string,now=Date.now()):number {
  if(reason==="spend-ceiling"){const d=new Date(now);return new Date(d.getFullYear(),d.getMonth()+1,1).getTime();}
  if(reason==="budget-exhausted")return (Math.floor(now/60000)+1)*60000;
  return now+(reason==="extractor-busy"?1000:60000);
}

/** One <=16KiB UTF-8 slice per invocation. Candidates and the absolute cursor
 * commit together; interrupted slices retry without replaying acknowledged ones.
 * Intent retains only this slice's <=20 IDs, keeping its metadata bounded.
 */
export async function consolidateCompletedMemorySource(jobId:string,extractor:TextOnlyExtractor|null,signal:AbortSignal,options:Parameters<typeof consolidateMemorySource>[3]={}){
 const db=database(),source=db.prepare("SELECT source_id,source_revision FROM memory_jobs WHERE id=?").get(jobId);
 if(!source)return;
 const gate=isLearnableSource(db,String(source.source_id),Number(source.source_revision));
 if(!gate.learnable||!extractor)return;
 return consolidateMemorySource(jobId,extractor,signal,options);
}
export async function consolidateMemorySource(completedJobId:string,extractor:TextOnlyExtractor|null,signal:AbortSignal,options:{connection?:string|null;reviewOnly?:boolean;budgetGate?:(scopeId:string)=>boolean}={}){
  const db=database(),id=`consolidation:${hash(completedJobId)}`;
  const persist=(scope:unknown,intent:ConsolidationIntent)=>writeConsolidationIntent(db,id,scope,intent);
  const budgetSource=completedSource(completedJobId);
  const existing=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id);
  const live=existing?JSON.parse(String(existing.intent)):null;
  const skipBudget=live?.status==="complete"||live?.status==="running"&&live.expiresAt>Date.now();
  const budgetAllowed=skipBudget||!isLearnableSource(db,String(budgetSource.id),Number(budgetSource.revision)).learnable||(options.budgetGate?.(String(budgetSource.scope_id))??true);
  const claim=transaction(()=>{
    const source=completedSource(completedJobId),prior=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id);
    const saved=prior?JSON.parse(String(prior.intent)):null;
    const state:ConsolidationIntent={evolutionPolicyRevision:saved?.evolutionPolicyRevision??readMemoryEvolutionPolicy().revision,jobId:completedJobId,sourceId:String(source.id),revision:Number(source.revision),cursor:saved?.cursor??0,totalBytes:Number(source.bytes),status:saved?.status??"partial",candidateIds:saved?.candidateIds??[],candidateCount:saved?.candidateCount??saved?.candidateIds?.length??0,updatedAt:Date.now(),
      extractionAttempts:Number(saved?.extractionAttempts)||0,sliceCalls:Number(saved?.sliceCalls)||0,...Array.isArray(saved?.skipped)?{skipped:saved.skipped}:{},
      ...Array.isArray(saved?.retries)?{retries:saved.retries}:{},...Array.isArray(saved?.retried)?{retried:saved.retried}:{},...saved?.parked?{parked:saved.parked}:{},
      ...Number.isSafeInteger(saved?.queueRevision)?{queueRevision:saved.queueRevision}:{}};
    if(saved?.status==="complete")return {done:{status:"unchanged" as const,candidateIds:state.candidateIds,cursor:state.totalBytes,candidateCount:state.candidateCount}};
    if(!Number.isSafeInteger(state.cursor)||state.cursor<0||state.cursor>state.totalBytes)throw new Error("MEMORY_CONSOLIDATION_CURSOR_INVALID");
    const work=sliceInWork(state);
    if(work.head&&!(Number.isSafeInteger(work.at)&&work.at>=0&&Number.isSafeInteger(work.size)&&work.size>0&&work.size<=CONSOLIDATION_CHUNK_BYTES&&work.at+work.size<=state.totalBytes))throw new Error("MEMORY_CONSOLIDATION_CURSOR_INVALID");
    if(saved?.status==="running"&&saved.expiresAt>Date.now())return {done:{status:"deferred" as const,reason:"extraction-already-running",candidateIds:[],cursor:state.cursor,candidateCount:state.candidateCount,retryAfter:saved.expiresAt as number}};
    const gate=isLearnableSource(db,String(source.id),Number(source.revision));
    if(!gate.learnable||!budgetAllowed){
      const reason=!gate.learnable?gate.reason:"project-budget-reached",retry=!gate.learnable?null:Date.now()+600000;
      persist(source.scope_id,{...state,status:"deferred",reason,retryAfter:retry});
      return {done:{status:"deferred" as const,reason,candidateIds:[],cursor:state.cursor,candidateCount:state.candidateCount,retryAfter:retry}};
    }
    if(!extractor||source.kind==="turn"||signal.aborted){
      const reason=signal.aborted?"extraction-incomplete":!extractor?"extractor-unavailable":"settlement-is-not-a-fact";
      const nextRetry=source.kind==="turn"?null:retryAfter(reason);
      persist(source.scope_id,{...state,status:"deferred",reason,retryAfter:nextRetry});
      return {done:{status:"deferred" as const,reason,candidateIds:[],cursor:state.cursor,candidateCount:state.candidateCount,retryAfter:nextRetry}};
    }
    // A reply withheld from bots (replay-lineage.ts) is not learned from: its
    // words never go to the extractor and nothing new rests on it.
    const lineage=LineageAllowance.tool();
    const writetime=writetimeSourceState(source);
    if(sourceIsWithheldMessage(lineage,source)||writetime!=="shown"){
      // a reply only unproven for now is tried again, not given up on: the allowance ran out, a large set it rests on is still being proven,
      // or a revoke is still being marked (write-time)
      const unchecked=lineage.hit||writetime==="checking";
      const retry=unchecked||sourceAwaitsProof(lineage,source)?Date.now()+60_000:null;
      persist(source.scope_id,{...state,status:"deferred",reason:unchecked?"reply-unchecked":"reply-withheld",retryAfter:retry});
      return {done:{status:"deferred" as const,reason:unchecked?"reply-unchecked":"reply-withheld",candidateIds:[],cursor:state.cursor,candidateCount:state.candidateCount,retryAfter:retry}};
    }
    const raw=db.prepare("SELECT substr(CAST(json_extract(payload,'$.text') AS BLOB),?,?) AS bytes FROM memory_source_versions WHERE source_id=? AND revision=?").get(work.at+1,work.size,source.id,source.revision)!.bytes as Uint8Array;
    let text:string|undefined,length=raw.length;
    for(let trim=0;trim<=3&&trim<=raw.length;trim++){try{length=raw.length-trim;text=new TextDecoder("utf-8",{fatal:true}).decode(raw.subarray(0,length));break;}catch{/* split code point at the chunk end */}}
    if(text===undefined||!length&&(work.head||state.cursor<state.totalBytes))throw new Error("MEMORY_CONSOLIDATION_UTF8_INVALID");
    // three admitted attempts (across retries and restarts) on this slice: it is skipped, never retried automatically
    if((state.extractionAttempts??0)>=SLICE_ATTEMPT_LIMIT&&length)return {done:skipSlice(db,source,state,length,persist)};
    const generation=randomUUID(),meta=db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta").get()!;
    persist(source.scope_id,{...state,status:"running",generation,expiresAt:Date.now()+65000});
    return {source,state,generation,meta,text,length,at:work.at,learningRevision:readMemoryLearning(db).revision};
  });
  if(claim.done)return claim.done;
  const {source,state,generation,meta,text,length,at,learningRevision}=claim;
  // Every admitted call of this slice is counted on the intent inside its reserve transaction (charged before dispatch, kept across a crash).
  let sliceCalls=state!.sliceCalls??0;
  const charge=(extraction:boolean):ReservationRecord=>chargeDb=>{
    const row=chargeDb.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id);if(!row)return;
    const intent=JSON.parse(String(row.intent)) as ConsolidationIntent;if(intent.generation!==generation)return;
    if(extraction)intent.extractionAttempts=(Number(intent.extractionAttempts)||0)+1;
    intent.sliceCalls=sliceCalls=(Number(intent.sliceCalls)||0)+1;
    chargeDb.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(intent),id);
  };
  // Each queued owner retry gets one admitted call through reply backoff. Budget/busy deferrals do not consume it;
  // persisted extractionAttempts does, so later automatic attempts (including after a restart) respect backoff.
  const ownerRetry=!!state!.retries?.length&&(state!.extractionAttempts??0)===0;
  // bot email (5.4): a slice of a source captured from a marked row reaches the extractor fenced, kind email-derived
  const shown=text!.trim()&&evidenceEmailDerived(db,[{sourceId:source.id,revision:source.revision}])?fenceEmailDerived(text!,`source-${String(source.id)}`):text!;
  const result=text!.trim()?await extractCandidates(text!,extractor,signal,readMemoryEvolutionPolicy(state!.evolutionPolicyRevision),charge(true),{ownerRetry,shown}):{status:"complete" as const,candidates:[]};
  const corrections=new Map<object,{id:string;version:number}>();
  const support=new Map<object,{supported:boolean;reason:string}>();
  // One grounding call per candidate: with a correction target the same call answers the correction and the support check.
  // At SLICE_CALL_GUARD calls the remaining candidates are left unjudged (never support) and the slice commits.
  if(result.status==="complete")for(const candidate of result.candidates){
    let prior:Record<string,unknown>[]=[];
    if(candidate.subject&&candidate.predicate&&candidate.update&&source!.speaker==="owner")prior=db.prepare(`SELECT r.id,r.version,r.text FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
        WHERE r.scope_id=? AND r.state='active' AND r.owner_pinned=0 AND d.entities=? AND r.kind='fact' AND d.partition!='identity' ORDER BY r.created_at DESC LIMIT 2`).all(source!.scope_id,JSON.stringify([candidate.subject,candidate.predicate]));
    const correcting=prior.length===1&&prior[0]!.text!==candidate.text;
    const needsSupport=Boolean(candidate.claimType&&candidate.claimType!=="inference"&&candidate.text!==candidate.quote);
    if(!correcting&&!needsSupport)continue;
    if(sliceCalls>=SLICE_CALL_GUARD){support.set(candidate,{supported:false,reason:SLICE_CALL_LIMIT_REASON});continue;}
    if(correcting){
      const checked=await groundMemoryClaim({text:candidate.text,quote:candidate.quote,claimType:candidate.claimType??"owner-statement",speaker:String(source!.speaker),outcome:String(source!.outcome),previousClaim:String(prior[0]!.text)},extractor,signal,charge(false));
      if(checked.supported){corrections.set(candidate,{id:String(prior[0]!.id),version:Number(prior[0]!.version)});support.set(candidate,{supported:true,reason:checked.reason});}
      else if(needsSupport)support.set(candidate,checked.entailed?{supported:true,reason:"source-entailment"}:{supported:false,reason:checked.entailed===false?"unsupported-claim":checked.reason});
    }else support.set(candidate,await groundMemoryClaim({text:candidate.text,quote:candidate.quote,claimType:candidate.claimType!,speaker:String(source!.speaker),outcome:String(source!.outcome)},extractor,signal,charge(false)));
  }
  return transaction(()=>{
    const current=db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta").get()!;
    completedSource(completedJobId);
    const intent=JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
    if(readMemoryLearning(db).revision!==learningRevision||intent.generation!==generation||(Number(intent.queueRevision)||0)!==(Number(state!.queueRevision)||0)||current.policy_revision!==meta!.policy_revision||current.deletion_epoch!==meta!.deletion_epoch||sourceIsWithheldMessage(LineageAllowance.tool(),source!)||writetimeSourceState(source!)!=="shown")throw new Error("MEMORY_CONSOLIDATION_REVOKED");
    // the counters as the reserve transactions left them
    const counted:ConsolidationIntent={...state!,extractionAttempts:Number(intent.extractionAttempts)||0,sliceCalls:Number(intent.sliceCalls)||0};
    if(result.status!=="complete"||signal.aborted){
      const reason=result.status!=="complete"?result.reason:"extraction-incomplete";
      if((counted.extractionAttempts??0)>=SLICE_ATTEMPT_LIMIT&&length)return skipSlice(db,source!,counted,length!,persist);
      const nextRetry=("retryAfter" in result?result.retryAfter:undefined)??retryAfter(reason);
      persist(source!.scope_id,{...counted,status:"deferred",reason,retryAfter:nextRetry,updatedAt:Date.now()});
      return {status:"deferred" as const,reason,candidateIds:[],cursor:state!.cursor,candidateCount:state!.candidateCount,retryAfter:nextRetry};
    }
    const candidateIds:string[]=[];let added=0;
    for(const candidate of result.candidates){
      const absolute={...candidate,startByte:at!+candidate.startByte,endByte:at!+candidate.endByte};
      const candidateId=`candidate:${hash(JSON.stringify([source!.id,source!.revision,absolute]))}`;candidateIds.push(candidateId);
      const inserted=insertMemoryRecord(db,{id:candidateId,version:1,scopeId:String(source!.scope_id),kind:"fact",text:candidate.text,assertion:"assistant-inference",state:"candidate",validFrom:Date.now(),createdAt:Date.now()},{orIgnore:true});
      added+=Number(inserted.changes);
      db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,1,?,?,?,?)").run(candidateId,source!.id,source!.revision,absolute.startByte,absolute.endByte);
      inheritEdge(db,{kind:"record",id:candidateId,version:1},{kind:"source",id:String(source!.id)});
      if(inserted.changes){
        const prior=corrections.get(candidate);
        const decision=prior?learningWriteDecision(db,{writer:"correction-supersede",sourceId:String(source!.id),sourceRevision:Number(source!.revision),targetScopeId:String(source!.scope_id),evidenceScopeIds:[...learningEvidenceScopes(db,candidateId,1),...learningEvidenceScopes(db,prior.id,prior.version)],botId:learningSourceBot(String(source!.thread_id))?.id,target:"memory"}):undefined;
        if(prior){
          db.prepare("UPDATE memory_records SET supersedes_id=? WHERE id=? AND version=1").run(prior.id,candidateId);
          db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(prior.id,prior.version,candidateId);
          inheritEdge(db,{kind:"record",id:candidateId,version:1},{kind:"record",id:String(prior.id),version:Number(prior.version)});
        }
        const active=activateGroundedMemory(db,candidateId,candidate.claimType,support.get(candidate),{connection:options.connection,decision,superseding:Boolean(prior),reviewOnly:options.reviewOnly});
        if(candidate.subject&&candidate.predicate)db.prepare("UPDATE memory_record_details SET entities=? WHERE record_id=? AND record_version=1").run(JSON.stringify([candidate.subject,candidate.predicate]),candidateId);
        if(active&&prior){
          const retired=db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=? AND state='active' AND owner_pinned=0").run(Date.now(),prior.id,prior.version);
          if(retired.changes!==1)throw new Error("MEMORY_CORRECTION_TARGET_CHANGED");
          db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(prior.id,prior.version);
          revokeRecordDisclosures(db,"consolidate-supersede",{recordIds:[prior.id,candidateId]});
          recordLearningEvent(db,{kind:"superseded",scopeId:String(source!.scope_id),recordId:candidateId,recordVersion:1,priorId:prior.id,priorVersion:prior.version,sourceId:String(source!.id),sourceRevision:Number(source!.revision),botId:learningSourceBot(String(source!.thread_id))?.id,connection:options.connection});
          enqueueProcedureCorrectionReview(db,candidateId,1);
        }else if(active&&candidate.subject&&candidate.predicate){
          const conflict=db.prepare(`SELECT r.id FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.scope_id=? AND r.state='active' AND r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND r.id!=? AND r.text!=? AND d.entities=? LIMIT 1`).get(source!.scope_id,candidateId,candidate.text,JSON.stringify([candidate.subject,candidate.predicate]));
          if(conflict)db.prepare("UPDATE memory_record_details SET claim_status='disputed' WHERE record_id=? AND record_version=1").run(candidateId);
        }
        if(!active&&support.has(candidate)&&!db.prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND confidence_basis IS NOT NULL").get(candidateId))db.prepare("UPDATE memory_record_details SET confidence_basis=? WHERE record_id=? AND record_version=1").run(support.get(candidate)!.reason,candidateId);
      }
    }
    const next=afterSlice(counted,length!),cursor=next.cursor,candidateCount=state!.candidateCount+added;
    const status=cursor===state!.totalBytes&&!next.retries?.length?"complete" as const:"partial" as const;
    // a retried slice that committed is remembered, so a later press on it answers "done"
    const retried=counted.retries?.length?{retried:[...(counted.retried??[]).filter(item=>item!==at),at!]}:{};
    persist(source!.scope_id,{...counted,...next,...retried,status,candidateIds,candidateCount,retryAfter:status==="partial"?Date.now():null,updatedAt:Date.now()});
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    return {status,candidateIds,cursor,candidateCount,retryAfter:status==="partial"?Date.now():null};
  });
}
