// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: store-patchbot (roster facts). Consumer owner: recall-scope-c (partition bounds and exactness).
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { setExecutionStore } from '../execution-audience.ts';
import { OWNER, WORKSPACE_OWNER, type HumanPrincipal } from '../human-principals.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import type { Store } from '../store.ts';
import { teamIdFor } from '../team-identities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, legacyRecallScopes, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { ConstructionBudget } from './recall-construction.ts';
import { recallMembershipSteps } from './recall-membership.ts';
import { prepareRecallContext, RECALL_BUILD_SLICE, resolveRecallView } from './recall-view.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setExecutionStore(undefined as unknown as Store);});
afterEach(()=>setExecutionStore(undefined as unknown as Store));
function execution(roster:MemoryRoster) {
  const store=roster as unknown as Store;store.bot=id=>store.bots.find(bot=>bot.id===id)??null;setExecutionStore(store);return store;
}
function scopes(roster:MemoryRoster,thread:string,notOwner=false) {
  const view=resolveRecallView({botId:'reader',threadId:thread,humanPrincipal:OWNER,notOwnerAudience:notOwner},roster).handle;
  return database().prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 ORDER BY scope_id').all(view.viewId,view.generation).map(row=>String(row.scope_id));
}
it('all partition kinds, project desks, shared work, DM audiences and home-member projects equal the original oracle',async()=>{
  const team=teamIdFor('Away');
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',section:'Home',partitionedAt:1,tasks:[
    {threadId:'direct'},{threadId:'home-task'},{threadId:'desk',channelProjectDesk:{groupId:'project'}},
    {threadId:'shared',sharedWork:{teamId:team}},{threadId:'isolated',sharedWork:{teamId:team,quarantined:true}},
  ]}],groups:[
    {id:'home',threadId:'home-room',memberIds:['reader'],section:'Home'},
    {id:'away',threadId:'away-room',memberIds:['reader'],section:'Away',partitionedFor:{reader:{kind:'team',teamId:team}}},
    {id:'room',threadId:'room-thread',memberIds:['reader'],section:'Other',partitionedFor:{reader:{kind:'room'}}},
    {id:'project',threadId:'project-thread',memberIds:['reader'],section:'Other',channelProject:true},
    {id:'home-project',threadId:'home-project-thread',memberIds:['reader'],section:'Home',channelProject:true},
    {id:'dm',threadId:'dm-thread',memberIds:['reader'],dm:true,dmAudience:{kind:'team',teamId:team}},
    {id:'isolated-dm',threadId:'isolated-dm-thread',memberIds:['reader'],dm:true,dmAudience:{kind:'isolated'}},
  ]};
  execution(roster);reconcileMemoryRoster(roster);
  for(const id of ['project','home-project'])database().prepare("INSERT INTO project_settings(group_id,mode,updated_at) VALUES(?,'ongoing',1)").run(id);
  const threads=['direct','home-task','desk','shared','isolated',...roster.groups.map(room=>room.threadId)];
  const expected=new Map<string,string[]>();
  for(const thread of threads)for(const flag of [false,true])expected.set(thread+flag,[...new Set(legacyRecallScopes('reader',thread,roster,flag))].sort());
  for(const thread of threads)for(const flag of [false,true]) {
    await prepareRecallContext('reader',thread,roster,flag);expect(scopes(roster,thread,flag),thread+flag).toEqual(expected.get(thread+flag));
  }
},120_000);
it('partition construction bounds every inherited task, room, member and sharing-list walk per slice',async()=>{
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',partitionedAt:1,section:'Home',tasks:Array.from({length:5000},(_,n)=>({threadId:n?`task-${n}`:'direct'}))}],groups:[{id:'room',threadId:'room-thread',section:'Other',memberIds:['reader'],tasks:Array.from({length:5000},(_,n)=>({threadId:`room-${n}`}))}]};
  execution(roster);reconcileMemoryRoster(roster);
  const expected=[...new Set(legacyRecallScopes('reader','direct',roster))].sort();
  let reads=0,max=0,active=true,turns=0;
  const wrap=<T>(items:T[])=>new Proxy(items,{get(target,key,receiver){if(active&&typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});
  roster.bots[0].tasks=wrap(roster.bots[0].tasks!);roster.groups[0].tasks=wrap(roster.groups[0].tasks!);roster.groups[0].memberIds=wrap(roster.groups[0].memberIds);
  const heartbeat=()=>{if(active){max=Math.max(max,reads);reads=0;turns++;setImmediate(heartbeat);}};setImmediate(heartbeat);
  try {const preparation=prepareRecallContext('reader','direct',roster);expect(reads).toBeLessThanOrEqual(RECALL_BUILD_SLICE);await preparation;max=Math.max(max,reads);}
  finally {active=false;}
  expect(max).toBeLessThanOrEqual(RECALL_BUILD_SLICE);expect(turns).toBeGreaterThan(30);expect(scopes(roster,'direct')).toEqual(expected);
},120_000);
it('legacy snapshot comparison and migration yield, revoke old receipts and recover without a monolithic intent read',async()=>{
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:Array.from({length:5000},(_,n)=>({threadId:`task-${n}`}))}],groups:[]};
  reconcileMemoryRoster(roster);const db=database();
  const current=JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()!.intent)).snapshot;
  const legacy={bots:current.bots.map(({id,section,threads}:{id:string;section:string;threads:string[]})=>({id,section,threads})),groups:[]};
  db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='memory-roster-policy'").run(JSON.stringify({hash:createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),snapshot:legacy}));
  const before=Number(db.prepare('SELECT policy_revision FROM memory_meta WHERE id=1').get()!.policy_revision);
  db.prepare("INSERT INTO memory_disclosures VALUES('legacy-receipt','direct','fixture',NULL,'[]','[]','[]',?,0,0,'delivered',1)").run(before);
  const prepare=db.prepare.bind(db);let monolithic=0,turns=0,active=true;
  db.prepare=(sql:string)=>{if(/SELECT (?:state,)?intent|json_(?:extract|type)\(intent/.test(sql)&&!sql.includes("subject_type="))monolithic++;return prepare(sql);};
  const heartbeat=()=>{if(active){turns++;setImmediate(heartbeat);}};setImmediate(heartbeat);
  try {await prepareRecallContext('reader','direct',roster);} finally {active=false;db.prepare=prepare;}
  expect(monolithic).toBe(0);expect(turns).toBeGreaterThan(30);expect(scopes(roster,'direct')).toEqual([...new Set(legacyRecallScopes('reader','direct',roster))].sort());
  expect(Number(db.prepare('SELECT policy_revision FROM memory_meta WHERE id=1').get()!.policy_revision)).toBe(before+1);
  expect(db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id='legacy-receipt'").get()!.state).toBe('revoked');
});
// 1020 CTXSTOP-ROSTER B: a workspace-owner view no longer walks every binding (recall-membership.ts ownerBindings: it reads the bindings of
// the threads it names and the grants to its own bot by memory_bindings_subject), so unrelated facts are neither read nor charged and
// it stays exact (the legacy oracle). A principal that still walks every binding keeps the refusal: it never truncates.
it('construction storage accounting includes unrelated binding facts and refuses instead of truncating',()=>{
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'}],groups:[]};reconcileMemoryRoster(roster);
  const db=database(),scope=String(db.prepare("SELECT id FROM memory_scopes WHERE kind='bot'").get()!.id);
  db.exec('BEGIN');try {const add=db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'unrelated','fixture',1,'granted','{}')");for(let n=0;n<33_000;n++)add.run(`unrelated-${n}`,scope);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  const person:HumanPrincipal={personId:'fixture-person',bindingId:'human-binding:fixture',revision:1};
  const steps=recallMembershipSteps(db,{botId:'reader',threadId:'direct',humanPrincipal:person,notOwnerAudience:false},roster,new ConstructionBudget());
  expect(()=>{while(!steps.next().done){/* explicit offline drain */}}).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
  expect(db.prepare("SELECT 1 FROM memory_recall_views WHERE state='ready'").get()).toBeUndefined();
  const owner=recallMembershipSteps(db,{botId:'reader',threadId:'direct',humanPrincipal:OWNER,notOwnerAudience:false},roster,new ConstructionBudget());
  let step=owner.next();while(!step.done)step=owner.next();
  expect([...step.value.scopes].sort()).toEqual([...new Set(legacyRecallScopes('reader','direct',roster))].sort());
});
it.each(['group','person','channel-owner'] as const)('F5 %s principals retain exact conversation, grant-kind and paired-DM boundaries',async kind=>{
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:[{threadId:'direct'}]},{id:'other',threadId:'private'}],groups:[{id:'dm',threadId:'paired',memberIds:['reader'],dm:true}]};
  reconcileMemoryRoster(roster);const db=database(),bindingId='human-binding:fixture',personId=kind==='channel-owner'?WORKSPACE_OWNER:'fixture-person';
  const principal:HumanPrincipal={personId,bindingId,revision:1},preferences=ensureScope('preferences','person:'+personId);
  const binding={id:bindingId,origin:{platform:'whatsapp',connectionId:'fixture',authorityId:'fixture',userId:kind==='group'?'fixture@g.us':'fixture'},personId,revision:1,active:true};
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-binding',?,1,'granted',?)").run(bindingId,preferences,bindingId,JSON.stringify(binding));
  for(const thread of ['direct','paired'])db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-thread',?,1,'granted',?)").run('human-thread:'+thread,preferences,thread,JSON.stringify(principal));
  const denied=[ensureScope('bot','other'),ensureScope('conversation','private'),ensureScope('preferences','person:other')],allowed=ensureScope('project','shared-project');
  for(const [n,scope] of [...denied,allowed].entries())db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'person',?,1,'granted','{}')").run('person-grant-'+n,scope,personId);
  for(const thread of ['direct','paired']) {
    await prepareRecallContext('reader',thread,roster);
    const registry=new InternalCapabilities(),generation=registry.begin('reader',thread,undefined,principal);
    const token=registry.mint({botId:'reader',threadId:thread,generation,depth:0,kind:'memory',skillAuthoring:false,humanPrincipal:principal});
    const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
    expect([...access.scopeIds].sort()).toEqual([...new Set(legacyRecallScopes('reader',thread,roster,false,principal))].sort());
    for(const scope of denied)expect(access.scopeIds).not.toContain(scope);
    if(kind==='group')expect(access.scopeIds).toEqual([ensureScope('conversation',thread)]);
    if(kind==='person'&&thread==='direct')expect(access.scopeIds).toContain(allowed);
  }
});
