import { mkdirSync,rmSync } from "node:fs";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess,reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob,publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { captureSource } from "./capture.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { installLearningDestination } from "./learning-destination.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { readMemoryLearning,updateMemoryLearning } from "./learning-policy.ts";
import { memoryAgentRoute } from "./routes.ts";

afterEach(()=>setMemoryCaptureRoster(null));
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
function fixture(){
  const roster={bots:[{id:"bot",threadId:"thread"},{id:"other",threadId:"private"}],groups:[]};
  setMemoryCaptureRoster(()=>roster);reconcileMemoryRoster(roster);setMemoryMode("capture");
  appendMessage("thread",{id:"m",at:1,role:"user",origin:"desktop",kind:"text",text:"Verified source note"});
  const work=claimMemoryJob("fixture")!;publishMemoryWork(work,"fixture",captureWork(work));
  setMemoryMode("active");
  const record=database().prepare("SELECT id FROM memory_records").get()!;
  const registry=new InternalCapabilities();registry.begin("bot","thread","generation");
  const token=registry.mint({botId:"bot",threadId:"thread",generation:"generation",depth:99,kind:"memory",skillAuthoring:false});
  const context=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const bridge={search:async()=>({hits:[],vectorRows:0})};
  const evidence=[{sourceId:work.sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(work.text)}];
  return {context,registry,recordId:String(record.id),evidence,bridge};
}
it("binds source hydration to the capability rather than caller identity",async()=>{
  const f=fixture();
  await expect(memoryAgentRoute("/api/internal/memory/get",{handles:[{id:f.recordId,version:1}],botId:"other"},f.context,f.bridge)).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
  const result=await memoryAgentRoute("/api/internal/memory/get",{handles:[{id:f.recordId,version:1}]},f.context,f.bridge);
  expect(JSON.stringify(result)).toContain("Verified source note");
  f.registry.revokeThread("thread");
  await expect(memoryAgentRoute("/api/internal/memory/get",{handles:[{id:f.recordId,version:1}]},f.context,f.bridge)).rejects.toThrow("MEMORY_UNAUTHORIZED");
});
it("stores correction proposals without changing an existing owner pin",async()=>{
  const f=fixture();database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(f.recordId);
  const result=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:"Proposed correction",evidence:f.evidence,idempotencyKey:"proposal"},f.context,f.bridge);
  expect(result).toMatchObject({state:"candidate",pendingReview:true});
  expect(database().prepare("SELECT text,owner_pinned,state FROM memory_records WHERE id=?").get(f.recordId)).toMatchObject({text:"Verified source note",owner_pinned:1,state:"active"});
});
it("rejects fabricated evidence and over-limit input before mutation",async()=>{
  const f=fixture();
  await expect(memoryAgentRoute("/api/internal/memory/save",{text:"Claim",evidence:[{sourceId:"fabricated",revision:1,startByte:0,endByte:3}],idempotencyKey:"fake"},f.context,f.bridge)).rejects.toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  await expect(memoryAgentRoute("/api/internal/memory/search",{query:"ไทย".repeat(1000)},f.context,f.bridge)).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='candidate'").get()?.n).toBe(0);
});

it("keeps maximum-length save keys usable and rejects changed evidence on replay",async()=>{
  const f=fixture();
  const input={text:"Candidate",evidence:f.evidence,idempotencyKey:"k".repeat(160)};
  const first=await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge) as {candidateId:string};
  expect(first.candidateId).toHaveLength(64);
  expect(await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge)).toMatchObject({candidateId:first.candidateId});
  await expect(memoryAgentRoute("/api/internal/memory/save",{...input,evidence:[{...f.evidence[0],endByte:3}]},f.context,f.bridge)).rejects.toThrow("MEMORY_IDEMPOTENCY_CONFLICT");
});
it.each(["off","capture","paused"] as const)("disables agent tools in %s mode",async(mode)=>{
  const f=fixture();setMemoryMode(mode);
  await expect(memoryAgentRoute("/api/internal/memory/get",{handles:[{id:f.recordId,version:1}]},f.context,f.bridge)).rejects.toThrow("MEMORY_NOT_ACTIVE");
});

it("saves a typed grounded owner assertion without approval and replays the same result",async()=>{
  const f=fixture(),input={text:"Verified source note",evidence:f.evidence,idempotencyKey:"grounded",claimType:"owner-statement"};
  const result=await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge);
  expect(result).toMatchObject({state:"active",pendingReview:false});
  expect(await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge)).toEqual(result);
});

it("stores bot-authored fiction only with grounded owner invitation and preserves both sources on replay",async()=>{
  const f=fixture(),text="In this fictional character, I grew up beside a lighthouse.";
  captureSource(database(),{id:"canon-source",occurredAt:2,threadId:"thread",kind:"text",speaker:"assistant",outcome:"recorded",text});
  const invitation="Please invent a fictional childhood for your character.";
  captureSource(database(),{id:"invitation",occurredAt:1,threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text:invitation});
  for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
  const extractor:TextOnlyExtractor=async()=>"[]";
  extractor.ground=async input=>{expect(input.ownerInvitation).toBe(invitation);return '{"supported":true}';};
  const input={text,evidence:[{sourceId:"canon-source",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],ownerInvitation:{sourceId:"invitation",revision:1,startByte:0,endByte:Buffer.byteLength(invitation)},claimType:"character-canon",idempotencyKey:"canon"};
  const result=await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge,undefined,extractor) as {candidateId:string};
  expect(result).toMatchObject({state:"active",pendingReview:false});
  expect(database().prepare("SELECT r.kind,r.assertion,d.partition,d.confidence_basis FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id=?").get(result.candidateId)).toMatchObject({kind:"character-canon",assertion:"assistant-inference",partition:"identity",confidence_basis:expect.stringContaining("fictional")});
  expect(await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge,undefined,extractor)).toEqual(result);
});

it("does not retire an unrelated target merely because replacement equals an owner quote",async()=>{
  const f=fixture(),extractor:TextOnlyExtractor=async()=>"[]";
  extractor.ground=async input=>{expect(input.previousClaim).toBe("Verified source note");return '{"supported":false}';};
  const result=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"unrelated"},f.context,f.bridge,undefined,extractor);
  expect(result).toMatchObject({state:"candidate",pendingReview:true});
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(f.recordId)?.state).toBe("active");
});
it("uses independent same-subject grounding before automatic correction",async()=>{
  const f=fixture(),text="Correction: the source note is now confirmed.";
  captureSource(database(),{id:"correction-source",threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text});
  for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
  const extractor:TextOnlyExtractor=async()=>"[]";
  extractor.ground=async input=>{expect(input.previousClaim).toBe("Verified source note");expect(input.quote).toBe(text);return '{"supported":true}';};
  const result=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:text,evidence:[{sourceId:"correction-source",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],idempotencyKey:"same-subject"},f.context,f.bridge,undefined,extractor);
  expect(result).toMatchObject({state:"active",pendingReview:false});
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(f.recordId)?.state).toBe("superseded");
  expect(database().prepare("SELECT kind,prior_id,source_id FROM memory_learning_events WHERE kind='superseded'").all()).toEqual([{kind:"superseded",prior_id:f.recordId,source_id:"correction-source"}]);
  const trigger=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'procedure-trigger:%'").get()!.intent));
  expect(trigger.trigger.ownerAuthorized).toBeUndefined();
});
it("routes identity corrections to the dedicated identity write contract before creating proposals",async()=>{
  const f=fixture();database().prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id=?").run(f.recordId);
  await expect(memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"identity"},f.context,f.bridge)).rejects.toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='candidate'").get()?.n).toBe(0);
});

it('C7 close lesson saves a bot-scoped candidate backed by the project, without grounding activation', async () => {
  const roster={bots:[{id:'bot',threadId:'direct'}],groups:[{id:'project',threadId:'room',memberIds:['bot']}]};
  reconcileMemoryRoster(roster);setMemoryMode('active');
  const {setMemoryCaptureRoster}=await import('./capture-scope.ts');setMemoryCaptureRoster(()=>roster);
  captureSource(database(),{id:'project-evidence',threadId:'room',kind:'text',speaker:'owner',outcome:'recorded',text:'Project closed: what I learned'});
  const {channelToProjectRows}=await import('../project-settings.ts');const {startProjectClose,resumeProjectCloses}=await import('../project-close.ts');const {markRequestDispatched}=await import('../room-requests.ts');
  channelToProjectRows(database(),{groupId:'project',bulletin:'',leadBotId:null,now:1});
  const deps={groupId:'project',threadId:'room',memberIds:['bot'],now:2,lineage:{rootThreadId:'room',origin:'desktop' as const,audienceFingerprint:'owner',notOwnerAudience:false,unattended:false},deliverables:()=>[],routineNames:()=>[],pauseRoutines:()=>{},post:()=>{},summary:()=>null,sync:()=>{}};
  startProjectClose(database(),deps);resumeProjectCloses(database(),deps);
  setMemoryCaptureRoster(null);
  const requestId=String(database().prepare("SELECT id FROM room_requests WHERE admission_key LIKE 'close-lesson:%'").get()!.id);markRequestDispatched(database(),requestId,{now:3,targetThreadId:'room'});
  const registry=new InternalCapabilities();registry.begin('bot','room','lesson');const token=registry.mint({botId:'bot',threadId:'room',generation:'lesson',depth:0,kind:'memory',skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const evidence=[{sourceId:'project-evidence',revision:1,startByte:0,endByte:Buffer.byteLength('Project closed: what I learned')}];
  const body={text:'Project closed: what I learned',evidence,idempotencyKey:'close-lesson',claimType:'owner-statement'};
  // R7-9: the lesson path refuses evidence whose capture is still pending, as every other save does
  await expect(memoryAgentRoute('/api/internal/memory/save',body,access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).rejects.toThrow('Source capture is still pending. Try saving this memory again after capture finishes.');
  expect(Number(database().prepare("SELECT COUNT(*) AS n FROM memory_records").get()!.n)).toBe(0);
  for(let job=claimMemoryJob('fixture');job;job=claimMemoryJob('fixture'))publishMemoryWork(job,'fixture',captureWork(job));
  const result=await memoryAgentRoute('/api/internal/memory/save',body,access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId}) as {candidateId:string};
  expect(database().prepare('SELECT s.kind,s.owner_key,r.state FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.id=?').get(result.candidateId)).toEqual({kind:'bot',owner_key:'bot',state:'candidate'});
  expect(database().prepare('SELECT source_id FROM memory_evidence WHERE record_id=?').all(result.candidateId)).toEqual([{source_id:'project-evidence'}]);
  expect(await memoryAgentRoute('/api/internal/memory/save',body,access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).toMatchObject({candidateId:result.candidateId,state:'candidate'});
  // R5: a Reopen while the lesson body is read revokes the lesson path; the save never
  // falls through to an ordinary grounded (project-scoped, possibly active) save.
  const {reopenProject}=await import('../project-close.ts');
  reopenProject(database(),{groupId:'project',now:4,sync:()=>{}});
  const before=Number(database().prepare('SELECT COUNT(*) AS n FROM memory_records').get()!.n);
  await expect(memoryAgentRoute('/api/internal/memory/save',{...body,idempotencyKey:'after-reopen'},access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).rejects.toThrow('MEMORY_CLOSE_LESSON_REQUIRED');
  expect(Number(database().prepare('SELECT COUNT(*) AS n FROM memory_records').get()!.n)).toBe(before);
});
it("holds an automatic correction when its prior evidence crosses the destination boundary",async()=>{
 const f=fixture(),db=database(),text="Correction: new note";
 captureSource(db,{id:"other-source",threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text:"other"});
 db.exec("UPDATE memory_sources SET scope_id=(SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key='bot') WHERE id='other-source'");
 db.prepare("INSERT INTO memory_evidence VALUES(?,1,'other-source',1,0,5)").run(f.recordId);
 captureSource(db,{id:"new-source",threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text});
  for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 const extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground:async()=>'{"supported":true}'});
 const restore=installLearningDestination(input=>input.evidenceScopeIds.length>1?{ok:false,reason:"cross-partition"}:{ok:true,scopeId:input.evidenceScopeIds[0],partition:{kind:"home"},audienceKey:"fixture"});
 try{
  const result=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:text,evidence:[{sourceId:"new-source",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],idempotencyKey:"guarded"},f.context,f.bridge,undefined,extractor);
  expect(result).toMatchObject({state:"candidate"});expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(f.recordId)?.state).toBe("active");expect(db.prepare("SELECT count(*) n FROM memory_learning_events").get()?.n).toBe(0);
 }finally{restore();}
});


it("keeps exact saves active but holds model-grounded corrections on a review-only default connection",async()=>{
 const f=fixture(),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{reviewOnly:true,learningConnection:"@murage/flux-fast",ground:async()=>'{"supported":true}'});
 expect(await memoryAgentRoute("/api/internal/memory/save",{text:"Verified source note",evidence:f.evidence,idempotencyKey:"default-save",claimType:"owner-statement"},f.context,f.bridge,undefined,extractor)).toMatchObject({state:"active"});
 const result=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"default-correction"},f.context,f.bridge,undefined,extractor) as {candidateId:string};
 expect(result).toMatchObject({state:"candidate"});
 expect(database().prepare("SELECT kind FROM memory_learning_events WHERE record_id=?").all(result.candidateId)).toEqual([]);
});

it.each(["schedule","unknown","bot-paused"])("holds agent saves and corrections from %s evidence before grounding",async reason=>{
 const f=fixture(),db=database(),ground=vi.fn(async()=>'{"supported":true}');
 if(reason==="bot-paused")updateMemoryLearning(db,{botsPaused:["bot"]},readMemoryLearning(db).revision);
 else db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind',?) WHERE source_id=?").run(reason,f.evidence[0].sourceId);
 const extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground});
 for(const correction of [false,true]){
  const result=await memoryAgentRoute(correction?"/api/internal/memory/propose-correction":"/api/internal/memory/save",correction?{id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"blocked-correction"}:{text:"Verified source note",evidence:f.evidence,idempotencyKey:"blocked-save",claimType:"owner-statement"},f.context,f.bridge,undefined,extractor) as {candidateId:string};
  expect(result).toMatchObject({state:"candidate"});
  expect(String(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(result.candidateId)?.confidence_basis)).toMatch(/\s/);
 }
 expect(ground).not.toHaveBeenCalled();expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(f.recordId)?.state).toBe("active");
});
it.each([[null,false,true],["@murage/flux-fast",false,false],[null,true,false]] as const)("model-grounded agent writes follow selected=%s defaultOn=%s",async(selected,defaultOn,reviewOnly)=>{
 const {resolveLearningConnection}=await import("./extractor-connections.ts");
 const f=fixture(),extractor=resolveLearningConnection({selected,defaultOn,instances:[],readKey:()=>"fixture-key"}).extractor!;
 extractor.ground=async()=>'{"supported":true}';
 const saved=await memoryAgentRoute("/api/internal/memory/save",{text:"Confirmed note",evidence:f.evidence,idempotencyKey:"paraphrase",claimType:"owner-statement"},f.context,f.bridge,undefined,extractor);
 expect(saved).toMatchObject({state:reviewOnly?"candidate":"active"});
 const corrected=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"grounded-correction"},f.context,f.bridge,undefined,extractor);
 expect(corrected).toMatchObject({state:reviewOnly?"candidate":"active"});
});
it("checks the project gate outside a transaction before agent grounding, while exact saves need no call",async()=>{
 const f=fixture(),db=database(),ground=vi.fn(async()=>'{"supported":true}'),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground});
 const budgetGate=vi.fn(()=>{db.exec("BEGIN IMMEDIATE;ROLLBACK");return false;});
 for(const correction of [false,true]){
  const result=await memoryAgentRoute(correction?"/api/internal/memory/propose-correction":"/api/internal/memory/save",correction?{id:f.recordId,version:1,replacement:"Confirmed note",evidence:f.evidence,idempotencyKey:"budget-correction"}:{text:"Confirmed note",evidence:f.evidence,idempotencyKey:"budget-save",claimType:"owner-statement"},f.context,f.bridge,undefined,extractor,{budgetGate});
  expect(result).toMatchObject({state:"candidate"});
  expect(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get((result as {candidateId:string}).candidateId)?.confidence_basis).toBe("The project learning allowance has been reached.");
 }
 expect(budgetGate).toHaveBeenCalledTimes(2);expect(ground).not.toHaveBeenCalled();
 expect(await memoryAgentRoute("/api/internal/memory/save",{text:"Verified source note",evidence:f.evidence,idempotencyKey:"no-call",claimType:"owner-statement"},f.context,f.bridge,undefined,extractor,{budgetGate})).toMatchObject({state:"active"});
 expect(budgetGate).toHaveBeenCalledTimes(2);
});


it.each((["procedure","character-canon","observation"] as const).flatMap(claimType=>["schedule","unknown","bot-paused","chats-off","tool"].flatMap(reason=>[false,true].map(paraphrase=>({claimType,reason,paraphrase})))))("gates $claimType from $reason before grounding, paraphrase=$paraphrase",async({claimType,reason,paraphrase})=>{
 const f=fixture(),db=database(),ground=vi.fn(async()=>'{"supported":true}'),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground});
 updateMemoryLearning(db,{botsPaused:reason==="bot-paused"?["bot"]:[],learnFrom:{chats:reason!=="chats-off",channels:false}},readMemoryLearning(db).revision);
 const sourceId=`blocked-${reason}`,text="Verified source note";
 captureSource(db,{id:sourceId,threadId:"thread",origin:{kind:reason==="schedule"||reason==="unknown"?reason:"attended"},kind:reason==="tool"?"tool-outcome":"text",speaker:reason==="tool"?"tool":"owner",outcome:reason==="tool"?"completed":"recorded",text,...(reason==="tool"?{action:{label:"fixture",reportedOutcome:"completed" as const,verification:"tool-reported" as const}}:{})});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 const evidence=[{sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(text)}];
 const result=await memoryAgentRoute("/api/internal/memory/save",{text:paraphrase?"Confirmed note":text,evidence,claimType,idempotencyKey:`${reason}-${paraphrase}`},f.context,f.bridge,undefined,extractor) as {candidateId:string};
 expect(result).toMatchObject({state:"candidate"});
 expect(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(result.candidateId)?.confidence_basis).toMatch(/\s/);
 expect(ground).not.toHaveBeenCalled();
});
it.each(["owner-statement","procedure","character-canon"] as const)("still activates an attended exact %s save",async claimType=>{
 const f=fixture();
 expect(await memoryAgentRoute("/api/internal/memory/save",{text:"Verified source note",evidence:f.evidence,claimType,idempotencyKey:"attended"},f.context,f.bridge)).toMatchObject({state:"active"});
});
it("cannot activate a held correction through same-key generic save",async()=>{
 const f=fixture(),db=database(),ground=vi.fn(async()=>'{"supported":true}'),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{reviewOnly:true,ground});
 const proposal={id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"held-replay"};
 const held=await memoryAgentRoute("/api/internal/memory/propose-correction",proposal,f.context,f.bridge,undefined,extractor) as {candidateId:string};
 expect(held).toMatchObject({state:"candidate"});ground.mockClear();
 expect(await memoryAgentRoute("/api/internal/memory/save",{text:proposal.replacement,evidence:proposal.evidence,idempotencyKey:proposal.idempotencyKey,claimType:"owner-statement"},f.context,f.bridge,undefined,extractor)).toMatchObject({candidateId:held.candidateId,state:"candidate"});
 expect(db.prepare("SELECT count(*) n FROM memory_records WHERE id IN (?,?) AND state='active'").get(f.recordId,held.candidateId)?.n).toBe(1);expect(ground).not.toHaveBeenCalled();
});
it.each([false,true])("a refused correction replay preserves active confidence, identity=%s",async identity=>{
 const f=fixture(),db=database(),input={text:"Verified source note",evidence:f.evidence,idempotencyKey:"active-replay",claimType:identity?"character-canon":"owner-statement"};
 const saved=await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge) as {candidateId:string};
 const before=db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(saved.candidateId)?.confidence_basis;
 updateMemoryLearning(db,{botsPaused:["bot"]},readMemoryLearning(db).revision);
 await expect(memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:input.text,evidence:f.evidence,idempotencyKey:input.idempotencyKey},f.context,f.bridge)).rejects.toThrow("MEMORY_IDEMPOTENCY_CONFLICT");
 expect(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(saved.candidateId)?.confidence_basis).toBe(before);
});
it.each(["owner-statement","procedure"])("refuses owner invitations on %s saves with a plain explanation",async claimType=>{
 const f=fixture();
 captureSource(database(),{id:"wrong-invitation",threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text:"Please invent a character."});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 await expect(memoryAgentRoute("/api/internal/memory/save",{text:"Verified source note",evidence:f.evidence,ownerInvitation:{sourceId:"wrong-invitation",revision:1,startByte:0,endByte:Buffer.byteLength("Please invent a character.")},idempotencyKey:"wrong-invitation",claimType},f.context,f.bridge)).rejects.toThrow("Owner invitations can only support character canon.");
 expect(database().prepare("SELECT count(*) n FROM memory_records WHERE state='candidate'").get()?.n).toBe(0);
});
it("refuses a save before capture completes, then activates the same request after capture",async()=>{
 const f=fixture(),db=database(),text="I prefer tea.";
 captureSource(db,{id:"pending-capture",threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text});
 const input={text,evidence:[{sourceId:"pending-capture",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],claimType:"owner-statement",idempotencyKey:"pending-capture"};
 await expect(memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge)).rejects.toThrow("Source capture is still pending. Try saving this memory again after capture finishes.");
 expect(db.prepare("SELECT count(*) n FROM memory_records WHERE state='candidate'").get()?.n).toBe(0);
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 expect(await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge)).toMatchObject({state:"active"});
});


it.each(["procedure","character-canon","observation"] as const)("the shared activation boundary gates %s independently of the save route",async claimType=>{
 const {saveMemoryCandidate}=await import("./authority.ts"),{activateGroundedMemory}=await import("./automatic-learning.ts"),{transaction}=await import("../database.ts");
 const f=fixture(),db=database();
 db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','schedule') WHERE source_id=?").run(f.evidence[0].sourceId);
 const id=saveMemoryCandidate("Verified source note",f.evidence,"boundary",f.context);
 expect(transaction(()=>activateGroundedMemory(db,id,claimType))).toBe(false);
 expect(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(id)?.confidence_basis).toBe("This source was not an attended owner message. Review it before using it.");
});
it("the shared activation boundary refuses a correction without atomic supersede",async()=>{
 const {activateGroundedMemory}=await import("./automatic-learning.ts"),{transaction}=await import("../database.ts");
 const f=fixture(),db=database(),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{reviewOnly:true,ground:async()=>'{"supported":true}'});
 const held=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"boundary-correction"},f.context,f.bridge,undefined,extractor) as {candidateId:string};
 expect(transaction(()=>activateGroundedMemory(db,held.candidateId,"owner-statement"))).toBe(false);
 expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(held.candidateId)?.state).toBe("candidate");
});

// Round 6: invitations cannot authorize automated input or override learning settings.
it.each(["schedule","webhook","bot-paused","chats-off"])("holds invited canon before grounding for %s",async reason=>{
 const f=fixture(),db=database(),text="I am Captain Vale.",invitation="Play Captain Vale.";
 captureSource(db,{id:"r6-canon",threadId:"thread",kind:"text",speaker:"assistant",outcome:"recorded",text});
 captureSource(db,{id:"r6-invite",threadId:"thread",origin:{kind:reason==="schedule"?"schedule":reason==="webhook"?"webhook":"attended"},kind:"text",speaker:"owner",outcome:"recorded",text:invitation});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 if(reason==="bot-paused")updateMemoryLearning(db,{botsPaused:["bot"]},readMemoryLearning(db).revision);
 if(reason==="chats-off")updateMemoryLearning(db,{learnFrom:{chats:false,channels:true}},readMemoryLearning(db).revision);
 const ground=vi.fn(async()=>'{"supported":true}'),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground});
 expect(await memoryAgentRoute("/api/internal/memory/save",{text,evidence:[{sourceId:"r6-canon",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],ownerInvitation:{sourceId:"r6-invite",revision:1,startByte:0,endByte:Buffer.byteLength(invitation)},claimType:"character-canon",idempotencyKey:"r6-canon"},f.context,f.bridge,undefined,extractor)).toMatchObject({state:"candidate"});
 expect(ground).not.toHaveBeenCalled();
});
it("links a correction before grounding so interleaved save cannot activate it",async()=>{
 const f=fixture(),db=database(),input={text:"Verified source note",evidence:f.evidence,idempotencyKey:"r6-race",claimType:"owner-statement"};
 let during:unknown;
 const extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground:async()=>{during=await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge);return '{"supported":true}';}});
 const result=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:input.text,evidence:input.evidence,idempotencyKey:input.idempotencyKey},f.context,f.bridge,undefined,extractor) as {candidateId:string};
 expect(during).toMatchObject({state:"candidate"});expect(result).toMatchObject({state:"active"});
 expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(f.recordId)?.state).toBe("superseded");
 expect(db.prepare("SELECT count(*) n FROM memory_records WHERE id IN (?,?) AND state='active'").get(f.recordId,result.candidateId)?.n).toBe(1);
});
it("rejects save then same-key correction without a stray derivation",async()=>{
 const f=fixture(),db=database(),input={text:"Verified source note",evidence:f.evidence,idempotencyKey:"r6-used",claimType:"owner-statement"};
 const saved=await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge) as {candidateId:string};
 await expect(memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:input.text,evidence:input.evidence,idempotencyKey:input.idempotencyKey},f.context,f.bridge)).rejects.toThrow("MEMORY_IDEMPOTENCY_CONFLICT");
 expect(db.prepare("SELECT count(*) n FROM memory_derivations WHERE child_id=?").get(saved.candidateId)?.n).toBe(0);
});
it.each(["failed","missing","pending"])("classifies %s capture on save and correction before candidate creation",async status=>{
 const f=fixture(),db=database();
 if(status==="missing")db.prepare("DELETE FROM memory_jobs WHERE source_id=?").run(f.evidence[0].sourceId);
 else db.prepare("UPDATE memory_jobs SET status=? WHERE source_id=?").run(status,f.evidence[0].sourceId);
 for(const path of ["save","propose-correction"]){
 const common={evidence:f.evidence,idempotencyKey:`r6-${path}`};
 const body=path==="save"?{...common,text:"Verified source note",claimType:"owner-statement"}:{...common,id:f.recordId,version:1,replacement:"Verified source note"};
 await expect(memoryAgentRoute(`/api/internal/memory/${path}`,body,f.context,f.bridge)).rejects.toMatchObject({status:status==="pending"?409:400,message:status==="pending"?expect.stringContaining("Try saving"):expect.stringContaining("cannot be used")});
 }
 expect(db.prepare("SELECT count(*) n FROM memory_records WHERE state='candidate'").get()?.n).toBe(0);
});

it("rechecks the invitation at activation after grounding",async()=>{
 const f=fixture(),db=database(),text="Captain Vale lives at sea.";
 captureSource(db,{id:"r6-recheck",occurredAt:2,threadId:"thread",kind:"text",speaker:"assistant",outcome:"recorded",text});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 const extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground:async()=>{
 db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','webhook') WHERE source_id=?").run(f.evidence[0].sourceId);
 return '{"supported":true}';}});
 expect(await memoryAgentRoute("/api/internal/memory/save",{text,evidence:[{sourceId:"r6-recheck",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],ownerInvitation:f.evidence[0],claimType:"character-canon",idempotencyKey:"r6-recheck"},f.context,f.bridge,undefined,extractor)).toMatchObject({state:"candidate"});
});
it.each(["bot-paused","chats-off","channels-off","excluded-thread"])("canon evidence independently honors %s with a learnable invitation",async reason=>{
 const f=fixture(),db=database(),text="Captain Vale lives at sea.";
 setMemoryCaptureRoster(()=>({bots:[{id:"bot",threadId:"thread"},{id:"other",threadId:"private"},{id:"evidence-bot",threadId:"canon-task"}],groups:[]}));
 captureSource(db,{id:"r6-settings",threadId:"canon-task",kind:"text",speaker:"assistant",outcome:"recorded",text,origin:reason==="channels-off"?{kind:"channel"}:{kind:"schedule"}});
 let invitation=f.evidence[0];
 if(reason==="chats-off"){
  captureSource(db,{id:"r6-channel-invite",threadId:"channel-t",kind:"text",speaker:"owner",outcome:"recorded",text:"Play Captain Vale",origin:{kind:"channel"}});
  const scope=db.prepare("SELECT scope_id FROM memory_sources WHERE id='r6-channel-invite'").get()!.scope_id;
  db.prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:channel-t',?,'human-thread','channel-t',1,'granted',?)").run(scope,JSON.stringify({personId:"workspace-owner",bindingId:"r6-verified",revision:1}));
  db.prepare("INSERT INTO memory_scope_bindings VALUES('r6-verified',?,'human-binding','r6-verified',1,'granted',?)").run(scope,JSON.stringify({id:"r6-verified",personId:"workspace-owner",revision:1,active:true}));
  invitation={sourceId:"r6-channel-invite",revision:1,startByte:0,endByte:16};
 }
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 if(reason==="bot-paused")updateMemoryLearning(db,{botsPaused:["evidence-bot"]},readMemoryLearning(db).revision);
 if(reason==="chats-off")updateMemoryLearning(db,{learnFrom:{chats:false,channels:true}},readMemoryLearning(db).revision);
 if(reason==="channels-off")updateMemoryLearning(db,{learnFrom:{chats:true,channels:false}},readMemoryLearning(db).revision);
 if(reason==="excluded-thread")db.prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)").run(db.prepare("SELECT scope_id FROM memory_sources WHERE id='r6-settings'").get()!.scope_id,JSON.stringify({excludedThreadIds:["canon-task"]}));
 // Test the shared predicate directly: distinct conversation scopes cannot
 // be combined by generic save, and the invitation must not mask the check.
 const {invitedCanonRefusal,ownerLearningRefusal}=await import("./automatic-learning.ts");
 expect(ownerLearningRefusal(db,[invitation])).toBeUndefined();
 expect(invitedCanonRefusal(db,[{sourceId:"r6-settings",revision:1}],invitation,"evidence-bot")).toBe(reason);
});
it("activation holds channel canon evidence while its attended invitation remains learnable",async()=>{
 const f=fixture(),db=database(),text="Captain Vale lives at sea.";
 captureSource(db,{id:"r6-channel-canon",occurredAt:2,threadId:"thread",kind:"text",speaker:"assistant",outcome:"recorded",text,origin:{kind:"channel"}});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 const {saveMemoryCandidate}=await import("./authority.ts"),{activateGroundedMemory,ownerLearningRefusal}=await import("./automatic-learning.ts");
 const id=saveMemoryCandidate(text,[{sourceId:"r6-channel-canon",revision:1,startByte:0,endByte:Buffer.byteLength(text)},f.evidence[0]],"r6-channel-canon",f.context);
 updateMemoryLearning(db,{learnFrom:{chats:true,channels:false}},readMemoryLearning(db).revision);
 expect(ownerLearningRefusal(db,f.evidence)).toBeUndefined();
 expect(activateGroundedMemory(db,id,"character-canon",{supported:true,ownerInvitation:"Play Captain Vale",ownerInvitationSourceId:f.evidence[0].sourceId},{botId:f.context.botId})).toBe(false);
 expect(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(id)?.confidence_basis).toBe("Learning from connected channels is off.");
});

// Round 7: provenance and invitation ordering apply at both authority boundaries.
it.each(["webhook","tool","other-bot","other-thread","later-invitation","person"])("holds invited canon from %s before grounding and at activation",async reason=>{
 const f=fixture(),db=database(),text="Captain Vale lives at sea.";
 captureSource(db,{id:"r7-evidence",threadId:"thread",kind:reason==="tool"?"tool-outcome":"text",speaker:reason==="webhook"?"owner":reason==="tool"?"tool":reason==="other-bot"?"other":reason==="person"?"person:visitor":"bot",outcome:"recorded",text,occurredAt:2,origin:{kind:reason==="webhook"?"webhook":"attended"}});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 // Preserve the same scope to exercise the thread rule rather than scope access.
 if(reason==="other-thread")db.prepare("UPDATE memory_sources SET thread_id='different-thread' WHERE id=?").run(f.evidence[0].sourceId);
 if(reason==="later-invitation")db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.occurredAt',3) WHERE source_id=?").run(f.evidence[0].sourceId);
 const evidence=[{sourceId:"r7-evidence",revision:1,startByte:0,endByte:Buffer.byteLength(text)}];
 const ground=vi.fn(async()=>'{"supported":true}'),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground});
 const saved=await memoryAgentRoute("/api/internal/memory/save",{text,evidence,ownerInvitation:f.evidence[0],claimType:"character-canon",idempotencyKey:"r7-refusal"},f.context,f.bridge,undefined,extractor) as {candidateId:string;state:string};
 expect(saved.state).toBe("candidate");expect(ground).not.toHaveBeenCalled();
 const {activateGroundedMemory}=await import("./automatic-learning.ts");
 expect(activateGroundedMemory(db,saved.candidateId,"character-canon",{supported:true,ownerInvitation:"Play Captain Vale",ownerInvitationSourceId:f.evidence[0].sourceId},{botId:f.context.botId})).toBe(false);
});
it.each(["bot","assistant","owner"])("activates invited canon from the acting %s with a truthful assertion",async speaker=>{
 const f=fixture(),db=database(),text="Captain Vale lives at sea.";
 captureSource(db,{id:"r7-own",threadId:"thread",kind:"text",speaker,outcome:"recorded",text,occurredAt:2,origin:{kind:"attended"}});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 const ground=vi.fn(async()=>'{"supported":true}'),extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground});
 const saved=await memoryAgentRoute("/api/internal/memory/save",{text,evidence:[{sourceId:"r7-own",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],ownerInvitation:f.evidence[0],claimType:"character-canon",idempotencyKey:"r7-own"},f.context,f.bridge,undefined,extractor) as {candidateId:string;state:string};
 expect(saved.state).toBe("active");expect(ground).toHaveBeenCalledOnce();
 expect(db.prepare("SELECT assertion FROM memory_records WHERE id=?").get(saved.candidateId)?.assertion).toBe(speaker==="owner"?"owner-statement":"assistant-inference");
});

it.each(["webhook","tool","other-bot","other-thread","later-invitation"])("rechecks %s canon provenance after grounding",async reason=>{
 const f=fixture(),db=database(),text="Captain Vale lives at sea.";
 captureSource(db,{id:"r7-race",threadId:"thread",kind:"text",speaker:"bot",outcome:"recorded",text,occurredAt:2});
 for(let job=claimMemoryJob("fixture");job;job=claimMemoryJob("fixture"))publishMemoryWork(job,"fixture",captureWork(job));
 const ground=vi.fn(async()=>{
  if(reason==="webhook"){
   db.prepare("UPDATE memory_sources SET speaker='owner' WHERE id='r7-race'").run();
   db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','webhook') WHERE source_id='r7-race'").run();
  }
  if(reason==="tool")db.prepare("UPDATE memory_sources SET kind='tool-outcome' WHERE id='r7-race'").run();
  if(reason==="other-bot")db.prepare("UPDATE memory_sources SET speaker='other' WHERE id='r7-race'").run();
  if(reason==="other-thread")db.prepare("UPDATE memory_sources SET thread_id='different-thread' WHERE id=?").run(f.evidence[0].sourceId);
  if(reason==="later-invitation")db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.occurredAt',3) WHERE source_id=?").run(f.evidence[0].sourceId);
  return '{"supported":true}';
 });
 const extractor:TextOnlyExtractor=Object.assign(async()=>"[]",{ground});
 expect(await memoryAgentRoute("/api/internal/memory/save",{text,evidence:[{sourceId:"r7-race",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],ownerInvitation:f.evidence[0],claimType:"character-canon",idempotencyKey:"r7-race"},f.context,f.bridge,undefined,extractor)).toMatchObject({state:"candidate"});
 expect(ground).toHaveBeenCalledOnce();
});
