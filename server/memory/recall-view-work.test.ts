// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { searchMemory } from './search.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { sendSearch } from './scope-set.ts';

// q1022-rvh (CHANGED-EXPECTATIONS.md, q1022-upgradecatchup build pace): this file's rows predate the build pace (recall-view.ts RECALL_BUILD_BYTES_PER_MINUTE) and test what is built, reclaimed and refused, not how fast; the pace is opened for them. The pace has its own witnesses (upgrade-catchup-1022.test.ts W-PACE, W-CAP, W-STEADY, W-TURN-PACE).
beforeEach(async () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); (await import('./recall-view.ts')).setRecallBuildPaceForTest(Infinity); });

async function sample(count: number, room: boolean, fallback: boolean) {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const views = await import('./recall-view.ts');
  const bot = { id: 'reader', threadId: 'direct', tasks: Array.from({length: count}, (_, i) => ({threadId: `owned-${i}`})) };
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [bot], groups: [{id: 'room', threadId: 'room-thread', memberIds: ['reader']}] };
  reconcileMemoryRoster(roster); setMemoryMode('active');
  const db = database(), scope = ensureScope('conversation', 'owned-0');
  db.prepare("INSERT INTO memory_records VALUES('expected',1,?,'constraint','zephyr fixture memory','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  const thread = room ? 'room-thread' : 'direct';
  await views.prepareRecallContext('reader', thread, roster);views.stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', thread, 'generation');
  const token = registry.mint({botId:'reader',threadId:thread,generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const before = views.recallViewCounters();
  let bytes = 0, messages = 0;
  // Poison all legacy scope consumers AFTER construction, before the measured turn.
  const poison = new Proxy([], { get() { throw new Error('turn enumerated scope array'); } });
  // Real access is immutable. The construction oracle itself must be untouched.
  views.poisonRecallScopeArraysForTest(access, poison);
  const result = await searchMemory('zephyr', access, { async search(input) {
    sendSearch(message => { messages++; bytes += Buffer.byteLength(JSON.stringify(message)); }, 'request', input);
    if (fallback) throw new Error('fixture helper outage');
    return {hits:[{id:'expected',version:1,score:1,lexical:true}],vectorRows:0};
  } }, {allowance: LineageAllowance.tool(1_000_000_000), lexical: null});
  expect(result.hits.map(hit => hit.id)).toEqual(['expected']);
  const after = views.recallViewCounters();
  return { bytes, messages, work: Object.fromEntries(Object.keys(before).map(key => [key, after[key as keyof typeof after] - before[key as keyof typeof before]])) };
}

it.each([false, true])('RED-1 active owner room=%s: 50 and 5000 owned scopes do equal logical work', async room => {
  expect(await sample(5000, room, false)).toEqual(await sample(50, room, false));
}, 120_000);
it.each([false, true])('RED-2 helper and lexical outage room=%s remain bounded and find the expected record', async room => {
  const large = await sample(5000, room, true), small = await sample(50, room, true);
  expect(large).toEqual(small);
  expect(large.messages).toBe(1);
}, 120_000);

it('RED-2 populated history, cache misses and pagination share hard raw and text ceilings', async () => {
  const views=await import('./recall-view.ts'),index=await import('./recall-view-index.ts');
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'}],groups:[]};reconcileMemoryRoster(roster);setMemoryMode('active');
  const db=database(),scope=ensureScope('conversation','direct'),put=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  db.exec('SAVEPOINT fixture_records');
  for(let n=0;n<20_000;n++)put.run(`record-${String(n).padStart(6,'0')}`,scope,n===0?'rarezephyr oldest fixture':'commonword fixture');
  db.exec('RELEASE fixture_records');
  db.prepare("UPDATE memory_records SET state='candidate' WHERE id='record-000001'").run();
  await views.prepareRecallContext('reader','direct',roster);views.stopRecallViewMaintenance();
  const registry=new InternalCapabilities();registry.begin('reader','direct','generation');const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster),budget=new index.RecallWorkBudget();
  expect(index.eligibleViewPage(db,access.view,'',2).map(ref=>ref.id)).toEqual(['record-000000','record-000001']);
  expect(index.lexicalViewPage(db,'rarezephyr',access.view,20,0,budget).hits.map(hit=>hit.id)).toEqual(['record-000000']);
  const common=new index.RecallWorkBudget();
  const first=index.lexicalViewPage(db,'commonword',access.view,100,0,common);
  expect(first.hits).toHaveLength(100);expect(first.bounded).toBe(true);
  console.log('recall storage benchmark',JSON.stringify({records:20_000,scopeCount:1,pages:db.prepare('PRAGMA page_count').get()?.page_count,pageSize:db.prepare('PRAGMA page_size').get()?.page_size,estimatedBytes:db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()?.bytes}));
  const next=index.lexicalViewPage(db,'commonword',access.view,100,100,common);
  expect(next.hits).toHaveLength(100);expect(next.hits[0].id).not.toBe(first.hits[0].id);
  expect(common.raw).toBeLessThanOrEqual(index.RECALL_RAW_LIMIT);
  expect(common.bytes).toBeLessThanOrEqual(index.RECALL_TEXT_LIMIT);
  for(const sql of [index.VIEW_RECORD_PAGE_SQL,index.VIEW_RECENT_PAGE_SQL,...index.VIEW_PENDING_PAGE_SQL,index.VIEW_JOBS_PAGE_SQL,index.VIEW_TERM_PAGE_SQL]) {
    const pending=index.VIEW_PENDING_PAGE_SQL.includes(sql);
    const args=sql===index.VIEW_RECORD_PAGE_SQL||pending?[access.view.viewId,access.view.generation,'',-1,10]:sql===index.VIEW_TERM_PAGE_SQL?[access.view.viewId,access.view.generation,'commonword',Number.MAX_SAFE_INTEGER,10]:[access.view.viewId,access.view.generation,Number.MAX_SAFE_INTEGER,10];
    const planRows=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
    // The pending page drives from the receipts' own pending index (key order), then probes view membership by key.
    expect(String(planRows[0].detail)).toMatch(pending?/SEARCH r USING (COVERING )?INDEX memory_projection_pending \(lexical_status=\?/:/SEARCH memory_recall_view_/);
    const plan=planRows.map(row=>String(row.detail)).join(' | ');
    expect(plan).toMatch(/SEARCH (memory_recall_view_|v USING PRIMARY KEY \(view_id=\? AND generation=\?)/);expect(plan).toMatch(/view_id=\? AND generation=\?/);expect(plan).not.toMatch(/SCAN memory_records|TEMP B-TREE/);
  }
},120_000);
it('RED-4 raw limits precede residual authorization, and oversized text is never hydrated', async () => {
  const views=await import('./recall-view.ts'),index=await import('./recall-view-index.ts');
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'}],groups:[]};reconcileMemoryRoster(roster);
  const db=database(),scope=ensureScope('conversation','direct');
  db.prepare("INSERT INTO memory_records VALUES('large',1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)").run(scope,'x'.repeat(index.RECALL_TEXT_LIMIT+1));
  await views.prepareRecallContext('reader','direct',roster);views.stopRecallViewMaintenance();
  const view=db.prepare('SELECT v.view_id,v.generation,v.digest FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation WHERE v.state=\'ready\' ORDER BY v.view_id LIMIT 1').get()!;
  const handle={viewId:String(view.view_id),generation:String(view.generation),digest:String(view.digest)},budget=new index.RecallWorkBudget();
  expect(index.recentViewPage(db,handle,Number.MAX_SAFE_INTEGER,10,budget)).toHaveLength(1);
  expect(index.viewRecordText(db,{id:'large',version:1},budget)).toBeNull();
  expect(budget.bytes).toBe(0);
},120_000);
it('RED-4 semantic scoring probes selected vectors without walking a resident matrix',async()=>{
  const {openTestIndex,put}=await import('./testing/open-index.ts'),{join}=await import('node:path');
  const index=await openTestIndex(join(DATA_DIR,'fixture-vector-index.db'));
  try {
    const record={id:'expected',version:1,scopeId:'fixture',text:'zephyr',deleted:false};await put(index,[record]);
    await index.vector(record,'fixture-model',0,[1,0]);
    // Every resident row is unrelated. Any iteration, including a bounded-result filter over values(), is a failure.
    (index as unknown as {matrix:unknown}).matrix={model:'fixture-model',coverage:null,rows:new Proxy(new Map(),{get(_t,key){if(key==='values'||key===Symbol.iterator)throw new Error('full resident-vector walk');return undefined;}})};
    const result=index.search('zephyr',[{id:'expected',version:1}],[1,0],'fixture-model',20,{words:false});
    expect(result.vectorRows).toBe(1);expect(result.vectorRanked[0]?.slice(0,2)).toEqual(['expected',1]);
  } finally {index.close();}
});

it('semantic continuation pages share one helper ceiling and a new request gets a new allowance',async()=>{
  const views=await import('./recall-view.ts'),{MemoryEligibility}=await import('./eligibility.ts'),{answerQuery}=await import('./worker-query.ts'),{join}=await import('node:path');
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'}],groups:[]};reconcileMemoryRoster(roster);
  const db=database(),scope=ensureScope('conversation','direct');
  db.exec('SAVEPOINT fixture_records');
  try {
    const put=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','fixture','owner-statement','active',0,1,NULL,NULL,1)");
    for(let n=0;n<9000;n++)put.run(`record-${String(n).padStart(6,'0')}`,scope);
  } finally {db.exec('RELEASE fixture_records');}
  await views.prepareRecallContext('reader','direct',roster);views.stopRecallViewMaintenance();
  const registry=new InternalCapabilities();registry.begin('reader','direct','generation');
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const input={view:access.view,reader:{botId:access.botId,threadId:access.threadId,humanPrincipal:access.humanPrincipal,notOwnerAudience:false},scopeIds:[],policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,historical:false,cursor:'',query:'absent',limit:10,semantic:true};
  const eligibility=new MemoryEligibility(join(DATA_DIR,'messages.db'));
  const index={search(_query:string,allowed:unknown[]){return {hits:[],vectorRows:allowed.length,lexicalRanked:[],vectorRanked:[],unvectored:[],unvectoredMore:false,timings:{}};}} as unknown as import('./index.ts').MemoryIndex;
  try {
    for(let n=0;n<2;n++) {
      const before=views.recallViewCounters().candidateVisits;
      const result=answerQuery(index,eligibility,input,[1,0],'fixture').result;
      expect(result.vectorRows).toBeGreaterThan(4096);
      expect(result.resumeAfter).toBeTruthy();
      expect(views.recallViewCounters().candidateVisits-before).toBeLessThanOrEqual(8192);
    }
  } finally {eligibility.close();}
},120_000);
