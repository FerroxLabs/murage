// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { turnAudienceIsOwner } from "../owner-audience.ts";
import { threadHumanPrincipal,isWorkspaceOwner } from "../human-principals.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { memoryCaptureRoster } from "./capture-scope.ts";
import type { MemoryRoster } from "./policy.ts";
import { readBotLearning } from "../bot-learning.ts";
import { classifyPastedText, redactLearningText, repeatsProspectText, structuralLine } from "./prospect-text.ts";
export function isLearnableSource(db:DatabaseSync,sourceId:string,revision:number,ctx:{roster?:MemoryRoster}={}):{learnable:true}|{learnable:false;reason:string}{
 const no=(reason:string)=>({learnable:false as const,reason});
 const source=db.prepare(`SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.revision=?`).get(sourceId,revision);
 if(!source||source.state!=="active")return no("not-active");
 if(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(sourceId,revision))return no("tombstoned");
 if(!db.prepare("SELECT 1 FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture' AND status='complete'").get(sourceId,revision))return no("not-active");
 if(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(source.thread_id))return no("excluded-thread");
 if(source.kind==="turn")return no("settlement");
 if(source.speaker==="tool"||source.kind==="tool-outcome")return no("tool-results-nightly-only");
 if(source.speaker!=="owner")return no("not-owner-speaker");
 const payload=JSON.parse(String(source.payload));
 const binding=db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='source-origin' AND subject_id=? AND state='granted'").get(sourceId);
 const origin=payload.origin??(binding?JSON.parse(String(binding.intent)):null);
 const kind=origin?.kind??"unknown";
 if(!["attended","channel"].includes(kind)||source.kind!=="text")return no(`origin-${kind}`);
 const thread=String(source.thread_id??"");
 if(!thread||!turnAudienceIsOwner(thread,{},db))return no("not-owner-audience");
 if(kind==="channel"){
  const principal=threadHumanPrincipal(thread,db);
  const verified=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-binding'").get(principal.bindingId);
  const value=verified?JSON.parse(String(verified.intent)):null;
  if(!isWorkspaceOwner(principal)||principal.bindingId==="local"||!value?.active||value.personId!==principal.personId||value.revision!==principal.revision)return no("not-owner-speaker");
 }
 return learnableSourceSettings(db,source,kind,ctx);
}
/** Settings and audience apply even to owner-invited fictional evidence. */
export function learnableSourceSettings(db:DatabaseSync,source:Record<string,import("node:sqlite").SQLOutputValue>,kind:string,ctx:{roster?:MemoryRoster}={}):{learnable:true}|{learnable:false;reason:string}{
 const no=(reason:string)=>({learnable:false as const,reason});
 if(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(source.thread_id))return no("excluded-thread");
 const thread=String(source.thread_id??"");
 if(!thread||!turnAudienceIsOwner(thread,{},db))return no("not-owner-audience");
 const settings=readMemoryLearning(db);
 if(kind==="channel"){
  if(!settings.learnFrom.channels)return no("channels-off");
 }else if(!settings.learnFrom.chats)return no("chats-off");
 const roster=ctx.roster??memoryCaptureRoster();
 const room=roster.groups.some(g=>g.threadId===thread||g.tasks?.some(t=>t.threadId===thread));
 const bot=roster.bots.find(b=>b.threadId===thread||b.tasks?.some(t=>t.threadId===thread));
 const scope=db.prepare("SELECT kind FROM memory_scopes WHERE id=?").get(source.scope_id);
 if(scope?.kind==='room'&&!settings.learnFrom.chats)return no("chats-off");
 if(!room&&bot&&settings.botsPaused.includes(bot.id))return no("bot-paused");
 return {learnable:true};
}

/** Which threads a bot may learn prospect words from. Chosen by the owner on
 * the opt-in screen; nothing is ingested for a thread that is not listed. */
export interface ProspectScope { threadIds: readonly string[] }
/** The threads the owner chose on the opt-in screen, from the bot's own learning
 * config (`learning.prospectThreadIds`, written by the Learning screen, B5).
 * Absent, malformed or the opt-in off: an empty scope, so nothing prospect-worded is admitted. */
export function readProspectScope(bot:{learning?:unknown}):ProspectScope{
 const raw=(bot.learning as {prospectThreadIds?:unknown}|null|undefined)?.prospectThreadIds;
 if(!Array.isArray(raw))return {threadIds:[]};
 return {threadIds:raw.filter((id):id is string=>typeof id==="string"&&id.length>0&&id.length<=200).slice(0,500)};
}
export type OutcomeEvidence =
 | { admit: true; words: "owner" | "bot" | "prospect"; /** What may be kept: redacted, and with prospect words replaced by a structural line unless the opt-in admits them. */ text: string; thirdPartyWords: "none" | "replaced" | "admitted" }
 | { admit: false; reason: string };
/** Whether one message may enter an outcome episode for `bot` (design 11).
 * Owner and bot words: bot Learning on, source active and current, not
 * tombstoned, thread not excluded, origin and audience as isLearnableSource.
 * Prospect or third-party words (another person in the thread, or pasted quotes
 * inside an owner message): additionally need the bot's prospectLearning on and
 * the thread in the selected scope. With the opt-in off a prospect message is
 * refused and pasted third-party text inside an owner message is replaced by a
 * structural line; nothing prospect-worded is ever returned. */
export function isOutcomeEvidence(db:DatabaseSync,source:{id:string;revision:number},bot:{id:string;learning?:unknown},ctx:{roster?:MemoryRoster;prospectScope?:ProspectScope}={}):OutcomeEvidence{
 const no=(reason:string)=>({admit:false as const,reason});
 const learning=readBotLearning(bot);
 if(!learning.enabled)return no("learning-off");
 // Scope comes from the bot's own learning config unless the caller hands one over; default empty.
 ctx={...ctx,prospectScope:ctx.prospectScope??readProspectScope(bot)};
 const row=db.prepare(`SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.revision=?`).get(source.id,source.revision);
 if(!row||row.state!=="active")return no("not-active");
 if(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision))return no("tombstoned");
 if(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(row.thread_id))return no("excluded-thread");
 const thread=String(row.thread_id??"");
 const roster=ctx.roster??memoryCaptureRoster();
 const owning=roster.bots.find(b=>b.threadId===thread||b.tasks?.some(t=>t.threadId===thread));
 if(owning&&owning.id!==bot.id)return no("not-this-bot");
 const text=JSON.parse(String(row.payload)).text;
 if(typeof text!=="string")return no("no-text");
 const speaker=String(row.speaker);
 if(speaker==="tool"||row.kind==="tool-outcome")return no("tool-results-nightly-only");
 if(speaker==="owner"){
  const verdict=isLearnableSource(db,source.id,source.revision,ctx);
  if(!verdict.learnable)return no(verdict.reason);
  const segments=classifyPastedText(text);
  const pasted=segments.some(s=>s.party==="third-party");
  if(!pasted)return {admit:true,words:"owner",text:redactLearningText(text),thirdPartyWords:"none"};
  if(learning.prospectLearning&&ctx.prospectScope?.threadIds.includes(thread))return {admit:true,words:"prospect",text:redactLearningText(text),thirdPartyWords:"admitted"};
  const kept=segments.map(s=>s.party==="owner"?s.text:structuralLine(s.text)).join("\n");
  return {admit:true,words:"owner",text:redactLearningText(kept),thirdPartyWords:"replaced"};
 }
 if(speaker.startsWith("person:")){
  if(!learning.prospectLearning)return no("prospect-learning-off");
  if(!ctx.prospectScope?.threadIds.includes(thread))return no("thread-not-in-prospect-scope");
  if(row.kind!=="text")return no("not-text");
  const payload=JSON.parse(String(row.payload));
  const binding=db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='source-origin' AND subject_id=? AND state='granted'").get(source.id);
  const kind=(payload.origin??(binding?JSON.parse(String(binding.intent)):null))?.kind??"unknown";
  if(!["attended","channel"].includes(kind))return no(`origin-${kind}`);
  const settings=readMemoryLearning(db);
  if(kind==="channel"?!settings.learnFrom.channels:!settings.learnFrom.chats)return no(kind==="channel"?"channels-off":"chats-off");
  if(owning&&settings.botsPaused.includes(owning.id))return no("bot-paused");
  return {admit:true,words:"prospect",text:redactLearningText(text),thirdPartyWords:"admitted"};
 }
 // The bot's own words (speaker is a bot id or "assistant"). Same thread, source and exclusion checks as above.
 return {admit:true,words:"bot",text:redactLearningText(text),thirdPartyWords:"none"};
}
/** The text a case context shows for a message: with the opt-in off, a
 * non-owner turn is a structural line, never its words. */
export function contextLineFor(evidence:OutcomeEvidence,rawProspectText:string):string{
 return evidence.admit?evidence.text:structuralLine(rawProspectText);
}

export type LessonAdmission =
 | { ok: true; text: string; prospectDerived: boolean; destination: "messages-db" | "learning-local"; mustSuggest: boolean }
 | { ok: false; reason: "prospect-text" | "empty" };
/** Gate for a lesson or guide text before it is stored or shared. Prospect
 * wording is refused outright when the bot's opt-in is off. With the opt-in on
 * it is allowed only as a prospect-derived suggestion kept under
 * learning-local/, never in messages.db and never automatic. Contact details
 * and secrets are redacted either way. */
export function admitLessonText(bot:{id?:string;learning?:unknown},candidate:string,prospectTexts:readonly string[]):LessonAdmission{
 const text=redactLearningText(candidate).trim();
 if(!text)return {ok:false,reason:"empty"};
 if(!repeatsProspectText(candidate,prospectTexts))return {ok:true,text,prospectDerived:false,destination:"messages-db",mustSuggest:false};
 if(!readBotLearning(bot).prospectLearning)return {ok:false,reason:"prospect-text"};
 return {ok:true,text,prospectDerived:true,destination:"learning-local",mustSuggest:true};
}
