import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt, memoryContinuationChanged } from "./dispatch.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
async function fixture(){
  const roster={bots:[{id:"bot",threadId:"thread"}],groups:[]};reconcileMemoryRoster(roster);
  const registry=new InternalCapabilities(),generation=registry.begin("bot","thread");
  const token=registry.mint({botId:"bot",threadId:"thread",generation,depth:10,kind:"memory",skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const bundle=await buildMemoryBundle("query",access,{search:async()=>({hits:[],vectorRows:0})});
  return {registry,generation,receipt:new MemoryDispatchReceipt(bundle,access,"driver")};
}
it("finishes a synchronous successful turn before capability revocation without rejecting its later handshake",async()=>{
  const {registry,generation,receipt}=await fixture();
  receipt.assertCurrent();receipt.sessionStarted("native");receipt.completed(true);
  registry.completeProviderTurn("thread","turn");
  expect(registry.bindProviderTurn("thread",generation,"turn")).toBe(false);
  expect(()=>receipt.accepted()).not.toThrow();
  expect(database().prepare("SELECT state,native_session FROM memory_disclosures").get()).toEqual({state:"delivered",native_session:"native"});
  expect(memoryContinuationChanged(receipt.bundle,"thread","driver","native")).toBe(false);
  expect(memoryContinuationChanged({...receipt.bundle,recordVersions:[{id:"new-record",version:1}]},"thread","driver","native")).toBe(true);
});
it("does not claim delivery from a failed setup terminal without observed output",async()=>{
  const {registry,receipt}=await fixture();receipt.completed(false);registry.revokeThread("thread");
  expect(database().prepare("SELECT state FROM memory_disclosures").get()?.state).toBe("prepared");
  expect(()=>receipt.accepted()).toThrow("MEMORY_UNAUTHORIZED");
});
