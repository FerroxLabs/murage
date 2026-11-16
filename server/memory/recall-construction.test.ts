// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: store-patchbot (revisioned roster). Consumer owner: recall-scope (construction and publication).
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { legacyRecallScopes, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { constructionJson } from './recall-construction.ts';
import { prepareRecallContext, RECALL_BUILD_SLICE } from './recall-view.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
function issue(roster:MemoryRoster) {
  const registry=new InternalCapabilities(),generation=registry.begin('reader','direct');
  const token=registry.mint({botId:'reader',threadId:'direct',generation,depth:0,kind:'memory',skillAuthoring:false});
  return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
}
it('construction yields while walking, sorting and hashing 5,000 scopes and publishes the exact oracle',async()=>{
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:Array.from({length:5000},(_,n)=>({threadId:`task-${n}`}))}],groups:[]};
  reconcileMemoryRoster(roster);
  let reads=0,maxReads=0,turns=0,active=true;
  roster.bots[0].tasks=new Proxy(roster.bots[0].tasks!,{get(target,key,receiver){if(active&&typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});
  const heartbeat=()=>{if(!active)return;turns++;maxReads=Math.max(maxReads,reads);reads=0;setImmediate(heartbeat);};
  setImmediate(heartbeat);
  try {
    const preparation=prepareRecallContext('reader','direct',roster);
    expect(reads).toBeLessThanOrEqual(RECALL_BUILD_SLICE);
    expect(()=>issue(roster)).toThrow('MEMORY_RECALL_UNAVAILABLE');
    await preparation;
    maxReads=Math.max(maxReads,reads);
    expect(maxReads).toBeLessThanOrEqual(RECALL_BUILD_SLICE);
    expect(turns).toBeGreaterThan(20);
  } finally {active=false;}
  const access=issue(roster);
  const actual=database().prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? ORDER BY scope_id').all(access.view.viewId,access.view.generation).map(row=>String(row.scope_id));
  expect(actual).toEqual([...new Set(legacyRecallScopes('reader','direct',roster))].sort());
},120_000);
it('a structural commit during construction never publishes a partial or stale view',async()=>{
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:Array.from({length:5000},(_,n)=>({threadId:`task-${n}`}))}],groups:[]};
  reconcileMemoryRoster(roster);
  const preparation=prepareRecallContext('reader','direct',roster);
  database().prepare("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'").run();
  await expect(preparation).rejects.toThrow('MEMORY_CONTEXT_REVOKED');
  expect(database().prepare("SELECT 1 FROM memory_recall_views WHERE state='ready'").get()).toBeUndefined();
  expect(()=>issue(roster)).toThrow('MEMORY_POLICY_PENDING');
});
it('streamed construction JSON preserves exact bytes at escape and surrogate boundaries',()=>{
  const value=['a'.repeat(2047)+'😀\\"\n\ud800','\udfff',{nested:['z',false,null,1],absent:undefined}];
  expect([...constructionJson(value)].join('')).toBe(JSON.stringify(value));
});
it('a superseded build cannot replace the newer context and collection preserves its active builder',async()=>{
  const {collectRecallViewSlice}=await import('./recall-view.ts');
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:Array.from({length:5000},(_,n)=>({threadId:`task-${n}`}))}],groups:[]};
  reconcileMemoryRoster(roster);
  const older=prepareRecallContext('reader','direct',roster);
  const newer=prepareRecallContext('reader','direct',roster);
  await expect(older).rejects.toThrow('MEMORY_CONTEXT_REVOKED');
  collectRecallViewSlice(database());
  await newer;
  expect(issue(roster).view).toBeDefined();
  expect(database().prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()?.n).toBe(1);
},120_000);
