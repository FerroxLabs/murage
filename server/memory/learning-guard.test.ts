// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { database,closeDatabase,transaction } from "../database.ts";
import { DATA_DIR } from "../config.ts";
import { mkdirSync,rmSync } from "node:fs";
import { captureSource } from "./capture.ts";
import { learningWriteDecision } from "./learning-guard.ts";
import { installLearningDestination,learningDestination,LEARNING_WRITERS } from "./learning-destination.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { activateGroundedMemory } from "./automatic-learning.ts";
import { claimMemoryJob,publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { pendingProcedureReviews,processProcedureReview,procedureCandidateHash,procedureSnapshotDigest,procedureTargetDigest,type ProcedureReviewHost,type ProcedureReviewSnapshot,type ProcedureEvaluationReceipt } from "./procedure-review.ts";
const uninstall:Array<()=>void>=[];
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});setMemoryCaptureRoster(()=>({bots:[{id:"bot",threadId:"t"}],groups:[]}));});
afterEach(()=>{while(uninstall.length)uninstall.pop()!();setMemoryCaptureRoster(null);});
function candidate(kind="conversation",owner="t",thread="t"){
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 captureSource(db,{id:"source",threadId:thread,kind:"text",speaker:"owner",outcome:"recorded",text:"tea",origin:{kind:"attended"}});
 const scope=String(db.prepare("SELECT scope_id FROM memory_sources WHERE id='source'").get()!.scope_id);
 db.prepare("UPDATE memory_scopes SET kind=?,owner_key=? WHERE id=?").run(kind,owner,scope);
 db.prepare("INSERT INTO memory_records VALUES('candidate',1,?,'fact','tea','assistant-inference','candidate',0,1,NULL,NULL,1)").run(scope);
 const work=claimMemoryJob("fixture")!;publishMemoryWork(work,"fixture",captureWork(work));
 db.exec("INSERT INTO memory_evidence VALUES('candidate',1,'source',1,0,3)");return {db,scope};
}
const activate=()=>transaction(db=>activateGroundedMemory(db,"candidate","owner-statement",undefined,{connection:"fixture"}));
const state=()=>database().prepare("SELECT state FROM memory_records WHERE id='candidate'").get()?.state;
const events=()=>database().prepare("SELECT * FROM memory_learning_events").all();
const input=(scope:string)=>({writer:"activation",sourceId:"source",sourceRevision:1,targetScopeId:scope,target:"memory" as const});
it("registers exactly the three automatic writers and rejects an unregistered writer",()=>{
 const {db,scope}=candidate();expect(LEARNING_WRITERS).toEqual(["activation","correction-supersede","procedure-review","pip-reflection"]);
 expect(()=>learningWriteDecision(db,{...input(scope),writer:"unregistered"})).toThrow();
});
it("refuses gone sources before consulting a destination",()=>{
 const {db,scope}=candidate();db.exec("UPDATE memory_sources SET state='retired'");
 expect(learningWriteDecision(db,input(scope))).toEqual({decision:"refused",reason:"source-gone"});
});
it("refuses contact-thread sources",()=>{
 const {db,scope}=candidate();db.prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:t',?,'human-thread','t',0,'granted',?)").run(scope,JSON.stringify({personId:"contact",bindingId:"contact",revision:1}));
 expect(learningWriteDecision(db,input(scope))).toEqual({decision:"refused",reason:"not-owner-audience"});
});
it("refuses evidence from two scopes and unknown or empty evidence",()=>{
 const {db,scope}=candidate();captureSource(db,{id:"other",threadId:"other",kind:"text",speaker:"owner",outcome:"recorded",text:"tea"});
 const other=String(db.prepare("SELECT scope_id FROM memory_sources WHERE id='other'").get()!.scope_id);
 expect(learningWriteDecision(db,{...input(scope),evidenceScopeIds:[scope,other]})).toEqual({decision:"refused",reason:"cross-partition"});
 expect(learningDestination({evidenceScopeIds:[],target:"memory"})).toEqual({ok:false,reason:"cross-partition"});
 expect(learningDestination({evidenceScopeIds:["missing"],target:"memory"})).toEqual({ok:false,reason:"cross-partition"});
});
it.each([["team","Sales"],["project","project"],["room","room"]])("activates a single composite %s scope with its own audience",(kind,key)=>{
 const {scope}=candidate("bot",`bot#${kind}:${key}`);
 expect(learningDestination({botId:"bot",evidenceScopeIds:[scope],target:"memory"})).toEqual({ok:true,scopeId:scope,partition:kind==="team"?{kind,teamId:key}:{kind,groupId:key},audienceKey:`bot:bot:${kind}:${key}:owner`});
 expect(activate()).toBe(true);expect(events()).toMatchObject([{kind:"activated",scope_id:scope,bot_id:"bot",source_id:"source",detail:'{"connection":"fixture"}'}]);
});
it("keeps general evidence as a candidate with a review reason and no event",()=>{
 candidate("bot","bot#general");expect(activate()).toBe(false);expect(state()).toBe("candidate");expect(events()).toEqual([]);
 expect(database().prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id='candidate'").get()?.confidence_basis).toBe("This memory needs you before it is used.");
});
it("refuses a destination scope different from the caller and a retired partition",()=>{
 const {db,scope}=candidate();uninstall.push(installLearningDestination(()=>({ok:true,scopeId:"another",audienceKey:"fixture",partition:{kind:"home"}})));
 expect(learningWriteDecision(db,input(scope))).toEqual({decision:"refused",reason:"cross-scope"});
 uninstall.push(installLearningDestination(()=>({ok:false,reason:"retired-partition"})));
 expect(learningWriteDecision(db,input(scope))).toEqual({decision:"refused",reason:"retired-partition"});
});
it.each([false,true])("private desk into a room with non-owner audience=%s",contact=>{
 setMemoryCaptureRoster(()=>({bots:[{id:"bot",threadId:"t"}],groups:[{id:"room",threadId:"main",memberIds:["bot"],tasks:[{threadId:"contact"}]}]}));
 const {db,scope}=candidate("room","room");
 if(contact)db.prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:contact',?,'human-thread','contact',0,'granted',?)").run(scope,JSON.stringify({personId:"person",bindingId:"person",revision:1}));
 expect(activate()).toBe(!contact);expect(state()).toBe(contact?"candidate":"active");expect(events()).toHaveLength(contact?0:1);
});
it("passes no botId for a room source and retains the room audience",()=>{
 setMemoryCaptureRoster(()=>({bots:[{id:"bot",threadId:"t",tasks:[{threadId:"main",channelProjectDesk:{groupId:"room"}}]}],groups:[{id:"room",threadId:"main",memberIds:["bot"],channelProject:true}]}));
 const {scope}=candidate("room","room","main");
 expect(learningDestination({evidenceScopeIds:[scope],target:"memory"})).toMatchObject({audienceKey:"room:room",partition:{kind:"project",groupId:"room"}});
 const spy=vi.fn(()=>({ok:true as const,scopeId:scope,audienceKey:"room:room",partition:{kind:"home" as const}}));uninstall.push(installLearningDestination(spy));
 expect(activate()).toBe(true);expect(spy.mock.calls[0]).toEqual([{threadId:"main",evidenceScopeIds:[scope],target:"memory"}]);expect(events()[0].bot_id).toBeNull();
});
it("activates an owner conversation exactly once and rolls event and state back together",()=>{
 candidate();expect(()=>transaction(db=>{activateGroundedMemory(db,"candidate","owner-statement");throw Error("rollback");})).toThrow("rollback");
 expect(state()).toBe("candidate");expect(events()).toEqual([]);expect(activate()).toBe(true);expect(activate()).toBe(false);expect(events()).toHaveLength(1);
});
it("an installed refusal holds activation and uninstall restores the mock",()=>{
 candidate();const restore=installLearningDestination(()=>({ok:false,reason:"needs-owner-approval"}));uninstall.push(restore);
 expect(activate()).toBe(false);expect(events()).toEqual([]);uninstall.pop()!();expect(activate()).toBe(true);
});
it.each(["skill","routine-instructions","persona","general"] as const)("requires a home bot for target %s",target=>{
 const {scope}=candidate("bot","bot#team:Sales");expect(learningDestination({botId:"bot",evidenceScopeIds:[scope],target})).toEqual({ok:false,reason:"needs-owner-approval"});
 database().prepare("UPDATE memory_scopes SET owner_key='bot' WHERE id=?").run(scope);
 expect(learningDestination({botId:"bot",evidenceScopeIds:[scope],target})).toEqual({ok:true,audienceKey:"bot:bot:owner",partition:{kind:"home"}});
 expect(learningDestination({evidenceScopeIds:[scope],target})).toEqual({ok:false,reason:"needs-owner-approval"});
});
it("routes correction-supersede through the destination hook before changing either record",async()=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 const learn=async(text:string,id:string,update=false)=>{
  captureSource(db,{id,threadId:"t",kind:"text",speaker:"owner",outcome:"recorded",text,origin:{kind:"attended"}});
  const work=claimMemoryJob("fixture")!;publishMemoryWork(work,"fixture",captureWork(work));
  const extractor=Object.assign(async()=>JSON.stringify([{text,quote:text,claimType:"owner-statement",subject:"owner",predicate:"drink",update,startByte:0,endByte:Buffer.byteLength(text)}]),{ground:async()=>'{"supported":true}'});
  return consolidateMemorySource(work.id,extractor,new AbortController().signal);
 };
 await learn("I prefer tea.","first");
 const scopes:string[][]=[];uninstall.push(installLearningDestination(input=>{scopes.push([...input.evidenceScopeIds]);return {ok:false,reason:"needs-owner-approval"};}));
 await learn("Correction: I prefer coffee.","second",true);
 expect(db.prepare("SELECT text,state FROM memory_records WHERE id LIKE 'candidate:%' ORDER BY created_at,rowid").all()).toEqual([{text:"I prefer tea.",state:"active"},{text:"Correction: I prefer coffee.",state:"candidate"}]);
 expect(events()).toHaveLength(1);expect(scopes.length).toBeGreaterThan(0);
 // Also distinguish the supersede writer from activation: only its combined evidence includes this prior scope.
 uninstall.pop()!();
 const prior=String(db.prepare("SELECT id FROM memory_records WHERE state='active' AND id LIKE 'candidate:%'").get()!.id);
 captureSource(db,{id:"prior-other",threadId:"other",kind:"text",speaker:"owner",outcome:"recorded",text:"tea"});
 const otherWork=claimMemoryJob("fixture")!;expect(otherWork.sourceId).toBe("prior-other");publishMemoryWork(otherWork,"fixture",captureWork(otherWork));
 db.prepare("INSERT INTO memory_evidence VALUES(?,1,'prior-other',1,0,3)").run(prior);
 await learn("Correction: I prefer water.","third",true);
 expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(prior)?.state).toBe("active");
 expect(db.prepare("SELECT confidence_basis FROM memory_record_details d JOIN memory_records r ON r.id=d.record_id WHERE r.text='Correction: I prefer water.' AND r.id LIKE 'candidate:%'").get()?.confidence_basis).toBe("The cited sources belong to different audiences. Review this memory before using it.");
 expect(events()).toHaveLength(1);
});
it.each(["skill","routine"] as const)("installed refusal holds automatic %s publication and uninstall restores it",async kind=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 captureSource(db,{id:"turn",threadId:"t",turnId:"turn",kind:"turn",speaker:"harness",outcome:"completed",text:"Completed"});
 const scope=String(db.prepare("SELECT scope_id FROM memory_sources WHERE id='turn'").get()!.scope_id);
 const host:ProcedureReviewHost={resolveTargets:()=>[{kind,scopeId:scope,ownerId:"bot",artifactId:"fixture",baseRevision:"1",threadId:"t",bundleId:"fixture"}],isTargetCurrent:()=>true,canReadEvidence:()=>true,canPublish:()=>true,publish:vi.fn(),evaluate:vi.fn(async (snapshot:ProcedureReviewSnapshot):Promise<ProcedureEvaluationReceipt>=>({id:"receipt",requestId:snapshot.requestId,targetDigest:procedureTargetDigest(snapshot.target),snapshotDigest:procedureSnapshotDigest(snapshot),evidenceDigest:snapshot.evidenceDigest,candidate:"Check first",candidateHash:procedureCandidateHash("Check first"),evaluator:"fixture",decision:"accepted",heldout:{corpusDigest:"a".repeat(64),untouched:true,cases:2,baseline:0,candidate:1,regressions:0},budgetRespected:true,cancelled:false}))};
 for(const id of pendingProcedureReviews())await processProcedureReview(id,host,new AbortController().signal);
 const id=String(db.prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").get()!.id);
 const spy=vi.fn(()=>({ok:false as const,reason:"needs-owner-approval" as const}));uninstall.push(installLearningDestination(spy));
 await processProcedureReview(id,host,new AbortController().signal);expect(host.publish).not.toHaveBeenCalled();expect(host.evaluate).not.toHaveBeenCalled();expect(spy).toHaveBeenCalledWith({botId:"bot",threadId:"t",evidenceScopeIds:[scope],target:kind==="skill"?"skill":"routine-instructions"});
 uninstall.pop()!();await processProcedureReview(id,host,new AbortController().signal);expect(host.publish).toHaveBeenCalledTimes(1);
});

it.each(["room","project","team"])("reports the %s partition for a non-bot scope",kind=>{
 const {scope}=candidate(kind,"partition-key");
 expect(learningDestination({evidenceScopeIds:[scope],target:"memory"})).toMatchObject({partition:kind==="team"?{kind,teamId:"partition-key"}:{kind,groupId:"partition-key"}});
});
