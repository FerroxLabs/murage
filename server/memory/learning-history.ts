// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { recordLearningEvent } from "./learning-ledger.ts";
import { changeLessonEvent, isKeptMomentEvent, isLessonEvent, lessonForEvent } from "./lessons.ts";
import { changeProcedureEvent, isProcedureEvent, procedureForEvent } from "./procedure-landing.ts";
import type { MemoryRoster } from "./policy.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
export function learningHistory(db:DatabaseSync,roster:MemoryRoster,input:{botId?:string;cursor?:string;limit?:number}){
 const limit=Math.min(50,Math.max(1,input.limit??50));
 let cursor:{created_at:number;id:string}|undefined;
 if(input.cursor){
  try{const value=JSON.parse(input.cursor);if(!Array.isArray(value)||value.length!==2||!Number.isSafeInteger(value[0])||value[0]<0||typeof value[1]!=="string"||!value[1])throw Error();cursor={created_at:value[0],id:value[1]};}
  catch{throw Object.assign(Error("This history page is no longer available. Refresh the list."),{status:400});}
 }
 const rows=db.prepare(`SELECT e.*,s.kind scope_kind,s.owner_key FROM memory_learning_events e JOIN memory_scopes s ON s.id=e.scope_id
 WHERE (? IS NULL OR e.bot_id=?) AND (? IS NULL OR e.created_at<? OR (e.created_at=? AND e.id<?)) ORDER BY e.created_at DESC,e.id DESC LIMIT ?`).all(input.botId??null,input.botId??null,cursor?.id??null,cursor?.created_at??null,cursor?.created_at??null,cursor?.id??null,limit+1);
 return {events:rows.slice(0,limit).map(row=>{
  const record=row.record_id?db.prepare("SELECT id,version,state,text FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(row.record_id):null;
  const source=row.source_id?db.prepare("SELECT thread_id,message_id,state FROM memory_sources WHERE id=?").get(row.source_id):null;
  const bot=roster.bots.find(b=>b.id===row.bot_id),room=roster.groups.find(g=>g.id===row.owner_key||g.threadId===source?.thread_id||g.tasks?.some(t=>t.threadId===source?.thread_id));
  const task=[...roster.bots,...roster.groups].flatMap(item=>item.tasks??[]).find(task=>task.threadId===source?.thread_id);
  const title=task&&"title" in task&&typeof task.title==="string"?task.title:undefined;
  const owner=String(row.owner_key),scopeBot=roster.bots.find(b=>b.id===owner||owner===`bot:${b.id}`||owner.startsWith(`${b.id}#`));
  const composite=row.scope_kind==="bot"?/^(.+)#(team|project|room):(.+)$/.exec(owner):null;
  const destination=composite?(composite[2]==="team"?composite[3]:roster.groups.find(g=>g.id===composite[3])?.name??(composite[2]==="project"?"Project":"Room")):null;
  const scopeLabel=composite&&scopeBot?`${scopeBot.name??"Bot"} for ${destination}`:row.scope_kind==="workspace"?"Workspace":room?.name??scopeBot?.name??bot?.name??(row.scope_kind==="room"?"Room":row.scope_kind==="team"?"Team":row.scope_kind==="preferences"?"Your preferences":row.scope_kind==="bot"?"Bot":"Conversation");
  return {...row,lesson:lessonForEvent(db,row),procedure:procedureForEvent(db,row),record:record?{...record,text:record.state==="deleted"?null:record.text}:null,scopeLabel,
   source:source&&source.state!=="deleted"?{threadId:source.thread_id,messageId:source.message_id,threadTitle:title??room?.name??bot?.name??"Conversation",botId:bot?.id??null,botName:bot?.name??null,roomName:room?.name??null}:null};
 }),nextCursor:rows.length>limit?JSON.stringify([Number(rows[limit-1].created_at),String(rows[limit-1].id)]):null};
}
/** Caller owns owner authorization and transaction. */
export function changeLearningEvent(db:DatabaseSync,eventId:string,action:"undo"|"keep",now:number=Date.now()){
 const event=db.prepare("SELECT * FROM memory_learning_events WHERE id=?").get(eventId);
 // Lessons and praise or win moments have their own undo (lessons.ts); the same list and the same two actions serve them.
 if(event&&(isLessonEvent(event.kind)||isKeptMomentEvent(event)))return changeLessonEvent(db,event,action,now);
 // Automatic skill and routine changes (B7c): Undo goes through the scoped skill rollback or the routine rollback.
 if(event&&isProcedureEvent(event))return changeProcedureEvent(db,event,action,now);
 if(!event||!["activated","superseded"].includes(String(event.kind)))throw Object.assign(Error("This learning item cannot be changed."),{status:409});
 if(action==="undo"&&event.undone_at!==null)return {ok:true,eventId,undone:true};
 if(action==="keep"&&event.kept_at!==null)return {ok:true,eventId,kept:true};
 const record=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(event.record_id);
 const fail=()=>{throw Object.assign(Error("This memory changed since it was learned. Open it to review the current version."),{status:409});};
 if(!record||record.version!==event.record_version||record.state!=="active"||record.owner_pinned===1)fail();
 if(action==="undo"){
  const links=record!.supersedes_id?db.prepare("SELECT parent_id,parent_version FROM memory_derivations WHERE child_id=? AND child_version=? AND parent_id=?").all(event.record_id,event.record_version,record!.supersedes_id):[];
  if(event.kind==="activated"&&record!.supersedes_id&&links.length!==1)fail();
  const priorId=event.kind==="superseded"?event.prior_id:links[0]?.parent_id;
  const priorVersion=event.kind==="superseded"?event.prior_version:links[0]?.parent_version??null;
  if(event.kind==="superseded"&&!priorId)fail();
  if(priorId){
   const prior=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(priorId);
   if(!prior||prior.version!==priorVersion||prior.state!=="superseded"||prior.owner_pinned===1)fail();
   if(db.prepare("SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? AND (s.state!='active' OR s.revision!=e.source_revision)").get(priorId,priorVersion))fail();
   db.prepare("UPDATE memory_records SET state='active',valid_to=NULL WHERE id=? AND version=?").run(priorId,priorVersion);
   db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending',embedding_status='pending' WHERE record_id=? AND record_version=?").run(priorId,priorVersion);
  }
  db.prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(event.record_id,event.record_version);
  db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(event.record_id,event.record_version);
  db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE record_id=? AND record_version=? AND kind IN ('activated','superseded')").run(Date.now(),event.record_id,event.record_version);
  // Forget means the words stop reaching future turns, not only the extracted fact: the owner's own source line (a verbatim chunk
  // resting only on this message) goes with it. Pinned lines and chunks that also rest on other messages stay.
  if(event.source_id!==null&&event.kind==="activated"&&!record!.supersedes_id){
   for(const chunk of db.prepare("SELECT r.id,r.version FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.kind='source' AND r.state='active' AND r.owner_pinned=0 AND e.source_id=? AND NOT EXISTS(SELECT 1 FROM memory_evidence o WHERE o.record_id=r.id AND o.record_version=r.version AND o.source_id<>?) GROUP BY r.id,r.version").all(event.source_id,event.source_id)){
    db.prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(chunk.id,chunk.version);
    db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(chunk.id,chunk.version);
   }
  }
 }else{
  db.prepare("UPDATE memory_record_details SET confidence_basis='owner_confirmed' WHERE record_id=? AND record_version=? AND partition!='identity'").run(event.record_id,event.record_version);
  db.prepare("UPDATE memory_learning_events SET kept_at=? WHERE id=?").run(Date.now(),eventId);
 }
 recordLearningEvent(db,{kind:action==="undo"?"owner-undo":"owner-keep",scopeId:String(event.scope_id),recordId:String(event.record_id),recordVersion:Number(event.record_version),sourceId:event.source_id===null?undefined:String(event.source_id),sourceRevision:event.source_revision===null?undefined:Number(event.source_revision),botId:event.bot_id===null?null:String(event.bot_id)});
 db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
 revokeRecordDisclosures(db,action==="undo"?"learning-undo":"learning-keep",{recordIds:[String(event.record_id),...(event.prior_id?[String(event.prior_id)]:[]),...(record!.supersedes_id?[String(record!.supersedes_id)]:[])]});
 return action==="undo"?{ok:true,eventId,undone:true}:{ok:true,eventId,kept:true};
}
