import { randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { gepaCallNotStarted } from "../gepa-worker.ts";
import { requireMemoryOwner } from "./authority.ts";
import { memoryState } from "./repository.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { withMemoryInferenceLease, type MemoryInferenceObserver } from "./extract.ts";
import type { DatabaseSync } from "node:sqlite";
import { evaluateProcedureWithGepa } from "./gepa-evaluator.ts";
import { PROCEDURE_CORPUS_DESCRIPTION, procedureFrozenSections, procedureOutcomeCorpus, procedureOutcomeEvaluator } from "./gepa-procedure-corpus.ts";
import { procedureCandidateHash, procedureSnapshotDigest, readProcedureReviewSnapshot, validateProcedureEvaluationReceipt, wakeProcedureReview,
  type ProcedureReviewHost, type ProcedureReviewSnapshot, type ProcedureReviewTarget, type ProcedureEvaluationReceipt } from "./procedure-review.ts";
import type { EvolutionRuntimeOptions } from "./evolution-runtime.ts";

const PREVIEW="procedure-evaluation-preview",GRANT="procedure-evaluation-grant",SESSION="procedure-evaluation-session",CHARGES="procedure-evaluation-charges";
const hash=(value:unknown)=>procedureCandidateHash(JSON.stringify(value));
type Handle=Pick<ProcedureReviewSnapshot["evidence"][number],"kind"|"id"|"revision"|"scopeId">;
interface Preview {schema:1;id:string;reviewId:string;target:ProcedureReviewTarget;seedHash:string;modelIdentity:string;corpusDigest:string;policyRevision:number;deletionEpoch:number;learningRevision:number;evidence:Handle[];createdAt:number;revoked?:boolean}
type Tally={calls:number;input:number;output:number};
/** Per-review lease accounting: every lease.request charge and refusal, keyed like the session. */
interface Charges {schema:1;reviewId:string;grantId:string;evaluation:Tally;reflection:Tally;refusals:Record<string,number>}
interface Grant extends Omit<Preview,"reviewId"|"target"|"seedHash"|"createdAt"> {targetKey:string;scopeId:string;kind:"skill"|"routine";ownerId:string;artifactId:string;rootRevision:string;currentRevision:string;currentSeedHash:string;corpusId:string;corpusVersion:string;lastReceiptId?:string}
export interface ProcedureEvaluatorBridgeOptions extends EvolutionRuntimeOptions {
  host:ProcedureReviewHost;
  readInstruction(target:ProcedureReviewTarget):string;
  modelLabel():string;
  audienceLabel?(target:ProcedureReviewTarget):string;
  workerReady?():boolean;
}
function load<T>(id:string,subject:string):T|undefined {const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id=? AND state='granted'").get(id,subject);if(!row)return;const value=JSON.parse(String(row.intent));return value?.revoked?undefined:value as T;}
function persist(id:string,scopeId:string,subject:string,value:unknown){database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(id,scopeId,subject,JSON.stringify(value));}
const handles=(snapshot:ProcedureReviewSnapshot):Handle[]=>snapshot.evidence.map(({kind,id,revision,scopeId})=>({kind,id,revision,scopeId}));
const targetKey=(target:ProcedureReviewTarget)=>hash([target.kind,target.scopeId,target.ownerId,target.artifactId]);

/** Host-owned synthetic registry and owner-admitted instruction bytes. Original
 * event text stays local; it is never smuggled into a synthetic model corpus. */
export function createProcedureEvaluator(options:ProcedureEvaluatorBridgeOptions){
  const corpus=procedureOutcomeCorpus(),corpusDigest=hash(corpus);
  const model=()=>options.modelIdentity();
  const fences=()=>({policyRevision:memoryState().policyRevision,deletionEpoch:memoryState().deletionEpoch,learningRevision:readMemoryLearning(database()).revision});
  const seed=(snapshot:ProcedureReviewSnapshot)=>{const instruction=options.readInstruction(snapshot.target);if(snapshot.target.kind==="memory-policy"||!instruction.trim()||instruction.length>20000)throw Error("PROCEDURE_INSTRUCTION_UNAVAILABLE");procedureFrozenSections(instruction,snapshot.target.kind);return instruction;};
  const grantFor=(snapshot:ProcedureReviewSnapshot,instruction:string):Grant|undefined=>{
    const row=database().prepare("SELECT id FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? AND scope_id=? AND state='granted' AND json_extract(intent,'$.targetKey')=? ORDER BY rowid DESC LIMIT 1").get(GRANT,snapshot.target.scopeId,targetKey(snapshot.target));
    const grant=row?load<Grant>(String(row.id),GRANT):undefined,current=fences();
    if(!grant||grant.schema!==1||grant.currentRevision!==snapshot.target.baseRevision||grant.currentSeedHash!==procedureCandidateHash(instruction)||grant.modelIdentity!==model()||grant.corpusDigest!==corpusDigest||grant.policyRevision!==current.policyRevision||grant.deletionEpoch!==current.deletionEpoch||grant.learningRevision!==current.learningRevision||!grant.evidence.every(item=>options.host.canReadEvidence(grant.scopeId,item.scopeId,item)))return;
    return grant;
  };
  const readiness=(snapshot:ProcedureReviewSnapshot):{ready:true}|{ready:false;reason:string}=>{
    try{
      if(!model())return {ready:false,reason:"PROCEDURE_MODEL_UNAVAILABLE"};
      if(options.workerReady&&!options.workerReady())return {ready:false,reason:"GEPA_RESOURCE_UNAVAILABLE"};
      if(readMemoryLearning(database()).dailyCostUsd!==null)return {ready:false,reason:"GEPA_COST_AUTHORITY_REQUIRED"};
      if(!grantFor(snapshot,seed(snapshot)))return {ready:false,reason:"PROCEDURE_CORPUS_ADMISSION_REQUIRED"};
      return {ready:true};
    }catch{return {ready:false,reason:"PROCEDURE_INSTRUCTION_UNAVAILABLE"};}
  };
  const status=(ticket:object)=>{
    requireMemoryOwner(ticket);
    const rows=database().prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='procedure-review-pending' AND state='granted' AND json_extract(intent,'$.target') IS NOT NULL ORDER BY rowid DESC LIMIT 32").all();
    return {reviews:rows.map(row=>{const intent=JSON.parse(String(row.intent));return {id:String(row.id),target:intent.target,status:intent.status,reason:intent.reason??null,started:Boolean(intent.snapshot)};}),max:32 as const};
  };
  const preview=(ticket:object,reviewId:string)=>{
    requireMemoryOwner(ticket);const snapshot=readProcedureReviewSnapshot(reviewId,options.host),instruction=seed(snapshot),selected=model(),state=fences();
    const id=`procedure-evaluation-preview:${randomUUID()}`;
    if(selected)transaction(()=>persist(id,snapshot.target.scopeId,PREVIEW,{schema:1,id,reviewId,target:snapshot.target,seedHash:procedureCandidateHash(instruction),modelIdentity:selected,corpusDigest,...state,evidence:handles(snapshot),createdAt:Date.now()} satisfies Preview));
    const grant=selected?grantFor(snapshot,instruction):undefined;
    return {previewId:id,reviewId,instruction,target:{kind:snapshot.target.kind,artifactId:snapshot.target.artifactId,ownerId:snapshot.target.ownerId,scopeId:snapshot.target.scopeId},audienceLabel:options.audienceLabel?.(snapshot.target)??"Selected private procedure audience",
      model:selected?{identity:selected,label:options.modelLabel()}:null,corpus:{id:corpus.id,version:corpus.version,kind:"synthetic" as const,description:PROCEDURE_CORPUS_DESCRIPTION},eventEvidenceIncluded:false as const,eligible:Boolean(selected),reason:selected?null:"PROCEDURE_MODEL_UNAVAILABLE",reusableGrant:Boolean(grant)};
  };
  const authorize=(ticket:object,previewId:string)=>{
    requireMemoryOwner(ticket);try{return transaction(()=>{
      const reviewed=load<Preview>(previewId,PREVIEW);if(!reviewed)throw Object.assign(Error("PROCEDURE_PREVIEW_CHANGED"),{status:409});
      const snapshot=readProcedureReviewSnapshot(reviewed.reviewId,options.host),instruction=seed(snapshot),state=fences();
      if(hash(snapshot.target)!==hash(reviewed.target)||reviewed.seedHash!==procedureCandidateHash(instruction)||reviewed.modelIdentity!==model()||reviewed.corpusDigest!==corpusDigest||reviewed.policyRevision!==state.policyRevision||reviewed.deletionEpoch!==state.deletionEpoch||reviewed.learningRevision!==state.learningRevision||hash(reviewed.evidence)!==hash(handles(snapshot)))throw Object.assign(Error("PROCEDURE_PREVIEW_CHANGED"),{status:409});
      if(snapshot.target.kind==="memory-policy")throw Error("PROCEDURE_TARGET_STALE");
      const key=targetKey(snapshot.target),id=`procedure-evaluation-grant:${hash([key,reviewed.seedHash,snapshot.target.baseRevision,model(),corpusDigest,state])}`;
      database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE subject_type='system' AND subject_id=? AND json_extract(intent,'$.targetKey')=? AND id!=?").run(GRANT,key,id);
      persist(id,snapshot.target.scopeId,GRANT,{schema:1,id,targetKey:key,scopeId:snapshot.target.scopeId,kind:snapshot.target.kind,ownerId:snapshot.target.ownerId,artifactId:snapshot.target.artifactId,rootRevision:snapshot.target.baseRevision,currentRevision:snapshot.target.baseRevision,currentSeedHash:reviewed.seedHash,modelIdentity:reviewed.modelIdentity,corpusId:corpus.id,corpusVersion:corpus.version,corpusDigest,...state,evidence:reviewed.evidence} satisfies Grant);
      wakeProcedureReview(reviewed.reviewId);return {authorized:true as const,reviewId:reviewed.reviewId};
    });}catch{throw Object.assign(Error("PROCEDURE_PREVIEW_CHANGED"),{status:409});}
  };
  const evaluate:NonNullable<ProcedureReviewHost["evaluate"]>=async(snapshot,signal)=>{
    const instruction=seed(snapshot),grant=grantFor(snapshot,instruction);if(!grant)throw gepaCallNotStarted();
    const chargesId=`${CHARGES}:${hash(snapshot.requestId)}`;
    const tally=(db:DatabaseSync,change:(value:Charges)=>void)=>{
      const row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id=?").get(chargesId,CHARGES);
      const value:Charges=row?JSON.parse(String(row.intent)):{schema:1,reviewId:snapshot.requestId,grantId:grant.id,evaluation:{calls:0,input:0,output:0},reflection:{calls:0,input:0,output:0},refusals:{}};
      change(value);db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(chargesId,snapshot.target.scopeId,CHARGES,JSON.stringify(value));
    };
    // Charged inside the extract-budget reservation transaction; a refusal charges nothing and is counted by reason.
    const observer:MemoryInferenceObserver={charged:(db,charge)=>tally(db,value=>{const part=value[charge.purpose];part.calls++;part.input+=charge.input;part.output+=charge.output;}),
      refused:reason=>transaction(db=>tally(db,value=>{value.refusals[reason]=(value.refusals[reason]??0)+1;}))};
    const leased=await withMemoryInferenceLease(async lease=>{
      const worker=options.worker();if(!worker.available)throw gepaCallNotStarted();
      try{
        const selected=model();if(!selected||selected!==grant.modelIdentity)throw Error("PROCEDURE_MODEL_CHANGED");
        const sessionId=`procedure-evaluation-session:${hash(snapshot.requestId)}`;
        const session={schema:1,reviewId:snapshot.requestId,snapshotDigest:procedureSnapshotDigest(snapshot),seedHash:procedureCandidateHash(instruction),grantId:grant.id,modelIdentity:selected,workerDigest:worker.workerDigest,evidence:handles(snapshot)};
        transaction(()=>{const existing=database().prepare("SELECT state FROM memory_scope_bindings WHERE id=?").get(sessionId);if(existing&&existing.state!=="granted")throw Error("PROCEDURE_EVALUATION_REVOKED");const prior=load<typeof session>(sessionId,SESSION);if(prior&&hash(prior)!==hash(session))throw Error("PROCEDURE_EVALUATION_IDENTITY_CHANGED");persist(sessionId,snapshot.target.scopeId,SESSION,session);});
        const extractor=options.resolveExtractor(selected);if(!extractor)throw gepaCallNotStarted();
        const assertCurrent=(value:ProcedureReviewSnapshot)=>{if(signal.aborted||procedureSnapshotDigest(value)!==procedureSnapshotDigest(snapshot)||!options.host.canPublish(snapshot)||!grantFor(snapshot,instruction)||!load(sessionId,SESSION))throw Error("PROCEDURE_EVALUATION_REVOKED");};
        const request=async(text:string,messages:ReadonlyArray<Readonly<{role:string;content:string}>>,callSignal:AbortSignal,purpose:"evaluation"|"reflection"="evaluation")=>{
          assertCurrent(snapshot);const result=await lease.request(extractor,text,purpose==="reflection"?8000:2000,callSignal,messages,purpose);if(result.status==="notStarted")throw gepaCallNotStarted();return {text:result.text,costUsd:null};
        };
        return await (options.evaluate??evaluateProcedureWithGepa)(snapshot,{command:worker.command,workerDigest:worker.workerDigest,evaluatorId:`procedure-outcomes-v1:${hash(selected).slice(0,24)}`,seedInstruction:instruction,corpus,
          budget:{totalUsd:readMemoryLearning(database()).dailyCostUsd,evaluationPerCaseUsd:null,reflectionUsd:null,authorityReference:grant.id},evaluate:procedureOutcomeEvaluator(instruction,snapshot.target.kind as "skill"|"routine",request),assertCurrent,
          reflect:(prompt,callSignal)=>request(prompt,Object.freeze([Object.freeze({role:"system",content:"Improve the supplied procedure against synthetic simulated outcomes. Preserve its frontmatter, compatibility and preconditions exactly. Do not add permissions, external actions, recipients or schedules. Return the complete instruction inside one outer triple-backtick envelope."}),Object.freeze({role:"user",content:prompt})]),callSignal,"reflection"),
        },signal);
      }finally{worker.cleanup?.();}
    },observer);
    if(leased.status==="notStarted")throw gepaCallNotStarted();return leased.value;
  };
  const published=(snapshot:ProcedureReviewSnapshot,receipt:ProcedureEvaluationReceipt,current:{revision:string;sha256:string})=>{
    validateProcedureEvaluationReceipt(snapshot,receipt);if(receipt.decision!=="accepted"||current.sha256!==receipt.candidateHash)return;
    transaction(()=>{
      const rows=database().prepare("SELECT id FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? AND scope_id=? AND state='granted' AND json_extract(intent,'$.targetKey')=?").all(GRANT,snapshot.target.scopeId,targetKey(snapshot.target));
      for(const row of rows){const grant=load<Grant>(String(row.id),GRANT);if(!grant||grant.lastReceiptId===receipt.id||grant.currentRevision!==snapshot.target.baseRevision||grant.modelIdentity!==model()||grant.corpusDigest!==receipt.corpusDigest)continue;
        const evidence=[...new Map([...grant.evidence,...handles(snapshot)].map(item=>[hash(item),item])).values()];
        if(evidence.length>64){database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id=?").run(grant.id);continue;}
        persist(grant.id,grant.scopeId,GRANT,{...grant,evidence,currentRevision:current.revision,currentSeedHash:current.sha256,lastReceiptId:receipt.id});}
    });
  };
  const retry=(ticket:object,reviewId:string)=>{
    requireMemoryOwner(ticket);try{
      const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='procedure-review-pending' AND state='granted'").get(reviewId),intent=row?JSON.parse(String(row.intent)):null;
      if(intent?.status!=="deferred"||!intent.snapshot)throw Error("PROCEDURE_REVIEW_NOT_RETRYABLE");
      const snapshot=readProcedureReviewSnapshot(reviewId,options.host);if(!grantFor(snapshot,seed(snapshot)))throw Error("PROCEDURE_PREVIEW_CHANGED");wakeProcedureReview(reviewId);return {authorized:true as const,reviewId};
    }catch{throw Object.assign(Error("PROCEDURE_PREVIEW_CHANGED"),{status:409});}
  };
  return {status,preview,authorize,retry,readiness,evaluate,published};
}
export type ProcedureEvaluatorBridge=ReturnType<typeof createProcedureEvaluator>;
