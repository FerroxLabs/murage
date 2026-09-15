import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { writeBotIdentity, readBotIdentity } from "./identity.ts";
import { captureBotReveals, pendingBotRevealJobs } from "./reveal-capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { forgetMemory } from "./forget.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import type { TextOnlyExtractor } from "./extract.ts";

const roster={bots:[{id:"moss",threadId:"private",tasks:[{threadId:"new-task"}]}],groups:[{id:"room",threadId:"room-thread",memberIds:["moss"]}]};
const ticket=ownerMemoryTicket(),text="Moss once tended a fictional lighthouse.",signal=()=>new AbortController().signal;
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);});
function canon(){return writeBotIdentity(ticket,{action:"identity-write",botId:"moss",kind:"character-canon",key:"lighthouse",expectedVersion:0,text,basis:"fiction",audience:"owner-private"},roster);}
function message(value=text,threadId="private",terminal=true){
  appendMessage(threadId,{id:"reply",at:1,role:"bot",kind:"text",text:value,turnId:"turn",turnTerminal:terminal});
  let work;while((work=claimMemoryJob("fixture")))publishMemoryWork(work,"fixture",captureWork(work));
  return String(database().prepare("SELECT id FROM memory_jobs WHERE source_id=?").get(`message:${threadId}:reply`)?.id??"");
}
const reveals=()=>readBotIdentity(ticket,"moss",roster).records.filter(row=>row.kind==="reveal-state");
function evaluator(supported:boolean){return Object.assign(vi.fn(async()=>"[]"),{ground:vi.fn(async()=>JSON.stringify({supported}))}) as TextOnlyExtractor;}
it("observes actual terminal text automatically and preserves canonical disclosure across restart and tasks",async()=>{
  const fact=canon(),job=message();
  expect(pendingBotRevealJobs()).toEqual([job]);
  expect(await captureBotReveals(job,()=>roster,null,signal())).toMatchObject({status:"partial",written:true});
  expect(reveals()[0].text).toContain(text);
  expect(database().prepare("SELECT source_id,start_byte,end_byte FROM memory_evidence WHERE record_id=?").all(reveals()[0].id)).toEqual([{source_id:"message:private:reply",start_byte:0,end_byte:Buffer.byteLength(text)}]);
  closeDatabase();
  await captureBotReveals(job,()=>roster,null,signal());
  const next=message(text,"new-task");await captureBotReveals(next,()=>roster,null,signal());
  expect(reveals()).toHaveLength(1);expect(reveals()[0].version).toBe(1);
  expect(database().prepare("SELECT parent_id,parent_version FROM memory_derivations WHERE child_id=?").get(reveals()[0].id)).toEqual({parent_id:fact.id,parent_version:1});
});
it("requires semantic grounding for paraphrases and refuses negation, quoted drafts and mere topics",async()=>{
  canon();const job=message("In my fictional past, I looked after a beacon by the sea.");
  expect(await captureBotReveals(job,()=>roster,null,signal())).toMatchObject({status:"deferred",reason:"grounding-unavailable"});
  expect(reveals()).toHaveLength(0);
  const extract=evaluator(true);await captureBotReveals(job,()=>roster,extract,signal());
  expect(extract.ground).toHaveBeenCalledWith(expect.objectContaining({purpose:"reveal",text,quote:"In my fictional past, I looked after a beacon by the sea."}),expect.any(Number),expect.any(AbortSignal));
  expect(reveals()).toHaveLength(1);
});
it.each(["I did not tend a lighthouse.",`Here is an unsent draft: ${text}`,"Perhaps I will tell you about the lighthouse later."])("does not label rejected semantic evidence as revealed: %s",async value=>{
  canon();await captureBotReveals(message(value),()=>roster,evaluator(false),signal());expect(reveals()).toHaveLength(0);
});
it("rejects streaming text, rooms, other principals and aliased threads before reading private canon",async()=>{
  canon();expect(message(text,"private",false)).toBe("");
  const roomJob=message(text,"room-thread"),extract=evaluator(true);
  await captureBotReveals(roomJob,()=>roster,extract,signal());expect(extract.ground).not.toHaveBeenCalled();
  const binding=observeVerifiedHuman({platform:"slack",connectionId:"test",authorityId:"workspace",userId:"other"});
  linkHumanBinding(ticket,{bindingId:binding,expectedRevision:1,as:"person"});bindHumanThread("new-task",resolveHumanBinding(binding));
  await captureBotReveals(message(text,"new-task"),()=>roster,extract,signal());expect(reveals()).toHaveLength(0);
});
it("fences source deletion during grounding and does not resurrect forgotten canon",async()=>{
  const fact=canon(),job=message("I watched the fictional light by the sea.");
  const extract=Object.assign(async()=>"[]",{ground:async()=>{forgetMemory(ticket,{kind:"record",id:fact.id});return '{"supported":true}';}}) as TextOnlyExtractor;
  await expect(captureBotReveals(job,()=>roster,extract,signal())).rejects.toThrow("MEMORY_REVEAL_REVOKED");
  expect(reveals()).toHaveLength(0);
});

it("keeps an explicit owner-authored unrevealed state authoritative after an observed disclosure",async()=>{
  const fact=canon();
  const manual=writeBotIdentity(ticket,{action:"identity-write",botId:"moss",kind:"reveal-state",key:"owner-choice",expectedVersion:0,text:"Keep this detail unrevealed in the continuity record.",basis:"fiction",audience:"owner-private",canon:{id:fact.id,version:fact.version},revealed:false},roster);
  const job=message();
  expect(await captureBotReveals(job,()=>roster,null,signal())).toMatchObject({status:"partial",written:false});
  expect(reveals()).toHaveLength(1);
  expect(reveals()[0]).toMatchObject({id:manual.id,version:1,text:manual.text});
  expect(JSON.parse(String(reveals()[0].text)).revealed).toBe(false);
  expect(database().prepare("SELECT version,assertion,state FROM memory_records WHERE id=?").all(manual.id)).toEqual([{version:1,assertion:"owner-statement",state:"active"}]);
});
it("rejects a direct thread aliased by two bots before invoking grounding",async()=>{
  canon();
  const aliased={...roster,bots:[...roster.bots,{id:"other",threadId:"private",tasks:[]}]};
  reconcileMemoryRoster(aliased);
  const job=message("I once watched a fictional beacon by the sea."),extract=evaluator(true);
  expect(await captureBotReveals(job,()=>aliased,extract,signal())).toMatchObject({status:"deferred",reason:"reveal-source-ineligible"});
  expect(extract.ground).not.toHaveBeenCalled();
  expect(reveals()).toHaveLength(0);
});
it("stages review-mode disclosure as a candidate without activating private continuity",async()=>{
  const fact=canon(),db=database();
  updateMemoryLearning(db,{reviewMode:true},readMemoryLearning(db).revision);
  expect(await captureBotReveals(message(),()=>roster,null,signal())).toMatchObject({status:"partial",written:true});
  expect(reveals()).toHaveLength(0);
  const rows=db.prepare("SELECT id,version,state,scope_id,text FROM memory_records WHERE kind='reveal-state'").all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({version:1,state:"candidate",scope_id:fact.scopeId});
  expect(JSON.parse(String(rows[0].text))).toMatchObject({canonId:fact.id,audience:"owner-private",revealed:true});
  expect(db.prepare("SELECT count(*) AS count FROM memory_records WHERE kind='reveal-state' AND state='active'").get()).toEqual({count:0});
  closeDatabase();
  expect(reveals()).toHaveLength(0);
  expect(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=1").get(rows[0].id)).toEqual({state:"candidate"});
});
