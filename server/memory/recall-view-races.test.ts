// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { assertMemoryAccess, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const roster: MemoryRoster = {memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'}],groups:[]}; reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin('reader','direct','generation');
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  return {roster,issue:()=>memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster)};
}
it('A5 rejects an issued generation after scope additions as well as revocations', async () => {
  const views=await import('./recall-view.ts'), f=fixture(); await views.prepareRecallContext('reader','direct',f.roster);
  const access=f.issue(); database().prepare("INSERT INTO memory_scopes VALUES('added','project','fixture','[]',0)").run();
  database().prepare("INSERT INTO memory_scope_bindings VALUES('fixture-grant','added','bot','reader',0,'granted','{}')").run();
  expect(()=>assertMemoryAccess(access)).toThrow();
  await views.prepareRecallContext('reader','direct',f.roster);
  // MAIN RULING 2026-11-14 design section 4: indexed issued/current intersection preserves old grants and denies additions.
  expect(()=>assertMemoryAccess(access,'added')).toThrow('MEMORY_SCOPE_DENIED');
  expect(()=>assertMemoryAccess(f.issue(),'added')).not.toThrow();
});
it('A11 forged handles and incomplete or stale publication fail closed', async () => {
  const views=await import('./recall-view.ts'), f=fixture(); await views.prepareRecallContext('reader','direct',f.roster);
  const access=f.issue();
  expect(()=>assertMemoryAccess({...access,view:{...access.view,digest:'forged'}})).toThrow('MEMORY_UNAUTHORIZED');
  database().prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=?").run(access.view.viewId);
  expect(()=>assertMemoryAccess(access)).toThrow();
});

it('A8 a second connection commit invalidates admission immediately', async () => {
  const views=await import('./recall-view.ts'),{DatabaseSync}=await import('../sqlite-open.ts'),{join}=await import('node:path');
  const f=fixture();await views.prepareRecallContext('reader','direct',f.roster);const access=f.issue();
  const second=new DatabaseSync(join(DATA_DIR,'messages.db'));
  try {second.exec("INSERT INTO memory_scopes VALUES('external','project','fixture-external','[]',0)");} finally {second.close();}
  expect(()=>assertMemoryAccess(access)).toThrow();
});
it('A8 authority changed while helper work was suspended is never delivered', async () => {
  const views=await import('./recall-view.ts'),{searchMemory}=await import('./search.ts'),{LineageAllowance}=await import('./lineage-allowance.ts');
  const f=fixture();await views.prepareRecallContext('reader','direct',f.roster);const access=f.issue();
  await expect(searchMemory('fixture',access,{async search(){await new Promise<void>(resolve=>setImmediate(resolve));database().exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'");return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool(1_000_000_000),lexical:null})).rejects.toThrow();
});
it('A11 authenticated cursors cannot cross reader bindings or view generations', async () => {
  const views=await import('./recall-view.ts'),{sealMemoryCursor,openMemoryCursor}=await import('./cursor.ts');
  const f=fixture();await views.prepareRecallContext('reader','direct',f.roster);const access=f.issue();
  const cursor=sealMemoryCursor('["fixture",1]',access,false);
  expect(openMemoryCursor(cursor,access,false)).toBe('["fixture",1]');
  expect(()=>openMemoryCursor(cursor,{...access,threadId:'elsewhere'},false)).toThrow('INVALID_MEMORY_CURSOR');
  await views.prepareRecallContext('reader','direct',f.roster);expect(()=>openMemoryCursor(cursor,f.issue(),false)).toThrow('INVALID_MEMORY_CURSOR');
});
it('RED-3 helper restart reads the same bounded view and refuses forged metadata',async()=>{
  const views=await import('./recall-view.ts'),{MemoryEligibility}=await import('./eligibility.ts'),{join}=await import('node:path');
  const f=fixture();await views.prepareRecallContext('reader','direct',f.roster);const access=f.issue();
  const input={view:access.view,reader:{botId:access.botId,threadId:access.threadId,humanPrincipal:access.humanPrincipal,notOwnerAudience:false},scopeIds:[],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:false,cursor:''};
  const before=views.recallViewCounters().oracleComputes;
  let first:unknown;
  for(let n=0;n<2;n++) {const helper=new MemoryEligibility(join(DATA_DIR,'messages.db'));try {const answer=helper.read(input);if(n===0)first=answer;else expect(answer).toEqual(first);expect(()=>helper.read({...input,view:{...input.view,digest:'x'.repeat(64)}})).toThrow('MEMORY_RECALL_UNAVAILABLE');}finally{helper.close();}}
  expect(views.recallViewCounters().oracleComputes).toBe(before);
});
it('A8 final callback revocation is checked before returning any result',async()=>{
  const views=await import('./recall-view.ts'),{searchMemory}=await import('./search.ts'),{LineageAllowance}=await import('./lineage-allowance.ts');
  const f=fixture();await views.prepareRecallContext('reader','direct',f.roster);const access=f.issue();
  await expect(searchMemory('fixture',access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool(1_000_000_000),lexical:null,telemetry(){database().exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'");}})).rejects.toThrow('MEMORY_CONTEXT_REVOKED');
});
it('A8 partition identity writes also invalidate the durable reader epoch',async()=>{
  const views=await import('./recall-view.ts'),f=fixture();await views.prepareRecallContext('reader','direct',f.roster);const access=f.issue();
  database().prepare("INSERT INTO team_identities(team_id,label,created_at,updated_at) VALUES('fixture-team','Fixture team',1,1)").run();
  expect(()=>assertMemoryAccess(access)).toThrow();
});
it('A8 replacing a grant with a non-authority binding cannot retain the old grant',async()=>{
  const views=await import('./recall-view.ts'),{ensureScope}=await import('./policy.ts'),f=fixture(),db=database();
  const scope=ensureScope('project','fixture-project');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-grant',?,'bot','reader',0,'granted','{}')").run(scope);
  await views.prepareRecallContext('reader','direct',f.roster);const access=f.issue();
  expect(()=>assertMemoryAccess(access,scope)).not.toThrow();
  // REPLACE does not fire DELETE triggers with recursive_triggers off. The insert fence must inspect the previous row too.
  db.prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('fixture-grant',?,'system','fixture-state',0,'granted','{}')").run(scope);
  expect(()=>assertMemoryAccess(access,scope)).toThrow();
});

// Recall scheduling producer owner: recall-scope; regression repair owner: c4-misc-a2.
it('structural revision changes during a yielded build release the old scheduling stamp', async () => {
  const views=await import('./recall-view.ts'),f=fixture();
  // MAIN RULING 1114-RECALL-S4-FIXTURES: 106 contexts stay inside the unchanged
  // 128-view cap while still yielding construction; pressure survival belongs to S7 below.
  f.roster.bots[0]!.tasks=Array.from({length:52},(_,index)=>({threadId:`owned-${index}`}));
  reconcileMemoryRoster(f.roster);
  views.prepareRosterRecallViews(f.roster);
  await new Promise<void>(resolve=>setImmediate(resolve));
  f.roster.memoryRosterRevision!++;
  reconcileMemoryRoster(f.roster);
  await views.waitForRecallConstructionIdleForTest(f.roster);
  views.prepareRosterRecallViews(f.roster);
  await views.waitForRecallConstructionIdleForTest(f.roster);
  expect(()=>f.issue()).not.toThrow();
},30_000);
// MAIN RULING 1114-RECALL-S4-FIXTURES. Producer/repair owner: recall-scope S7
// (capacity accounting and eviction); fixture consumer owner: c4-misc-a2.
// Kept red and visible until S7: the original 512-task admission contract is unchanged.
it('S7 capacity: original reader stays admitted after 512 tasks and a yielded revision change', async () => {
  const views=await import('./recall-view.ts'),f=fixture();
  f.roster.bots[0]!.tasks=Array.from({length:512},(_,index)=>({threadId:`owned-${index}`}));
  reconcileMemoryRoster(f.roster);
  views.prepareRosterRecallViews(f.roster);
  await new Promise<void>(resolve=>setImmediate(resolve));
  f.roster.memoryRosterRevision!++;
  reconcileMemoryRoster(f.roster);
  await views.waitForRecallConstructionIdleForTest(f.roster);
  views.prepareRosterRecallViews(f.roster);
  await views.waitForRecallConstructionIdleForTest(f.roster);
  expect(()=>f.issue()).not.toThrow();
},30_000);
it('a matching cached revision cannot suppress repair of an unavailable publication', async () => {
  const views=await import('./recall-view.ts'),f=fixture();
  await views.prepareRecallContext('reader','direct',f.roster);
  const prior=f.issue();
  database().prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=?").run(prior.view.viewId);
  expect(()=>f.issue()).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await views.waitForRecallConstructionIdleForTest(f.roster);
  expect(()=>f.issue()).not.toThrow();
  database().exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'");
  expect(()=>f.issue()).toThrow();
});
