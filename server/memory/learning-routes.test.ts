// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach,expect,it } from "vitest";
import { z } from "zod";
import { mkdirSync,rmSync } from "node:fs";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute,memoryOwnerStatus } from "./settings.ts";
const roster={bots:[{id:"bot",threadId:"thread"}],groups:[]};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
it("serves v2 status without a monetary field and revision checks bot switches",async()=>{
 const ticket=ownerMemoryTicket(),status=memoryOwnerStatus(ticket,roster);
 expect(status.learning.settings.version).toBe(2);expect(status).not.toHaveProperty("cost");
 await memoryOwnerRoute("/api/memory/action",{action:"learning-bot",botId:"bot",enabled:false,learningRevision:0},ticket,roster);
 expect(memoryOwnerStatus(ticket,roster).learning.settings.botsPaused).toEqual(["bot"]);
 await expect(memoryOwnerRoute("/api/memory/action",{action:"configure",learning:{dailyCostUsd:5},learningRevision:1},ticket,roster)).rejects.toMatchObject({status:400});
 expect(database().prepare("SELECT revision FROM memory_learning_config").get()?.revision).toBe(1);
});

import {claimMemoryJob,publishMemoryWork} from "./jobs.ts";
import {captureWork} from "./chunks.ts";
import {captureSource} from "./capture.ts";
import {activateGroundedMemory} from "./automatic-learning.ts";
import {recordLearningEvent} from "./learning-ledger.ts";
import {transaction} from "../database.ts";
import {forgetMemory} from "./forget.ts";
function learned(){
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");captureSource(db,{id:"source",threadId:"thread",messageId:"m",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text:"tea"});
 const work=claimMemoryJob("fixture")!;publishMemoryWork(work,"fixture",captureWork(work));
 const scope=String(db.prepare("SELECT scope_id FROM memory_sources WHERE id='source'").get()!.scope_id);
 db.prepare("INSERT INTO memory_records VALUES('fact',1,?,'fact','tea','assistant-inference','candidate',0,1,NULL,NULL,1)").run(scope);db.exec("INSERT INTO memory_evidence VALUES('fact',1,'source',1,0,3)");transaction(()=>activateGroundedMemory(db,"fact","owner-statement"));
 const event=String(db.prepare("SELECT id FROM memory_learning_events").get()!.id);return {db,scope,event};
}
it("keeps and undoes activation idempotently, and purges forgotten history",async()=>{
 const f=learned(),ticket=ownerMemoryTicket();
 const act=(action:string,eventId=f.event)=>memoryOwnerRoute("/api/memory/action",{action,eventId},ticket,roster);
 expect(await act("learning-keep")).toMatchObject({kept:true});expect(await act("learning-keep")).toMatchObject({kept:true});
 expect(f.db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id='fact'").get()?.confidence_basis).toBe("owner_confirmed");
 expect(await act("learning-undo")).toEqual(await act("learning-undo"));
 expect(f.db.prepare("SELECT state FROM memory_records WHERE id='fact'").get()?.state).toBe("archived");
 expect(f.db.prepare("SELECT count(*) n FROM memory_learning_events WHERE kind='owner-undo'").get()?.n).toBe(1);
 forgetMemory(ticket,{kind:"source",id:"source"});
 expect(await memoryOwnerRoute("/api/memory/action",{action:"learning-history"},ticket,roster)).toMatchObject({events:[]});
});
it("undoes supersede in one transaction and refuses changed versions",async()=>{
 const f=learned(),ticket=ownerMemoryTicket();f.db.exec("UPDATE memory_records SET state='superseded' WHERE id='fact'");
 f.db.prepare("INSERT INTO memory_records VALUES('new',1,?,'fact','coffee','owner-statement','active',0,2,NULL,'fact',2)").run(f.scope);
 const event=recordLearningEvent(f.db,{kind:"superseded",scopeId:f.scope,recordId:"new",recordVersion:1,priorId:"fact",priorVersion:1,sourceId:"source",sourceRevision:1});
 await memoryOwnerRoute("/api/memory/action",{action:"learning-undo",eventId:event},ticket,roster);
 expect(f.db.prepare("SELECT id,state FROM memory_records WHERE id IN ('fact','new') ORDER BY id").all()).toEqual([{id:"fact",state:"active"},{id:"new",state:"archived"}]);
 f.db.prepare("INSERT INTO memory_records VALUES('fact',2,?,'fact','changed','owner-statement','active',0,3,NULL,NULL,3)").run(f.scope);
 await expect(memoryOwnerRoute("/api/memory/action",{action:"learning-undo",eventId:f.event},ticket,roster)).rejects.toMatchObject({status:409});
});
it("pages history without duplicates and filters by bot",async()=>{
 const f=learned(),ticket=ownerMemoryTicket();
 f.db.prepare("UPDATE memory_learning_events SET bot_id='bot' WHERE id=?").run(f.event);
 recordLearningEvent(f.db,{kind:"owner-keep",scopeId:f.scope,recordId:"fact",recordVersion:1,botId:"other"});
 const page=z.object({events:z.array(z.object({id:z.string()})),nextCursor:z.string().nullable()});
 const first=page.parse(await memoryOwnerRoute("/api/memory/action",{action:"learning-history",limit:1},ticket,roster));
 expect(first.nextCursor).toEqual(expect.any(String));
 const next=page.parse(await memoryOwnerRoute("/api/memory/action",{action:"learning-history",cursor:first.nextCursor,limit:1},ticket,roster));
 expect(next.events[0].id).not.toBe(first.events[0].id);
 expect(await memoryOwnerRoute("/api/memory/action",{action:"learning-history",botId:"bot"},ticket,roster)).toMatchObject({events:[{id:f.event}]});
});


it("requires the bot switch revision and refuses stale writes",async()=>{
 const ticket=ownerMemoryTicket();
 await expect(memoryOwnerRoute("/api/memory/action",{action:"learning-bot",botId:"bot",enabled:false},ticket,roster)).rejects.toMatchObject({status:400});
 await memoryOwnerRoute("/api/memory/action",{action:"learning-bot",botId:"bot",enabled:false,learningRevision:0},ticket,roster);
 await expect(memoryOwnerRoute("/api/memory/action",{action:"learning-bot",botId:"bot",enabled:true,learningRevision:0},ticket,roster)).rejects.toMatchObject({status:409});
});
it("keeps paging position after the boundary event is forgotten and uses plain scope labels",async()=>{
 const f=learned(),ticket=ownerMemoryTicket();
 f.db.prepare("UPDATE memory_scopes SET kind='workspace',owner_key='installation-uuid' WHERE id=?").run(f.scope);
 const second=recordLearningEvent(f.db,{kind:"owner-keep",scopeId:f.scope,recordId:"fact",recordVersion:1});f.db.prepare("UPDATE memory_learning_events SET created_at=100 WHERE id=?").run(f.event);f.db.prepare("UPDATE memory_learning_events SET created_at=200 WHERE id=?").run(second);
 const newest=recordLearningEvent(f.db,{kind:"owner-keep",scopeId:f.scope,recordId:"fact",recordVersion:1});f.db.prepare("UPDATE memory_learning_events SET created_at=300 WHERE id=?").run(newest);
 const page=z.object({events:z.array(z.object({id:z.string(),scopeLabel:z.string()})),nextCursor:z.string().nullable()});
 const first=page.parse(await memoryOwnerRoute("/api/memory/action",{action:"learning-history",limit:2},ticket,roster));expect(first.events[0].scopeLabel).toBe("Workspace");
 f.db.prepare("DELETE FROM memory_learning_events WHERE id=?").run(second);
 const next=page.parse(await memoryOwnerRoute("/api/memory/action",{action:"learning-history",limit:1,cursor:first.nextCursor},ticket,roster));expect(next.events.map(e=>e.id)).toEqual([f.event]);
 await expect(memoryOwnerRoute("/api/memory/action",{action:"learning-history",cursor:"garbage"},ticket,roster)).rejects.toMatchObject({status:400});
});
it("undoes an old duplicate Learned item by restoring its linked prior",async()=>{
 const f=learned(),ticket=ownerMemoryTicket();f.db.exec("UPDATE memory_records SET state='superseded' WHERE id='fact'");
 f.db.prepare("INSERT INTO memory_records VALUES('new',1,?,'fact','coffee','owner-statement','active',0,2,NULL,'fact',2)").run(f.scope);f.db.exec("INSERT INTO memory_derivations VALUES('fact',1,'new',1)");
 const event=recordLearningEvent(f.db,{kind:"activated",scopeId:f.scope,recordId:"new",recordVersion:1});
 const updated=recordLearningEvent(f.db,{kind:"superseded",scopeId:f.scope,recordId:"new",recordVersion:1,priorId:"fact",priorVersion:1});
 await memoryOwnerRoute("/api/memory/action",{action:"learning-undo",eventId:event},ticket,roster);
 expect(f.db.prepare("SELECT state FROM memory_records WHERE id='fact'").get()?.state).toBe("active");
 expect(await memoryOwnerRoute("/api/memory/action",{action:"learning-undo",eventId:updated},ticket,roster)).toMatchObject({undone:true});
});

// owner_key stores the bare bot id, not the bot: scope prefix.
it("uses a bot and team name instead of a composite scope key",async()=>{
 const f=learned();f.db.prepare("UPDATE memory_scopes SET kind='bot',owner_key='bot#team:Design' WHERE id=?").run(f.scope);
 expect(await memoryOwnerRoute("/api/memory/action",{action:"learning-history"},ownerMemoryTicket(),{bots:[{id:"bot",name:"Ember",threadId:"thread"}],groups:[]})).toMatchObject({events:[{scopeLabel:"Ember for Design"}]});
});

it.each(["team","project","room"])("labels composite %s history with bot and destination names",async kind=>{
 const f=learned();f.db.prepare("UPDATE memory_scopes SET kind='bot',owner_key=? WHERE id=?").run(`bot#${kind}:${kind==="team"?"Design":"group"}`,f.scope);
 const roster={bots:[{id:"bot",threadId:"thread",name:"Ember"}],groups:[{id:"group",threadId:"room-thread",name:"Launch",memberIds:[]}]};
 expect(await memoryOwnerRoute("/api/memory/action",{action:"learning-history"},ownerMemoryTicket(),roster)).toMatchObject({events:[{scopeLabel:`Ember for ${kind==="team"?"Design":"Launch"}`}]});
});

it("serves candidate review reasons in the owner list and inspection",async()=>{
 const f=learned(),ticket=ownerMemoryTicket();f.db.exec("UPDATE memory_records SET state='candidate' WHERE id='fact';UPDATE memory_record_details SET confidence_basis='needs-owner-approval' WHERE record_id='fact'");
 for(const action of [{action:"list",state:"candidate"},{action:"inspect",id:"fact",version:1}]){
  const result=await memoryOwnerRoute("/api/memory/action",action,ticket,roster);
  expect(JSON.stringify(result)).toContain("This memory needs you before it is used.");
 }
});
