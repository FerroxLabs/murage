// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSAVE-1024 (field 1.0.23): a memory save was refused with "Source capture is still pending. Try saving this memory again after
// capture finishes." for as long as the background capture worker was kept out. Every case here leaves the capture queue unworked
// (no worker runs in this file) and enters through the shipped agent route handler.
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob,publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { captureSource } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { memoryAgentRoute } from "./routes.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

afterEach(()=>setMemoryCaptureRoster(null));
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
useOutsideStoreFixture();

function fixture(){
  const roster={bots:[{id:"bot",threadId:"thread"}],groups:[]};
  setMemoryCaptureRoster(()=>roster);reconcileMemoryRoster(roster);setMemoryMode("capture");
  appendMessage("thread",{id:"m",at:1,role:"user",origin:"desktop",kind:"text",text:"Verified source note"});
  const work=claimMemoryJob("fixture")!;publishMemoryWork(work,"fixture",captureWork(work));
  setMemoryMode("active");
  const record=database().prepare("SELECT id FROM memory_records").get()!;
  const registry=new InternalCapabilities();registry.begin("bot","thread","generation");
  const token=registry.mint({botId:"bot",threadId:"thread",generation:"generation",depth:99,kind:"memory",skillAuthoring:false});
  const context=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const bridge={search:async()=>({hits:[],vectorRows:0})};
  return {context,recordId:String(record.id),bridge};
}
/** The owner says something; its capture job is written and nobody works it. */
function ownerSays(id:string,text:string){
  captureSource(database(),{id,threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text});
  return {text,evidence:[{sourceId:id,revision:1,startByte:0,endByte:Buffer.byteLength(text)}],claimType:"owner-statement",idempotencyKey:id};
}
const job=(sourceId:string)=>database().prepare("SELECT status,cursor,lease_owner FROM memory_jobs WHERE source_id=? AND stage='capture'").get(sourceId)!;
/** What the caller got: the route's answer, or the refusal it was given (so a refusal fails the case at its own assertion). */
const outcome=(call:Promise<unknown>)=>call.then(answer=>answer,error=>({refused:String((error as Error).message)}));
const save=(f:ReturnType<typeof fixture>,input:unknown)=>outcome(memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge));

// How the queue was left when the save arrived: the states the refused guard named (authority.ts), one row each.
const STATES:Array<[string,(sourceId:string)=>void]>=[
  ["pending (never claimed)",()=>{}],
  ["deferred, backed off for ten minutes",id=>{database().prepare("UPDATE memory_jobs SET status='deferred',retry_at=?,error='transient:3:MEMORY_DATABASE_BUSY' WHERE source_id=?").run(Date.now()+600_000,id);}],
  ["leased by a worker that has not published",()=>{expect(claimMemoryJob("starved-worker")).not.toBeNull();}],
  ["partial (one slice published, then starved)",id=>{database().prepare("UPDATE memory_jobs SET status='partial' WHERE source_id=?").run(id);}],
];
it.each(STATES)("W1 a save whose cited source is %s is saved at once, by one request",async(_name,arrange)=>{
  const f=fixture(),input=ownerSays("owner-line","I prefer tea.");
  arrange("owner-line");
  expect(job("owner-line").status).not.toBe("complete");
  expect(await save(f,input)).toMatchObject({state:"active"});
  expect(job("owner-line").status).toBe("complete");
  expect(database().prepare("SELECT e.source_id FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id WHERE r.kind='fact'").all()).toEqual([{source_id:"owner-line"}]);
});
it("W2 a starved queue of 50 other captures still completes the owner's cited source, and only that one",async()=>{
  const f=fixture();
  for(let n=0;n<50;n++)captureSource(database(),{id:`backlog-${n}`,threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text:`Backlog line ${n}.`});
  const input=ownerSays("owner-line","I prefer tea.");
  expect(await save(f,input)).toMatchObject({state:"active"});
  expect(job("owner-line").status).toBe("complete");
  expect(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE stage='capture' AND status='pending' AND source_id LIKE 'backlog-%'").get()!.n).toBe(50);
});
it("W3 the worker whose lease the save took over cannot publish over it",async()=>{
  const f=fixture(),input=ownerSays("owner-line","I prefer tea.");
  const stale=claimMemoryJob("starved-worker")!;
  expect(await save(f,input)).toMatchObject({state:"active"});
  expect(()=>publishMemoryWork(stale,"starved-worker",captureWork(stale))).toThrow("STALE_MEMORY_LEASE");
  expect(job("owner-line").status).toBe("complete");
});
it("W4 a correction proposal quoting a line whose capture is pending is stored, not refused",async()=>{
  const f=fixture(),input=ownerSays("correction-line","Correction: the source note is now confirmed.");
  expect(await outcome(memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:input.text,evidence:input.evidence,idempotencyKey:"proposal"},f.context,f.bridge))).toMatchObject({candidateId:expect.any(String)});
  expect(job("correction-line").status).toBe("complete");
});
it("W5 a cited source too large for the save's own bound is not refused either: saved with its evidence linked, capture left to the worker",async()=>{
  const f=fixture(),lead="I prefer tea.",text=lead+" filler".repeat(450_000);
  captureSource(database(),{id:"large-line",threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text});
  const input={text:lead,evidence:[{sourceId:"large-line",revision:1,startByte:0,endByte:Buffer.byteLength(lead)}],claimType:"owner-statement",idempotencyKey:"large-line"};
  expect(await save(f,input)).toMatchObject({candidateId:expect.any(String)});
  expect(database().prepare("SELECT e.source_id FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id WHERE r.kind='fact'").all()).toEqual([{source_id:"large-line"}]);
  // bounded: the save worked the front of the source and stopped; the job is still the worker's to finish
  expect(job("large-line")).toMatchObject({status:"partial",lease_owner:null});
  expect(Number(job("large-line").cursor)).toBeGreaterThan(0);
  for(let work=claimMemoryJob("fixture");work;work=claimMemoryJob("fixture"))publishMemoryWork(work,"fixture",captureWork(work));
  expect(job("large-line").status).toBe("complete");
  expect(await save(f,input)).toMatchObject({state:"active"});
});
it("G1 (kept) a source whose capture can no longer complete is still refused, and nothing is saved",async()=>{
  const f=fixture(),input=ownerSays("owner-line","I prefer tea.");
  database().prepare("UPDATE memory_jobs SET status='failed',attempts=3 WHERE source_id='owner-line'").run();
  expect(await save(f,input)).toEqual({refused:"This source cannot be used because its capture did not complete."});
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='fact'").get()!.n).toBe(0);
});
it("W6 the slice bound is one bound for the whole save: the slice that completes one cited source is counted against the next",async()=>{
  const f=fixture(),lead="I prefer tea.",text=lead+"x".repeat(24*65536-Buffer.byteLength(lead));
  for(const id of ["large-a","large-b"])captureSource(database(),{id,threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text});
  const evidence=["large-a","large-b"].map(sourceId=>({sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(lead)}));
  // the wall bound is held still, so the slice bound alone decides where the save stops
  const clock=vi.spyOn(performance,"now").mockReturnValue(performance.now());
  let saved:unknown;
  try{saved=await save(f,{text:lead,evidence,idempotencyKey:"two-large"});}finally{clock.mockRestore();}
  expect(saved).toMatchObject({candidateId:expect.any(String)});
  expect(job("large-a")).toMatchObject({status:"complete",cursor:24*65536});
  // 32 slices in all: 24 completed the first source, 8 are left for the second
  expect(job("large-b")).toMatchObject({status:"partial",cursor:8*65536,lease_owner:null});
});
it("W7 a held write lock costs the capture step no more than its own bound: it gives up, the save still lands, and the repeat finishes it",async()=>{
  const f=fixture(),input=ownerSays("owner-line","I prefer tea.");
  // another connection holds the write lock for 700 ms (longer than the capture bound, shorter than a save's own lock wait)
  const holder=new Worker(`const {DatabaseSync}=require("node:sqlite"),{parentPort,workerData}=require("node:worker_threads");
    const db=new DatabaseSync(workerData.file);db.exec("PRAGMA busy_timeout=5000");db.exec("BEGIN IMMEDIATE");parentPort.postMessage("held");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700);db.exec("COMMIT");db.close();`,{eval:true,workerData:{file:join(DATA_DIR,"messages.db")}});
  const released=new Promise(resolve=>holder.once("exit",resolve));
  await new Promise(resolve=>holder.once("message",resolve));
  const saved=await save(f,input);
  await released;
  expect(saved).toMatchObject({candidateId:expect.any(String)});
  expect(job("owner-line").status).toBe("pending");
  expect(await save(f,input)).toMatchObject({state:"active"});
  expect(job("owner-line").status).toBe("complete");
});
