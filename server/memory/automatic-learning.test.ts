import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
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
  captureSource(database(),{id,threadId:"thread",kind:"text",speaker,outcome,text,
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
  expect(record()).toMatchObject({state:"candidate",assertion:"assistant-inference"});
});
it("keeps failed tool actions provisional",async()=>{
  const text="deployment failed",job=capture(text,"tool","failed");
  await consolidateMemorySource(job,extract(text,"observation"),signal());
  expect(record().state).toBe("candidate");
});
it("activates completed tool reported observations with qualified provenance",async()=>{
  const text="saved fixture file",job=capture(text,"tool","completed");
  await consolidateMemorySource(job,extract(text,"observation"),signal());
  expect(record()).toMatchObject({state:"active",assertion:"tool-observation",confidence_basis:"Exact completed tool-reported outcome"});
});
it("uses review and procedure switches at activation",async()=>{
  settings({automaticProcedures:false});
  const text="Use the existing test command.",job=capture(text);
  await consolidateMemorySource(job,extract(text,"procedure"),signal());
  expect(record().state).toBe("candidate");
});
it("makes unavailable synthesis and configured cost ceilings truthful without spending",async()=>{
  const text="I prefer concise answers.",job=capture(text);let calls=0;
  expect(await consolidateMemorySource(job,null,signal())).toMatchObject({status:"deferred",reason:"extractor-unavailable",cursor:0});
  settings({dailyCostUsd:1});
  expect(await consolidateMemorySource(job,async()=>{calls++;return "[]";},signal())).toMatchObject({status:"deferred",reason:"cost-estimate-unavailable",cursor:0});
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
    captureSource(database(),{id:"source",threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text:"I prefer detailed answers."});
    return await extract(quote,"owner-statement")();
  },signal())).rejects.toThrow("MEMORY_COMPLETED_SOURCE_REQUIRED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE id LIKE 'candidate:%'").get()?.n).toBe(0);
});
