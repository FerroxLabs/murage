// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Recall projection/deletion consumer: c3-memory-side; producer: recall-scope.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { prepareRecallContext, maintainRecallViewSlice, stopRecallViewMaintenance, startRecallViewMaintenance, assertRecallView } from './recall-view.ts';
import { buildMemoryBundle } from './bundle.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { advanceRevocationJob, forgetJob } from './memory-revocation.ts';
import { setMemoryMode } from './repository.ts';

beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
async function fixture(pinned=0) {
  const roster:MemoryRoster={memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct'}],groups:[]};
  reconcileMemoryRoster(roster);setMemoryMode('active');const db=database(),scope=ensureScope('bot','reader');
  db.prepare("INSERT INTO memory_records VALUES('constraint',1,?,'constraint','zephyr secret fixture','owner-statement','active',?,1,NULL,NULL,1)").run(scope,pinned);
  await prepareRecallContext('reader','direct',roster);stopRecallViewMaintenance();
  const registry=new InternalCapabilities();registry.begin('reader','direct','generation');
  const token=registry.mint({botId:'reader',threadId:'direct',generation:'generation',depth:0,kind:'memory',skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const bundle=()=>buildMemoryBundle('',access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool(1_000_000_000)});
  return {db,roster,access,bundle};
}
it('BLOCK deletion debt drains terms from retained stale and superseded views before completion, across restart',async()=>{
  const {db,roster,access}=await fixture(1);
  await prepareRecallContext('reader','direct',roster);stopRecallViewMaintenance();
  // Retain the obsolete generation too: collection is not a deletion guarantee.
  db.prepare("INSERT INTO memory_recall_contexts VALUES('retained',?,?)").run(access.view.viewId,access.view.generation);
  const initial=Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms').get()!.n);expect(initial).toBeGreaterThan(2);
  db.exec("UPDATE memory_records SET state='deleted',text='',owner_pinned=0 WHERE id='constraint'; UPDATE memory_meta SET deletion_epoch=deletion_epoch+1");
  expect(()=>assertRecallView(db,access.view)).toThrow();
  let job=forgetJob({id:'fixture-deletion',phases:['expand','done'],record:{id:'constraint',rev:1,notes:false}});
  // One row per slice, round-trip the durable cursor after every commit and reopen.
  let finished=false;
  for(let n=0;n<100&&!finished;n++) {
    finished=transaction(d=>advanceRevocationJob(d,job,1));
    if(!finished) {
      const saved=JSON.stringify(job);closeDatabase();database();job=JSON.parse(saved);
    }
  }
  expect(finished).toBe(true);
  expect(database().prepare('SELECT count(*) AS n FROM memory_recall_view_terms').get()!.n).toBe(0);
});
it('BLOCK a turn immediately after pinning refuses an incomplete projection',async()=>{
  const {db,bundle}=await fixture();await bundle();
  db.exec("UPDATE memory_records SET owner_pinned=1 WHERE id='constraint'");
  await expect(bundle()).rejects.toThrow('MEMORY_RECALL_UNAVAILABLE');
});
it('BLOCK pin omission cannot survive maintenance under the same authority pin stamp',async()=>{
  const {db,access,bundle}=await fixture();await bundle();
  db.exec("UPDATE memory_records SET owner_pinned=1 WHERE id='constraint'");
  // A refused turn must not poison the next turn's pin cache.
  await bundle().catch(()=>undefined);
  while(!maintainRecallViewSlice(access.view)){}
  expect((await bundle()).pinned.map(row=>row.id)).toEqual(['constraint']);
  expect((await bundle()).pinned.map(row=>row.id)).toEqual(['constraint']);
});

it('Medium filtered replay epoch probes seek past zero-revision history',async()=>{
  const {sendReplaySessionCurrent}=await import('./replay-lineage.ts');
  const {sqlWork}=await import('./testing/sql-work.ts');
  const db=database();
  db.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<2000) INSERT INTO send_replay_epochs SELECT 'epoch-'||i,0 FROM c");
  const {work,result}=sqlWork(db,()=>sendReplaySessionCurrent('fresh','fixture','session'));expect(result).toBe(true);
  const sql=[...work.sqls.keys()].find(sql=>sql.includes('FROM send_replay_epochs')&&!sql.includes('thread_id=?'))!;
  expect(sql).toBeDefined();
  const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(row=>String(row.detail));
  expect(plan.filter(detail=>/SCAN send_replay_epochs/.test(detail))).toEqual([]);
  db.exec("INSERT INTO send_replay_epochs VALUES('negative',-1)");
  expect(sendReplaySessionCurrent('fresh','fixture','session')).toBe(false);
  db.exec("DELETE FROM send_replay_epochs WHERE thread_id='negative'; INSERT INTO send_replay_epochs VALUES('positive',1)");
  expect(sendReplaySessionCurrent('fresh','fixture','session')).toBe(false);
});
it('Medium maintenance reports unexpected storage failures once and quietly retries expected unavailability',async()=>{
  const {db}=await fixture();vi.useFakeTimers();const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const prepare=db.prepare.bind(db);let failure:Error & {code?:string}=new Error('MEMORY_RECALL_UNAVAILABLE');
  const spy=vi.spyOn(db,'prepare').mockImplementation(sql=>{
    if(sql.includes('FROM memory_recall_contexts'))throw failure;
    return prepare(sql);
  });
  try {
    startRecallViewMaintenance();await vi.advanceTimersByTimeAsync(50);expect(warn).not.toHaveBeenCalled();
    failure=Object.assign(new Error('fixture storage failure'),{code:'SQLITE_IOERR'});
    await vi.advanceTimersByTimeAsync(150);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SQLITE_IOERR');
  } finally {stopRecallViewMaintenance();spy.mockRestore();warn.mockRestore();vi.useRealTimers();}
});
