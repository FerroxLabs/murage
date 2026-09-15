import { randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { gepaCallNotStarted, type GepaWorkerCommand } from "../gepa-worker.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope } from "./policy.ts";
import { memoryState } from "./repository.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { withMemoryInferenceLease, type TextOnlyExtractor } from "./extract.ts";
import { memoryRecallCorpus, recallPolicyEvaluator } from "./gepa-recall-corpus.ts";
import { memoryClassificationCorpus, classificationPolicyEvaluator } from "./gepa-classification-corpus.ts";
import { evaluateProcedureWithGepa } from "./gepa-evaluator.ts";
import { admitMemoryEvolutionCorpus, resumeMemoryEvolutionAdmission, publishMemoryEvolutionPolicy,
  readMemoryEvolutionPolicy, rollbackMemoryEvolutionPolicy, memoryEvolutionHistory, memoryEvolutionFieldsSchema } from "./evolution-policy.ts";
import { procedureCandidateHash, validateProcedureEvaluationReceipt, type ProcedureReviewSnapshot, type ProcedureEvaluationReceipt } from "./procedure-review.ts";

export interface EvolutionRuntimeOptions {
  /** Cheap configuration metadata only; must not resolve credentials or hash the worker tree. */
  availabilityIdentity():string;
  modelIdentity():string|null;
  worker():{available:true;command:GepaWorkerCommand;workerDigest:string;cleanup?:()=>void}|{available:false;reason:string};
  resolveExtractor(identity:string):TextOnlyExtractor|null;
  /** Test seam; production always uses the actual GEPA evaluator. */
  evaluate?:typeof evaluateProcedureWithGepa;
}
type State="pending"|"running"|"waiting"|"deferred"|"complete"|"blocked";
interface EvolutionJob {
  schema:1;id:string;grantId:string;scopeId:string;corpusId:string;corpusVersion:string;corpusDigest:string;holdoutDigest:string;
  status:State;reason?:string;availability?:string;retryAt?:number;generation?:string;expiresAt?:number;
  snapshot?:ProcedureReviewSnapshot;seedInstruction?:string;modelIdentity?:string;workerDigest?:string;
  runtimeIdentity?:string;
  receipt?:ProcedureEvaluationReceipt;publishedRevision?:string;
}
const SUBJECT="memory-evolution-runtime",hash=(value:unknown)=>procedureCandidateHash(JSON.stringify(value));
const safeReason=(error:unknown)=>error instanceof Error&&/^[A-Za-z][A-Za-z0-9_-]{1,100}$/.test(error.message)?error.message:"MEMORY_EVOLUTION_FAILED";
function read(id?:string,corpusId?:string):EvolutionJob|undefined {
  const row=id?database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id=?").get(id,SUBJECT)
    :database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? AND (? IS NULL OR json_extract(intent,'$.corpusId')=?) ORDER BY rowid DESC LIMIT 1").get(SUBJECT,corpusId??null,corpusId??null);
  return row?JSON.parse(String(row.intent)) as EvolutionJob:undefined;
}
function save(job:EvolutionJob){database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(job.id,job.scopeId,SUBJECT,JSON.stringify(job));}
const permits=()=>["active","capture"].includes(memoryState().mode)&&readMemoryLearning(database()).automaticProcedures&&!readMemoryLearning(database()).reviewMode;

/** One explicit owner grant runs the shipped synthetic recall corpus once.
 * No owner ticket or private-memory corpus is constructed in the background. */
export function createMemoryEvolutionRuntime(options:EvolutionRuntimeOptions){
  const boot=randomUUID();
  const descriptor=(kind:"recall"|"classification")=>{const corpus=kind==="recall"?memoryRecallCorpus():memoryClassificationCorpus();return {kind,corpus,corpusDigest:hash(corpus),holdoutDigest:hash([corpus.id,corpus.version,corpus.groupBy,corpus.holdout])};};
  const kindFor=(job:EvolutionJob):"recall"|"classification"=>job.corpusId==="memory-classification-groups"?"classification":"recall";
  const availability=()=>`${boot}:${options.availabilityIdentity()}`;
  const status=(kind:"recall"|"classification"="recall")=>{const {corpus}=descriptor(kind),job=read(undefined,corpus.id);return {authorized:Boolean(job&&database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND state='granted'").get(job.grantId)),corpus:{id:corpus.id,version:corpus.version,kind:"synthetic" as const},policy:readMemoryEvolutionPolicy(),job:job?{
    id:job.id,status:job.status,reason:job.reason??null,started:Boolean(job.snapshot),decision:job.receipt?.decision??null,
    publishedRevision:job.publishedRevision??null,costKnown:job.receipt?.accounting?.costKnown??false,actualCostUsd:job.receipt?.accounting?.actualCostUsd??null,heldout:job.receipt?.heldout??null,
  }:null};};
  const authorize=(ticket:object,kind:"recall"|"classification"="recall")=>{
    requireMemoryOwner(ticket);
    const {corpus,corpusDigest,holdoutDigest}=descriptor(kind);
    transaction(()=>{
      const grant=admitMemoryEvolutionCorpus(ticket,{kind:"synthetic",corpusDigest,holdoutDigest,family:kind});
      const id=`memory-evolution-job:${hash([grant.id,corpus.id,corpus.version])}`;
      if(!read(id))save({schema:1,id,grantId:grant.id,scopeId:ensureScope("workspace",memoryState().installationId),corpusId:corpus.id,corpusVersion:corpus.version,corpusDigest,holdoutDigest,status:permits()?"pending":"waiting",...permits()?{}:{reason:"MEMORY_EVOLUTION_ADMISSION_REQUIRED",availability:availability()}});
    });return status(kind);
  };
  const retry=(ticket:object,id:string)=>{
    requireMemoryOwner(ticket);transaction(()=>{const job=read(id);if(!job)throw Error("MEMORY_EVOLUTION_JOB_UNAVAILABLE");
      if(job.status==="running"&&(job.expiresAt??0)>Date.now())throw Error("MEMORY_EVOLUTION_BUSY");
      if(job.status==="complete")return;
      if(job.status==="blocked")throw Error("MEMORY_EVOLUTION_JOB_STALE");
      if(!resumeMemoryEvolutionAdmission(job.grantId))throw Error("MEMORY_EVOLUTION_ADMISSION_REQUIRED");
      save({...job,status:"pending",reason:undefined});});const job=read(id);return status(job?kindFor(job):"recall");
  };
  const pending=()=>{
    if(!permits())return undefined;
    for(const kind of ["recall","classification"] as const){const job=read(undefined,descriptor(kind).corpus.id);if(!job)continue;
      if(job.status==="pending"||job.status==="running"&&(job.expiresAt??0)<=Date.now())return job.id;
      if(job.status==="waiting"&&!job.snapshot&&(job.availability!==availability()||job.reason==="extractor-busy"&&(job.retryAt??Infinity)<=Date.now()))return job.id;
    }
    return undefined;
  };
  const run=async(id:string,signal:AbortSignal)=>{
    const claim=transaction(()=>{const job=read(id);if(!job||["complete","blocked","deferred"].includes(job.status))return undefined;
      if(job.status==="running"&&(job.expiresAt??0)>Date.now())return undefined;
      if(job.status==="running"&&job.snapshot&&!job.receipt){save({...job,status:"deferred",reason:"MEMORY_EVOLUTION_INTERRUPTED"});return undefined;}
      const next={...job,status:"running" as const,generation:randomUUID(),expiresAt:Date.now()+35000};save(next);return next;});
    if(!claim)return status();
    const {kind,corpus,corpusDigest,holdoutDigest}=descriptor(kindFor(claim));
    let worker:ReturnType<EvolutionRuntimeOptions["worker"]>|undefined;
    const current=()=>{const job=read(id);if(!job||job.generation!==claim.generation||job.status!=="running"||(job.expiresAt??0)<Date.now())throw Error("MEMORY_EVOLUTION_LEASE_STALE");if(signal.aborted)throw Error("GEPA_CANCELLED");return job;};
    const wait=(reason:string)=>transaction(()=>{const job=current();save({...job,status:job.snapshot?"deferred":"waiting",reason,availability:availability(),retryAt:reason==="extractor-busy"?Date.now()+1000:undefined});});
    try{
      if(!permits()||!resumeMemoryEvolutionAdmission(claim.grantId)){wait("MEMORY_EVOLUTION_ADMISSION_REQUIRED");return status(kind);}
      if(claim.corpusDigest!==corpusDigest||claim.holdoutDigest!==holdoutDigest)throw Error("MEMORY_EVOLUTION_CORPUS_CHANGED");
      if(claim.receipt&&claim.snapshot){
        const admission=resumeMemoryEvolutionAdmission(claim.grantId)!;
        transaction(()=>{const job=current();const receipt=validateProcedureEvaluationReceipt(claim.snapshot!,claim.receipt);
          if(readMemoryEvolutionPolicy().revision===claim.snapshot!.target.baseRevision&&(claim.runtimeIdentity!==options.availabilityIdentity()||claim.modelIdentity!==options.modelIdentity()))throw Error("MEMORY_EVOLUTION_RUNTIME_CHANGED");
          const published=receipt.decision==="accepted"?publishMemoryEvolutionPolicy(claim.snapshot!,receipt,admission):null;
          save({...job,status:"complete",reason:receipt.decision,...published?{publishedRevision:published.revision}:{}});});return status(kind);
      }
      if(readMemoryLearning(database()).dailyCostUsd!==null){wait("GEPA_COST_AUTHORITY_REQUIRED");return status(kind);}
      const leased=await withMemoryInferenceLease(async lease=>{
        const resource=options.worker();worker=resource;if(!resource.available){wait(resource.reason);return;}
        const selected=options.modelIdentity();if(!selected){wait("MEMORY_EVOLUTION_MODEL_UNAVAILABLE");return;}
        if(claim.snapshot&&(claim.workerDigest!==resource.workerDigest||claim.modelIdentity!==selected||claim.runtimeIdentity!==options.availabilityIdentity()))throw Error("MEMORY_EVOLUTION_RUNTIME_CHANGED");
        const extractor=options.resolveExtractor(selected);if(!extractor){wait("MEMORY_EVOLUTION_MODEL_UNAVAILABLE");return;}
        const job=transaction(()=>{const latest=current();if(latest.snapshot)return latest;
          const policy=readMemoryEvolutionPolicy(),state=memoryState();
          const snapshot:ProcedureReviewSnapshot={requestId:id,scopeId:latest.scopeId,target:{kind:"memory-policy",scopeId:latest.scopeId,ownerId:"workspace-owner",artifactId:"memory-policy",threadId:"memory-policy",baseRevision:policy.revision,bundleId:hash(policy)},policyRevision:state.policyRevision,deletionEpoch:state.deletionEpoch,learningRevision:readMemoryLearning(database()).revision,evidence:[],evidenceDigest:hash([]),outcomeBasis:"source-reported"};
          const next={...latest,snapshot,seedInstruction:JSON.stringify(memoryEvolutionFieldsSchema.parse({extraction:policy.extraction,retrieval:policy.retrieval})),workerDigest:resource.workerDigest,modelIdentity:selected,runtimeIdentity:options.availabilityIdentity()};save(next);return next;});
        const snapshot=job.snapshot!,seed=memoryEvolutionFieldsSchema.parse(JSON.parse(job.seedInstruction!));
        const assertCurrent=(value:ProcedureReviewSnapshot)=>{
          const latest=current(),state=memoryState();
          if(!permits()||!resumeMemoryEvolutionAdmission(job.grantId)||hash(value)!==hash(latest.snapshot)||options.modelIdentity()!==job.modelIdentity||options.availabilityIdentity()!==job.runtimeIdentity||readMemoryEvolutionPolicy().revision!==snapshot.target.baseRevision||state.policyRevision!==snapshot.policyRevision||state.deletionEpoch!==snapshot.deletionEpoch||readMemoryLearning(database()).revision!==snapshot.learningRevision)throw Error("MEMORY_EVOLUTION_AUTHORITY_CHANGED");
        };
        assertCurrent(snapshot);
        const receipt=await (options.evaluate??evaluateProcedureWithGepa)(snapshot,{
          command:resource.command,workerDigest:resource.workerDigest,evaluatorId:`memory-${kind}-policy-v1:${hash(selected).slice(0,24)}`,seedInstruction:job.seedInstruction!,corpus,
          budget:{totalUsd:null,evaluationPerCaseUsd:kind==="recall"?0:null,reflectionUsd:null,authorityReference:`${id}:learning:${snapshot.learningRevision}`},
          evaluate:kind==="recall"?recallPolicyEvaluator(seed):classificationPolicyEvaluator(seed,async(text,messages,callSignal)=>{assertCurrent(snapshot);const result=await lease.request(extractor,text,2000,callSignal,messages,"evaluation");if(result.status==="notStarted")throw gepaCallNotStarted();return {text:result.text,costUsd:null};}),assertCurrent,
          reflect:async(prompt,callSignal)=>{
            assertCurrent(snapshot);
            const messages=Object.freeze([Object.freeze({role:"system",content:kind==="recall"?"Improve only the bounded retrieval fields of the supplied JSON policy using synthetic evaluation feedback. Keep extraction.classificationGuidance unchanged. Return the complete JSON policy inside one triple-backtick envelope. No tools, permissions, budgets, identity, user facts or other fields may be changed.":"Improve only extraction.classificationGuidance in the supplied JSON policy using synthetic classification feedback. Preserve retrieval fields exactly. Return the whole JSON policy inside one triple-backtick envelope. The fixed extraction, grounding, authority and tool-free contracts remain immutable."}),Object.freeze({role:"user",content:prompt})]);
            const result=await lease.request(extractor,prompt,2000,callSignal,messages,"reflection");
            if(result.status==="notStarted")throw gepaCallNotStarted();
            return {text:result.text,costUsd:null};
          },
        },signal);
        transaction(()=>{assertCurrent(snapshot);save({...current(),receipt:validateProcedureEvaluationReceipt(snapshot,receipt)});});
        transaction(()=>{assertCurrent(snapshot);const admission=resumeMemoryEvolutionAdmission(job.grantId)!;
          const published=receipt.decision==="accepted"?publishMemoryEvolutionPolicy(snapshot,receipt,admission):null;
          save({...current(),status:"complete",reason:receipt.decision,...published?{publishedRevision:published.revision}:{}});});
      });
      if(leased.status==="notStarted")wait(leased.reason);
    }catch(error){
      transaction(()=>{const job=read(id);if(job?.generation===claim.generation&&job.status==="running"){
        const reason=safeReason(error),blocked=/CHANGED|CONFLICT|TARGET_MISMATCH|JOB_STALE/.test(reason);
        save({...job,status:blocked?"blocked":job.snapshot?"deferred":"waiting",reason,availability:availability()});
      }});
    }finally{if(worker?.available)worker.cleanup?.();}
    return status(kind);
  };
  return {status,authorize,retry,pending,run,history:(ticket:object)=>memoryEvolutionHistory(ticket),
    rollback:(ticket:object,expectedRevision:string,targetRevision:string)=>{rollbackMemoryEvolutionPolicy(ticket,expectedRevision,targetRevision);return status();}};
}
export type MemoryEvolutionRuntime=ReturnType<typeof createMemoryEvolutionRuntime>;
