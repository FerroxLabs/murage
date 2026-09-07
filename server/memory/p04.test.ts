import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, heartbeatMemoryJob, publishMemoryWork } from "./jobs.ts";
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
