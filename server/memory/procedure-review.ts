import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { database, transaction } from "../database.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { isGepaCallNotStarted } from "../gepa-worker.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const procedureCandidateHash = (text: string) => createHash("sha256").update(text).digest("hex");
const PENDING = "procedure-review-pending", COMPLETE = "procedure-review";
const MAX_EVIDENCE = 64, LEASE_MS = 65000;
export type ProcedureEvidence = { kind:"source"; id:string; revision:number } | { kind:"record"; id:string; revision:number };
export interface ProcedureReviewTarget {
  kind:"skill"|"routine"|"memory-policy"; scopeId:string; ownerId:string; artifactId:string; baseRevision:string;
  threadId:string; bundleId:string;
}
export interface ProcedureReviewTrigger {
  kind:"turn-settled"|"owner-correction"; scopeId:string; threadId?:string; turnId?:string;
  outcome?:string; evidence:ProcedureEvidence[];
}
export interface ProcedureReviewSnapshot {
  requestId:string; scopeId:string; target:ProcedureReviewTarget; evidenceDigest:string;
  policyRevision:number; deletionEpoch:number; learningRevision:number;
  evidence:Array<ProcedureEvidence & {scopeId:string; text:string; speaker:string; outcome:string}>;
  /** Lifecycle completion is never independent verification of an effect. */
  outcomeBasis:"source-reported";
}
const receiptSchema = z.object({
  id:z.string().min(1).max(200), requestId:z.string().min(1), targetDigest:z.string().regex(/^[a-f0-9]{64}$/),
  evidenceDigest:z.string().regex(/^[a-f0-9]{64}$/), candidate:z.string().min(1).max(20000),
  snapshotDigest:z.string().regex(/^[a-f0-9]{64}$/),
  corpusDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  accounting:z.object({costLimitUsd:z.number().finite().nonnegative().nullable(),actualCostUsd:z.number().finite().nonnegative().nullable(),costKnown:z.boolean(),authorityReference:z.string().min(1),metricCalls:z.number().int().nonnegative().max(24),reflectionCalls:z.number().int().nonnegative().max(2)}).strict().optional(),
  candidateHash:z.string().regex(/^[a-f0-9]{64}$/), evaluator:z.string().min(1).max(200),
  decision:z.enum(["accepted","rejected","no-change"]),
  heldout:z.object({corpusDigest:z.string().regex(/^[a-f0-9]{64}$/), untouched:z.literal(true),
    cases:z.number().int().positive(), baseline:z.number().finite(), candidate:z.number().finite(), regressions:z.number().int().nonnegative()}).strict(),
  budgetRespected:z.literal(true), cancelled:z.literal(false),
}).strict();
export type ProcedureEvaluationReceipt = z.infer<typeof receiptSchema>;
export const procedureTargetDigest = (target:ProcedureReviewTarget) => hash(target);
export const procedureSnapshotDigest = (snapshot:ProcedureReviewSnapshot) => hash(snapshot);
export function validateProcedureEvaluationReceipt(snapshot:ProcedureReviewSnapshot,value:unknown):ProcedureEvaluationReceipt {
  const receipt=receiptSchema.parse(value);
  if(receipt.requestId!==snapshot.requestId||receipt.snapshotDigest!==procedureSnapshotDigest(snapshot)||receipt.targetDigest!==procedureTargetDigest(snapshot.target)||receipt.evidenceDigest!==snapshot.evidenceDigest||receipt.candidateHash!==procedureCandidateHash(receipt.candidate))throw Error("PROCEDURE_RECEIPT_MISMATCH");
  if(receipt.decision==="accepted"&&(receipt.heldout.candidate<=receipt.heldout.baseline||receipt.heldout.regressions!==0))throw Error("PROCEDURE_HELDOUT_REJECTED");
  return receipt;
}
export interface ProcedureReviewHost {
  automaticFailureRetry?:boolean;
  evaluationReadiness?(snapshot:ProcedureReviewSnapshot):{ready:true}|{ready:false;reason:string};
  /** Host resolves only authorized immutable task pins, never model-selected targets. */
  resolveTargets(trigger:ProcedureReviewTrigger):ProcedureReviewTarget[];
  isTargetCurrent(target:ProcedureReviewTarget):boolean;
  canReadEvidence(reviewScopeId:string,evidenceScopeId:string,evidence:ProcedureEvidence):boolean;
  /** Evidence audience must cover the complete target audience, not only its owning bot. */
  canPublish(snapshot:ProcedureReviewSnapshot):boolean;
  /** Check actual committed target provenance after a publication/acknowledgement crash. */
  wasPublished?(snapshot:ProcedureReviewSnapshot,receipt:ProcedureEvaluationReceipt):boolean;
  /** Same requestId must recover an existing result; never charge/run it twice. */
  evaluate?(snapshot:ProcedureReviewSnapshot,signal:AbortSignal):Promise<ProcedureEvaluationReceipt>;
  /** Synchronous, idempotent by receipt.id, CAS against target.baseRevision. */
  publish?(snapshot:ProcedureReviewSnapshot,receipt:ProcedureEvaluationReceipt):void;
}
interface Intent {
  schema:1; id:string; scopeId:string; status:"pending"|"running"|"deferred"|"complete"|"cancelled";
  trigger?:ProcedureReviewTrigger; target?:ProcedureReviewTarget; evidence:ProcedureEvidence[];
  policyRevision:number; deletionEpoch:number; learningRevision:number;
  generation?:string; expiresAt?:number; retryAfter?:number|null; reason?:string;
  attempts?:number;
  targetCursor?:number; targetSetDigest?:string;
  snapshot?:ProcedureReviewSnapshot; receipt?:ProcedureEvaluationReceipt;
}
function versions(db:DatabaseSync) {
  const meta=db.prepare("SELECT mode,policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  return {mode:String(meta.mode),policyRevision:Number(meta.policy_revision),deletionEpoch:Number(meta.deletion_epoch),learningRevision:readMemoryLearning(db).revision};
}
function read(db:DatabaseSync,id:string):Intent|undefined {
  const row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system'").get(id);
  return row?JSON.parse(String(row.intent)) as Intent:undefined;
}
function save(db:DatabaseSync,intent:Intent) {
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,?,'granted',?) ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id,intent=excluded.intent")
    .run(intent.id,intent.scopeId,["complete","cancelled"].includes(intent.status)?COMPLETE:PENDING,intent.policyRevision,JSON.stringify(intent));
}
function unique(evidence:ProcedureEvidence[]) {
  return [...new Map(evidence.map(item=>[`${item.kind}:${item.id}:${item.revision}`,item])).values()]
    .sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)||a.revision-b.revision);
}
function enqueue(db:DatabaseSync,trigger:ProcedureReviewTrigger) {
  const v=versions(db);if(v.mode==="off")return;
  const id=`procedure-trigger:${hash([trigger.kind,trigger.evidence])}`;
  if(read(db,id))return;
  save(db,{schema:1,id,scopeId:trigger.scopeId,status:"pending",trigger,evidence:trigger.evidence,...v});
}
/** Caller owns the source transaction. Replayed source versions are no-ops. */
export function enqueueProcedureSourceReview(db:DatabaseSync,sourceId:string,revision:number) {
  const row=db.prepare("SELECT * FROM memory_sources WHERE id=? AND revision=? AND state='active' AND kind='turn' AND outcome!='working'").get(sourceId,revision);
  if(!row)return;
  enqueue(db,{kind:"turn-settled",scopeId:String(row.scope_id),threadId:String(row.thread_id),turnId:String(row.turn_id),outcome:String(row.outcome),evidence:[{kind:"source",id:sourceId,revision}]});
}
/** Direct owner edits carry the new record itself; old source text is not proof of the edit. */
export function enqueueProcedureCorrectionReview(db:DatabaseSync,recordId:string,version:number) {
  const row=db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=? AND state='active' AND assertion='owner-statement'").get(recordId,version);
  if(row)enqueue(db,{kind:"owner-correction",scopeId:String(row.scope_id),evidence:[{kind:"record",id:recordId,revision:version}]});
}
function hydrate(db:DatabaseSync,evidence:ProcedureEvidence[],scopeId:string,host:ProcedureReviewHost):ProcedureReviewSnapshot["evidence"] {
  let bytes=0;
  return unique(evidence).map(item=>{
    let text:string,speaker:string,outcome:string,evidenceScopeId:string;
    if(item.kind==="source"){
      const row=db.prepare("SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.revision=? AND s.state='active'").get(item.id,item.revision);
      if(!row||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(item.id,item.revision))throw Error("PROCEDURE_EVIDENCE_STALE");
      evidenceScopeId=String(row.scope_id);if(!host.canReadEvidence(scopeId,evidenceScopeId,item))throw Error("PROCEDURE_EVIDENCE_FORBIDDEN");
      const payload=JSON.parse(String(row.payload));text=String(payload.text??"");speaker=String(row.speaker);outcome=String(row.outcome);
    }else{
      const row=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=? AND state='active' AND version=(SELECT max(version) FROM memory_records WHERE id=?)").get(item.id,item.revision,item.id);
      if(!row)throw Error("PROCEDURE_EVIDENCE_STALE");
      evidenceScopeId=String(row.scope_id);if(!host.canReadEvidence(scopeId,evidenceScopeId,item))throw Error("PROCEDURE_EVIDENCE_FORBIDDEN");
      text=String(row.text);speaker=String(row.assertion);outcome="owner-correction";
    }
    bytes+=Buffer.byteLength(text);if(bytes>65536)throw Error("PROCEDURE_EVIDENCE_LIMIT");
    return {...item,scopeId:evidenceScopeId,text,speaker,outcome};
  });
}
function assertCurrent(db:DatabaseSync,intent:Intent,host:ProcedureReviewHost) {
  const v=versions(db),learning=readMemoryLearning(db);
  if(!["active","capture"].includes(v.mode)||!learning.automaticProcedures||learning.reviewMode)throw Error("PROCEDURE_REVIEW_PAUSED");
  if(v.policyRevision!==intent.policyRevision||v.deletionEpoch!==intent.deletionEpoch||v.learningRevision!==intent.learningRevision)throw Error("PROCEDURE_REVIEW_REVOKED");
  hydrate(db,intent.evidence,intent.scopeId,host);
  if(intent.target&&!host.isTargetCurrent(intent.target))throw Error("PROCEDURE_TARGET_STALE");
}
let scanCursor=0;
/** Bounded indexed polling; expired leases reuse persisted snapshots and receipts. */
export function pendingProcedureReviews(limit=1,host?:ProcedureReviewHost):string[] {
  const db=database(),now=Date.now(),v=versions(db),learning=readMemoryLearning(db);
  if(!["active","capture"].includes(v.mode)||!learning.automaticProcedures||learning.reviewMode)return [];
  const query=db.prepare("SELECT rowid,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? AND state='granted' AND rowid>? ORDER BY rowid LIMIT 64");
  let rows=query.all(PENDING,scanCursor);if(!rows.length){scanCursor=0;rows=query.all(PENDING,0);}
  const result:string[]=[];
  for(const row of rows){scanCursor=Number(row.rowid);const intent=JSON.parse(String(row.intent)) as Intent;
    let published=false;
    if(intent.status==="deferred"&&intent.snapshot&&intent.receipt&&host?.wasPublished){try{published=host.wasPublished(intent.snapshot,intent.receipt);}catch{/* No proven publication: leave explicit retry unchanged. */}}
    if(published||intent.status==="pending"||intent.status==="running"&&(intent.expiresAt??0)<=now||intent.status==="deferred"&&typeof intent.retryAfter==="number"&&intent.retryAfter<=now)result.push(intent.id);
    if(result.length>=Math.min(4,Math.max(1,limit)))break;
  }
  return result;
}
function expand(db:DatabaseSync,intent:Intent,host:ProcedureReviewHost) {
  const trigger=intent.trigger!,evidence=[...intent.evidence];
  if(trigger.threadId&&trigger.turnId){
    const rows=db.prepare("SELECT id,revision FROM memory_sources WHERE thread_id=? AND turn_id=? AND state='active' AND kind!='turn' ORDER BY id LIMIT 65").all(trigger.threadId,trigger.turnId);
    if(rows.length>MAX_EVIDENCE-1)throw Error("PROCEDURE_EVIDENCE_LIMIT");
    evidence.push(...rows.map(row=>({kind:"source" as const,id:String(row.id),revision:Number(row.revision)})));
  }
  for(const item of intent.evidence.filter(item=>item.kind==="record")){
    const rows=db.prepare("SELECT source_id,source_revision FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id LIMIT 65").all(item.id,item.revision);
    evidence.push(...rows.map(row=>({kind:"source" as const,id:String(row.source_id),revision:Number(row.source_revision)})));
  }
  // Canonical original handles survive fan-out and are never replaced by summaries.
  const canonical=unique(evidence);if(canonical.length>MAX_EVIDENCE)throw Error("PROCEDURE_EVIDENCE_LIMIT");hydrate(db,canonical,intent.scopeId,host);
  const targets=[...new Map(host.resolveTargets({...trigger,evidence:canonical}).map(target=>[procedureTargetDigest(target),target])).entries()]
    .sort(([a],[b])=>a.localeCompare(b)).map(([,target])=>target);
  if(!targets.length){save(db,{...intent,status:"complete",reason:"no-applicable-procedure"});return;}
  const targetSetDigest=hash(targets),cursor=intent.targetCursor??0;
  if(intent.targetSetDigest&&intent.targetSetDigest!==targetSetDigest)throw Error("PROCEDURE_TARGET_SET_CHANGED");
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>targets.length)throw Error("PROCEDURE_TARGET_CURSOR_INVALID");
  for(const target of targets.slice(cursor,cursor+16)){
    if(!target.scopeId||!target.ownerId||!target.artifactId||!target.baseRevision||!target.bundleId||!target.threadId||!host.isTargetCurrent(target))throw Error("PROCEDURE_TARGET_STALE");
    // Normalize the work audience without changing the original trigger scope.
    // Every original handle needs fresh authorization for this target audience.
    hydrate(db,canonical,target.scopeId,host);
    // Coalesce only unclaimed work. A claimed evaluation snapshot never changes.
    const artifact=hash([target.scopeId,target.kind,target.ownerId,target.artifactId,target.baseRevision]);
    const id=`procedure-review:${artifact}:${hash(canonical)}`;if(read(db,id))continue;
    const pending=db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? AND id LIKE ? ORDER BY rowid LIMIT 16").all(PENDING,`procedure-review:${artifact}:%`)
      .map(row=>JSON.parse(String(row.intent)) as Intent).find(row=>!row.snapshot&&["pending","deferred"].includes(row.status)&&row.policyRevision===intent.policyRevision&&row.deletionEpoch===intent.deletionEpoch&&row.learningRevision===intent.learningRevision&&unique([...row.evidence,...canonical]).length<=MAX_EVIDENCE);
    if(pending){save(db,{...pending,evidence:unique([...pending.evidence,...canonical]),status:"pending",retryAfter:undefined});continue;}
    save(db,{schema:1,id,scopeId:target.scopeId,target:structuredClone(target),evidence:canonical,status:"pending",policyRevision:intent.policyRevision,deletionEpoch:intent.deletionEpoch,learningRevision:intent.learningRevision});
  }
  const targetCursor=Math.min(cursor+16,targets.length);
  save(db,{...intent,evidence:canonical,targetCursor,targetSetDigest,status:targetCursor===targets.length?"complete":"pending"});
}
async function evaluateBounded(host:ProcedureReviewHost,snapshot:ProcedureReviewSnapshot,signal:AbortSignal) {
  const controller=new AbortController();
  const abort=()=>controller.abort(Error("PROCEDURE_REVIEW_CANCELLED"));
  signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  const timer=setTimeout(()=>controller.abort(Error("PROCEDURE_REVIEW_TIMEOUT")),60000);timer.unref();
  let rejectAbort:()=>void=()=>{};
  const stopped=new Promise<never>((_resolve,reject)=>{rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener("abort",rejectAbort,{once:true});if(controller.signal.aborted)rejectAbort();});
  try{return await Promise.race([host.evaluate!(structuredClone(snapshot),controller.signal),stopped]);}
  finally{clearTimeout(timer);signal.removeEventListener("abort",abort);controller.signal.removeEventListener("abort",rejectAbort);}
}
export async function processProcedureReview(id:string,host:ProcedureReviewHost,signal:AbortSignal) {
  const claim=transaction(db=>{
    let intent=read(db,id);if(!intent||["complete","cancelled"].includes(intent.status))return undefined;
    if(intent.status==="running"&&(intent.expiresAt??0)>Date.now())return undefined;
    if(intent.snapshot&&intent.receipt&&host.wasPublished?.(intent.snapshot,intent.receipt)){save(db,{...intent,status:"complete",reason:"accepted"});return undefined;}
    // Unstarted work can be reauthorized against current grants. Evaluated
    // snapshots keep their original fences and can never inherit a new grant.
    if(!intent.snapshot&&!intent.receipt){
      try{hydrate(db,intent.evidence,intent.scopeId,host);if(intent.target&&!host.isTargetCurrent(intent.target))throw Error("PROCEDURE_TARGET_STALE");}
      catch(error){save(db,{...intent,status:"cancelled",reason:error instanceof Error?error.message:"PROCEDURE_REVIEW_REVOKED"});return undefined;}
      intent={...intent,...versions(db)};save(db,intent);
    }
    try{assertCurrent(db,intent,host);}catch(error){const reason=error instanceof Error?error.message:"PROCEDURE_REVIEW_REVOKED";save(db,{...intent,status:reason==="PROCEDURE_REVIEW_PAUSED"?"deferred":"cancelled",reason,retryAfter:Date.now()+60000});return undefined;}
    if(signal.aborted)return undefined;
    if(intent.trigger){
      try{const triggerIntent=intent;transaction(inner=>expand(inner,triggerIntent,host));}
      catch(error){const reason=error instanceof Error?error.message:"PROCEDURE_TARGET_UNAVAILABLE",attempts=(intent.attempts??0)+1;save(db,{...intent,status:"deferred",attempts,reason,retryAfter:attempts>=3||reason.endsWith("_LIMIT")?null:Date.now()+60000});}
      return undefined;
    }
    if(!host.evaluate&&!intent.receipt||!host.publish){save(db,{...intent,status:"deferred",reason:"procedure-evaluator-unavailable",retryAfter:Date.now()+60000});return undefined;}
    const evidence=hydrate(db,intent.evidence,intent.scopeId,host);
    const snapshot=intent.snapshot??{requestId:id,scopeId:intent.scopeId,target:intent.target!,evidenceDigest:hash(evidence),policyRevision:intent.policyRevision,deletionEpoch:intent.deletionEpoch,learningRevision:intent.learningRevision,evidence,outcomeBasis:"source-reported" as const};
    if(!host.canPublish(snapshot)){save(db,{...intent,status:"deferred",reason:"scope-widening-unavailable",retryAfter:Date.now()+60000});return undefined;}
    const readiness=host.evaluationReadiness?.(snapshot);
    if(readiness&&!readiness.ready){save(db,{...intent,status:"deferred",reason:readiness.reason,retryAfter:Date.now()+60000});return undefined;}
    const next={...intent,status:"running" as const,generation:randomUUID(),expiresAt:Date.now()+LEASE_MS,snapshot};save(db,next);return next;
  });
  if(!claim)return {status:"settled" as const};
  try{
    const snapshot=claim.snapshot!;
    const receipt=validateProcedureEvaluationReceipt(snapshot,claim.receipt??await evaluateBounded(host,snapshot,signal));
    const current=()=>{const saved=read(database(),id);if(!saved||saved.generation!==claim.generation||saved.status!=="running"||(saved.expiresAt??0)<Date.now())throw Error("PROCEDURE_LEASE_STALE");assertCurrent(database(),saved,host);if(signal.aborted)throw Error("PROCEDURE_REVIEW_CANCELLED");if(!host.canPublish(snapshot))throw Error("PROCEDURE_AUDIENCE_REVOKED");return saved;};
    // Receipt survives a crash between publication and queue acknowledgement.
    transaction(db=>save(db,{...current(),receipt}));
    transaction(db=>{
      const saved=current();
      if(receipt.decision==="accepted")host.publish!(structuredClone(snapshot),structuredClone(receipt));
      save(db,{...saved,status:"complete",receipt,reason:receipt.decision});
    });
    return {status:"complete" as const,decision:receipt.decision};
  }catch(error){
    const reason=error instanceof Error?error.message:"PROCEDURE_REVIEW_FAILED";
    transaction(db=>{const saved=read(db,id);if(saved?.generation===claim.generation&&saved.status==="running"){const notStarted=isGepaCallNotStarted(error),attempts=(saved.attempts??0)+(notStarted?0:1);save(db,{...saved,status:"deferred",attempts,reason,retryAfter:notStarted||host.automaticFailureRetry===false||attempts>=3?null:Date.now()+60000});}});
    return {status:"deferred" as const,reason};
  }
}

/** Host-only preview uses the same original handles and fences as execution. */
export function readProcedureReviewSnapshot(id:string,host:ProcedureReviewHost):ProcedureReviewSnapshot {
  const db=database(),intent=read(db,id);if(!intent?.target||["complete","cancelled"].includes(intent.status))throw Error("PROCEDURE_REVIEW_UNAVAILABLE");
  const current=intent.snapshot?intent:{...intent,...versions(db)};assertCurrent(db,current,host);
  if(intent.snapshot)return structuredClone(intent.snapshot);
  const evidence=hydrate(db,intent.evidence,intent.scopeId,host);
  return {requestId:id,scopeId:intent.scopeId,target:intent.target,evidenceDigest:hash(evidence),policyRevision:current.policyRevision,deletionEpoch:current.deletionEpoch,learningRevision:current.learningRevision,evidence,outcomeBasis:"source-reported"};
}
export function wakeProcedureReview(id:string):void {
  transaction(db=>{const intent=read(db,id);if(!intent?.target||["complete","cancelled","running"].includes(intent.status))throw Error("PROCEDURE_REVIEW_UNAVAILABLE");save(db,{...intent,status:"pending",reason:undefined,retryAfter:undefined});});
}
