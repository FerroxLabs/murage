import { mkdirSync,rmSync } from "node:fs";
import { beforeEach,expect,it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess,reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob,publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { memoryAgentRoute } from "./routes.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
function fixture(){
  const roster={bots:[{id:"bot",threadId:"thread"},{id:"other",threadId:"private"}],groups:[]};
  reconcileMemoryRoster(roster);setMemoryMode("capture");
  appendMessage("thread",{id:"m",at:1,role:"user",kind:"text",text:"Verified source note"});
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
