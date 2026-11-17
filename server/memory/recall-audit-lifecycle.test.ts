// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producers: recall-scope owns admitted views; store-patchbot owns roster revisions.
// Consumer: recall-audit-b owns these lifecycle and bounded-work regressions.
import { OWNER_PIN } from './schema.ts';
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { assertMemoryAccess, ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { prepareRecallContext, recallViewCounters, stopRecallViewMaintenance } from './recall-view.ts';
import { setMemoryMode } from './repository.ts';
import { buildMemoryBundle } from './bundle.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { recallPreparationFailure } from './recall-recovery.ts';
import { captureSource } from './capture.ts';
import { sqlWork } from './testing/sql-work.ts';

beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
function fixture() {
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'},{id:'other',threadId:'private'}],groups:[]};
  reconcileMemoryRoster(roster);setMemoryMode('active');
  const registry=new InternalCapabilities();registry.begin('reader','direct','generation');
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  return {roster,issue:()=>memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster)};
}
const empty={async search(){return {hits:[],vectorRows:0};}};

for(const appends of [1,600])it(`C1: a current reader catches up its own view after ${appends} message captures`,async()=>{
  const f=fixture();await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const access=f.issue(),db=database();db.exec(OWNER_PIN.sql);
  // Exercise the actual message-capture writer, rather than manufacturing a stale watermark.
  for(let n=0;n<appends;n++)captureSource(db,{id:`fixture-message-${n}`,threadId:'direct',kind:'text',speaker:'owner',outcome:'recorded',text:`Fixture message ${n}.`});
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_jobs').get()!.n)).toBe(appends);
  const result=await buildMemoryBundle('',access,empty,{allowance:LineageAllowance.tool(1_000_000_000)});
  expect(result.pinned).toEqual([]);
});

it('H1: a ready persisted view admits after restart without rebuilding memory history',async()=>{
  const {Store}=await import('../store.ts'),views=await import('./recall-view.ts');
  const makeStore=()=>new Store(()=>({instanceId:'fixture',model:'model'}));
  let roster=makeStore();
  roster.createBot({name:'Reader'},{seedMessages:false});roster.createBot({name:'Other'},{seedMessages:false});
  roster.finishSharingBoot();setMemoryMode('active');
  await views.waitForRecallConstructionIdleForTest(roster);stopRecallViewMaintenance();
  const reader=roster.bots[0],registry=new InternalCapabilities();registry.begin(reader.id,reader.threadId,'generation');
  const token=registry.mint({botId:reader.id,threadId:reader.threadId,generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  const issue=()=>memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const original=issue().view;
  closeDatabase();const db=database();
  expect(db.prepare("SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?").get(original.viewId,original.generation)?.state).toBe('ready');
  // S4 boot uses the real Store certificate and background hydration. Keep the
  // whole-boot no-history proof separate from the no-oracle-on-admission proof.
  const sql:string[]=[],prepare=db.prepare.bind(db);
  const probe=vi.spyOn(db,'prepare').mockImplementation(query=>{sql.push(query);return prepare(query);});
  try {
    roster=makeStore();roster.finishSharingBoot();
    await views.waitForRecallConstructionIdleForTest(roster);stopRecallViewMaintenance();
    const before=recallViewCounters().oracleComputes;
    expect(issue().view).toEqual(original);
    expect(recallViewCounters().oracleComputes).toBe(before);
    expect(sql.filter(query=>/FROM memory_(records|jobs)\b/i.test(query))).toEqual([]);
  } finally {probe.mockRestore();}
});

it('H1: unchanged startup reconciliation preserves a ready persisted authority epoch',async()=>{
  const f=fixture();await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const before=Number(database().prepare('SELECT epoch FROM memory_recall_epoch').get()!.epoch);
  closeDatabase();database();reconcileMemoryRoster(f.roster,{unlessUnchanged:true});
  expect(Number(database().prepare('SELECT epoch FROM memory_recall_epoch').get()!.epoch)).toBe(before);
});

it('H1: a roster rebuild does not walk unrelated private memory history per context',async()=>{
  const f=fixture(),db=database(),privateScope=ensureScope('conversation','private');
  await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const put=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','Private fixture.','owner-statement','active',0,1,NULL,NULL,1)");
  for(let n=0;n<1025;n++)put.run(`private-${n}`,privateScope);
  f.roster.memoryRosterRevision!++;f.roster.bots.push({id:'new-reader',threadId:'new-direct'});
  reconcileMemoryRoster(f.roster);
  // This measured rebuild has no asynchronous interleaving on the explicit
  // fixture boundary; it is the same builder used by the yielding background path.
  const views=await import('./recall-view.ts');
  const {work}=sqlWork(db,()=>views.prepareRecallContextSync('reader','direct',f.roster));
  const historyWalk=[...work.sqls].filter(([sql])=>/FROM memory_records WHERE rowid>/.test(sql));
  expect(historyWalk.reduce((n,[,calls])=>n+calls,0)).toBe(0);
  expect(()=>assertMemoryAccess(f.issue(),privateScope)).toThrow('MEMORY_SCOPE_DENIED');
});

it('M3: an actual out-of-view scope denial stays a denial through recovery',async()=>{
  const f=fixture(),privateScope=ensureScope('conversation','private');
  await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  let failure:unknown;
  try {assertMemoryAccess(f.issue(),privateScope);}catch(error){failure=error;}
  expect(failure).toMatchObject({message:'MEMORY_SCOPE_DENIED'});
  expect(recallPreparationFailure(failure)).toBe(failure);
});

it('M1: retired generations do not consume the live context admission cap',async()=>{
  const f=fixture();
  for(let n=0;n<128;n++)await prepareRecallContext('reader','direct',f.roster);
  stopRecallViewMaintenance();
  expect(Number(database().prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n)).toBe(1);
  await expect(prepareRecallContext('reader','direct',f.roster)).resolves.toBeUndefined();
},120_000);

it('H1: a crash during a yielding rebuild cannot publish the interrupted generation after restart',async()=>{
  const f=fixture();
  const pending=prepareRecallContext('reader','direct',f.roster).catch(error=>error);
  closeDatabase();const restarted=database();
  await expect(pending).resolves.toBeInstanceOf(Error);
  expect(restarted.prepare("SELECT 1 FROM memory_recall_contexts").get()).toBeUndefined();
  expect(()=>f.issue()).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await prepareRecallContext('reader','direct',f.roster);
  expect(f.issue().view).toBeDefined();
});
