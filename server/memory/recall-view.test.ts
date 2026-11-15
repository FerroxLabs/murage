// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
export function rosterFixture(): MemoryRoster { return {memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:[{threadId:'task'}]},{id:'other',threadId:'private'}],groups:[{id:'room',threadId:'room-thread',memberIds:['reader']}]}; }
export function issue(roster: MemoryRoster, threadId = 'direct', notOwnerAudience = false) {
  const registry = new InternalCapabilities(); registry.begin('reader',threadId,'generation');
  const token = registry.mint({botId:'reader',threadId,generation:'generation',depth:0,kind:'memory',skillAuthoring:false,...notOwnerAudience?{notOwnerAudience:true as const}:{}});
  return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
}
it('RED-3 cold contexts explicitly refuse without computing or iterating scopes and recover through maintenance', async () => {
  const views = await import('./recall-view.ts'), roster = rosterFixture(); reconcileMemoryRoster(roster);
  views.evictRecallViewsForTest(database());
  const tasks=roster.bots[0].tasks!;roster.bots[0].tasks=new Proxy(tasks,{get(target,key,receiver){if(typeof key==='string'&&/^[0-9]+$/.test(key))throw new Error('cold turn enumerated tasks');return Reflect.get(target,key,receiver);}});
  const before = views.recallViewCounters();
  expect(() => issue(roster)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  expect(views.recallViewCounters().oracleComputes).toBe(before.oracleComputes);
  roster.bots[0].tasks=tasks;
  await views.prepareRecallContext('reader','direct',roster);
  expect(issue(roster).view).toBeDefined();
});
it('A1 exact membership equals the complete legacy oracle for direct, room and unproven readers', async () => {
  const views = await import('./recall-view.ts'), policy = await import('./policy.ts'), roster = rosterFixture(); reconcileMemoryRoster(roster);
  for (const thread of ['direct','room-thread']) for (const notOwner of [false,true]) {
    await views.prepareRecallContext('reader',thread,roster,notOwner);
    const access = issue(roster,thread,notOwner);
    const rows = database().prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? ORDER BY scope_id').all(access.view.viewId,access.view.generation);
    expect(rows.map(row=>row.scope_id)).toEqual([...new Set(policy.legacyRecallScopes('reader',thread,roster,notOwner))].sort());
    expect(views.recallViewHasScope(database(),access.view,ensureScope('conversation','private'))).toBe(false);
  }
});
it('A9 lineage membership is distinct and cannot grant retrieval', async () => {
  const views = await import('./recall-view.ts'), roster = rosterFixture(); reconcileMemoryRoster(roster);
  await views.prepareRecallContext('reader','direct',roster);
  const access = issue(roster), scope = ensureScope('conversation','private');
  expect(views.recallViewHasScope(database(),access.view,scope)).toBe(false);
  expect(views.recallViewHasScope(database(),access.view,scope,true)).toBe(false);
});

it('A1-A4 generated rosters preserve room, alias, exclusion, DM, grant and malformed-binding rules exactly', async () => {
  const views=await import('./recall-view.ts'), policy=await import('./policy.ts');
  for(let seed=0;seed<12;seed++) {
    const roster=rosterFixture();
    roster.memoryRosterRevision=seed+1;
    roster.bots[0].tasks!.push({threadId:`extra-${seed}`});
    if(seed%3===0)roster.groups[0].dm=true;
    if(seed%3===1)roster.groups[0].tasks=[{threadId:'room-task'}];
    if(seed%3===2)roster.bots[1].tasks=[{threadId:'task'}];
    reconcileMemoryRoster(roster);
    const db=database(), scope=ensureScope('project',`project-${seed}`);
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot','reader',0,'granted','{}')").run(`grant-${seed}`,scope);
    const workspace=ensureScope('workspace','fixture-settings');
    db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','settings',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(workspace,JSON.stringify({excludedThreadIds:seed%2?['task']:[]}));
    if(seed%4===0)db.prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('human-thread:task',?,'human-thread','task',0,'granted','{}')").run(scope);
    for(const thread of ['direct','room-thread'])for(const notOwner of [false,true]) {
      await views.prepareRecallContext('reader',thread,roster,notOwner);
      const access=issue(roster,thread,notOwner);
      const rows=db.prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 ORDER BY scope_id').all(access.view.viewId,access.view.generation);
      expect(rows.map(row=>String(row.scope_id))).toEqual([...new Set(policy.legacyRecallScopes('reader',thread,roster,notOwner))].sort());
    }
  }
});
it('A6 a readable record never makes private, excluded or deleted evidence readable', async () => {
  const views=await import('./recall-view.ts'), {readableMemoryRecord}=await import('./readable.ts'),{LineageAllowance}=await import('./lineage-allowance.ts');
  const roster=rosterFixture();reconcileMemoryRoster(roster);
  const db=database(), allowed=ensureScope('bot','reader'),denied=ensureScope('conversation','private');
  db.prepare("INSERT INTO memory_sources VALUES('evidence',?,'private',NULL,NULL,1,'fixture','text','owner','recorded',NULL,'active')").run(denied);
  db.prepare("INSERT INTO memory_source_versions VALUES('evidence',1,'fixture',?,1)").run(JSON.stringify({text:'fixture evidence'}));
  db.prepare("INSERT INTO memory_records VALUES('record',1,?,'constraint','fixture','owner-statement','active',0,1,NULL,NULL,1)").run(allowed);
  db.prepare("INSERT INTO memory_evidence VALUES('record',1,'evidence',1,0,7)").run();
  await views.prepareRecallContext('reader','direct',roster);
  const access=issue(roster),read=()=>readableMemoryRecord('record',1,access,{allowance:LineageAllowance.tool(1_000_000_000)});
  expect(read()).toBe('MEMORY_SCOPE_DENIED');
  db.prepare("UPDATE memory_sources SET state='deleted' WHERE id='evidence'").run();
  expect(read()).toBe('MEMORY_EVIDENCE_UNAVAILABLE');
});
it('A7 tombstones, provisional history and PIP gates are retained', async () => {
  const views=await import('./recall-view.ts'), {readableMemoryRecord}=await import('./readable.ts'),{LineageAllowance}=await import('./lineage-allowance.ts');
  const roster=rosterFixture();reconcileMemoryRoster(roster);const db=database(),scope=ensureScope('bot','reader');
  db.prepare("INSERT INTO memory_records VALUES('pip',1,?,'continuity-brief','fixture','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  db.prepare("INSERT INTO memory_records VALUES('forgotten',1,?,'constraint','fixture','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  db.prepare("INSERT INTO memory_tombstones VALUES('marker','record','forgotten',1,NULL,0,'fixture',1)").run();
  await views.prepareRecallContext('reader','direct',roster);const access=issue(roster);
  for(const id of ['pip','forgotten'])expect(readableMemoryRecord(id,1,access,{allowance:LineageAllowance.tool(1_000_000_000),agent:true})).toBe('MEMORY_RECORD_UNAVAILABLE');
});
it('A10 unrelated denied scopes cannot change selected results or metadata', async () => {
  const views=await import('./recall-view.ts'),index=await import('./recall-view-index.ts');
  const roster=rosterFixture();reconcileMemoryRoster(roster);const db=database(),scope=ensureScope('bot','reader');
  db.prepare("INSERT INTO memory_records VALUES('expected',1,?,'constraint','zephyr','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  await views.prepareRecallContext('reader','direct',roster);const access=issue(roster);
  const before=index.lexicalViewPage(db,'zephyr',access.view,20);
  const other=ensureScope('conversation','private');
  for(let n=0;n<100;n++)db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','zephyr','owner-statement','active',1,1,NULL,NULL,1)").run(`denied-${n}`,other);
  while(!views.maintainRecallViewSlice(access.view)){}
  expect(index.lexicalViewPage(db,'zephyr',access.view,20)).toEqual(before);
});
it('A9 a linked person may use S(P) for lineage while recall stays thread-local', async () => {
  const views=await import('./recall-view.ts');const roster=rosterFixture();reconcileMemoryRoster(roster);
  const db=database(),scope=ensureScope('preferences','person:fixture-person');
  const binding={id:'human-binding:fixture',origin:{platform:'slack',connectionId:'fixture',authorityId:'fixture',userId:'fixture'},personId:'fixture-person',revision:1,active:true};
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-binding',?,1,'granted',?)").run(binding.id,scope,binding.id,JSON.stringify(binding));
  const principal={personId:'fixture-person',bindingId:binding.id,revision:1};
  for(const thread of ['direct','private','room-thread'])db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-thread',?,1,'granted',?)").run(`human-thread:${thread}`,scope,thread,JSON.stringify(principal));
  await views.prepareRecallContext('reader','direct',roster);
  const registry=new InternalCapabilities();registry.begin('reader','direct','generation',principal);
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false,humanPrincipal:principal});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster),privateScope=ensureScope('conversation','private');
  expect(views.recallViewHasScope(db,access.view,privateScope)).toBe(false);
  expect(views.recallViewHasScope(db,access.view,privateScope,true)).toBe(true);
  await views.prepareRecallContext('reader','room-thread',roster);
  const policy=await import('./policy.ts'),early=policy.preparationLineageAudience('reader','room-thread',roster,principal,false),roomScope=ensureScope('room','room');
  expect(early.personOnly).toBe(true);
  expect(views.recallViewHasScope(db,early.view!,roomScope,true)).toBe(true);
  expect(views.recallViewHasScope(db,early.view!,roomScope,true,true)).toBe(false);
});
it('A2 contexts keep owner, unproven and room bindings separate',async()=>{
  const views=await import('./recall-view.ts'),roster=rosterFixture();reconcileMemoryRoster(roster);
  await views.prepareRecallContext('reader','direct',roster,false);await views.prepareRecallContext('reader','direct',roster,true);await views.prepareRecallContext('reader','room-thread',roster,false);
  const own=issue(roster),unproven=issue(roster,'direct',true),room=issue(roster,'room-thread');
  const botScope=ensureScope('bot','reader');
  expect(views.recallViewHasScope(database(),own.view,botScope)).toBe(true);
  expect(views.recallViewHasScope(database(),unproven.view,botScope)).toBe(false);
  expect(own.view.viewId).not.toBe(room.view.viewId);
});
it('A3 exclusions and another holder of an owned thread remain hard denials',async()=>{
  const views=await import('./recall-view.ts'),roster=rosterFixture();
  roster.bots[0].tasks!.push({threadId:'alias'});roster.bots[1].tasks=[{threadId:'alias'}];reconcileMemoryRoster(roster);
  const db=database(),scope=ensureScope('workspace','fixture-settings');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','settings',0,'granted','{\"excludedThreadIds\":[\"task\"]}')").run(scope);
  await views.prepareRecallContext('reader','direct',roster);const access=issue(roster);
  expect(views.recallViewHasScope(db,access.view,ensureScope('conversation','task'))).toBe(false);
  expect(views.recallViewHasScope(db,access.view,ensureScope('conversation','alias'))).toBe(false);
});
it('A4 an isolated partition cannot acquire bot memory through an explicit grant',async()=>{
  const views=await import('./recall-view.ts'),execution=await import('../execution-audience.ts');
  const previous=execution.executionStore();const roster=rosterFixture();
  roster.bots[0].partitionedAt=1;roster.bots[0].tasks!.push({threadId:'isolated',sharedWork:{teamId:'fixture-team',quarantined:true}});
  const store=Object.assign(roster,{bot:(id:string)=>roster.bots.find(bot=>bot.id===id),taskByThread:(id:string,thread:string)=>roster.bots.find(bot=>bot.id===id)?.tasks?.find(task=>task.threadId===thread)});
  execution.setExecutionStore(store as unknown as import('../store.ts').Store);
  try {
    reconcileMemoryRoster(roster);const db=database(),scope=ensureScope('project','fixture-project');
    db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-grant',?,'bot','reader',0,'granted','{}')").run(scope);
    await views.prepareRecallContext('reader','isolated',roster);const access=issue(roster,'isolated');
    expect(views.recallViewHasScope(db,access.view,scope)).toBe(false);
    expect(views.recallViewHasScope(db,access.view,ensureScope('bot','reader'))).toBe(false);
    expect(views.recallViewHasScope(db,access.view,ensureScope('conversation','isolated'))).toBe(true);
  } finally {execution.setExecutionStore(previous as import('../store.ts').Store);}
});
