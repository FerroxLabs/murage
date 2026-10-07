// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach,expect,it } from "vitest";
import { database,closeDatabase } from "../database.ts";
import { DATA_DIR } from "../config.ts";
import { mkdirSync,rmSync } from "node:fs";
import { captureMessage } from "./capture.ts";
import { isLearnableSource } from "./learnable.ts";
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
it.each(["attended","schedule","manual","webhook","channel","delegation","card","ask","message","room","unproven","unknown"] as const)("gates %s by its captured provenance",kind=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 captureMessage(db,"thread",{id:"m",at:1,role:"user",kind:"text",text:"I like tea",...(kind==="attended"?{origin:"desktop" as const}:kind==="unproven"?{origin:"unproven" as const}:kind==="unknown"?{}:{automation:{kind}})});
 db.exec("UPDATE memory_jobs SET status='complete',cursor=10");
 const row=db.prepare("SELECT payload FROM memory_source_versions").get()!;
 expect(JSON.parse(String(row.payload)).origin.kind).toBe(kind);
 expect(isLearnableSource(db,"message:thread:m",1).learnable).toBe(kind==="attended");
});

import {captureSource} from "./capture.ts";
import {backfillMemoryOrigins} from "./origin-backfill.ts";
import {updateMemoryLearning} from "./learning-policy.ts";
import {consolidateCompletedMemorySource,consolidateMemorySource} from "./consolidate.ts";
it.each(["owner","person:one","assistant","tool"])("checks every origin for speaker %s",speaker=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 for(const kind of ["attended","schedule","manual","webhook","channel","delegation","card","ask","message","room","unproven","unknown"]){
 captureSource(db,{id:kind,threadId:"t",kind:"text",speaker,outcome:"recorded",text:"tea",origin:{kind}});db.exec("UPDATE memory_jobs SET status='complete',cursor=3");
 expect(isLearnableSource(db,kind,1).learnable).toBe(speaker==="owner"&&kind==="attended");
 }
});
it("backfills only unanimous retained runs, never evicted history or mixed threads, without changing source hashes",()=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 for(const thread of ["schedule","mixed","evicted","deleted","delegation","card"])captureSource(db,{id:thread,threadId:thread,kind:"text",speaker:"owner",outcome:"recorded",text:"tea"});
 const before=db.prepare("SELECT * FROM memory_source_versions ORDER BY source_id").all();
 const runs=[{threadId:"schedule",triggerSource:"schedule" as const,manual:false,routineId:"deleted-definition"},{threadId:"mixed",triggerSource:"schedule" as const,manual:false,routineId:"r"},{threadId:"mixed",triggerSource:"channel" as const,manual:false,routineId:"r"}];
 backfillMemoryOrigins(db,runs);backfillMemoryOrigins(db,runs);
 expect(db.prepare("SELECT subject_id FROM memory_scope_bindings WHERE subject_type='source-origin'").all()).toEqual([{subject_id:"schedule"}]);expect(db.prepare("SELECT * FROM memory_source_versions ORDER BY source_id").all()).toEqual(before);
});
it("defers automation permanently before extraction and pauses bot chats only",async()=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 captureSource(db,{id:"s",threadId:"t",kind:"text",speaker:"owner",outcome:"recorded",text:"tea",origin:{kind:"schedule"}});db.exec("UPDATE memory_jobs SET status='complete',cursor=3");
 const job=String(db.prepare("SELECT id FROM memory_jobs").get()!.id);let calls=0;
 await consolidateCompletedMemorySource(job,async()=>{calls++;return "[]";},new AbortController().signal);
 expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_id LIKE 'consolidation%'").get()).toBeUndefined();
 expect(await consolidateMemorySource(job,async()=>{calls++;return "[]";},new AbortController().signal)).toMatchObject({status:"deferred",reason:"origin-schedule",retryAfter:null});expect(calls).toBe(0);
 db.exec(`UPDATE memory_source_versions SET payload='{"text":"tea","origin":{"kind":"attended"}}'`);updateMemoryLearning(db,{botsPaused:["bot"]},0);
 expect(isLearnableSource(db,"s",1,{roster:{bots:[{id:"bot",threadId:"t"}],groups:[]}})).toEqual({learnable:false,reason:"bot-paused"});
 expect(isLearnableSource(db,"s",1,{roster:{bots:[{id:"bot",threadId:"t"}],groups:[{id:"g",threadId:"t",memberIds:["bot"]}]}})).toEqual({learnable:true});
});

it("accepts only a currently owner-verified channel binding with channels enabled",()=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 captureSource(db,{id:"channel",threadId:"channel-t",kind:"text",speaker:"owner",outcome:"recorded",text:"tea",origin:{kind:"channel"}});db.exec("UPDATE memory_jobs SET status='complete',cursor=3");
 const scope=db.prepare("SELECT scope_id FROM memory_sources WHERE id='channel'").get()!.scope_id;
 const principal={personId:"workspace-owner",bindingId:"verified",revision:1};
 db.prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:channel-t',?,'human-thread','channel-t',1,'granted',?)").run(scope,JSON.stringify(principal));
 db.prepare("INSERT INTO memory_scope_bindings VALUES('verified',?,'human-binding','verified',1,'granted',?)").run(scope,JSON.stringify({id:"verified",personId:"workspace-owner",revision:1,active:true}));
 expect(isLearnableSource(db,"channel",1)).toEqual({learnable:true});
 updateMemoryLearning(db,{learnFrom:{chats:true,channels:false}},0);expect(isLearnableSource(db,"channel",1)).toEqual({learnable:false,reason:"channels-off"});
 db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='human-thread:channel-t'").run(JSON.stringify({...principal,personId:"contact"}));
 expect(isLearnableSource(db,"channel",1)).toEqual({learnable:false,reason:"not-owner-audience"});
});
it("rejects inactive, tombstoned, excluded and settlement sources",()=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 captureSource(db,{id:"s",threadId:"t",kind:"text",speaker:"owner",outcome:"recorded",text:"tea",origin:{kind:"attended"}});
 expect(isLearnableSource(db,"s",1)).toEqual({learnable:false,reason:"not-active"});
 db.exec("UPDATE memory_jobs SET status='complete',cursor=3;UPDATE memory_sources SET kind='turn'");expect(isLearnableSource(db,"s",1)).toEqual({learnable:false,reason:"settlement"});
 db.exec("UPDATE memory_sources SET kind='text';INSERT INTO memory_tombstones VALUES('t','source','s',1,NULL,1,'fixture',1)");expect(isLearnableSource(db,"s",1)).toEqual({learnable:false,reason:"tombstoned"});
 db.exec("DELETE FROM memory_tombstones");const scope=db.prepare("SELECT scope_id FROM memory_sources").get()!.scope_id;
 db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)").run(scope,JSON.stringify({excludedThreadIds:["t"]}));expect(isLearnableSource(db,"s",1)).toEqual({learnable:false,reason:"excluded-thread"});
});


import { createHash } from "node:crypto";
import { appendMessage,updateMessage } from "../message-db.ts";
import { CURRENT_MEMORY } from "./eligibility.ts";
it("keeps pre-v4 evidence and jobs unchanged when an old message is patched",()=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 const message={id:"old",at:1,role:"user" as const,kind:"text" as const,text:"tea",origin:"desktop" as const};
 appendMessage("thread",message);
 const row=db.prepare("SELECT * FROM memory_source_versions").get()!,payload=JSON.parse(String(row.payload));delete payload.origin;
 const encoded=JSON.stringify(payload),hash=createHash("sha256").update(encoded).digest("hex");
 db.prepare("UPDATE memory_source_versions SET payload=?,content_hash=?").run(encoded,hash);db.prepare("UPDATE memory_sources SET content_hash=?").run(hash);
 const scope=db.prepare("SELECT scope_id FROM memory_sources").get()!.scope_id;
 db.prepare("INSERT INTO memory_records VALUES('old-fact',1,?,'fact','tea','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
 db.exec("INSERT INTO memory_evidence VALUES('old-fact',1,'message:thread:old',1,0,3);UPDATE memory_jobs SET status='complete',cursor=3");
 const jobs=db.prepare("SELECT * FROM memory_jobs").all();updateMessage("thread",{...message,text:"tea"});
 expect(db.prepare("SELECT revision,content_hash FROM memory_sources").get()).toEqual({revision:1,content_hash:hash});
 expect(db.prepare("SELECT * FROM memory_jobs").all()).toEqual(jobs);
 expect(db.prepare(`SELECT r.id FROM memory_records r WHERE ${CURRENT_MEMORY}`).all()).toContainEqual({id:"old-fact"});
});
it("applies a bot pause to its project desk even when captured into a room scope",()=>{
 const db=database();db.exec("UPDATE memory_meta SET mode='active'");
 captureSource(db,{id:"desk",threadId:"desk-thread",kind:"text",speaker:"owner",outcome:"recorded",text:"tea",origin:{kind:"attended"}});
 db.exec("UPDATE memory_jobs SET status='complete',cursor=3;UPDATE memory_scopes SET kind='room',owner_key='project'");
 updateMemoryLearning(db,{botsPaused:["bot"]},0);
 const roster={bots:[{id:"bot",threadId:"home",tasks:[{threadId:"desk-thread",channelProjectDesk:{groupId:"project"}}]}],groups:[{id:"project",threadId:"room-thread",memberIds:["bot"],channelProject:{}}]};
 expect(isLearnableSource(db,"desk",1,{roster})).toEqual({learnable:false,reason:"bot-paused"});
});
