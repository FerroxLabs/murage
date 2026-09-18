import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { Store } from "../store.ts";
import { RoutineManager, routineInstructionRevision } from "../routines.ts";
import { createProcedurePin, preparePinnedProcedures } from "../procedure-bundles.ts";
import { taskWorkspacePath } from "../workspace.ts";
import { createProcedureReviewHost } from "../procedure-review-host.ts";
import { stageSkillWrite, applyStagedSkillWrite, assertSkillProcedureEvidence, skillEvolutionDescriptor, publishEvaluatedScopedSkill, wasEvaluatedScopedSkillPublished, rollbackScopedSkillRevision, scopedSkillRevisionHistory } from "../skills.ts";
import { backgroundMemoryAudience, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { captureSource } from "./capture.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { createProcedureEvaluator, type ProcedureEvaluatorBridge, type ProcedureEvaluatorBridgeOptions } from "./procedure-evaluator.ts";
import { pendingProcedureReviews, processProcedureReview, procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureEvaluationReceipt } from "./procedure-review.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { gepaCallNotStarted } from "../gepa-worker.ts";
import { verifyGepaBundle } from "../gepa-resource.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
const hash=(value:unknown)=>procedureCandidateHash(JSON.stringify(value));
const body="## Preconditions\nOnly simulated-file-check-v1.\n\n## Steps\nTreat completed as verified.\n";
const markdown=(text:string)=>`---\nname: checked-method\ndescription: Report simulated outcomes\n---\n${text}`;
const learned=(text:string)=>text.replace("Treat completed as verified.","Verify receipts before reporting completion.");
function fixture(kind:"skill"|"routine"="skill",native?:{directory:string;manifest:string;cancelOnEvaluation?:AbortController}){
  const store=new Store(()=>({instanceId:"fixture",model:"fixture"})),bot=store.createBot(),threadId=bot.threadId;
  reconcileMemoryRoster({bots:store.bots,groups:store.groups});setMemoryMode("capture");
  if(native)transaction(db=>updateMemoryLearning(db,{inputLimit:10_000_000,outputLimit:2_000_000,callsPerMinute:26,dailyCostUsd:null},readMemoryLearning(db).revision));
  const context=(thread=threadId)=>{const a=backgroundMemoryAudience(bot.id,thread,{bots:store.bots,groups:store.groups})!;return {audienceKey:a.audienceKey,allowedScopeIds:a.scopeIds};};
  let host:ReturnType<typeof createProcedureReviewHost>,evaluator:ProcedureEvaluatorBridge;
  const manager=new RoutineManager({file:join(DATA_DIR,"routines.json"),botState:()=>"busy",createTask:()=>null,startTurn:async()=>{},validateInstructionPromotion:(routine,proposal)=>host.validateRoutinePromotion(routine,proposal),validateInstructionEvidence:(ctx,evidence)=>host.validateRoutineEvidence(ctx,evidence)});
  const routine=kind==="routine"?manager.create({name:"Outcome check",botId:bot.id,prompt:body,target:"bot",enabled:false,runOn:"ember",schedule:{type:"interval",everyMinutes:5,anchorAt:Date.now()}}):undefined;
  if(kind==="skill"){const stage=stageSkillWrite(bot.id,{action:"create",source:"learn:synthetic",files:[{path:"SKILL.md",content:markdown(body)}]});if("error" in stage)throw Error(stage.error);const result=applyStagedSkillWrite(bot.id,stage.id);if("error" in result)throw Error(result.error);}
  const pin=createProcedurePin(bot.id,threadId,[],[],routine?{id:routine.id,instructionRevision:routineInstructionRevision(routine)}:undefined,context());store.pinTaskProcedures(bot.id,threadId,pin);preparePinnedProcedures(bot.id,threadId,pin,false,context());
  const hostOptions:Parameters<typeof createProcedureReviewHost>[0]={store,routines:()=>manager,automaticFailureRetry:false,evaluate:(snapshot,signal)=>evaluator.evaluate(snapshot,signal),evaluationReadiness:snapshot=>evaluator.readiness(snapshot),onPublished:(snapshot,receipt,current)=>evaluator.published(snapshot,receipt,current),validateEvidence:(a,e)=>{try{assertSkillProcedureEvidence({audienceKey:a.audienceKey,allowedScopeIds:a.scopeIds},e);return true;}catch{return false;}},skills:{
    current:(id,name,a)=>skillEvolutionDescriptor(id,name,{audienceKey:a.audienceKey,allowedScopeIds:a.scopeIds}),publish:(snapshot,receipt,a)=>publishEvaluatedScopedSkill(snapshot,receipt,{audienceKey:a.audienceKey,allowedScopeIds:a.scopeIds}),wasPublished:(snapshot,receipt,a)=>wasEvaluatedScopedSkillPublished(snapshot,receipt,{audienceKey:a.audienceKey,allowedScopeIds:a.scopeIds}),
  }};
  host=createProcedureReviewHost(hostOptions);
  const seen:string[]=[],seenWindows:number[]=[];let model="fixture-model",refused=false,reflections=0,workerStarts=0;
  const extractor:TextOnlyExtractor=async(text,_maximum,_signal,dispatch)=>{
    seen.push(JSON.stringify(dispatch?.messages));expect(JSON.stringify(dispatch?.messages)).not.toContain("PRIVATE_EVENT_CANARY");
    if(native)seenWindows.push(JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.intent)).minute);
    if(native?.cancelOnEvaluation&&dispatch?.purpose!=="reflection")return await new Promise<string>((_resolve,reject)=>{
      const cancelled=()=>reject(Error("GEPA_CANCELLED"));
      if(_signal.aborted)return cancelled();
      _signal.addEventListener("abort",cancelled,{once:true});queueMicrotask(()=>native.cancelOnEvaluation!.abort());
    });
    if(dispatch?.purpose==="reflection"){
      if(!native)return "```\n"+learned(text)+"\n```";
      const candidate=++reflections===1?body.replace("Treat completed as verified.","Always claim verification."):learned(body);
      return "```\n"+(kind==="skill"?markdown(candidate):candidate)+"\n```";
    }
    const input=JSON.parse(text),correct=input.procedure.includes("Verify receipts"),always=input.procedure.includes("Always claim verification");
    return JSON.stringify({results:input.task.observations.map((item:{id:string;reported:string;verified:boolean;evidenceId:string|null})=>({id:item.id,status:always?"verified":item.reported==="failed"?"failed":correct?!item.verified?"unconfirmed":"verified":"verified",evidenceIds:item.evidenceId?[item.evidenceId]:[]})),actions:[]});
  };
  const scripted:NonNullable<ProcedureEvaluatorBridgeOptions["evaluate"]>=async(snapshot,options,signal)=>{
    if(refused)throw gepaCallNotStarted();
    const reflected=await options.reflect(options.seedInstruction,signal),candidate=/^```\n([\s\S]*)\n```$/.exec(reflected.text)![1];
    const base=await options.evaluate(options.seedInstruction,options.corpus.holdout,signal),next=await options.evaluate(candidate,options.corpus.holdout,signal);
    const receipt:ProcedureEvaluationReceipt={id:`fixture:${hash(snapshot.requestId)}`,requestId:snapshot.requestId,snapshotDigest:procedureSnapshotDigest(snapshot),targetDigest:procedureTargetDigest(snapshot.target),evidenceDigest:snapshot.evidenceDigest,corpusDigest:hash(options.corpus),candidate,candidateHash:procedureCandidateHash(candidate),evaluator:"scripted-controller-fixture",decision:"accepted",heldout:{corpusDigest:hash([options.corpus.id,options.corpus.version,options.corpus.groupBy,options.corpus.holdout]),untouched:true,cases:1,baseline:base.hardPass[0]?base.evaluation.scores[0]:0,candidate:next.hardPass[0]?next.evaluation.scores[0]:0,regressions:0},budgetRespected:true,cancelled:false};return receipt;
  };
  const evaluatorOptions:ProcedureEvaluatorBridgeOptions={host:host.host,readInstruction:host.readInstruction,modelIdentity:()=>model,modelLabel:()=>"Scripted fixture model",availabilityIdentity:()=>model,resolveExtractor:()=>extractor,
    worker:()=>{if(!native)return {available:true,command:{executable:"/synthetic/worker",args:[],cwd:DATA_DIR,expectedPythonVersion:"3.13.15"},workerDigest:"a".repeat(64)};
      const admitted=verifyGepaBundle(native.directory,`${process.platform}-${process.arch}`,native.manifest);workerStarts++;
      return {available:true,command:{executable:admitted.executable,args:[],cwd:DATA_DIR,expectedPythonVersion:admitted.expectedPythonVersion},workerDigest:admitted.manifestSha256};},
    ...(native?{}:{evaluate:scripted})};
  evaluator=createProcedureEvaluator(evaluatorOptions);
  const settle=async(thread=threadId,key="original")=>{
    transaction(db=>{captureSource(db,{id:`tool:${key}`,threadId:thread,turnId:key,kind:"tool-outcome",speaker:"tool",outcome:"failed",text:"PRIVATE_EVENT_CANARY reported output was missing"});captureSource(db,{id:`turn:${key}`,threadId:thread,turnId:key,kind:"turn",speaker:"harness",outcome:"completed",text:"Turn completed."});});
    for(const id of pendingProcedureReviews(4))await processProcedureReview(id,host.host,new AbortController().signal);
    const row=database().prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%' ORDER BY rowid DESC LIMIT 1").get()!;return String(row.id);
  };
  const restart=()=>{
    closeDatabase();const recoveredStore=new Store(()=>({instanceId:"fixture",model:"fixture"}));let recoveredEvaluator:ProcedureEvaluatorBridge;
    const recoveredHost=createProcedureReviewHost({...hostOptions,store:recoveredStore,evaluate:(snapshot,signal)=>recoveredEvaluator.evaluate(snapshot,signal),evaluationReadiness:snapshot=>recoveredEvaluator.readiness(snapshot),onPublished:(snapshot,receipt,current)=>recoveredEvaluator.published(snapshot,receipt,current)});
    recoveredEvaluator=createProcedureEvaluator({...evaluatorOptions,host:recoveredHost.host,readInstruction:recoveredHost.readInstruction});
    return {store:recoveredStore,host:recoveredHost,evaluator:recoveredEvaluator};
  };
  return {store,bot,threadId,context,manager,routine,pin,host,evaluator,settle,seen,seenWindows,restart,nativeCounts:()=>({reflections,workerStarts}),changeModel:()=>{model="changed-model";},refuse:(value:boolean)=>{refused=value;}};
}
it("waits without consuming attempts, admits exact owner preview, publishes scoped bytes and reuses grant on the next task",async()=>{
  const f=fixture(),id=await f.settle();await processProcedureReview(id,f.host.host,new AbortController().signal);
  const pending=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));expect(pending.reason).toBe("PROCEDURE_CORPUS_ADMISSION_REQUIRED");expect(pending.attempts??0).toBe(0);expect(pending.snapshot).toBeUndefined();
  const preview=f.evaluator.preview(ownerMemoryTicket(),id);expect(preview.instruction).toBe(markdown(body));expect(preview.eventEvidenceIncluded).toBe(false);expect(preview.reusableGrant).toBe(false);
  f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);await processProcedureReview(id,f.host.host,new AbortController().signal);
  const next=f.store.createTask(f.bot.id,"next",false)!,pin=createProcedurePin(f.bot.id,next.threadId,[],[],undefined,f.context(next.threadId));f.store.pinTaskProcedures(f.bot.id,next.threadId,pin);preparePinnedProcedures(f.bot.id,next.threadId,pin,false,f.context(next.threadId));
  const file=(thread:string,bundle:string)=>join(taskWorkspacePath(DATA_DIR,f.bot.id,thread),".murage-procedures",bundle,"skills","checked-method","SKILL.md");
  expect(readFileSync(file(next.threadId,pin.bundleId),"utf8")).toBe(learned(markdown(body)));expect(readFileSync(file(f.threadId,f.pin.bundleId),"utf8")).toBe(markdown(body));
  const second=await f.settle(next.threadId,"next");expect(f.evaluator.preview(ownerMemoryTicket(),second).reusableGrant).toBe(true);expect(f.seen).toHaveLength(3);
});
it.each(["skill","routine"] as const)("attributes %s evaluation and reflection to the exact review and shared ledger",async(kind)=>{
  const f=fixture(kind),id=await f.settle(),preview=f.evaluator.preview(ownerMemoryTicket(),id);
  f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);
  await processProcedureReview(id,f.host.host,new AbortController().signal);
  const rows=database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='procedure-evaluation-charges'").all();
  expect(rows).toHaveLength(1);
  const charges=JSON.parse(String(rows[0].intent));
  const review=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
  const grant=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='procedure-evaluation-grant'").get()!.intent));
  const ledger=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.intent));
  expect(review.status).toBe("complete");
  expect(charges).toMatchObject({schema:1,reviewId:review.snapshot.requestId,grantId:grant.id,evaluation:{calls:2},reflection:{calls:1},refusals:{}});
  expect(charges.evaluation.input+charges.reflection.input).toBe(ledger.input);
  expect(charges.evaluation.output+charges.reflection.output).toBe(ledger.output);
  expect(ledger.calls).toBe(3);
  expect(f.seen).toHaveLength(3);
});
it("rejects changed model preview with409 and never sends original private evidence",async()=>{
  const f=fixture(),id=await f.settle(),preview=f.evaluator.preview(ownerMemoryTicket(),id);f.changeModel();expect(()=>f.evaluator.authorize(ownerMemoryTicket(),preview.previewId)).toThrow("PROCEDURE_PREVIEW_CHANGED");
  try{f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);}catch(error){expect(error).toMatchObject({status:409});}expect(f.seen).toEqual([]);
});
it("updates only routine instruction fields, preserving queued instruction and schedule authority",async()=>{
  const f=fixture("routine"),queued=f.manager.runNow(f.routine!.id)!,id=await f.settle(),preview=f.evaluator.preview(ownerMemoryTicket(),id);
  f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);await processProcedureReview(id,f.host.host,new AbortController().signal);
  const current=f.manager.listRoutines()[0];expect(current.prompt).toBe(learned(body).trim());expect(current.schedule).toEqual(f.routine!.schedule);expect(current.enabled).toBe(f.routine!.enabled);expect(current.runOn).toBe(f.routine!.runOn);expect(current.botId).toBe(f.routine!.botId);expect(queued.prompt).toBe(f.routine!.prompt);
  expect(f.manager.runNow(current.id)!.prompt).toBe(learned(body).trim());
});
it("resumes a quota-refused started review using its existing grant and snapshot",async()=>{
  const f=fixture(),id=await f.settle(),preview=f.evaluator.preview(ownerMemoryTicket(),id);f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);f.refuse(true);
  await processProcedureReview(id,f.host.host,new AbortController().signal);const first=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));expect(first).toMatchObject({status:"deferred",retryAfter:null,attempts:0});expect(first.snapshot).toBeTruthy();expect(f.seen).toEqual([]);
  f.refuse(false);f.evaluator.retry(ownerMemoryTicket(),id);await processProcedureReview(id,f.host.host,new AbortController().signal);
  const last=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));expect(last.status).toBe("complete");expect(last.snapshot).toEqual(first.snapshot);expect(f.seen).toHaveLength(3);
  expect(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id='procedure-evaluation-grant' AND state='granted'").get()?.n).toBe(1);
});
it("recovers already-published bytes and advances a missed grant acknowledgement without evaluation",async()=>{
  const f=fixture(),id=await f.settle(),preview=f.evaluator.preview(ownerMemoryTicket(),id);f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);await processProcedureReview(id,f.host.host,new AbortController().signal);
  database().prepare("UPDATE memory_scope_bindings SET intent=json_remove(json_set(intent,'$.currentRevision',json_extract(intent,'$.rootRevision'),'$.currentSeedHash',?),'$.lastReceiptId') WHERE subject_id='procedure-evaluation-grant'").run(procedureCandidateHash(markdown(body)));
  database().prepare("UPDATE memory_scope_bindings SET subject_id='procedure-review-pending',intent=json_set(intent,'$.status','deferred','$.retryAfter',NULL) WHERE id=?").run(id);
  expect(pendingProcedureReviews(4,f.host.host)).toContain(id);await processProcedureReview(id,f.host.host,new AbortController().signal);expect(f.seen).toHaveLength(3);
  const grant=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='procedure-evaluation-grant' AND state='granted'").get()!.intent));expect(grant.currentRevision).not.toBe(grant.rootRevision);expect(grant.currentSeedHash).toBe(procedureCandidateHash(learned(markdown(body))));
});

// Explicit native qualification only: ordinary CI has no admitted native bundle.
/** MURAGE_B33_NATIVE_RECEIPT names where a native run's receipt goes. It has
 * no default; it must be an absolute path outside this checkout, so a
 * receipt can never land in (and be committed with) the repository. */
const receiptOutsideCheckout=(path:string)=>{const rel=relative(resolve(import.meta.dirname,"..",".."),path);return isAbsolute(path)&&(rel.startsWith("..")||isAbsolute(rel));};

it.skipIf(!process.env.MURAGE_B33_NATIVE_DIR)("native GEPA completes approved publication, restart recovery and scoped rollback",async()=>{
  const native={directory:process.env.MURAGE_B33_NATIVE_DIR!,manifest:process.env.MURAGE_B33_NATIVE_MANIFEST!};
  expect(native.manifest).toMatch(/^[a-f0-9]{64}$/);
  const f=fixture("skill",native),id=await f.settle();
  expect(f.nativeCounts()).toEqual({reflections:0,workerStarts:0});
  const preview=f.evaluator.preview(ownerMemoryTicket(),id);f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);
  await processProcedureReview(id,f.host.host,new AbortController().signal);
  const readReview=()=>JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
  const review=readReview();expect(review,String(review.reason??"Missing review outcome")).toMatchObject({status:"complete",reason:"accepted"});
  const receipt=review.receipt as ProcedureEvaluationReceipt;
  expect(receipt).toMatchObject({decision:"accepted",candidate:learned(markdown(body)).trim(),heldout:{untouched:true,baseline:0,candidate:1,regressions:0},budgetRespected:true,accounting:{costKnown:false,actualCostUsd:null,reflectionCalls:2}});
  expect(receipt.evaluator).toContain(`:${native.manifest}`);expect(receipt.accounting!.metricCalls).toBeLessThanOrEqual(24);
  expect(f.nativeCounts()).toEqual({reflections:2,workerStarts:1});
  const charge=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='procedure-evaluation-charges'").get()!.intent));
  const ledger=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.intent));
  expect(charge.evaluation.calls+charge.reflection.calls).toBe(f.seen.length);expect(ledger.calls).toBe(f.seenWindows.filter(minute=>minute===ledger.minute).length);expect(f.seen.length).toBeLessThanOrEqual(26);
  expect(charge.evaluation.input+charge.reflection.input).toBe(ledger.input);expect(charge.evaluation.output+charge.reflection.output).toBe(ledger.output);
  const reflections=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'gepa-call:%' AND json_extract(intent,'$.kind')='reflect'").all().map(row=>JSON.parse(String(row.intent)));
  expect(reflections).toHaveLength(2);expect(reflections.every(row=>row.state==="complete")).toBe(true);
  expect(reflections.some(row=>JSON.stringify(row.value).includes("Always claim verification"))).toBe(true);
  expect(receipt.candidate).not.toContain("Always claim verification");
  const file=(thread:string,bundle:string)=>join(taskWorkspacePath(DATA_DIR,f.bot.id,thread),".murage-procedures",bundle,"skills","checked-method","SKILL.md");
  const pinTask=(store:Store,name:string)=>{const task=store.createTask(f.bot.id,name,false)!;expect(task).toBeTruthy();const audience=backgroundMemoryAudience(f.bot.id,task.threadId,{bots:store.bots,groups:store.groups})!;expect(audience).toBeTruthy();const context={audienceKey:audience.audienceKey,allowedScopeIds:audience.scopeIds};const pin=createProcedurePin(f.bot.id,task.threadId,[],[],undefined,context);store.pinTaskProcedures(f.bot.id,task.threadId,pin);preparePinnedProcedures(f.bot.id,task.threadId,pin,false,context);return {task,pin};};
  const next=pinTask(f.store,"native published");
  expect(readFileSync(file(f.threadId,f.pin.bundleId),"utf8")).toBe(markdown(body));
  expect(readFileSync(file(next.task.threadId,next.pin.bundleId),"utf8")).toBe(receipt.candidate);
  const charges=()=>database().prepare("SELECT id,intent FROM memory_scope_bindings WHERE id LIKE 'gepa-%' OR subject_id IN ('extract-budget','procedure-evaluation-charges') ORDER BY id").all();
  const beforeRestart=charges(),seenBefore=f.seen.length;
  // Reproduce a crash after publication but before its grant acknowledgement.
  database().prepare("UPDATE memory_scope_bindings SET intent=json_remove(json_set(intent,'$.currentRevision',json_extract(intent,'$.rootRevision'),'$.currentSeedHash',?),'$.lastReceiptId') WHERE subject_id='procedure-evaluation-grant'").run(procedureCandidateHash(markdown(body)));
  database().prepare("UPDATE memory_scope_bindings SET subject_id='procedure-review-pending',intent=json_set(intent,'$.status','deferred','$.retryAfter',NULL) WHERE id=?").run(id);
  const recovered=f.restart();expect(pendingProcedureReviews(4,recovered.host.host)).toContain(id);
  await processProcedureReview(id,recovered.host.host,new AbortController().signal);
  expect(readReview().status).toBe("complete");expect(f.seen).toHaveLength(seenBefore);expect(f.nativeCounts().workerStarts).toBe(1);expect(charges()).toEqual(beforeRestart);
  const grant=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='procedure-evaluation-grant' AND state='granted'").get()!.intent));
  expect(grant.currentSeedHash).toBe(receipt.candidateHash);expect(grant.lastReceiptId).toBe(receipt.id);
  const history=scopedSkillRevisionHistory(f.bot.id,"checked-method",f.context())!;
  expect(history.currentRevision).toBe(`evaluated:${receipt.id}`);expect(history.revisions.some(item=>item.revision===review.snapshot.target.baseRevision)).toBe(true);
  const rolled=rollbackScopedSkillRevision(f.bot.id,"checked-method",history.currentRevision!,review.snapshot.target.baseRevision,f.context());expect(rolled).not.toHaveProperty("error");
  const afterRollback=pinTask(recovered.store,"native rollback");
  expect(readFileSync(file(afterRollback.task.threadId,afterRollback.pin.bundleId),"utf8")).toBe(markdown(body));
  expect(readFileSync(file(next.task.threadId,next.pin.bundleId),"utf8")).toBe(receipt.candidate);expect(readFileSync(file(f.threadId,f.pin.bundleId),"utf8")).toBe(markdown(body));
  const evidence=process.env.MURAGE_B33_NATIVE_RECEIPT;
  if(evidence){expect(receiptOutsideCheckout(evidence)).toBe(true);writeFileSync(evidence,JSON.stringify({status:"PASS",nativeManifest:native.manifest,receipt,charges:charge,ledgerCalls:ledger.calls,nativeCounts:f.nativeCounts(),restartChargesUnchanged:true,activePinUnchanged:true,nextPinPublished:true,rollbackRestoredBase:true,earlierPinsUnchanged:true,networkProviderCalls:0},null,2)+"\n",{flag:"wx",mode:0o600});}
},45_000);

it.skipIf(!process.env.MURAGE_B33_NATIVE_DIR)("native GEPA cancellation preserves publication and fences restart charges",async()=>{
  const cancel=new AbortController(),native={directory:process.env.MURAGE_B33_NATIVE_DIR!,manifest:process.env.MURAGE_B33_NATIVE_MANIFEST!,cancelOnEvaluation:cancel};
  const f=fixture("skill",native),id=await f.settle(),preview=f.evaluator.preview(ownerMemoryTicket(),id);f.evaluator.authorize(ownerMemoryTicket(),preview.previewId);
  await processProcedureReview(id,f.host.host,cancel.signal);
  const readReview=()=>JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
  const review=readReview();expect(review).toMatchObject({status:"deferred",attempts:1,retryAfter:null});expect(review.reason).toMatch(/CANCEL/);expect(review.receipt).toBeUndefined();
  expect(f.seen).toHaveLength(1);expect(f.nativeCounts()).toEqual({workerStarts:1,reflections:0});
  const current=skillEvolutionDescriptor(f.bot.id,"checked-method",f.context())!;expect(current.revision).toBe(review.snapshot.target.baseRevision);expect(current.sha256).toBe(procedureCandidateHash(markdown(body)));
  const rows=()=>database().prepare("SELECT id,intent FROM memory_scope_bindings WHERE id LIKE 'gepa-%' OR subject_id IN ('extract-budget','procedure-evaluation-charges') ORDER BY id").all();
  const before=rows(),recovered=f.restart();await processProcedureReview(id,recovered.host.host,new AbortController().signal);
  expect(rows()).toEqual(before);expect(f.seen).toHaveLength(1);expect(f.nativeCounts().workerStarts).toBe(1);expect(readReview().status).toBe("deferred");
  const evidence=process.env.MURAGE_B33_NATIVE_RECEIPT;
  if(evidence){expect(receiptOutsideCheckout(evidence)).toBe(true);writeFileSync(evidence+".cancel.json",JSON.stringify({status:"PASS",nativeManifest:native.manifest,reason:review.reason,nativeCounts:f.nativeCounts(),publicationUnchanged:true,restartChargesUnchanged:true,networkProviderCalls:0},null,2)+"\n",{flag:"wx",mode:0o600});}
},45_000);
