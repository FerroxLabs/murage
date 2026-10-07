import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { writeBotIdentity, deleteBotIdentity, readBotIdentity, type IdentityWrite } from "./identity.ts";
import { buildMemoryBundle, assertMemoryBundle, hydrateMemoryRecord, MEMORY_FRAME_TOKENS } from "./bundle.ts";
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
  const second=writeBotIdentity(ticket,input({expectedVersion:1,expectedId:first.id,text:"Finish the fictional lighthouse story tomorrow."}),roster);
  expect(second).toMatchObject({id:first.id,version:2});
  // The brief is a PIP kind: an edit revokes the disclosures that carried it, and the prepared bundle's old version is gone.
  expect(()=>assertMemoryBundle(bundle,ctx)).toThrow(/MEMORY_CONTEXT_REVOKED|MEMORY_RECORD_UNAVAILABLE/);
  expect(()=>writeBotIdentity(ticket,input({expectedVersion:1,expectedId:first.id}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(database().prepare("SELECT version,state FROM memory_records WHERE id=? ORDER BY version").all(first.id)).toEqual([{version:1,state:"superseded"},{version:2,state:"active"}]);
});
it("does not resurrect a forgotten key even with the latest expected version",()=>{
  const first=writeBotIdentity(ticket,input(),roster);forgetMemory(ticket,{kind:"record",id:first.id});
  // The brief takes the next generation after a delete (like the relation), so a stale window is a version conflict.
  expect(()=>writeBotIdentity(ticket,input({expectedVersion:1}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
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
  expect(bundle.tokenCount-MEMORY_FRAME_TOKENS).toBeLessThanOrEqual(2048);
  expect(bundle.text).toContain("fictional character canon; not model autobiography or world truth");
  // The fixed frame is paid once above the share: a 12k context still carries
  // the pin and the brief within a tenth of it (1200), and so does an 8k one.
  const smaller=await buildMemoryBundle("",access(),bridge,{availableContextTokens:12000});
  expect(smaller.recordVersions).toEqual([{id:fact.id,version:1},{id:brief.id,version:1}]);
  expect(smaller.tokenCount-MEMORY_FRAME_TOKENS).toBeLessThanOrEqual(1200);
  expect((await buildMemoryBundle("",access(),bridge,{availableContextTokens:8192})).pinned.map(record=>record.id)).toEqual([fact.id]);
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
  // Owner-route correction maps the identity refusal to a plain sentence.
  await expect(memoryOwnerRoute("/api/memory/action",{action:"correct",id:saved.id,version:1,text:"New unbounded identity text"},ticket,roster)).rejects.toThrow("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
  await expect(memoryOwnerRoute("/api/memory/action",{action:"promote",id:saved.id,version:1,scopeId:saved.scopeId},ticket,roster)).rejects.toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
  expect(readBotIdentity(ticket,"moss",roster).records).toHaveLength(1);
  expect(readBotIdentity(ticket,"moss",roster).records[0]).toMatchObject({version:1,text:input().text});
});

// INT2 pass-3: a re-created relation is a new generation whose version restarts at 1; stale windows must conflict.
const rel=(patch:Partial<IdentityWrite>={})=>input({kind:"relation",key:"owner",basis:"owner-fact",text:"Short answers.",...patch});
const delRel=(expectedVersion:number,expectedId?:string)=>({action:"identity-delete" as const,botId:"moss",kind:"relation" as const,key:"owner",expectedVersion,...(expectedId?{expectedId}:{})});
it("fences relation writes and deletes by record id: a stale window cannot touch a re-created relation",()=>{
  const gen0=writeBotIdentity(ticket,rel(),roster);                       // window A sees gen0 v1
  deleteBotIdentity(ticket,delRel(1,gen0.id),roster);                      // window B deletes ...
  const gen1=writeBotIdentity(ticket,rel({text:"Fresh start."}),roster);   // ... and re-creates: gen1 v1
  expect(gen1.id).not.toBe(gen0.id);expect(gen1.version).toBe(1);
  expect(()=>writeBotIdentity(ticket,rel({expectedVersion:1,expectedId:gen0.id,text:"stale overwrite"}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(()=>deleteBotIdentity(ticket,delRel(1,gen0.id),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  // a relation edit that names a version but no id is not accepted either
  expect(()=>writeBotIdentity(ticket,rel({expectedVersion:1,text:"no id"}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(()=>deleteBotIdentity(ticket,delRel(1),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(readBotIdentity(ticket,"moss",roster).records.filter(r=>r.kind==="relation")).toMatchObject([{id:gen1.id,text:"Fresh start.",version:1}]);
  // the current generation edits and deletes normally
  expect(writeBotIdentity(ticket,rel({expectedVersion:1,expectedId:gen1.id,text:"Edited."}),roster).version).toBe(2);
  expect(deleteBotIdentity(ticket,delRel(2,gen1.id),roster)).toEqual({id:gen1.id,deleted:true});
});
it("fences brief writes and deletes by record id too: a stale window cannot touch a re-created brief",()=>{
  const del=(expectedVersion:number,expectedId?:string)=>({action:"identity-delete" as const,botId:"moss",kind:"continuity-brief" as const,key:"core",expectedVersion,...(expectedId?{expectedId}:{})});
  const gen0=writeBotIdentity(ticket,input(),roster);
  deleteBotIdentity(ticket,del(1,gen0.id),roster);
  const gen1=writeBotIdentity(ticket,input({text:"Fresh brief."}),roster);
  expect(gen1.id).not.toBe(gen0.id);expect(gen1.version).toBe(1);
  expect(()=>writeBotIdentity(ticket,input({expectedVersion:1,expectedId:gen0.id,text:"stale overwrite"}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(()=>deleteBotIdentity(ticket,del(1,gen0.id),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  // naming a version without an id is not accepted for a brief any more
  expect(()=>writeBotIdentity(ticket,input({expectedVersion:1,text:"no id"}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(()=>deleteBotIdentity(ticket,del(1),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(readBotIdentity(ticket,"moss",roster).records.filter(r=>r.kind==="continuity-brief")).toMatchObject([{id:gen1.id,text:"Fresh brief.",version:1}]);
  expect(writeBotIdentity(ticket,input({expectedVersion:1,expectedId:gen1.id,text:"Edited brief."}),roster).version).toBe(2);
  expect(deleteBotIdentity(ticket,del(2,gen1.id),roster)).toEqual({id:gen1.id,deleted:true});
});
it("commitments and traits keep working with or without an id; a wrong id still conflicts",()=>{
  const c=writeBotIdentity(ticket,input({kind:"commitment",key:"fridays",basis:"owner-fact",text:"Check in."}),roster);
  expect(writeBotIdentity(ticket,input({kind:"commitment",key:"fridays",basis:"owner-fact",expectedVersion:1,text:"Check in weekly."}),roster).version).toBe(2);
  expect(writeBotIdentity(ticket,input({kind:"commitment",key:"fridays",basis:"owner-fact",expectedVersion:2,expectedId:c.id,text:"Check in daily."}),roster).version).toBe(3);
  expect(()=>writeBotIdentity(ticket,input({kind:"commitment",key:"fridays",basis:"owner-fact",expectedVersion:3,expectedId:"identity:other",text:"x"}),roster)).toThrow("MEMORY_VERSION_CONFLICT");
  expect(deleteBotIdentity(ticket,{action:"identity-delete",botId:"moss",kind:"commitment",key:"fridays",expectedVersion:3},roster).deleted).toBe(true);
});
