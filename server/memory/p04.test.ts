import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, deferStaleMemoryWork, heartbeatMemoryJob, publishMemoryWork, requeueStaleMemoryWork } from "./jobs.ts";
import { extractCandidates, memoryExtractionMessages } from "./extract.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");});
function source(text="Durable evidence") {appendMessage("thread",{id:"source",at:1,role:"user",kind:"text",text});}
it("preserves all byte coverage over large Unicode chunks without duplicates",()=>{
  const text="ข้อมูลไทย ".repeat(8000);source(text);
  let steps=0;
  for (;;) {const work=claimMemoryJob("worker");if(!work)break;publishMemoryWork(work,"worker",captureWork(work));steps++;}
  expect(steps).toBeGreaterThan(1);
  expect(database().prepare("SELECT status,cursor FROM memory_jobs").get()).toMatchObject({status:"complete",cursor:Buffer.byteLength(text)});
  const rows=database().prepare("SELECT r.text FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id ORDER BY e.start_byte").all();
  expect(rows.map(r=>r.text).join("")).toBe(text);
});
it("fences an expired holder after takeover and prevents it refreshing the new lease",()=>{
  source();const a=claimMemoryJob("A",1000)!;const b=claimMemoryJob("B",32000)!;
  expect(b.leaseGeneration).toBeGreaterThan(a.leaseGeneration);
  expect(heartbeatMemoryJob(a,"A",32001)).toBe(false);
  expect(()=>publishMemoryWork(a,"A",captureWork(a),32001)).toThrow("STALE_MEMORY_LEASE");
  publishMemoryWork(b,"B",captureWork(b),32001);
  expect(database().prepare("SELECT count(*) AS n FROM memory_records").get()?.n).toBe(1);
});
it("rejects partial output presented as full completion",()=>{
  source("x".repeat(70000));const work=claimMemoryJob("A")!;
  expect(()=>publishMemoryWork(work,"A",{...captureWork(work),status:"complete"})).toThrow("INCOMPLETE_MEMORY_SOURCE");
  expect(database().prepare("SELECT cursor FROM memory_jobs").get()?.cursor).toBe(0);
});
it("rejects a worker rewriting evidence or publishing after a source deletion",()=>{
  source();const work=claimMemoryJob("A")!;const result=captureWork(work);
  result.chunks[0].text="fabricated";
  expect(()=>publishMemoryWork(work,"A",result)).toThrow("INVALID_MEMORY_CHUNK");
  database().exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1");
  expect(()=>publishMemoryWork(work,"A",captureWork(work))).toThrow("STALE_MEMORY_SOURCE");
});
// RED2J: a job whose publication is refused as stale (the policy revision
// moved while the worker held it) used to stay `leased` with nobody working
// it until the lease expired — up to 30 s in which the queue could not drain.
// It goes back to `pending` at once instead; the old holder stays fenced.
it("requeues a job at once when its publication is refused as stale, fencing the old holder",()=>{
  source();const work=claimMemoryJob("A",1000)!;
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  expect(()=>publishMemoryWork(work,"A",captureWork(work),1500)).toThrow("STALE_MEMORY_SOURCE");
  // still leased to A: nobody can claim it before the lease expires
  expect(database().prepare("SELECT status,lease_owner,attempts FROM memory_jobs").get()).toMatchObject({status:"leased",lease_owner:"A",attempts:0});
  expect(claimMemoryJob("B",1600)).toBeNull();
  expect(requeueStaleMemoryWork(work,"A")).toBe(true);
  expect(database().prepare("SELECT status,lease_owner,lease_until,attempts FROM memory_jobs").get()).toMatchObject({status:"pending",lease_owner:null,lease_until:0,attempts:0});
  // the next claim runs it under the moved authority, with a newer generation
  const retry=claimMemoryJob("B",1600)!;
  expect(retry.id).toBe(work.id);
  expect(retry.leaseGeneration).toBeGreaterThan(work.leaseGeneration);
  expect(retry.policyRevision).toBe(work.policyRevision+1);
  // the old holder's late output is fenced, and it cannot release B's lease
  expect(()=>publishMemoryWork(work,"A",captureWork(work),1700)).toThrow("STALE_MEMORY_LEASE");
  expect(requeueStaleMemoryWork(work,"A")).toBe(false);
  expect(database().prepare("SELECT status,lease_owner FROM memory_jobs").get()).toMatchObject({status:"leased",lease_owner:"B"});
  publishMemoryWork(retry,"B",captureWork(retry),1700);
  expect(database().prepare("SELECT status,attempts FROM memory_jobs").get()).toMatchObject({status:"complete",attempts:0});
  expect(database().prepare("SELECT count(*) AS n FROM memory_records").get()?.n).toBe(1);
});
// RED2K: past the stale-requeue bound the controller defers the job with an
// attempt spent instead — the ordinary deferral row (backoff, attempt cap,
// reason), fenced to the holder's own live lease like the requeue.
it("defers a stale-refused job with one attempt spent, the ordinary backoff and the attempt cap, fenced to the holder's live lease",()=>{
  source();const first=claimMemoryJob("A",1000)!;
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  expect(()=>publishMemoryWork(first,"A",captureWork(first),1500)).toThrow("STALE_MEMORY_SOURCE");
  expect(deferStaleMemoryWork(first,"A","MEMORY_STALE_REQUEUE_LIMIT",1500)).toBe(true);
  // first attempt: 5 s backoff, the reason on the row, the lease released
  expect(database().prepare("SELECT status,attempts,retry_at,lease_owner,lease_until,error FROM memory_jobs").get()).toMatchObject({status:"deferred",attempts:1,retry_at:6500,lease_owner:null,lease_until:0,error:"MEMORY_STALE_REQUEUE_LIMIT"});
  // not before the backoff; a repeat by the old holder is fenced
  expect(claimMemoryJob("B",6000)).toBeNull();
  expect(deferStaleMemoryWork(first,"A","MEMORY_STALE_REQUEUE_LIMIT",6000)).toBe(false);
  const second=claimMemoryJob("B",6500)!;
  expect(second.id).toBe(first.id);
  expect(second.policyRevision).toBe(first.policyRevision+1);
  // the old holder cannot defer B's lease either
  expect(deferStaleMemoryWork(first,"A","MEMORY_STALE_REQUEUE_LIMIT",7000)).toBe(false);
  expect(database().prepare("SELECT status,lease_owner,attempts FROM memory_jobs").get()).toMatchObject({status:"leased",lease_owner:"B",attempts:1});
  // second attempt: 30 s backoff
  expect(deferStaleMemoryWork(second,"B","MEMORY_WORKER_TIMEOUT",7000)).toBe(true);
  expect(database().prepare("SELECT status,attempts,retry_at,error FROM memory_jobs").get()).toMatchObject({status:"deferred",attempts:2,retry_at:37000,error:"MEMORY_WORKER_TIMEOUT"});
  // third attempt: the cap ends it, with the reason on the row
  const third=claimMemoryJob("C",37000)!;
  expect(deferStaleMemoryWork(third,"C","MEMORY_STALE_REQUEUE_LIMIT",37500)).toBe(true);
  expect(database().prepare("SELECT status,attempts,error FROM memory_jobs").get()).toMatchObject({status:"failed",attempts:3,error:"MEMORY_STALE_REQUEUE_LIMIT"});
  expect(claimMemoryJob("D",90000)).toBeNull();
  expect(database().prepare("SELECT count(*) AS n FROM memory_records").get()?.n).toBe(0);
});
it("does not requeue a job a newer source revision cancelled under the lease",()=>{
  source();const work=claimMemoryJob("A",1000)!;
  appendMessage("thread",{id:"source",at:2,role:"user",kind:"text",text:"Durable evidence, revised"});
  expect(()=>publishMemoryWork(work,"A",captureWork(work),1500)).toThrow("STALE_MEMORY_LEASE");
  expect(requeueStaleMemoryWork(work,"A")).toBe(false);
  expect(database().prepare("SELECT status FROM memory_jobs WHERE id=?").get(work.id)).toMatchObject({status:"cancelled"});
  expect(database().prepare("SELECT status FROM memory_jobs WHERE id!=?").get(work.id)).toMatchObject({status:"pending"});
});
it("retains failed chunk progress and stops after the bounded retry allowance",()=>{
  source();let now=1000;
  for(let attempt=0;attempt<3;attempt++){
    const work=claimMemoryJob("A",now)!;
    publishMemoryWork(work,"A",{id:work.id,leaseGeneration:work.leaseGeneration,status:"deferred",nextCursor:work.cursor,chunks:[],reason:"provider-unavailable"},now);
    now+=31000;
  }
  expect(database().prepare("SELECT status,cursor,attempts FROM memory_jobs").get()).toMatchObject({status:"failed",cursor:0,attempts:3});
  expect(claimMemoryJob("A",now)).toBeNull();
});
it("distinguishes unavailable and malformed extraction from valid complete-empty",async()=>{
  const signal=new AbortController().signal;
  expect((await extractCandidates("source",null,signal)).status).toBe("deferred");
  expect((await extractCandidates("source",async()=>"invalid",signal)).status).toBe("deferred");
  expect((await extractCandidates("source",async()=>"[]",signal)).status).toBe("complete");
  expect((await extractCandidates("source",async()=>JSON.stringify([{text:"invented",quote:"not in source",startByte:0,endByte:6}]),signal)).status).toBe("deferred");
});
it("reserves cost durably and does not reset budget on database reopen",async()=>{
  const signal=new AbortController().signal;
  // Consume the daily budget through two admitted, sub-64KiB requests,
  // including the now-required conservative message framing reservation.
  const payload="x".repeat(50000-Buffer.byteLength(JSON.stringify(memoryExtractionMessages(""))));
  expect((await extractCandidates(payload,async()=>"[]",signal)).status).toBe("complete");
  expect((await extractCandidates(payload,async()=>"[]",signal)).status).toBe("complete");
  closeDatabase();let called=false;
  const result=await extractCandidates("more",async()=>{called=true;return "[]";},signal);
  expect(result).toMatchObject({status:"deferred",reason:"budget-exhausted"});expect(called).toBe(false);
});
it("runs and stops the real owned worker without exposing the database to its process",async()=>{
  source();const controller=new MemoryWorkerController();controller.start();
  try {
    const deadline=Date.now()+5000;
    while(Date.now()<deadline && database().prepare("SELECT status FROM memory_jobs").get()?.status!=="complete")await new Promise(r=>setTimeout(r,50));
    expect(database().prepare("SELECT status FROM memory_jobs").get()?.status).toBe("complete");
    expect(controller.error).toBeNull();
  } finally {await controller.stop();}
});
