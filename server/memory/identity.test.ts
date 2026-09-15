import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { writeBotIdentity, readBotIdentity, type IdentityWrite } from "./identity.ts";
import { buildMemoryBundle, assertMemoryBundle, hydrateMemoryRecord } from "./bundle.ts";
import { forgetMemory } from "./forget.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { personalityImprint } from "../../shared/bot-identity.ts";

const roster={bots:[{id:"moss",threadId:"private",tasks:[{threadId:"new-task"}]},{id:"neutral",threadId:"neutral-thread"}],groups:[{id:"room",threadId:"room-thread",memberIds:["moss","neutral"]}]};
const ticket=ownerMemoryTicket(),bridge={search:async()=>({hits:[],vectorRows:0})};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);});
function input(patch:Partial<IdentityWrite>={}):IdentityWrite{return {action:"identity-write",botId:"moss",kind:"continuity-brief",key:"core",expectedVersion:0,text:"Moss speaks gently; finish the lighthouse story.",basis:"fiction",audience:"owner-private",...patch};}
function access(botId="moss",threadId="private"){
  const registry=new InternalCapabilities(),generation=registry.begin(botId,threadId);
  const token=registry.mint({botId,threadId,generation,depth:0,kind:"memory",skillAuthoring:false});
  return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
}
function canon(){return writeBotIdentity(ticket,input({kind:"character-canon",key:"lighthouse",text:"Moss once tended a fictional lighthouse."}),roster);}

it("preserves exact personality whitespace and defaults blank personality independently of memory",()=>{
  expect(personalityImprint("  Speak gently.\n Keep the accent.  ")).toBe("  Speak gently.\n Keep the accent.  ");
  expect(personalityImprint(" \n")).toBe("Professional and Natural");expect(personalityImprint(undefined)).toBe("Professional and Natural");
});
it("requires owner authority and validates fictional canon, byte limits and fixed core key",()=>{
  expect(()=>writeBotIdentity({},input(),roster)).toThrow("MEMORY_OWNER_REQUIRED");
  expect(()=>writeBotIdentity(ticket,input({text:"é".repeat(385)}),roster)).toThrow("MEMORY_IDENTITY_TEXT_LIMIT");
  expect(()=>writeBotIdentity(ticket,input({key:"other"}),roster)).toThrow("MEMORY_IDENTITY_CORE_KEY_REQUIRED");
  expect(()=>writeBotIdentity(ticket,input({kind:"character-canon",basis:"owner-fact"}),roster)).toThrow("MEMORY_IDENTITY_FICTION_REQUIRED");
  expect(readBotIdentity(ticket,"moss",roster).records).toHaveLength(0);
});
it("versions atomically, fences stale writes, preserves prior versions and revokes prepared bundles",async()=>{
  const first=writeBotIdentity(ticket,input(),roster),ctx=access();
  const bundle=await buildMemoryBundle("",ctx,bridge);
  const second=writeBotIdentity(ticket,input({expectedVersion:1,text:"Finish the fictional lighthouse story tomorrow."}),roster);
  expect(second).toMatchObject({id:first.id,version:2});
  expect(()=>assertMemoryBundle(bundle,ctx)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(()=>writeBotIdentity(ticket,input({expectedVersion:1}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(database().prepare("SELECT version,state FROM memory_records WHERE id=? ORDER BY version").all(first.id)).toEqual([{version:1,state:"superseded"},{version:2,state:"active"}]);
});
it("does not resurrect a forgotten key even with the latest expected version",()=>{
  const first=writeBotIdentity(ticket,input(),roster);forgetMemory(ticket,{kind:"record",id:first.id});
  expect(()=>writeBotIdentity(ticket,input({expectedVersion:1}),roster)).toThrow("MEMORY_RECORD_UNAVAILABLE");
  expect(readBotIdentity(ticket,"moss",roster).records).toHaveLength(0);
});
it("retains brief across database restart and new task while excluding other bots and rooms",async()=>{
  const first=writeBotIdentity(ticket,input(),roster);closeDatabase();
  expect(readBotIdentity(ticket,"moss",roster).records[0]).toMatchObject({id:first.id,version:1});
  expect((await buildMemoryBundle("",access("moss","new-task"),bridge)).identity[0].id).toBe(first.id);
  expect((await buildMemoryBundle("",access("neutral","neutral-thread"),bridge)).text).not.toContain("lighthouse");
  expect((await buildMemoryBundle("",access("moss","room-thread"),bridge)).text).not.toContain("lighthouse");
  expect(()=>hydrateMemoryRecord(first.id,1,access("moss","room-thread"))).toThrow("MEMORY_SCOPE_DENIED");
});
it("prioritizes compact continuity after owner pins within the existing total bound",async()=>{
  const brief=writeBotIdentity(ticket,input(),roster),fact=canon();
  database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(fact.id);
  const bundle=await buildMemoryBundle("",access(),bridge);
  expect(bundle.recordVersions).toEqual([{id:fact.id,version:1},{id:brief.id,version:1}]);
  expect(bundle.tokenCount).toBeLessThanOrEqual(2048);
  expect(bundle.text).toContain("fictional character canon; not model autobiography or world truth");
  expect((await buildMemoryBundle("",access(),bridge,{availableContextTokens:12000})).tokenCount).toBeLessThanOrEqual(1200);
});
it("persists canonical audience reveal state, deduplicates event keys, and forgets derived reveals with canon",async()=>{
  const fact=canon();
  const reveal=input({kind:"reveal-state",key:"event-one",text:"The owner has heard the lighthouse story.",canon:{id:fact.id,version:1},revealed:true});
  const first=writeBotIdentity(ticket,reveal,roster);
  const updated=writeBotIdentity(ticket,{...reveal,key:"event-two",expectedVersion:1,text:"The owner has also heard the ending."},roster);
  expect(updated).toMatchObject({id:first.id,version:2});closeDatabase();
  const bundle=await buildMemoryBundle("",access("moss","new-task"),bridge);
  expect(bundle.text).toContain("owner-private");expect(bundle.text).toContain("ending");
  expect(readBotIdentity(ticket,"moss",roster).records.filter(row=>row.kind==="reveal-state")).toHaveLength(1);
  forgetMemory(ticket,{kind:"record",id:fact.id});
  expect(readBotIdentity(ticket,"moss",roster).records).toHaveLength(0);
});
it("provides strict owner-only write/read routes",async()=>{
  const saved=await memoryOwnerRoute("/api/memory/action",input(),ticket,roster);
  expect(saved).toMatchObject({version:1});
  expect(await memoryOwnerRoute("/api/memory/action",{action:"identity-read",botId:"moss"},ticket,roster)).toMatchObject({records:[{version:1}]});
  await expect(memoryOwnerRoute("/api/memory/action",{...input(),audience:"room"},ticket,roster)).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
  await expect(memoryOwnerRoute("/api/memory/action",{action:"identity-read",botId:"moss"},{},roster)).rejects.toThrow("MEMORY_OWNER_REQUIRED");
});

it("prevents generic correction and promotion from bypassing identity bounds or private canon",async()=>{
  const saved=writeBotIdentity(ticket,input(),roster);
  for(const action of [
    {action:"correct",id:saved.id,version:1,text:"New unbounded identity text"},
    {action:"promote",id:saved.id,version:1,scopeId:saved.scopeId},
  ])await expect(memoryOwnerRoute("/api/memory/action",action,ticket,roster)).rejects.toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
  expect(readBotIdentity(ticket,"moss",roster).records).toHaveLength(1);
  expect(readBotIdentity(ticket,"moss",roster).records[0]).toMatchObject({version:1,text:input().text});
});
