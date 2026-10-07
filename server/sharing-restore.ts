// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { parseTeamOpRecords } from "./team-identities.ts";
type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>!!v&&typeof v==="object"&&!Array.isArray(v);
const uuid=(v:unknown)=>typeof v==="string"&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v);
const id=(v:unknown)=>typeof v==="string"&&/^[\w-]+$/.test(v);
const time=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>=0;
function marker(v:unknown,dm:boolean){return object(v)&&(v.kind==="isolated"||v.kind==="team"&&uuid(v.teamId)||dm&&(v.kind==="project"||v.kind==="room")&&id(v.groupId)||!dm&&v.kind==="room");}
function rows(v:unknown):RecordValue[]{return Array.isArray(v)?v.filter(object):[];}
export function inferSharingPartitions(bots:RecordValue[],groups:RecordValue[],now:number):string[]{
 const notes:string[]=[];for(const bot of bots)if(bot.partitionedAt===undefined&&(rows(bot.tasks).some(t=>t.sharedWork!==undefined)||groups.some(g=>object(g.partitionedFor)&&Object.hasOwn(g.partitionedFor,String(bot.id))||g.dmAudience!==undefined&&Array.isArray(g.memberIds)&&g.memberIds.includes(bot.id)))){bot.partitionedAt=now;notes.push(`Inferred partitioning for ${String(bot.id)} from preserved work markers.`);}return notes;
}
export function repairRestoredSharing(bots:RecordValue[],groups:RecordValue[],now:number):string[]{
 const notes:string[]=[];
 const liveRoom=(v:unknown)=>!object(v)||v.kind!=="project"&&v.kind!=="room"||groups.some(g=>g.id===v.groupId&&g.dm!==true);
 for(const group of groups){if(group.dmAudience!==undefined&&(!marker(group.dmAudience,true)||!liveRoom(group.dmAudience))){group.dmAudience={kind:"isolated"};notes.push(`Isolated pair room ${String(group.id)}.`);}
  if(group.partitionedFor!==undefined){if(!object(group.partitionedFor)){group.partitionedFor=Object.fromEntries((Array.isArray(group.memberIds)?group.memberIds:[]).map(id=>[id,{kind:"isolated"}]));notes.push(`Isolated invalid room markers for ${String(group.id)}.`);}else for(const [bot,value] of Object.entries(group.partitionedFor))if(!marker(value,false)||!id(bot)){if(id(bot))group.partitionedFor[bot]={kind:"isolated"};else {delete group.partitionedFor[bot];for(const member of Array.isArray(group.memberIds)?group.memberIds:[])if(id(member))group.partitionedFor[String(member)]={kind:"isolated"};}notes.push(`Isolated room marker ${String(group.id)} for ${bot}.`);}}
 }
 for(const bot of bots){if(bot.sharedWith!==undefined){delete bot.sharedWith;notes.push("Bots shared with other teams were reset to their own team.");}
  const seen=new Set<string>();for(const task of rows(bot.tasks)){if(task.sharedWork===undefined)continue;
   const work=object(task.sharedWork)?task.sharedWork:{teamId:"invalid",createdAt:now};
   const invalid=!uuid(work.teamId)||seen.has(String(work.teamId))||task.channelProjectDesk!==undefined||!time(work.createdAt);
   if(invalid||work.quarantined===true){work.quarantined=true;notes.push(`Quarantined work conversation ${String(task.threadId)}.`);}else seen.add(String(work.teamId));
   if(typeof work.teamId!=="string")work.teamId="invalid";if(!time(work.createdAt))work.createdAt=now;
   work.closedAt=now;work.closedReason="restored";delete work.finishing;delete work.finishRequestId;task.sharedWork=work;
  }
 }
 notes.push(...inferSharingPartitions(bots,groups,now));return notes;
}
export function validateSharingStructure(bots:RecordValue[],groups:RecordValue[],db?:DatabaseSync):void {
 const fail=()=>{throw new Error("INVALID_SHARING_STRUCTURE");};
 for(const bot of bots){if(bot.partitionedAt!==undefined&&!time(bot.partitionedAt))fail();
  if(bot.sharedWith!==undefined){const s=bot.sharedWith;if(!object(s)||!["none","all","list"].includes(String(s.mode))||!Array.isArray(s.teams)||s.teams.some(t=>!object(t)||!uuid(t.id)||typeof t.name!=="string")||new Set(s.teams.map(t=>(t as RecordValue).id)).size!==s.teams.length)fail();}
  const seen=new Set<string>();for(const task of rows(bot.tasks)){if(task.sharedWork===undefined)continue;const w=task.sharedWork;
   if(!object(w))return fail();if(!time(w.createdAt)||w.closedAt!==undefined&&!time(w.closedAt)||w.closedReason!==undefined&&!["revoked","team-deleted","restored"].includes(String(w.closedReason)))fail();
   if(w.quarantined===true){if(typeof w.teamId!=="string"||w.closedAt===undefined)fail();}else{if(!uuid(w.teamId)||seen.has(String(w.teamId))||task.channelProjectDesk!==undefined)fail();seen.add(String(w.teamId));}
   if(w.finishing!==undefined){if(!object(w.finishing)||!w.finishing.requestId&&!w.finishing.generation||Object.entries(w.finishing).some(([key,value])=>!["requestId","generation","rootRequestId"].includes(key)||typeof value!=="string"||!value))fail();}
  }
 }
 for(const group of groups){if(group.dmAudience!==undefined&&!marker(group.dmAudience,true))fail();if(group.partitionedFor!==undefined&&(!object(group.partitionedFor)||Object.entries(group.partitionedFor).some(([key,value])=>!id(key)||!marker(value,false))))fail();}
 if(db?.prepare("SELECT 1 FROM sqlite_schema WHERE name='team_identities'").get())for(const r of db.prepare("SELECT * FROM team_identities").all()){
  if(!uuid(r.team_id))fail();if(r.op!==null){if(!["rename","delete"].includes(String(r.op))||r.op_phase===null||r.op_records===null||r.op_label===null||r.op==="delete"&&!['keep','archive'].includes(String(r.op_choice))||r.op==="rename"&&r.op_choice!==null)fail();try{parseTeamOpRecords(String(r.op_records));}catch{return fail();}}
  else if([r.op_phase,r.op_records,r.op_label,r.op_choice,r.op_since].some(v=>v!==null))fail();
 }
}
export function validateSharingPaused(bots:RecordValue[],groups:RecordValue[],db?:DatabaseSync):void {
 validateSharingStructure(bots,groups,db);
 if(bots.some(b=>object(b.sharedWith)&&b.sharedWith.mode!=="none"||rows(b.tasks).some(t=>object(t.sharedWork)&&(t.sharedWork.closedAt===undefined||t.sharedWork.finishing!==undefined)))||db?.prepare("SELECT 1 FROM sqlite_schema WHERE name='team_identities'").get()&&db.prepare("SELECT 1 FROM team_identities WHERE op IS NOT NULL").get())throw new Error("SHARING_NOT_PAUSED");
}
