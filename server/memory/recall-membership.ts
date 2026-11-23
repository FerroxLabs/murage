// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: store-patchbot (revisioned roster). Consumer owner: recall-scope (cooperative exact membership).
import type { DatabaseSync } from 'node:sqlite';
import { isGroupPrincipal, isWorkspaceOwner, WORKSPACE_OWNER } from '../human-principals.ts';
import { type MemoryRoster } from './policy.ts';
import { scopeRow } from './scope-id.ts';
import { ConstructionBudget, constructionSort } from './recall-construction.ts';
import { recallPartitionSteps } from './recall-partitions.ts';
import type { ensureScope } from './policy.ts';
import type { RecallViewBinding } from './recall-view.ts';

type Row = Record<string, unknown>;
/** Raw rows are paged BEFORE residual classification; no complete binding/scope result is read at once. */
function* rows(db: DatabaseSync, table: 'memory_scope_bindings'|'memory_scopes'): Generator<Row> {
  let after=0;
  for(;;) {
    const fields=table==='memory_scopes'?'id,kind,owner_key':"id,scope_id,subject_type,subject_id,state,CASE WHEN subject_type='human-thread' THEN json_extract(intent,'$.personId') END AS person";
    const page=db.prepare(`SELECT rowid AS position,${fields} FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 64`).all(after);
    if(!page.length)return;
    for(const row of page){after=Number(row.position);yield row;}
  }
}
const BINDING_FIELDS="id,scope_id,subject_type,subject_id,state,CASE WHEN subject_type='human-thread' THEN json_extract(intent,'$.personId') END AS person";
/** The bindings an owner view reads, in rowid order per subject (a later binding of one thread wins, as in the walk): each named thread's
 * human-thread rows and the grants to one subject. Bounded by what the view names, never by how many bindings exist. */
function* ownerBindings(db: DatabaseSync, threads: readonly string[], grantee: [string,string]): Generator<Row> {
  const human=db.prepare(`SELECT rowid AS position,${BINDING_FIELDS} FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='human-thread' AND subject_id=? ORDER BY rowid`);
  for(const thread of new Set(threads))for(const row of human.all(thread))yield row;
  yield* db.prepare(`SELECT rowid AS position,${BINDING_FIELDS} FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type=? AND subject_id=? AND state='granted' ORDER BY rowid`).all(...grantee);
}
export interface ConstructedMembership {scopes:string[];lineage:string[];personScopes:Set<string>;room:boolean;threadRecall?:boolean}
/** The legacy oracle's complete rules, including partition-added scopes and the separate S(P) lineage union.
 * Every roster item, authority row, membership lookup, sort move and output copy is a resumable step. */
export function* recallMembershipSteps(db: DatabaseSync,binding: RecallViewBinding,roster: MemoryRoster,budget = new ConstructionBudget(),ensure?: typeof ensureScope): Generator<void,ConstructedMembership> {
  const {botId,threadId,humanPrincipal:principal,notOwnerAudience}=binding;
  const owner=isWorkspaceOwner(principal)&&!notOwnerAudience;
  let bot:MemoryRoster['bots'][number]|undefined,group:MemoryRoster['groups'][number]|undefined;
  let owns=false,deskId:string|undefined,deskSeen=false;
  const foreign=new Set<string>(),ownThreads=new Set<string>(),roomThreads=new Map<MemoryRoster['groups'][number],Set<string>>(),roomMembers=new Map<MemoryRoster['groups'][number],boolean>();
  for(const candidate of roster.bots) {
    budget.add(candidate.id,candidate.threadId);
    const selected=candidate.id===botId && !bot;
    if(selected){bot=candidate;ownThreads.add(candidate.threadId);owns=candidate.threadId===threadId;}
    if(candidate.id!==botId)foreign.add(candidate.threadId);yield;
    for(const task of candidate.tasks??[]) {
      budget.add(task.threadId);
      if(selected){ownThreads.add(task.threadId);if(task.threadId===threadId)owns=true;}
      if(candidate.id!==botId)foreign.add(task.threadId);
      if(!deskSeen && task.threadId===threadId && task.channelProjectDesk){deskSeen=true;deskId=task.channelProjectDesk.groupId;}
      yield;
    }
  }
  for(const room of roster.groups) {
    budget.add(room.id,room.threadId);
    const threads=new Set<string>([room.threadId]);foreign.add(room.threadId);
    if(!group && room.threadId===threadId)group=room;yield;
    for(const task of room.tasks??[]){budget.add(task.threadId);threads.add(task.threadId);foreign.add(task.threadId);if(!group&&task.threadId===threadId)group=room;yield;}
    roomThreads.set(room,threads);let member=false;
    for(const id of room.memberIds){budget.add(id);if(id===botId)member=true;yield;}
    roomMembers.set(room,member);
  }
  const empty:ConstructedMembership={scopes:[],lineage:[],personScopes:new Set(),room:false};
  if(!bot || group&&!roomMembers.get(group) || !group&&(!owns||foreign.has(threadId)))return empty;
  let desk:MemoryRoster['groups'][number]|undefined;
  if(!group&&deskId)for(const room of roster.groups){if(!desk&&room.id===deskId&&!room.dm&&room.channelProject&&roomMembers.get(room))desk=room;yield;}
  const result:ConstructedMembership={scopes:[],lineage:[],personScopes:new Set(),room:!!group||!!desk};
  const personThreads=new Set<string>();
  const scopes=new Set<string>(),persons=new Map<string,string|null>(),grants:Array<{scope:string;type:string;id:string}>=[];
  function* add(kind:string,key:string): Generator<void> {const row=scopeRow(db,kind,key);if(row)scopes.add(String(row.id));yield;}
  yield* add('conversation',threadId);
  if(isGroupPrincipal(principal)){for(const scope of scopes){result.scopes.push(scope);yield;}return result;}
  // 1020 CTXSTOP-ROSTER B: for the workspace owner only the bindings of the threads this view can name (its own, the rooms') and the
  // grants to its own bot or room are read, by memory_bindings_subject. A full page walk of every binding per view (system, pip and
  // checkpoint rows included) made a rebuild of 1167 views after one roster change read 158k-285k pages a minute and held the
  // admission ledger lock past its deadline. Another principal still walks every binding (personThreads needs them all).
  const bindings=isWorkspaceOwner(principal)?ownerBindings(db,[threadId,...ownThreads,...[...roomThreads.values()].flatMap(threads=>[...threads])],group?['room',group.id]:['bot',botId]):rows(db,'memory_scope_bindings');
  for(const row of bindings) {
    budget.add(String(row.id),String(row.scope_id),String(row.subject_id));
    if(row.subject_type==='human-thread') {
      const person=row.person;
      if(person===principal.personId)personThreads.add(String(row.subject_id));
      persons.set(String(row.subject_id),person===null||person===undefined?null:String(person));
    }
    if(row.state==='granted' && ['bot','room','person'].includes(String(row.subject_type)))grants.push({scope:String(row.scope_id),type:String(row.subject_type),id:String(row.subject_id)});
    yield;
  }
  const excluded=(thread:string)=>!!db.prepare('SELECT 1 FROM memory_recall_excluded WHERE thread_id=?').get(thread);
  const sameAudience=(thread:string)=>(persons.has(thread)?persons.get(thread):WORKSPACE_OWNER)===principal.personId;
  function* own():Generator<void> {for(const thread of ownThreads){if(!foreign.has(thread)&&!excluded(thread)&&sameAudience(thread))yield* add('conversation',thread);yield;}}
  function* reach(room:MemoryRoster['groups'][number],same=false):Generator<void> {
    yield* add('room',room.id);
    for(const thread of roomThreads.get(room)??[]) {
      const person=persons.get(thread);
      if(!excluded(thread) && (same?thread!==threadId&&sameAudience(thread):person===undefined||person===null||person===WORKSPACE_OWNER))yield* add('conversation',thread);
      yield;
    }
  }
  if(group) {
    yield* add('room',group.id);
    if(owner){yield* reach(group,true);yield* add('bot',botId);yield* add('team',bot.section?.trim()||'');yield* own();}
  } else {
    if(owner){yield* add('bot',botId);yield* add('team',bot.section?.trim()||'');}
    if(owner&&desk)yield* reach(desk);
    if(owner&&!desk)for(const room of roster.groups) {
      let personThread=false;
      for(const thread of roomThreads.get(room)??[]) {const p=persons.get(thread);if(p!==undefined&&p!==null&&p!==WORKSPACE_OWNER)personThread=true;yield;}
      if(!room.dm&&roomMembers.get(room)&&!personThread)yield* reach(room);yield;
    }
    if(!(notOwnerAudience&&isWorkspaceOwner(principal))){yield* add('preferences','person:'+principal.personId);yield* own();}
  }
  if(!(notOwnerAudience&&isWorkspaceOwner(principal))) {
    const type=isWorkspaceOwner(principal)?group?'room':'bot':'person',id=isWorkspaceOwner(principal)?group?.id??botId:principal.personId;
    for(const grant of grants) {
      if(grant.type===type&&grant.id===id) {
        const kind=db.prepare('SELECT kind FROM memory_scopes WHERE id=?').get(grant.scope)?.kind;
        if(kind!==undefined && (type!=='person'||['room','project','team','workspace'].includes(String(kind))))scopes.add(grant.scope);
      }
      yield;
    }
  }
  const filtered=new Set<string>();
  const partition=yield* recallPartitionSteps(db,botId,threadId,owner,principal.personId,budget,ensure);
  for(const scope of partition.base){filtered.add(scope);yield;}
  for(const scope of scopes){if(partition.allows(scope))filtered.add(scope);yield;}
  if(owner && !group && owns && !foreign.has(threadId)) {
    result.threadRecall=false;
    for(const thread of ownThreads){
      const scope=scopeRow(db,'conversation',thread);
      if(scope&&!foreign.has(thread)&&!excluded(thread)&&sameAudience(thread)&&partition.allows(String(scope.id)))result.threadRecall=true;
      yield;
    }
  }
  if(!isWorkspaceOwner(principal)) {
    try {
      for(const row of rows(db,'memory_scopes')) {
        budget.add(String(row.id),String(row.owner_key));
        const kind=String(row.kind),key=String(row.owner_key);
        if(kind==='conversation'&&personThreads.has(key) || kind==='preferences'&&key==='person:'+principal.personId)result.personScopes.add(String(row.id));yield;
      }
      for(const grant of grants){if(grant.type==='person'&&grant.id===principal.personId){const kind=db.prepare('SELECT kind FROM memory_scopes WHERE id=?').get(grant.scope)?.kind;if(['room','project','team','workspace'].includes(String(kind)))result.personScopes.add(grant.scope);}yield;}
    } catch(error) {if(error instanceof Error && error.message==='MEMORY_RECALL_STORAGE_LIMIT')throw error;result.personScopes.clear();}
  }
  for(const scope of filtered){result.scopes.push(scope);yield;}
  for(const scope of result.personScopes){if(!filtered.has(scope))result.lineage.push(scope);yield;}
  const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
  result.scopes=yield* constructionSort(result.scopes,compare);result.lineage=yield* constructionSort(result.lineage,compare);
  return result;
}
