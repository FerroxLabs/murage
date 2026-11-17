// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: recall-audit owns the projection/search/view fixes and these consumers.
import { OWNER_PIN } from './schema.ts';
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { collectRecallViewSlice, prepareRecallContext, prepareRecallContextSync, recallContextKey, resolveRecallView, stopRecallViewMaintenance } from './recall-view.ts';
import { setMemoryMode } from './repository.ts';
import { searchMemory, clearMemorySearchCache } from './search.ts';
import { RecallWorkBudget, RECALL_TEXT_LIMIT } from './recall-view-index.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { buildMemoryBundle } from './bundle.ts';
import { OWNER } from '../human-principals.ts';

beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});clearMemorySearchCache();});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(tasks=0) {
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:Array.from({length:tasks},(_,n)=>({threadId:`task-${String(n).padStart(3,'0')}`}))},{id:'other',threadId:'private'}],groups:[]};
  reconcileMemoryRoster(roster);setMemoryMode('active');
  const registry=new InternalCapabilities();registry.begin('reader','direct','generation');
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  return {roster,registry,issue:()=>memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster)};
}
const empty={async search(){return {hits:[],vectorRows:0};}};

it('audit 1: an authoritative pin survives capture lag through dispatch assembly',async()=>{
  const f=fixture(),db=database(),scope=ensureScope('bot','reader');
  db.prepare("INSERT INTO memory_records VALUES('constraint',1,?,'constraint','Keep the owner constraint.','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const access=f.issue();db.exec(OWNER_PIN.sql);db.exec("UPDATE memory_records SET owner_pinned=1 WHERE id='constraint'");
  const bundle=await buildMemoryBundle('',access,empty,{allowance:LineageAllowance.tool(1_000_000_000)});
  expect(bundle.pinned.map(pin=>pin.id)).toEqual(['constraint']);
  expect(bundle.text).toContain('Keep the owner constraint.');
});

it('audit 1: Stop takes precedence over a pending mandatory pin projection',async()=>{
  const f=fixture(),db=database(),scope=ensureScope('bot','reader');
  db.prepare("INSERT INTO memory_records VALUES('constraint',1,?,'constraint','Keep the owner constraint.','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const access=f.issue();db.exec("UPDATE memory_records SET owner_pinned=1 WHERE id='constraint'");
  const stop=new Error('fixture owner stopped');
  await expect(buildMemoryBundle('',access,empty,{allowance:LineageAllowance.tool(1_000_000_000),signal:AbortSignal.abort(stop)})).rejects.toBe(stop);
  f.registry.revokeThread('direct');
  await expect(buildMemoryBundle('',access,empty,{allowance:LineageAllowance.tool(1_000_000_000)})).rejects.toThrow('MEMORY_UNAUTHORIZED');
});

for(const helper of ['healthy','offline'] as const)it(`audit 2: common-term scanning leaves authorization capacity with helper ${helper}`,async()=>{
  const f=fixture(),db=database(),scope=ensureScope('bot','reader'),denied=ensureScope('conversation','private');
  db.exec('SAVEPOINT fixture_records');
  const put=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','commonword fixture','owner-statement','active',0,1,NULL,NULL,1)");
  for(let n=0;n<8193;n++)put.run(`record-${String(n).padStart(5,'0')}`,scope);
  put.run('private-record',denied);db.exec('RELEASE fixture_records');
  await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const budget=new RecallWorkBudget(8192);
  const result=await searchMemory('commonword',f.issue(),{async search(){
    if(helper==='offline')throw new Error('fixture helper offline');
    return {hits:[{id:'record-08192',version:1,score:1,lexical:true},{id:'private-record',version:1,score:2,lexical:true}],vectorRows:0};
  }},{workBudget:budget,allowance:LineageAllowance.tool(1_000_000_000),caller:'tool',limit:20});
  expect(result.hits).toHaveLength(20);
  expect(result.hits.every(hit=>hit.scopeId===scope)).toBe(true);
  expect(result.hits.map(hit=>hit.id)).not.toContain('private-record');
  expect(result.coverageComplete).toBe(false);
  expect(budget.raw).toBeLessThanOrEqual(8192);expect(budget.bytes).toBeLessThanOrEqual(RECALL_TEXT_LIMIT);
},120_000);

it('audit 2: an undersized request still hydrates the candidates its allowance can authorize',async()=>{
  const f=fixture(),db=database(),scope=ensureScope('bot','reader');
  const put=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','commonword fixture','owner-statement','active',0,1,NULL,NULL,1)");
  for(let n=0;n<80;n++)put.run(`small-${n}`,scope);
  await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const budget=new RecallWorkBudget(36);
  const result=await searchMemory('commonword',f.issue(),empty,{workBudget:budget,allowance:LineageAllowance.tool(1_000_000_000),limit:20});
  expect(result.hits.length).toBeGreaterThan(0);expect(result.hits.length).toBeLessThanOrEqual(20);
  expect(result.partial).toBe(true);expect(budget.raw).toBeLessThanOrEqual(36);
});

it('audit 2: Stop while a bounded search awaits its helper still revokes all hits',async()=>{
  const f=fixture();await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  await expect(searchMemory('commonword',f.issue(),{async search(){f.registry.revokeThread('direct');return {hits:[],vectorRows:0};}},
    {workBudget:new RecallWorkBudget(8192),allowance:LineageAllowance.tool(1_000_000_000)})).rejects.toThrow('MEMORY_UNAUTHORIZED');
});

it('audit 3: returning to a pressure-evicted context rebuilds without a roster change',async()=>{
  const f=fixture(130),db=database();stopRecallViewMaintenance();
  for(let n=0;n<128;n++)prepareRecallContextSync('reader',`task-${String(n).padStart(3,'0')}`,f.roster);
  expect(()=>prepareRecallContextSync('reader','task-129',f.roster)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
  const victim=String(db.prepare('SELECT context_key FROM memory_recall_contexts ORDER BY context_key LIMIT 1').get()!.context_key);
  const [botId,threadId,humanPrincipal,notOwnerAudience]=JSON.parse(victim);
  const binding={botId,threadId,humanPrincipal,notOwnerAudience};
  for(let n=0;n<100&&!collectRecallViewSlice(db);n++){/* bounded reclamation */}
  expect(db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(victim)).toBeUndefined();
  expect(()=>resolveRecallView(binding,f.roster)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  let recovered=false;
  for(let n=0;n<200;n++) {await tick();try {resolveRecallView(binding,f.roster);recovered=true;break;}catch{/* await queued build */}}
  expect(recovered).toBe(true);
  const restored=resolveRecallView(binding,f.roster);
  expect(db.prepare('SELECT 1 FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND scope_id=?').get(restored.handle.viewId,restored.handle.generation,ensureScope('conversation','private'))).toBeUndefined();
},120_000);

it('audit 3: a queued rebuild cannot publish across database close/restart',async()=>{
  const f=fixture();await prepareRecallContext('reader','direct',f.roster);stopRecallViewMaintenance();
  const binding={botId:'reader',threadId:'direct',humanPrincipal:OWNER,notOwnerAudience:false},key=recallContextKey(binding);
  database().prepare('DELETE FROM memory_recall_contexts WHERE context_key=?').run(key);
  expect(()=>resolveRecallView(binding,f.roster)).toThrow();
  closeDatabase();const restarted=database();await tick();await tick();
  expect(restarted.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(key)).toBeUndefined();
  await prepareRecallContext('reader','direct',f.roster);expect(resolveRecallView(binding,f.roster).handle).toBeDefined();
});
