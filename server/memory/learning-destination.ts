// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { memoryCaptureRoster } from "./capture-scope.ts";
import { database } from "../database.ts";
import { ensureScope } from "./policy.ts";
export type PartitionRef = { kind: "home" } | { kind: "team"; teamId: string } | { kind: "project"; groupId: string }
 | { kind: "room"; groupId: string } | { kind: "general" };
export type LearningTarget = "memory" | "skill" | "routine-instructions" | "persona" | "general" | "identity";
export type LearningDestinationInput = { botId?: string; threadId?: string; evidenceScopeIds: readonly string[]; target: LearningTarget };
export type LearningDestinationResult = { ok: true; scopeId?: string; audienceKey: string; partition: PartitionRef }
 | { ok: false; reason: "cross-partition" | "needs-owner-approval" | "retired-partition" };
export const LEARNING_WRITERS: readonly string[] = ["activation","correction-supersede","procedure-review","pip-reflection"];
function localIdentityDestination(input:LearningDestinationInput):LearningDestinationResult {
 // PIP (I-4): lived identity rows land in the bot's own private scope, and only when every evidence scope is a
 // conversation of a thread this bot owns (never a team, project or room partition).
 const bot=input.botId?memoryCaptureRoster().bots.find(b=>b.id===input.botId):undefined;
 const ids=[...new Set(input.evidenceScopeIds)];
 if(!bot||!ids.length)return {ok:false,reason:"cross-partition"};
 const own=(thread:string)=>bot.threadId===thread||Boolean(bot.tasks?.some(t=>t.threadId===thread));
 for(const id of ids){
  const row=database().prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(id);
  if(!row||row.kind!=="conversation"||!own(String(row.owner_key)))return {ok:false,reason:"cross-partition"};
 }
 return {ok:true,scopeId:ensureScope("bot",bot.id),audienceKey:`bot:${bot.id}:owner`,partition:{kind:"home"}};
}
function localDestination(input:LearningDestinationInput):LearningDestinationResult {
 if(input.target==="identity")return localIdentityDestination(input);
 const scopes=[...new Set(input.evidenceScopeIds)].map(id=>({id,row:database().prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(id)}));
 if(scopes.length!==1||!scopes[0].row)return {ok:false,reason:"cross-partition"};
 const {id}=scopes[0],row=scopes[0].row!,kind=String(row.kind),owner=String(row.owner_key);
 if(kind==="bot"&&owner.endsWith("#general"))return {ok:false,reason:"needs-owner-approval"};
 const composite=kind==="bot"?/^(.+)#(team|project|room):(.+)$/.exec(owner):null;
 if(input.target!=="memory")return input.botId&&!composite?{ok:true,partition:{kind:"home"},audienceKey:`bot:${input.botId}:owner`}:{ok:false,reason:"needs-owner-approval"};
 if(composite){
  const [,bot,partition,key]=composite;
  return {ok:true,scopeId:id,partition:partition==="team"?{kind:"team",teamId:key}:{kind:partition as "project"|"room",groupId:key},audienceKey:`bot:${bot}:${partition}:${key}:owner`};
 }
 const audienceKey=kind==="room"?`room:${owner}${input.botId?`:bot:${input.botId}`:""}`:kind==="bot"?`bot:${owner}:owner`:input.botId?`bot:${input.botId}:owner`:`${kind}:${owner}`;
 const partition:PartitionRef=kind==="team"?{kind:"team",teamId:owner}:kind==="project"||kind==="room"?{kind:kind==="project"||memoryCaptureRoster().groups.some(g=>g.id===owner&&g.channelProject)?"project":"room",groupId:owner}:{kind:"home"};
 return {ok:true,scopeId:id,partition,audienceKey};
}
let implementation:(input:LearningDestinationInput)=>LearningDestinationResult=localDestination;
export function learningDestination(input:LearningDestinationInput):LearningDestinationResult{return implementation(input);}
export function installLearningDestination(fn:(input:LearningDestinationInput)=>LearningDestinationResult):()=>void {
 const previous=implementation;implementation=fn;return ()=>{implementation=previous;};
}
