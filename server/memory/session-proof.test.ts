// Owners: recall-s1s2g owns proof production and these consumers; warm-keep owns the warm contract.
import { mkdirSync, readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import * as policy from './policy.ts';
import * as lineage from './replay-lineage.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { stampFreshSession, WritetimeFixture } from './testing/writetime-fixture.ts';
import { DatabaseSync } from '../sqlite-open.ts';
import { collectSessionChecksSlice, deleteSessionChecks, ensureSessionProofSchema } from './session-proof-schema.ts';

import { proofModule, setupProofFixture, receipts } from './session-proof-fixture.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(async()=>{const p=await proofModule();p.setSessionProofCommitFaultForTest?.(undefined);vi.restoreAllMocks();stopRecallViewMaintenance();closeDatabase();});

it('an unchanged retained proof avoids another durable write but new receipts and withdrawal are still checked',async()=>{
 const f=setupProofFixture('direct'),p=await proofModule();await receipts(f,1);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 const db=database();
 new WritetimeFixture(db).source('unrelated-proof-source',policy.ensureScope('bot','reader'));
 db.prepare("UPDATE memory_sources SET revision=revision+1 WHERE id='unrelated-proof-source'").run();
 lineage.prepareLineageCache();
 const before=db.prepare('SELECT total_changes() AS n').get()!.n;
 const old=db.prepare('SELECT up_to FROM memory_session_checks').get()!.up_to;
 for(let n=0;n<3;n++)expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
 await receipts(f,1);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 expect(Number(db.prepare('SELECT up_to FROM memory_session_checks').get()!.up_to)).toBeGreaterThan(Number(old));
 const checked=Number(db.prepare('SELECT checked FROM memory_session_checks').get()!.checked);
 const clock=vi.spyOn(Date,'now').mockReturnValue(checked+60_001);
 try {
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
  expect(db.prepare('SELECT checked FROM memory_session_checks').get()!.checked).toBe(checked+60_001);
 } finally {clock.mockRestore();}
 db.prepare("UPDATE memory_disclosures SET state='revoked'").run();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toMatchObject({kind:'fresh',cause:'denied'});
});

it.each([0,10_000,100_000])('recovery invalidates a checkpoint with flat writes across %i dependent proofs',count=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec('CREATE TABLE memory_sources(id,state,revision,scope_id);CREATE TABLE memory_records(id,state,version,scope_id);CREATE TABLE memory_tombstones(target_type,target_id);CREATE TABLE memory_disclosures(bundle_id,state);CREATE TABLE memory_session_lineage(thread_id,driver_instance,native_session)');
  ensureSessionProofSchema(db);
  db.exec(`INSERT INTO memory_session_checks VALUES('thread','engine','session','reader',1,0,0,NULL,NULL,NULL,1,0,'[]',${count},0,${Date.now()});
   WITH RECURSIVE n(i) AS (SELECT 1 WHERE ${count}>0 UNION ALL SELECT i+1 FROM n WHERE i<${count})
   INSERT INTO memory_session_check_cites SELECT 'thread','engine','session','record',printf('%06d',i),1,'bundle' FROM n;
   WITH RECURSIVE n(i) AS (SELECT 1 WHERE ${count}>0 UNION ALL SELECT i+1 FROM n WHERE i<${count})
   INSERT INTO memory_session_check_messages SELECT 'thread','engine','session','source',printf('%06d',i) FROM n;`);
  const writes=()=>Number(db.prepare('SELECT total_changes() AS n').get()!.n);
  const before=writes();deleteSessionChecks(db,{threadId:'thread',driverInstance:'engine',nativeSession:'session'});
  expect(writes()-before).toBe(1);
  expect(db.prepare('SELECT 1 FROM memory_session_checks').get()).toBeUndefined();
  expect(db.prepare('SELECT count(*) AS n FROM memory_session_check_cites').get()?.n).toBe(count);
  const beforeMaintenance=writes();collectSessionChecksSlice(db);
  expect(writes()-beforeMaintenance).toBe(Math.min(count,128)*2);
  expect(db.prepare('SELECT count(*) AS n FROM memory_session_check_messages').get()?.n).toBe(Math.max(count-128,0));
 }finally{db.close();}
});

it('reproof waits for bounded orphan cleanup and maintenance preserves a live checkpoint',async()=>{
 const f=setupProofFixture(),p=await proofModule(),db=database(),scope=policy.ensureScope('bot','reader');
 new WritetimeFixture(db).source('cleanup-source',scope).record('cleanup-record',1,scope,['cleanup-source']);
 f.access=f.issue();await receipts(f,1);
 db.prepare('UPDATE memory_disclosures SET record_versions=?,source_versions=?').run(JSON.stringify([{id:'cleanup-record',version:1}]),JSON.stringify([{id:'cleanup-source',revision:1}]));
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 const cites=db.prepare('SELECT * FROM memory_session_check_cites').all();expect(cites.length).toBeGreaterThan(0);
 collectSessionChecksSlice(db);
 expect(db.prepare('SELECT * FROM memory_session_check_cites').all()).toEqual(cites);
 deleteSessionChecks(db,f.key);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toMatchObject({kind:'fresh',cause:'checking',reason:'session-proof-cleanup'});
 collectSessionChecksSlice(db);
 expect(db.prepare('SELECT 1 FROM memory_session_check_cites').get()).toBeUndefined();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 expect(db.prepare('SELECT cites FROM memory_session_checks').get()?.cites).toBe(cites.length);
});

it('T-G1c: disclosed without any receipt is never resumed',async()=>{
  const f=setupProofFixture(),p=await proofModule();
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toMatchObject({kind:'fresh',reason:'no-receipts'});
});
it('T-G1d: each cited scope is checked with live access and room lineage has a non-null audience',async()=>{
  const f=setupProofFixture('room-thread',true),db=database(),scope=policy.ensureScope('room','room');
  new WritetimeFixture(db).source('fixture-source',scope).record('fixture-record',1,scope,['fixture-source']);
  await receipts(f,1);
  db.prepare("UPDATE memory_disclosures SET record_versions=?,source_versions=? WHERE rowid=(SELECT min(rowid) FROM memory_disclosures)").run(JSON.stringify([{id:'fixture-record',version:1}]),JSON.stringify([{id:'fixture-source',revision:1}]));
  const check=vi.spyOn(policy,'assertMemoryAccess'),judge=vi.spyOn(lineage,'sessionLineageBad'),p=await proofModule();
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
  expect(check.mock.calls.some(c=>c[0]===f.access&&c[1]===scope)).toBe(true);
  expect(judge.mock.calls.length).toBeGreaterThan(0);
  expect(judge.mock.calls.every(c=>c[4]!==null&&c[4]!==undefined)).toBe(true);
  // MAIN RULING 1115-RECALL-DESIGN-GROK: pin the P4 scope check as well as observing the real live-access calls.
  expect(readFileSync(new URL('./session-proof.ts',import.meta.url),'utf8')).toMatch(/scopes\.set\(citeKey,scope\)[\s\S]*?assertMemoryAccess\(access,scope\)/);
});
for(const kind of ['receipt','receipt-line','roots','disclosed'] as const) it(`T-G2a: held mode rejects recall carried by ${kind}`,async()=>{
  const f=setupProofFixture(),db=database(),p=await proofModule();
  if(kind==='receipt')await receipts(f,1);
  if(kind==='receipt-line') {
    db.prepare('INSERT INTO memory_session_no VALUES(?,?,?,1)').run(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
    const no=new WritetimeFixture(db);no.owner(f.key.threadId,'line',2);
    db.prepare("INSERT INTO memory_receipt_lines VALUES('unbound',(SELECT no FROM memory_thread_no WHERE thread_id=?),2,1)").run(f.key.threadId);
  }
  if(kind==='roots')db.prepare("INSERT INTO memory_session_roots VALUES(?,?,?,'fixture-root')").run(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:kind==='disclosed'})).toMatchObject({kind:'fresh',reason:'held-session-holds-recall'});
});
it('T-CTRL-G2b: held ordinary transcript without recall keeps its warm session',async()=>{
  const f=setupProofFixture(),p=await proofModule();
  // MAIN RULING 1115-RECALL-GROK-Q1Q2: the control models a positively fresh, undisclosed provider session.
  if(database().prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_state'").get())database().prepare('INSERT OR REPLACE INTO memory_session_state VALUES(?,?,?,0)').run(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:false})).toEqual({kind:'resume'});
});
for(const thread of ['room-thread','direct'])it(`T-G3: missing lineage refuses ${thread} even before lineage is live`,async()=>{
  const f=setupProofFixture(thread),p=await proofModule();database().exec('DELETE FROM memory_session_lineage');
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:false})).toMatchObject({kind:'fresh',reason:'no-session-lineage'});
});
it('T-LONG: durable steady-state cost does not grow with 300 versus 3000 receipts',async()=>{
  const p=await proofModule(),costs:number[]=[];
  for(const count of [300,3000]) {
    const f=setupProofFixture();f.key.nativeSession=`session-${count}`;
    stampFreshSession(database(),f.key.threadId,f.key.driverInstance,f.key.nativeSession);await receipts(f,count);
    expect(typeof p.seedSessionChecksSlice).toBe('function');
    for(let n=0;n<4;n++)p.seedSessionChecksSlice(f.access);
    for(let turn=0;turn<50;turn++) {
      expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
      const meter=p.sessionProofMeter();expect(meter.rows+meter.seeks).toBeLessThanOrEqual(200);
      if(turn===49)costs.push(meter.rows+meter.seeks);
    }
  }
  expect(Math.abs(costs[0]-costs[1])).toBeLessThanOrEqual(8);
});
for(const change of ['forget','source','record','receipt','scope','roster','withheld','policy'] as const)it(`T-OLD-${change}: an old receipt or held line invalidates the next proof`,async()=>{
  const f=setupProofFixture(),db=database(),p=await proofModule(),scope=policy.ensureScope('room','room');
  new WritetimeFixture(db).source('old-source',scope).record('old-record',1,scope,['old-source']);
  await receipts(f,3000);
  db.prepare("UPDATE memory_disclosures SET source_versions=?,record_versions=? WHERE bundle_id=(SELECT bundle_id FROM memory_disclosures ORDER BY rowid LIMIT 1 OFFSET 5)").run(JSON.stringify([{id:'old-source',revision:1}]),JSON.stringify([{id:'old-record',version:1}]));
  expect(typeof p.seedSessionChecksSlice).toBe('function');for(let n=0;n<4;n++)p.seedSessionChecksSlice(f.access);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
  if(change==='source')db.exec("UPDATE memory_sources SET state='retired' WHERE id='old-source'");
  if(change==='record')db.exec("UPDATE memory_records SET state='archived' WHERE id='old-record'");
  if(change==='receipt')db.exec("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=(SELECT bundle_id FROM memory_disclosures ORDER BY rowid LIMIT 1 OFFSET 5)");
  if(change==='forget') {new WritetimeFixture(db).denySession(f.key.threadId,'engine','session');db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");}
  if(change==='policy')db.exec('UPDATE memory_meta SET policy_revision=policy_revision+1');
  if(change==='withheld') {
    new WritetimeFixture(db).owner(f.key.threadId,'held-line',1);
    db.exec(`UPDATE messages SET json='{"withheldFromBots":true}' WHERE id='held-line'`);
  }
  if(change==='scope'||change==='roster') {
    db.prepare("UPDATE memory_session_checks SET footprint=?,view_id='prior-reader',view_digest='old-view'").run(JSON.stringify(['removed-scope']));
    db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1');f.issue();
  }
  const result=p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:change==='scope'||change==='roster'?f.issue():f.access,disclosed:true});
  expect(result.kind).toBe('fresh');expect(p.sessionProofMeter().rows+p.sessionProofMeter().seeks).toBeLessThanOrEqual(8400);
});
for(const overflow of ['new','log','footprint','allowance'] as const)it(`T-OVF-${overflow}: bounded work fails closed`,async()=>{
  const f=setupProofFixture(),p=await proofModule(),db=database();await receipts(f,1);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
  if(overflow==='new')await receipts(f,65,1);
  if(overflow==='log') {expect(typeof p.seedSessionChecksSlice).toBe('function');db.exec('UPDATE memory_session_checks SET cites=1025');for(let i=0;i<5000;i++)db.prepare("INSERT INTO memory_session_change_log(id) VALUES('source:unrelated')").run();}
  if(overflow==='footprint') {db.exec(`UPDATE memory_session_checks SET footprint='"wide"',view_id='prior-reader',view_digest='old-view'`);db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1');f.issue();}
  expect(p.proveRetainedSession(overflow==='allowance'?LineageAllowance.turn(0):LineageAllowance.tool(),f.key,{access:overflow==='footprint'?f.issue():f.access,disclosed:true})).toMatchObject({kind:'fresh',reason:({new:'new-receipts-overflow',log:'cite-overflow',footprint:'footprint-wide',allowance:'lineage-warming'})[overflow]});
});
it('T-RESTART: durable checkpoint survives connection loss and a precommit fault re-proves the old prefix',async()=>{
  const f=setupProofFixture('direct'),p=await proofModule();await receipts(f,100);
  expect(typeof p.setSessionProofCommitFaultForTest).toBe('function');
  p.seedSessionChecksSlice(f.access);
  const old=database().prepare('SELECT up_to FROM memory_session_checks').get();
  await receipts(f,1);
  p.setSessionProofCommitFaultForTest(()=>{throw new Error('fixture-proof-crash');});
  expect(()=>p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toThrow('fixture-proof-crash');
  p.setSessionProofCommitFaultForTest(undefined);
  // MAIN RULING 1115-RECALL-DESIGN-GROK: crash preserves the previously established durable prefix.
  expect(database().prepare('SELECT up_to FROM memory_session_checks').get()).toEqual(old);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
  closeDatabase();const next=f.issue();
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:next,disclosed:true})).toEqual({kind:'resume'});
  expect(p.sessionProofMeter().rows+p.sessionProofMeter().seeks).toBeLessThanOrEqual(200);
});
it('T-SCAN: continuation paths use the unified proof and never invent held watermarks',()=>{
  const index=readFileSync(new URL('../index.ts',import.meta.url),'utf8'),dispatch=readFileSync(new URL('./dispatch.ts',import.meta.url),'utf8');
  expect(index).not.toMatch(/retainedSessionInvalid\(/);
  expect(dispatch.slice(dispatch.indexOf('export class MemoryDispatchReceipt'),dispatch.indexOf('const checkingReasons'))).not.toMatch(/retainedSessionInvalid\(/);
  // MAIN RULING 1115-RECALL-HELD-REPLACE: pin the retained watermark, excluding unrelated prompt-head ternaries.
  expect(index).not.toMatch(/(?:roomSessionLastLsn|sessionLastLsn)\s*=[^;]*:\s*(roomTurnLineage|turnLineage)\.turnLsn/);
  expect(index).not.toContain('AUDIENCE_SESSION_READER');
});
it('T-LONG adapter writes use the bounded proof rather than the old whole-session reader',async()=>{
 const f=setupProofFixture(),p=await proofModule();await receipts(f,3000);
 expect(typeof p.seedSessionChecksSlice).toBe('function');for(let n=0;n<4;n++)p.seedSessionChecksSlice(f.access);
 const {buildMemoryBundle}=await import('./bundle.ts');
 const {MemoryDispatchReceipt}=await import('./dispatch.ts');
 const bundle=await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()});
 const receipt=new MemoryDispatchReceipt(bundle,f.access,f.key.driverInstance);
 receipt.retains(f.key.nativeSession,{access:f.access,disclosed:true});
 for(let write=0;write<3;write++) {
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:true}).kind).toBe('fresh');
  expect(p.sessionProofMeter().path).toBe('recall-free');
  expect(()=>receipt.assertCurrent()).not.toThrow();
  expect(p.sessionProofMeter().path).toBe('incremental');
  expect(p.sessionProofMeter().rows+p.sessionProofMeter().seeks).toBeLessThanOrEqual(200);
 }
});
it('T-CTRL-S1: a room key without any send-replay certificate is current on a legacy-empty replay file',()=>{
 const f=setupProofFixture();
 expect(lineage.sendReplaySessionCurrent(f.key.threadId,f.key.driverInstance,f.key.nativeSession)).toBe(true);
});
