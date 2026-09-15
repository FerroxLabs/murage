import { correctMemory, ownerMemoryTicket } from "./memory/authority.ts";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { captureSource } from "./memory/capture.ts";
import { memoryState, setMemoryMode } from "./memory/repository.ts";
import { procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureReviewSnapshot, type ProcedureEvaluationReceipt } from "./memory/procedure-review.ts";
import { applyStagedSkillWrite, stageSkillWrite, skillEvolutionDescriptor, publishEvaluatedScopedSkill, wasEvaluatedScopedSkillPublished, readSkillFile, rollbackSkillRevision, rollbackScopedSkillRevision, scopedSkillRevisionHistory, skillRevisionHistory, type SkillProcedureContext, assertSkillProcedureEvidence } from "./skills.ts";
import { createProcedurePin, preparePinnedProcedures, readProcedureBundle } from "./procedure-bundles.ts";
import { taskWorkspacePath } from "./workspace.ts";
const botId="scoped-fixture",name="checked-method";
const md=(body:string)=>`---\nname: ${name}\ndescription: Checked method\n---\n${body}\n`;
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");});
function ownerEdit(body:string,action:"create"|"update"="create"){
  const stage=stageSkillWrite(botId,{action,targetName:action==="update"?name:undefined,source:"learn:owner-fixture",files:[{path:"SKILL.md",content:md(body)}]});
  if("error" in stage)throw Error(stage.error);
  const result=applyStagedSkillWrite(botId,stage.id);if("error" in result)throw Error(result.error);return stage.id;
}
function evidence(threadId:string,text:string){
  const id=`source:${threadId}`;
  transaction(db=>captureSource(db,{id,threadId,kind:"tool-outcome",speaker:"tool",outcome:"completed",text,action:{label:"fixture-check",reportedOutcome:"completed",verification:"tool-reported"}}));
  const scopeId=String(database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(id)!.scope_id);
  return {kind:"source" as const,id,revision:1,scopeId,text,speaker:"tool",outcome:"completed"};
}
function proposal(threadId:string,audienceKey:string,text:string){
  const source=evidence(threadId,text),context:SkillProcedureContext={audienceKey,allowedScopeIds:[source.scopeId]};
  const pin=createProcedurePin(botId,threadId,[],[],undefined,context),base=readProcedureBundle(botId,threadId,pin).imported[0]!;
  const state=memoryState();
  const snapshot:ProcedureReviewSnapshot={requestId:`review:${threadId}`,scopeId:source.scopeId,target:{kind:"skill",scopeId:source.scopeId,ownerId:botId,artifactId:name,baseRevision:base.revision!,threadId,bundleId:pin.bundleId},evidenceDigest:procedureCandidateHash(JSON.stringify([source])),policyRevision:state.policyRevision,deletionEpoch:state.deletionEpoch,learningRevision:1,evidence:[source],outcomeBasis:"source-reported"};
  const candidate=md(text),receipt:ProcedureEvaluationReceipt={id:`receipt:${threadId}`,requestId:snapshot.requestId,snapshotDigest:procedureSnapshotDigest(snapshot),targetDigest:procedureTargetDigest(snapshot.target),evidenceDigest:snapshot.evidenceDigest,candidate,candidateHash:procedureCandidateHash(candidate),evaluator:"fixture-evaluator",decision:"accepted",heldout:{corpusDigest:"a".repeat(64),untouched:true,cases:2,baseline:0,candidate:1,regressions:0},budgetRespected:true,cancelled:false};
  return {source,context,pin,snapshot,receipt};
}
function pinnedText(threadId:string,context:SkillProcedureContext){
  const pin=createProcedurePin(botId,threadId,[],[],undefined,context),prepared=preparePinnedProcedures(botId,threadId,pin,true,context);
  const file=JSON.parse(/Read (".*")\./.exec(prepared.importedPrompt)![1]!);
  return {pin,text:readFileSync(file,"utf8"),file};
}
it("private owner/person/room evaluated pointers never change global or another audience's selected bytes",()=>{
  const original=ownerEdit("GLOBAL OWNER METHOD");
  const owner=proposal("owner-task",`bot:${botId}:owner`,"OWNER_PRIVATE_CANARY");publishEvaluatedScopedSkill(owner.snapshot,owner.receipt,owner.context);
  expect(readSkillFile(botId,name)).toBe(md("GLOBAL OWNER METHOD"));
  expect(wasEvaluatedScopedSkillPublished(owner.snapshot,owner.receipt,owner.context)).toBe(true);
  expect(skillEvolutionDescriptor(botId,name)?.revision).toBe(original);
  expect(pinnedText("owner-next",owner.context).text).toContain("OWNER_PRIVATE_CANARY");
  const person=proposal("person-task",`bot:${botId}:person:visitor`,"PERSON_PRIVATE_CANARY");
  expect(readProcedureBundle(botId,"person-task",person.pin).imported[0]!.revision).toBe(original);
  publishEvaluatedScopedSkill(person.snapshot,person.receipt,person.context);
  expect(pinnedText("person-next",person.context).text).toContain("PERSON_PRIVATE_CANARY");
  const room=proposal("room-task",`room:room-one:bot:${botId}`,"ROOM_PRIVATE_CANARY");publishEvaluatedScopedSkill(room.snapshot,room.receipt,room.context);
  expect(pinnedText("room-next",room.context).text).toContain("ROOM_PRIVATE_CANARY");
  expect(pinnedText("owner-again",owner.context).text).not.toContain("PERSON_PRIVATE_CANARY");
  expect(pinnedText("another-person",{...owner.context,audienceKey:`bot:${botId}:person:other`}).text).toBe(md("GLOBAL OWNER METHOD"));
  expect(skillRevisionHistory(botId,name)?.revisions.some(item=>item.description.includes("PRIVATE"))).toBe(false);
});
it("owner edits invalidate scoped selection while prior pins retain their initial version",()=>{
  ownerEdit("GLOBAL ORIGINAL");const review=proposal("owner-task",`bot:${botId}:owner`,"PRIVATE METHOD");publishEvaluatedScopedSkill(review.snapshot,review.receipt,review.context);
  const previous=pinnedText("old-task",review.context);
  ownerEdit("OWNER CORRECTION","update");
  expect(pinnedText("next-task",review.context).text).toContain("OWNER CORRECTION");
  expect(preparePinnedProcedures(botId,"old-task",previous.pin,true,review.context).importedPrompt).toContain("checked-method");
  expect(readFileSync(previous.file,"utf8")).toContain("PRIVATE METHOD");
});
it("revocation/forgetting rejects a private pin and removes only its known native/materialized projections",()=>{
  ownerEdit("GLOBAL");const review=proposal("private-source",`bot:${botId}:owner`,"FORGET_CANARY");publishEvaluatedScopedSkill(review.snapshot,review.receipt,review.context);
  const previous=pinnedText("private-next",review.context);
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(review.source.id);
  expect(()=>preparePinnedProcedures(botId,"private-next",previous.pin,true,review.context)).toThrow("PROCEDURE_EVIDENCE_REVOKED");
  expect(()=>readFileSync(previous.file)).toThrow();
  expect(()=>readFileSync(join(taskWorkspacePath(DATA_DIR,botId,"private-next"),".agents","skills",name,"SKILL.md"))).toThrow();
  expect(pinnedText("after-forget",review.context).text).toBe(md("GLOBAL"));
});
it("scope grants cannot turn an owner-private pin into a person or room pin",()=>{
  ownerEdit("GLOBAL");const review=proposal("private-source",`bot:${botId}:owner`,"PRIVATE");publishEvaluatedScopedSkill(review.snapshot,review.receipt,review.context);
  const previous=pinnedText("private-next",review.context);
  expect(()=>preparePinnedProcedures(botId,"private-next",previous.pin,true,{...review.context,audienceKey:`room:elsewhere:bot:${botId}`})).toThrow("PROCEDURE_AUDIENCE_REVOKED");
});
it("scoped rollback retains audience/evidence and cannot use the global rollback route",()=>{
  ownerEdit("GLOBAL");const first=proposal("first",`bot:${botId}:owner`,"PRIVATE ONE");publishEvaluatedScopedSkill(first.snapshot,first.receipt,first.context);
  // The second review needs current authority for the first revision's support.
  const second=proposal("second",first.context.audienceKey,"PRIVATE TWO");
  second.context.allowedScopeIds=[...second.context.allowedScopeIds,...first.context.allowedScopeIds];
  // Build its target pin again under the combined current grant.
  const secondPin=createProcedurePin(botId,"second",[],[],undefined,second.context);
  second.snapshot.target={...second.snapshot.target,bundleId:secondPin.bundleId,baseRevision:readProcedureBundle(botId,"second",secondPin).imported[0]!.revision!};
  second.receipt.targetDigest=procedureTargetDigest(second.snapshot.target);second.receipt.snapshotDigest=procedureSnapshotDigest(second.snapshot);
  publishEvaluatedScopedSkill(second.snapshot,second.receipt,second.context);
  const old=`evaluated:${first.receipt.id}`,current=`evaluated:${second.receipt.id}`;
  expect(scopedSkillRevisionHistory(botId,name,second.context)?.revisions.some(item=>item.revision===old)).toBe(true);
  expect(rollbackSkillRevision(botId,name,current,old)).toHaveProperty("error");
  expect(rollbackScopedSkillRevision(botId,name,current,old,second.context)).not.toHaveProperty("error");
  expect(pinnedText("after-rollback",second.context).text).toContain("PRIVATE ONE");expect(readSkillFile(botId,name)).toBe(md("GLOBAL"));
});
it("identity-canon evidence and mismatched evaluated bytes never publish",()=>{
  ownerEdit("GLOBAL");const review=proposal("private-source",`bot:${botId}:owner`,"PRIVATE CANON");
  expect(()=>publishEvaluatedScopedSkill(review.snapshot,{...review.receipt,candidateHash:"0".repeat(64)},review.context)).toThrow();
  database().prepare("UPDATE memory_sources SET kind='character-canon' WHERE id=?").run(review.source.id);
  expect(()=>publishEvaluatedScopedSkill(review.snapshot,review.receipt,review.context)).toThrow("PROCEDURE_EVIDENCE_REVOKED");
  expect(readSkillFile(botId,name)).toBe(md("GLOBAL"));
});

it("the first scoped improvement can roll back to global bytes without replaying its old receipt",()=>{
  const base=ownerEdit("GLOBAL");const review=proposal("private",`bot:${botId}:owner`,"PRIVATE");publishEvaluatedScopedSkill(review.snapshot,review.receipt,review.context);
  expect(rollbackScopedSkillRevision(botId,name,`evaluated:${review.receipt.id}`,base,review.context)).not.toHaveProperty("error");
  expect(pinnedText("after-first-rollback",review.context).text).toBe(md("GLOBAL"));
  expect(wasEvaluatedScopedSkillPublished(review.snapshot,review.receipt,review.context)).toBe(false);
  expect(()=>publishEvaluatedScopedSkill(review.snapshot,review.receipt,review.context)).toThrow("PROCEDURE_TARGET_STALE");
});

it("a committed owner correction can learn from retained superseded ancestry without presenting it as current truth",()=>{
  ownerEdit("GLOBAL");const review=proposal("correction-source",`bot:${botId}:owner`,"Original observed procedure");
  const id="owner-procedure",db=database();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'procedure','Old owner method','owner-statement','active',0,?,NULL,NULL,?)").run(id,review.source.scopeId,Date.now(),Date.now());
  expect(correctMemory(ownerMemoryTicket(),id,1,"Corrected owner method")).toBe(2);
  const corrected={kind:"record" as const,id,revision:2,scopeId:review.source.scopeId,text:"Corrected owner method",speaker:"owner-statement",outcome:"owner-correction"};
  const state=memoryState();
  review.snapshot={...review.snapshot,policyRevision:state.policyRevision,deletionEpoch:state.deletionEpoch,evidence:[corrected],evidenceDigest:procedureCandidateHash(JSON.stringify([corrected]))};
  const candidate=md("Corrected owner method");
  review.receipt={...review.receipt,candidate,candidateHash:procedureCandidateHash(candidate),evidenceDigest:review.snapshot.evidenceDigest,snapshotDigest:procedureSnapshotDigest(review.snapshot)};
  expect(()=>publishEvaluatedScopedSkill(review.snapshot,review.receipt,review.context)).not.toThrow();
  expect(pinnedText("corrected-task",review.context).text).toContain("Corrected owner method");
  expect(()=>assertSkillProcedureEvidence(review.context,[{...corrected,revision:1}])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
  db.prepare("UPDATE memory_records SET state='deleted' WHERE id=? AND version=1").run(id);
  expect(()=>assertSkillProcedureEvidence(review.context,[corrected])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
});
