import { mkdirSync,rmSync } from "node:fs";
import { beforeEach,expect,it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase,database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope,memoryAccess,reconcileMemoryRoster,assertMemoryAccess } from "./policy.ts";
import { searchMemory } from "./search.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { materializeRecentMemory } from "./recent.ts";
import { claimMemoryJob,publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
const roster=()=>({bots:[{id:"a",threadId:"new",tasks:[{threadId:"new"},{threadId:"old"}]},{id:"b",threadId:"other"}],groups:[{id:"room",threadId:"shared",memberIds:["a","b"]}]});
function context(r=roster(),thread="new"){
  reconcileMemoryRoster(r);const registry=new InternalCapabilities();const generation=registry.begin("a",thread);
  const token=registry.mint({botId:"a",threadId:thread,generation,depth:0,kind:"memory",skillAuthoring:false});
  return {access:memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>r),registry};
}
const empty={search:async()=>({hits:[],vectorRows:0,degradedReason:"keyword-only"})};
it("recalls a captured preference from the bot's previous task before worker indexing",async()=>{
  const {access}=context();appendMessage("old",{id:"preference",at:123,role:"user",kind:"text",text:"My report colour is charcoal."});
  expect(database().prepare("SELECT count(*) n FROM memory_records").get()?.n).toBe(0);
  const result=await searchMemory("report colour",access,empty);
  expect(result.hits.some(hit=>hit.text.includes("charcoal"))).toBe(true);expect(result.recentFallback).toBe(true);
  expect(result.hits.flatMap(hit=>hit.evidence).some(e=>e.occurredAt===123)).toBe(true);
  expect((await buildMemoryBundle("report colour",access,empty)).text).toContain("charcoal");
  const before=database().prepare("SELECT count(*) n FROM memory_records").get()?.n;
  await searchMemory("report colour",access,empty);
  expect(database().prepare("SELECT count(*) n FROM memory_records").get()?.n).toBe(before);
});
it("does not grant another bot the private prior-task history, in a shared room either",async()=>{
  const r=roster(),{access}=context(r);appendMessage("old",{id:"private",at:1,role:"user",kind:"text",text:"PRIVATE_PAST_CANARY report"});
  await searchMemory("report",access,empty);
  // 0.1.61 lane M recall both ways: in an owner room the bot recalls its own
  // prior task, its teammate never does
  const room=context(r,"shared").access;
  expect(()=>assertMemoryAccess(room,ensureScope("conversation","old"))).not.toThrow();
  reconcileMemoryRoster(r);const registry=new InternalCapabilities(),generation=registry.begin("b","shared");
  const teammate=memoryAccess(registry,registry.resolve(`Bearer ${registry.mint({botId:"b",threadId:"shared",generation,depth:0,kind:"memory",skillAuthoring:false})}`)!,()=>r);
  expect((await searchMemory("PRIVATE_PAST_CANARY report",teammate,empty)).hits).toEqual([]);
  expect(()=>assertMemoryAccess(teammate,ensureScope("conversation","old"))).toThrow("MEMORY_SCOPE_DENIED");
  expect(()=>assertMemoryAccess(access,ensureScope("conversation","other"))).toThrow("MEMORY_SCOPE_DENIED");
});
it("does not infer grants for aliased or excluded old tasks",()=>{
  const r=roster();r.bots[1].tasks=[{threadId:"old"}];const {access}=context(r);
  expect(()=>assertMemoryAccess(access,ensureScope("conversation","old"))).toThrow("MEMORY_SCOPE_DENIED");
  const clean=context();const scope=ensureScope("workspace","settings");
  database().prepare("INSERT INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)")
    .run(scope,JSON.stringify({excludedThreadIds:["old"]}));
  expect(()=>assertMemoryAccess(clean.access,ensureScope("conversation","old"))).toThrow("MEMORY_SCOPE_DENIED");
});
it("returns bounded recent evidence with explicit degradation when the worker is unavailable",async()=>{
  const {access}=context();appendMessage("old",{id:"fresh",at:321,role:"user",kind:"text",text:"The launch deadline is Friday."});
  const result=await searchMemory("launch deadline",access,{search:async()=>{throw new Error("worker offline");}});
  expect(result.degradedReason).toBe("MEMORY_RECALL_UNAVAILABLE");expect(result.coverageComplete).toBe(false);
  expect(result.hits.some(hit=>hit.text.includes("Friday"))).toBe(true);
  expect((await searchMemory("unrelated_opaque_id",access,empty)).hits).toEqual([]);
});
it("does not steal a live worker lease and keeps per-request catch-up bounded",()=>{
  const {access}=context();appendMessage("old",{id:"leased",at:1,role:"user",kind:"text",text:"A retained source"});
  const leased=claimMemoryJob("worker")!;
  expect(materializeRecentMemory(access)).toBe(0);
  publishMemoryWork(leased,"worker",captureWork(leased));
  // One linear chain (each message parented on the previous leaf): a message with another parent is a branch change that retires the earlier sources, and their jobs are parked, not pending.
  for(let i=0;i<5;i++)appendMessage("old",{id:`queued-${i}`,parentId:i?`queued-${i-1}`:"leased",at:i+2,role:"user",kind:"text",text:`Queued source ${i}`});
  expect(materializeRecentMemory(access)).toBeLessThanOrEqual(2);
  expect(Number(database().prepare("SELECT count(*) n FROM memory_jobs WHERE status='pending'").get()?.n)).toBeGreaterThanOrEqual(3);
});
it("an ordinary append keeps its predecessors' jobs pending and only a branch change parks the retired ones",()=>{
  context();const rows=()=>database().prepare("SELECT source_id,status,error FROM memory_jobs ORDER BY rowid").all().map(r=>`${r.source_id}|${r.status}|${r.error??""}`);
  appendMessage("old",{id:"m0",at:1,role:"user",kind:"text",text:"First"});
  appendMessage("old",{id:"m1",parentId:"m0",at:2,role:"user",kind:"text",text:"Second"});
  expect(rows()).toEqual(["message:old:m0|pending|","message:old:m1|pending|"]);
  // m2 has no parent while the leaf is m1: a branch change, m0 and m1 are retired and their jobs parked with a reopen marker
  appendMessage("old",{id:"m2",at:3,role:"user",kind:"text",text:"Fork"});
  expect(rows()).toEqual(["message:old:m0|cancelled|parked:v1:{\"s\":\"pending\",\"e\":null}","message:old:m1|cancelled|parked:v1:{\"s\":\"pending\",\"e\":null}","message:old:m2|pending|"]);
});
it("revocation during worker await cannot disclose the recent fallback",async()=>{
  const {access,registry}=context();appendMessage("old",{id:"secret",at:1,role:"user",kind:"text",text:"Fresh private report"});
  await expect(searchMemory("private report",access,{search:async()=>{registry.revokeThread("new");return {hits:[],vectorRows:0};}})).rejects.toThrow("MEMORY_UNAUTHORIZED");
});
