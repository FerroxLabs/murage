import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { buildMemoryBundleAfterReset, MemoryDispatchReceipt } from "./dispatch.ts";
import { forgetMemory } from "./forget.ts";
import { ownerMemoryTicket } from "./authority.ts";

const threadId="7f00a32e-17a4-426b-bdc6-910220ba66c9";
const roster={bots:[{id:"bot",threadId}],groups:[]};
const bridge={search:async()=>({hits:[],vectorRows:0})};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);setMemoryMode("capture");});
function fixture(){
  const registry=new InternalCapabilities(),generation=registry.begin("bot",threadId);
  const token=registry.mint({botId:"bot",threadId,generation,depth:0,kind:"memory",skillAuthoring:false});
  return {registry,access:memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster)};
}
function checkpoint(text:string){
  const sourceId=`message:${threadId}:${randomUUID()}`;
  captureSource(database(),{id:sourceId,threadId,messageId:randomUUID(),kind:"text",speaker:"owner",outcome:"recorded",text});
  const work=claimMemoryJob("dispatch-reset-fixture");
  if(!work)throw Error("No actual capture job");
  publishMemoryWork(work,"dispatch-reset-fixture",captureWork(work));
  const result=refreshMemoryCheckpoint(work.id);
  if(result.status!=="updated")throw Error("Expected actual checkpoint publication");
  return {sourceId,id:result.checkpointId,version:result.version};
}

it("reproduces the former failure when a selected checkpoint rolls over during reset",async()=>{
  const f=fixture(),first=checkpoint("Verified initial result.");
  const before=await buildMemoryBundle("result",f.access,bridge);
  expect(before.recordVersions).toContainEqual({id:first.id,version:first.version});
  await Promise.resolve().then(()=>checkpoint("Verified later result."));
  expect(()=>new MemoryDispatchReceipt(before,f.access,"fixture")).toThrow("MEMORY_RECORD_UNAVAILABLE");
});

it("builds after checkpoint rollover during reset and prepares the current version without a provider retry",async()=>{
  const f=fixture(),first=checkpoint("Verified initial result.");let resets=0;
  const bundle=await buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    resets++;await Promise.resolve();checkpoint("Verified later result.");
  });
  expect(resets).toBe(1);
  expect(bundle.recordVersions).toContainEqual({id:first.id,version:first.version+1});
  expect(bundle.recordVersions).not.toContainEqual({id:first.id,version:first.version});
  const receipt=new MemoryDispatchReceipt(bundle,f.access,"fixture");
  expect(()=>receipt.assertCurrent()).not.toThrow();
  expect(database().prepare("SELECT count(*) AS n FROM memory_disclosures").get()?.n).toBe(1);
});

it("retains original authority when the turn is revoked during session reset",async()=>{
  const f=fixture();checkpoint("Retain evidence.");
  await expect(buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    f.registry.revokeThread(threadId);
  })).rejects.toThrow("MEMORY_UNAUTHORIZED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_disclosures").get()?.n).toBe(0);
});

it("refuses forgotten evidence during reset through the original deletion epoch",async()=>{
  const f=fixture(),first=checkpoint("Forget this evidence.");
  await expect(buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    forgetMemory(ownerMemoryTicket(),{kind:"source",id:first.sourceId,revision:1});
  })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
});

it("never drops a mandatory pin whose supporting evidence retires during reset",async()=>{
  const f=fixture(),first=checkpoint("Mandatory backed-up constraint.");
  database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=?").run(first.id,first.version);
  await expect(buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(first.sourceId);
  })).rejects.toThrow("MEMORY_PIN_UNAVAILABLE");
});

it("uses post-reset bundle preparation in both real dispatch paths before receipt construction",()=>{
  const source=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
  const direct=source.slice(source.indexOf("      let memoryReceipt: MemoryDispatchReceipt | undefined;"),source.indexOf("      if (!markDirectTurnDispatching"));
  const roomStart=source.indexOf("  const prepareRoomMemory=async()=>{");
  const room=source.slice(roomStart,source.indexOf("  let providerTurnId",roomStart));
  expect(direct).toContain("bundle=await buildMemoryBundleAfterReset(query,access,memoryWorker");
  expect(room).toContain("const bundle=await buildMemoryBundleAfterReset(query,access,memoryWorker");
  for(const block of [direct,room]){
    const reset=block.indexOf("buildMemoryBundleAfterReset(");
    expect(reset).toBeGreaterThan(-1);
    expect(block.lastIndexOf("filterMemoryReplay(")).toBeGreaterThan(reset);
    expect(block.indexOf("new MemoryDispatchReceipt(")).toBeGreaterThan(reset);
  }
});
