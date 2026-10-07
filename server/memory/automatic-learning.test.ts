import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";

beforeEach(()=>{
  closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});
  reconcileMemoryRoster({bots:[{id:"bot",threadId:"thread"}],groups:[]});
});
function capture(text:string,speaker="owner",outcome="recorded",id="source"){
  captureSource(database(),{id,threadId:"thread",origin:{kind:"attended"},kind:"text",speaker,outcome,text,
    ...(speaker==="tool"?{action:{label:"fixture",reportedOutcome:outcome as "completed"|"failed",verification:"tool-reported" as const}}:{})});
  const work=claimMemoryJob("fixture")!;expect(work).toBeTruthy();
  publishMemoryWork(work,"fixture",captureWork(work));return work.id;
}
const signal=()=>new AbortController().signal;
const extract=(quote:string,claimType:string,text=quote)=>async()=>JSON.stringify([{text,quote,claimType,startByte:0,endByte:Buffer.byteLength(quote)}]);
function settings(patch:unknown){updateMemoryLearning(database(),patch,readMemoryLearning(database()).revision);}
function record(){return database().prepare("SELECT r.*,d.partition,d.confidence_basis FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id LIKE 'candidate:%'").get()!;}

it("activates an exact owner preference without review, indexes it, and replays without double application",async()=>{
  const text="I prefer concise answers.",job=capture(text);
  await consolidateMemorySource(job,extract(text,"owner-statement"),signal());
  expect(record()).toMatchObject({state:"active",assertion:"owner-statement",partition:"semantic",text});
  expect(database().prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id=?").get(record().id)?.lexical_status).toBe("pending");
  expect((await consolidateMemorySource(job,async()=>{throw Error("must not call");},signal())).status).toBe("unchanged");
});
it("does not elevate a paraphrase or a model's own claimed authority",async()=>{
  const text="Possibly the deployment succeeded.",job=capture(text,"assistant");
  await consolidateMemorySource(job,extract(text,"owner-statement","Deployment succeeded."),signal());
  expect(record()).toBeUndefined();
});
it("defers failed tool actions to the nightly path",async()=>{
  const text="deployment failed",job=capture(text,"tool","failed");
  await consolidateMemorySource(job,extract(text,"observation"),signal());
  expect(record()).toBeUndefined();
});
it("defers completed tool observations to the nightly path",async()=>{
  const text="saved fixture file",job=capture(text,"tool","completed");
  await consolidateMemorySource(job,extract(text,"observation"),signal());
  expect(record()).toBeUndefined();
});
it("uses review and procedure switches at activation",async()=>{
  settings({automaticProcedures:false});
  const text="Use the existing test command.",job=capture(text);
  await consolidateMemorySource(job,extract(text,"procedure"),signal());
  expect(record().state).toBe("candidate");
});
it("makes unavailable synthesis and configured token limits truthful without spending",async()=>{
  const text="I prefer concise answers.",job=capture(text);let calls=0;
  expect(await consolidateMemorySource(job,null,signal())).toMatchObject({status:"deferred",reason:"extractor-unavailable",cursor:0});
  settings({dailyOutputTokens:0});
  expect(await consolidateMemorySource(job,async()=>{calls++;return "[]";},signal())).toMatchObject({status:"deferred",reason:"budget-exhausted",cursor:0});
  expect(calls).toBe(0);
});
it("rejects an in-flight result when source revision or learning configuration changes",async()=>{
  const text="I prefer concise answers.",job=capture(text);
  await expect(consolidateMemorySource(job,async()=>{settings({reviewMode:true});return await extract(text,"owner-statement")();},signal())).rejects.toThrow("MEMORY_CONSOLIDATION_REVOKED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE id LIKE 'candidate:%'").get()?.n).toBe(0);
});
it("refuses budget exhausted calls and preserves the unacknowledged cursor",async()=>{
  settings({callsPerMinute:0});const job=capture("source");let calls=0;
  expect(await consolidateMemorySource(job,async()=>{calls++;return "[]";},signal())).toMatchObject({status:"deferred",reason:"budget-exhausted",cursor:0});
  expect(calls).toBe(0);
});

it("supports grounded paraphrases through a separate evaluator and charges both calls",async()=>{
  const quote="I would like answers kept short.",job=capture(quote);
  const extractor:TextOnlyExtractor=extract(quote,"owner-statement","Prefers concise answers.");
  extractor.ground=async input=>{expect(input.quote).toBe(quote);expect(input.text).toBe("Prefers concise answers.");return '{"supported":true}';};
  await consolidateMemorySource(job,extractor,signal());
  expect(record()).toMatchObject({state:"active",text:"Prefers concise answers."});
  const budget=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.intent));
  expect(budget.calls).toBe(2);
});
it("supersedes an explicit independently grounded same-subject update while preserving both original sources",async()=>{
  const first="I prefer long answers.",second="Correction: I now prefer short answers.";
  const extractor=(quote:string,update=false):TextOnlyExtractor=>{
    const fn:TextOnlyExtractor=async()=>JSON.stringify([{text:quote,quote,claimType:"owner-statement",subject:"owner",predicate:"answer-length",update,startByte:0,endByte:Buffer.byteLength(quote)}]);
    fn.ground=async input=>{expect(input.previousClaim).toBe(first);return '{"supported":true}';};return fn;
  };
  await consolidateMemorySource(capture(first),extractor(first),signal());const old=record();
  await consolidateMemorySource(capture(second,"owner","recorded","source-2"),extractor(second,true),signal());
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(old.id)?.state).toBe("superseded");
  expect(database().prepare("SELECT text,state FROM memory_records WHERE supersedes_id=?").get(old.id)).toMatchObject({text:second,state:"active"});
  expect(database().prepare("SELECT count(*) AS n FROM memory_source_versions").get()?.n).toBe(2);
});
it("fences concurrent source edits before optional synthesis publishes",async()=>{
  const quote="I prefer concise answers.",job=capture(quote);
  await expect(consolidateMemorySource(job,async()=>{
    captureSource(database(),{id:"source",threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text:"I prefer detailed answers."});
    return await extract(quote,"owner-statement")();
  },signal())).rejects.toThrow("MEMORY_COMPLETED_SOURCE_REQUIRED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE id LIKE 'candidate:%'").get()?.n).toBe(0);
});

it.each([false,true])("default connection activation follows learningDefaultOn=%s",async defaultOn=>{
 const text="I prefer tea.",job=capture(text);
 await consolidateMemorySource(job,extract(text,"owner-statement"),signal(),{connection:"@murage/flux-fast",reviewOnly:!defaultOn});
 expect(record().state).toBe(defaultOn?"active":"candidate");
 expect(database().prepare("SELECT count(*) n FROM memory_learning_events WHERE kind='activated'").get()?.n).toBe(defaultOn?1:0);
});
it("defers a reached project budget without calls and learns after it is raised",async()=>{
 const text="I prefer tea.",job=capture(text);let calls=0,allowed=false;
 const extractor=async()=>{calls++;return extract(text,"owner-statement")();};
 expect(await consolidateMemorySource(job,extractor,signal(),{budgetGate:()=>allowed})).toMatchObject({reason:"project-budget-reached"});expect(calls).toBe(0);
 allowed=true;expect((await consolidateMemorySource(job,extractor,signal(),{budgetGate:()=>allowed})).status).toBe("complete");expect(calls).toBe(1);expect(record().state).toBe("active");
});
it("records the default once only for enabled learning with a key",async()=>{
 const {recordDefaultLearningConnection}=await import("./learning-ledger.ts");const db=database();
 expect(recordDefaultLearningConnection(db,null,false)).toBe(false);settings({automaticFacts:false,automaticProcedures:false});expect(recordDefaultLearningConnection(db,null,true)).toBe(false);
 settings({automaticFacts:true});expect(recordDefaultLearningConnection(db,"chosen",true)).toBe(false);
 expect(recordDefaultLearningConnection(db,null,true)).toBe(true);expect(recordDefaultLearningConnection(db,null,true)).toBe(false);
});


import { changeLearningEvent } from "./learning-history.ts";
import { transaction } from "../database.ts";
it("writes one Updated item and Undo restores its prior memory",async()=>{
 const db=database(),first="I like tea",second="I like coffee";
 const extractor=(text:string,update=false):TextOnlyExtractor=>Object.assign(async()=>JSON.stringify([{text,quote:text,claimType:"owner-statement",subject:"owner",predicate:"drink",update,startByte:0,endByte:Buffer.byteLength(text)}]),{ground:async()=>'{"supported":true}'});
 await consolidateMemorySource(capture(first),extractor(first),signal());const prior=record();
 await consolidateMemorySource(capture(second,"owner","recorded","new-source"),extractor(second,true),signal());
 const next=db.prepare("SELECT id FROM memory_records WHERE supersedes_id=?").get(prior.id)!;
 const events=db.prepare("SELECT id,kind FROM memory_learning_events WHERE record_id=?").all(next.id);expect(events).toHaveLength(1);expect(events[0].kind).toBe("superseded");
 transaction(()=>changeLearningEvent(db,String(events[0].id),"undo"));transaction(()=>changeLearningEvent(db,String(events[0].id),"undo"));
 expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(prior.id)?.state).toBe("active");expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(next.id)?.state).toBe("archived");
});
it("does not let a second claim replace a running intent after a gate changes",async()=>{
 const db=database(),text="tea",job=capture(text);let finish!:(value:string)=>void;
 const running=consolidateMemorySource(job,()=>new Promise(resolve=>{finish=resolve;}),signal());
 const before=db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='consolidation-pending'").get()!.intent;
 expect(await consolidateMemorySource(job,extract(text,"owner-statement"),signal(),{budgetGate:()=>false})).toMatchObject({reason:"extraction-already-running"});
 expect(db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='consolidation-pending'").get()!.intent).toBe(before);
 finish("[]");await running;
});
it("checks project learning outside the claim transaction",async()=>{
 const db=database(),job=capture("tea");let checked=false;
 await consolidateMemorySource(job,async()=>"[]",signal(),{budgetGate:()=>{checked=true;db.exec("BEGIN IMMEDIATE;ROLLBACK");return true;}});expect(checked).toBe(true);
});
it("does not record the default while memory is off or acquire another write lock once recorded",async()=>{
 const {recordDefaultLearningConnection}=await import("./learning-ledger.ts"),db=database();db.exec("UPDATE memory_meta SET mode='off'");
 expect(recordDefaultLearningConnection(db,null,true)).toBe(false);expect(db.prepare("SELECT count(*) n FROM memory_learning_events").get()?.n).toBe(0);
 db.exec("UPDATE memory_meta SET mode='active'");expect(recordDefaultLearningConnection(db,null,true)).toBe(true);
 const prepare=vi.spyOn(db,"prepare"),exec=vi.spyOn(db,"exec");try{expect(recordDefaultLearningConnection(db,null,true)).toBe(false);expect(prepare).not.toHaveBeenCalled();expect(exec).not.toHaveBeenCalled();}finally{prepare.mockRestore();exec.mockRestore();}
});

it("does not memoize a default event rolled back by its caller",async()=>{
 const {recordDefaultLearningConnection}=await import("./learning-ledger.ts"),db=database();
 db.exec("BEGIN IMMEDIATE");expect(recordDefaultLearningConnection(db,null,true)).toBe(true);db.exec("ROLLBACK");
 expect(recordDefaultLearningConnection(db,null,true)).toBe(true);expect(db.prepare("SELECT count(*) n FROM memory_learning_events WHERE kind='connection-defaulted'").get()?.n).toBe(1);
});

it.each(["default","review","destination"])("retains a held %s correction target for atomic owner approval",async hold=>{
 const {ownerMemoryTicket,approveMemory,readCorrectionTarget}=await import("./authority.ts"),{installLearningDestination}=await import("./learning-destination.ts");
 const db=database(),first="I prefer tea",second="Correction: I prefer coffee";
 const extractor=(text:string,update=false):TextOnlyExtractor=>Object.assign(async()=>JSON.stringify([{text,quote:text,claimType:"owner-statement",subject:"owner",predicate:"drink",update,startByte:0,endByte:Buffer.byteLength(text)}]),{ground:async()=>'{"supported":true}'});
 await consolidateMemorySource(capture(first),extractor(first),signal());const prior=record();
 if(hold==="review")settings({reviewMode:true});
 const restore=hold==="destination"?installLearningDestination(()=>({ok:false,reason:"needs-owner-approval"})):()=>{};
 try{
  const result=await consolidateMemorySource(capture(second,"owner","recorded","correction"),extractor(second,true),signal(),{reviewOnly:hold==="default"});
  const id=result.candidateIds[0];expect(readCorrectionTarget(db,id,1)).toMatchObject({status:"current",target:{id:prior.id,version:1}});
  expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(id)?.state).toBe("candidate");
  approveMemory(ownerMemoryTicket(),id,1);
  expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(prior.id)?.state).toBe("superseded");expect(db.prepare("SELECT state FROM memory_records WHERE id=?").get(id)?.state).toBe("active");
 }finally{restore();}
});
it("Keep preserves fictional identity disclaimers",async()=>{
 const db=database(),job=capture("I prefer tea");await consolidateMemorySource(job,extract("I prefer tea","owner-statement"),signal());
 const row=record(),basis="Owner-invited fictional character canon; not model autobiography or world truth";
 db.prepare("UPDATE memory_record_details SET partition='identity',confidence_basis=? WHERE record_id=?").run(basis,row.id);
 const event=db.prepare("SELECT id FROM memory_learning_events WHERE record_id=?").get(row.id)!;
 transaction(()=>changeLearningEvent(db,String(event.id),"keep"));
 expect(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(row.id)?.confidence_basis).toBe(basis);
 expect(db.prepare("SELECT kept_at FROM memory_learning_events WHERE id=?").get(event.id)?.kept_at).not.toBeNull();
});
