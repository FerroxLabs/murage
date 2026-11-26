// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { assertMemoryAccess, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
// q1022-upgradecatchup (CHANGED-EXPECTATIONS.md): this file's rows predate the build pace (recall-view.ts RECALL_BUILD_BYTES_PER_MINUTE) and test what is reclaimed and built, not how fast; the pace is opened for them. The pace has its own witnesses (upgrade-catchup-1022.test.ts W-PACE, W-CAP, W-STEADY).
beforeEach(async () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); (await import('./recall-view.ts')).setRecallBuildPaceForTest(Infinity); });
function fixture() {
  const roster: MemoryRoster = {memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'}],groups:[]}; reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin('reader','direct','generation');
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  return {roster,registry,issue:()=>memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster)};
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

// Repair owner: askcards-flake-a; publication/collection owner: recall-scope.
it('storage pressure collects stale contexts without evicting the running reader', async () => {
  const views = await import('./recall-view.ts'), f = fixture(), db = database();
  await views.prepareRecallContext('reader', 'direct', f.roster);
  const access = f.issue();
  const epoch = views.recallAuthorityEpoch(db);
  // Deleted readers can leave publications behind. Fill the unchanged cap
  // with obsolete contexts whose keys sort after the live owner's context.
  const insert = db.prepare(`INSERT INTO memory_recall_views
    (view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader)
    VALUES(?,?,?,1,'ready',1,'fixture',0)`);
  for (let n = 0; n < 127; n++) {
    const id = `stale-${n}`;
    insert.run(id, 'generation', epoch - 1);
    db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run(JSON.stringify([id]), id, 'generation');
  }
  expect(() => views.prepareRecallContextSync('reader', 'direct', f.roster, true)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
  // Force the maintenance interleaving between preparation and submission.
  views.collectRecallViewSlice(db);
  views.collectRecallViewSlice(db);
  expect(() => assertMemoryAccess(access)).not.toThrow();
  expect(db.prepare("SELECT count(*) AS n FROM memory_recall_contexts WHERE context_key LIKE '%stale-%'").get()!.n).toBe(126);
});

// Reader lifetime and capacity repair owner: askcards-flake-b; integration owner: MAIN.
it('saturation reclaims the oldest idle current-epoch context while every live reader survives', async () => {
  const views = await import('./recall-view.ts'), f = fixture(), db = database();
  f.roster.bots[0]!.tasks = Array.from({length:128}, (_, n) => ({threadId:`idle-${n}`}));
  reconcileMemoryRoster(f.roster);
  await views.prepareRecallContext('reader', 'direct', f.roster);
  views.stopRecallViewMaintenance();
  const access = f.issue(), second = new InternalCapabilities();
  second.begin('reader', 'direct', 'second');
  const token = second.mint({botId:'reader',threadId:'direct',generation:'second',kind:'memory',depth:0,skillAuthoring:false});
  const other = memoryAccess(second, second.resolve(`Bearer ${token}`)!, () => f.roster);
  try {
    for (let n = 127; n > 0; n--) views.prepareRecallContextSync('reader', `idle-${n}`, f.roster);
    const oldest = db.prepare("SELECT view_id FROM memory_recall_contexts WHERE context_key LIKE '%\"idle-127\"%'").get()!;
    expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views WHERE authority_epoch=?').get(views.recallAuthorityEpoch(db))!.n).toBe(128);
    expect(() => views.prepareRecallContextSync('reader', 'idle-0', f.roster)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    for (let n = 0; n < 20; n++) views.collectRecallViewSlice(db);
    expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(oldest.view_id)).toBeUndefined();
    views.prepareRecallContextSync('reader', 'idle-0', f.roster);
    const incoming = new InternalCapabilities();
    incoming.begin('reader', 'idle-0', 'incoming');
    const next = incoming.mint({botId:'reader',threadId:'idle-0',generation:'incoming',kind:'memory',depth:0,skillAuthoring:false});
    try { expect(memoryAccess(incoming, incoming.resolve(`Bearer ${next}`)!, () => f.roster).view).toBeDefined(); }
    finally { incoming.revokeAll(); }
    expect(() => assertMemoryAccess(access)).not.toThrow();
    f.registry.revokeAll();
    expect(() => views.prepareRecallContextSync('reader', 'idle-127', f.roster)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    for (let n = 0; n < 20; n++) views.collectRecallViewSlice(db);
    expect(() => assertMemoryAccess(other)).not.toThrow();
    views.prepareRecallContextSync('reader', 'idle-127', f.roster);
    second.revokeAll();
    expect(() => views.prepareRecallContextSync('reader', 'direct', f.roster, true)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    for (let n = 0; n < 20; n++) views.collectRecallViewSlice(db);
    expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(access.view.viewId)).toBeUndefined();
  } finally { f.registry.revokeAll(); second.revokeAll(); }
});

it('collection preserves a live issued view after its context is superseded and releases it on failure', async () => {
  const views = await import('./recall-view.ts'), f = fixture(), db = database();
  await views.prepareRecallContext('reader', 'direct', f.roster);
  const access = f.issue();
  await expect((async () => { try {
    await views.prepareRecallContext('reader', 'direct', f.roster);
    const add=db.prepare(`INSERT INTO memory_recall_views
      (view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader)
      VALUES(?,'generation',?,1,'ready',1,'fixture',0)`);
    for(let n=0;n<126;n++)add.run(`orphan-${n}`,views.recallAuthorityEpoch(db));
    expect(()=>views.prepareRecallContextSync('reader','direct',f.roster,true)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    for (let n = 0; n < 160; n++) views.collectRecallViewSlice(db);
    expect(() => assertMemoryAccess(access)).not.toThrow();
    throw new Error('fixture failure');
  } finally { f.registry.revokeAll(); } })()).rejects.toThrow('fixture failure');
  for (let n = 0; n < 20; n++) views.collectRecallViewSlice(db);
  expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(access.view.viewId)).toBeUndefined();
});

it('collector releases an expired reader even without another capability lookup', async () => {
  const views=await import('./recall-view.ts'), f=fixture(), db=database();
  await views.prepareRecallContext('reader','direct',f.roster);
  let now=1;
  const registry=new InternalCapabilities({now:()=>now,orphanMs:10});
  registry.begin('reader','direct','expiring');
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'expiring',kind:'memory',depth:0,skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>f.roster);
  try {
    await views.prepareRecallContext('reader','direct',f.roster);
    now=11;
    for(let n=0;n<20;n++)views.collectRecallViewSlice(db);
    expect(db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(access.view.viewId)).toBeUndefined();
  } finally {registry.revokeAll();}
});

it('failed recovered approval delivery releases its private reader in finally', async () => {
  const views=await import('./recall-view.ts'), authority=await import('./authority.ts'), f=fixture();
  await views.prepareRecallContext('reader','direct',f.roster);
  const access=f.issue();
  const dir=join(DATA_DIR,'decision-queues');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'memory.json'),JSON.stringify({version:1,entries:[{state:'waiting',item:{
    kind:'memory',ref:'fixture',epoch:'epoch',approvalId:'approval',proof:{},
    call:{tool:'memory_save',input:{candidateId:'missing',version:1},approval:{queueRef:'fixture',epoch:'epoch',action:{tool:'memory_save'}}},
  }}]}));
  const uninstall=authority.installMemoryApprovalAccess(()=>({access,release:()=>f.registry.revokeAll()}));
  try {
    const queue=authority.memoryApprovalQueue();
    expect(queue.respondNow(queue.pendingApprovals()[0],{behavior:'allow'},{answerId:'answer'})).toEqual({state:'failed'});
    expect(f.registry.activeGeneration('direct')).toBeUndefined();
    await views.prepareRecallContext('reader','direct',f.roster);
    for(let n=0;n<20;n++)views.collectRecallViewSlice(database());
    expect(database().prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(access.view.viewId)).toBeUndefined();
  } finally {uninstall();f.registry.revokeAll();}
});
