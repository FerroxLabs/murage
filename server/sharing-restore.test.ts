// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeTeamIdentityTables } from "./team-identities.ts";
import { repairRestoredSharing, validateSharingStructure, validateSharingPaused } from "./sharing-restore.ts";
it("restore isolates malformed markers, quarantines duplicate work, infers partitioning and pauses",()=>{
 const id="a1111111-1111-4111-8111-111111111111";
 const bots=[{id:"iris",sharedWith:{mode:"all",teams:[]},tasks:[{threadId:"one",sharedWork:{teamId:id,createdAt:1}},{threadId:"two",sharedWork:{teamId:id,createdAt:1}},{threadId:"three",sharedWork:{teamId:"../invalid",createdAt:1},channelProjectDesk:{groupId:"p"}}]}];
 const groups=[{id:"g",dm:true,memberIds:["iris"],dmAudience:{kind:"team",teamId:"bad"},partitionedFor:{iris:{kind:"team",teamId:"bad"}}}];
 const notes=repairRestoredSharing(bots,groups,10);expect(notes.length).toBeGreaterThan(0);
 expect(bots[0]).toMatchObject({partitionedAt:10});expect(bots[0].sharedWith).toBeUndefined();
 expect(bots[0].tasks[1].sharedWork).toMatchObject({quarantined:true,closedReason:"restored",closedAt:10});
 expect(groups[0].dmAudience).toEqual({kind:"isolated"});expect(groups[0].partitionedFor.iris).toEqual({kind:"isolated"});
 expect(()=>validateSharingStructure(bots,groups)).not.toThrow();expect(()=>validateSharingPaused(bots,groups)).not.toThrow();
});
it("ordinary boot accepts live sharing while paused validation refuses it",()=>{
 const bots=[{id:"iris",partitionedAt:1,sharedWith:{mode:"all",teams:[]},tasks:[]}];
 expect(()=>validateSharingStructure(bots,[])).not.toThrow();expect(()=>validateSharingPaused(bots,[])).toThrow("SHARING_NOT_PAUSED");
});
it("journal combinations are structural and paused checks reject open journals",()=>{
 const db=new DatabaseSync(":memory:");initializeTeamIdentityTables(db);
 db.prepare("INSERT INTO team_identities(team_id,label,created_at,updated_at,op) VALUES(?,?,1,1,'rename')").run("a1111111-1111-4111-8111-111111111111","Sales");
 expect(()=>validateSharingStructure([],[],db)).toThrow("INVALID_SHARING_STRUCTURE");
 db.exec("UPDATE team_identities SET op_phase=1,op_label='Revenue',op_records='{\"bots\":[],\"groups\":[]}'");
 expect(()=>validateSharingStructure([],[],db)).not.toThrow();expect(()=>validateSharingPaused([],[],db)).toThrow("SHARING_NOT_PAUSED");db.close();
});
it("a restored pair-room marker must name a live, non-pair room, or the pair room is isolated",()=>{
 const groups:Record<string,unknown>[]=[{id:"general",memberIds:["iris","sam"]},{id:"pair-a",dm:true,memberIds:["iris","sam"]},
  {id:"ok",dm:true,memberIds:["iris","sam"],dmAudience:{kind:"room",groupId:"general"}},
  {id:"gone",dm:true,memberIds:["iris","sam"],dmAudience:{kind:"room",groupId:"missing"}},
  {id:"pair",dm:true,memberIds:["iris","sam"],dmAudience:{kind:"project",groupId:"pair-a"}}];
 repairRestoredSharing([],groups,10);
 expect(groups.find(g=>g.id==="ok")!.dmAudience).toEqual({kind:"room",groupId:"general"});
 expect(groups.find(g=>g.id==="gone")!.dmAudience).toEqual({kind:"isolated"});
 expect(groups.find(g=>g.id==="pair")!.dmAudience).toEqual({kind:"isolated"});
});
