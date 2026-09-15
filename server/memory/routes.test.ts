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
import { captureSource } from "./capture.ts";
import type { TextOnlyExtractor } from "./extract.ts";
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

it("saves a typed grounded owner assertion without approval and replays the same result",async()=>{
  const f=fixture(),input={text:"Verified source note",evidence:f.evidence,idempotencyKey:"grounded",claimType:"owner-statement"};
  const result=await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge);
  expect(result).toMatchObject({state:"active",pendingReview:false});
  expect(await memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge)).toEqual(result);
});

it("stores bot-authored fiction only with grounded owner invitation and preserves both sources on replay",async()=>{
  const f=fixture(),text="In this fictional character, I grew up beside a lighthouse.";
  captureSource(database(),{id:"canon-source",threadId:"thread",kind:"text",speaker:"assistant",outcome:"recorded",text});
  const invitation="Please invent a fictional childhood for your character.";
  captureSource(database(),{id:"invitation",threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text:invitation});
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
  captureSource(database(),{id:"correction-source",threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text});
  const extractor:TextOnlyExtractor=async()=>"[]";
  extractor.ground=async input=>{expect(input.previousClaim).toBe("Verified source note");expect(input.quote).toBe(text);return '{"supported":true}';};
  const result=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:text,evidence:[{sourceId:"correction-source",revision:1,startByte:0,endByte:Buffer.byteLength(text)}],idempotencyKey:"same-subject"},f.context,f.bridge,undefined,extractor);
  expect(result).toMatchObject({state:"active",pendingReview:false});
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(f.recordId)?.state).toBe("superseded");
});
it("routes identity corrections to the dedicated identity write contract before creating proposals",async()=>{
  const f=fixture();database().prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id=?").run(f.recordId);
  await expect(memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.recordId,version:1,replacement:"Verified source note",evidence:f.evidence,idempotencyKey:"identity"},f.context,f.bridge)).rejects.toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='candidate'").get()?.n).toBe(0);
});
