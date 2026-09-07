import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource, pendingMemoryConsolidationJobs } from "./consolidate.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});
  reconcileMemoryRoster({bots:[{id:"bot",threadId:"thread"}],groups:[]});setMemoryMode("capture");
});
afterEach(()=>vi.useRealTimers());
function complete(text:string){
  captureSource(database(),{id:"resume-source",threadId:"thread",messageId:"source-message",kind:"text",speaker:"owner",outcome:"recorded",text});
  let id="";
  for(;;){
    const work=claimMemoryJob("resume-fixture");if(!work)throw Error("fixture source not captured completely");
    id=work.id;const result=captureWork(work);publishMemoryWork(work,"resume-fixture",result);
    if(result.status==="complete")break;
  }
  return id;
}
function quoted(text:string){const quote=Array.from(text).slice(0,8).join("");return JSON.stringify([{text:quote,quote,startByte:0,endByte:Buffer.byteLength(quote)}]);}
function intent(){return JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'consolidation:%'").get()!.intent));}

it("resumes the interrupted second model slice with absolute UTF-8 evidence after restart",async()=>{
  const text="abcไทย".repeat(2100),job=complete(text),seen:string[]=[];
  const first=await consolidateMemorySource(job,async chunk=>{seen.push(chunk);return quoted(chunk);},new AbortController().signal);
  expect(first.status).toBe("partial");expect(first.cursor).toBeGreaterThan(16380);expect(first.cursor).toBeLessThanOrEqual(16384);
  expect(seen[0]).toBe(Buffer.from(text).subarray(0,first.cursor).toString("utf8"));
  const interrupted=await consolidateMemorySource(job,async chunk=>{seen.push(chunk);throw Error("fixture second-slice interruption");},new AbortController().signal);
  expect(interrupted).toMatchObject({status:"deferred",cursor:first.cursor,candidateCount:1});
  expect(intent().cursor).toBe(first.cursor);
  closeDatabase();vi.setSystemTime(Date.now()+60001);
  expect(pendingMemoryConsolidationJobs()).toContain(job);
  const resumed=await consolidateMemorySource(job,async chunk=>{seen.push(chunk);return quoted(chunk);},new AbortController().signal);
  expect(resumed).toMatchObject({status:"complete",cursor:Buffer.byteLength(text),candidateCount:2});
  expect(seen[2]).toBe(seen[1]);expect(seen[0]+seen[2]).toBe(text);
  const evidence=database().prepare("SELECT e.start_byte,e.end_byte,r.text FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE r.state='candidate' ORDER BY e.start_byte").all();
  expect(evidence.map(row=>row.start_byte)).toEqual([0,first.cursor]);
  for(const row of evidence)expect(Buffer.from(text).subarray(Number(row.start_byte),Number(row.end_byte)).toString("utf8")).toBe(row.text);
  expect((await consolidateMemorySource(job,async()=>{throw Error("must not spend after complete");},new AbortController().signal)).status).toBe("unchanged");
  expect(pendingMemoryConsolidationJobs()).not.toContain(job);
  expect(intent().candidateIds).toHaveLength(1); // bounded last-slice metadata
});

it("rolls back candidate and cursor together, then retries an expired interrupted lease idempotently",async()=>{
  const job=complete("a".repeat(20000));
  const first=await consolidateMemorySource(job,async chunk=>quoted(chunk),new AbortController().signal);
  database().exec("CREATE TRIGGER fixture_consolidation_commit_failure BEFORE UPDATE ON memory_scope_bindings WHEN NEW.id LIKE 'consolidation:%' AND json_extract(NEW.intent,'$.status')='complete' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END");
  await expect(consolidateMemorySource(job,async chunk=>quoted(chunk),new AbortController().signal)).rejects.toThrow("fixture commit failure");
  expect(intent().cursor).toBe(first.cursor);
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='candidate'").get()?.n).toBe(1);
  database().exec("DROP TRIGGER fixture_consolidation_commit_failure");closeDatabase();vi.setSystemTime(Date.now()+65001);
  expect(pendingMemoryConsolidationJobs()).toContain(job);
  const retried=await consolidateMemorySource(job,async chunk=>quoted(chunk),new AbortController().signal);
  expect(retried).toMatchObject({status:"complete",cursor:20000,candidateCount:2});
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='candidate'").get()?.n).toBe(2);
});

it("keeps large sources resumable across the unchanged daily budget without spending on refusal",async()=>{
  const job=complete("b".repeat(80000));let calls=0;
  const extractor=async()=>{calls++;return "[]";};
  const first=await consolidateMemorySource(job,extractor,new AbortController().signal);
  expect(first).toMatchObject({status:"partial",cursor:16384});
  database().prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.input',100000) WHERE id=?").run("extract-budget:2026-09-07");
  const stopped=await consolidateMemorySource(job,extractor,new AbortController().signal);
  expect(stopped).toMatchObject({status:"deferred",reason:"budget-exhausted",cursor:16384,retryAfter:Date.parse("2026-09-08T00:00:00Z")});
  expect(calls).toBe(1);expect(pendingMemoryConsolidationJobs()).not.toContain(job);
  vi.setSystemTime(new Date("2026-09-08T00:00:01Z"));
  expect(pendingMemoryConsolidationJobs()).toContain(job);
  const resumed=await consolidateMemorySource(job,extractor,new AbortController().signal);
  expect(resumed).toMatchObject({status:"partial",cursor:32768});expect(calls).toBe(2);
});
