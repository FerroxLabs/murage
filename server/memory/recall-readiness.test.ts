// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (typed readiness and zero-pin proof).
// Consumer owner: recall-smoke (direct and room send fences).
import { droppedPinLine, withheldPinLine } from './dispatch.ts';
import type { MemoryBundle } from '../../shared/memory.ts';
import { mkdirSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { OWNER_PIN } from './schema.ts';
import { RecallPreparationPending, RecallViewLost, recallPreparationFailure, MemoryPinProjectionPending } from './recall-recovery.ts';
import { RecallReadiness, RecallHeld, assertRecallDispatch } from './recall-readiness.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});database().exec(OWNER_PIN.sql);});
afterEach(()=>{vi.useRealTimers();closeDatabase();});
const pending=()=>{throw new RecallPreparationPending();};
const stop=new Error('fixture stopped');
it('S1: only typed preparation failures are recoverable, including view loss',()=>{
  for(const error of [new Error('MEMORY_RECALL_UNAVAILABLE'),new Error('MEMORY_SCOPE_DENIED'),new Error('MEMORY_UNAUTHORIZED'),new Error('MEMORY_POLICY_PENDING'),new MemoryPinProjectionPending()])expect(recallPreparationFailure(error)).toBe(error);
  expect(recallPreparationFailure(new RecallViewLost())).toBeInstanceOf(RecallPreparationPending);
});
it('S1: a truly fresh home takes the held path after the bounded probes without building a view',async()=>{
  const readiness=new RecallReadiness(),at=performance.now();
  await expect(readiness.access(pending,new AbortController().signal)).rejects.toBeInstanceOf(RecallHeld);
  expect(performance.now()-at).toBeGreaterThanOrEqual(290);
  expect(()=>readiness.assertHeld()).not.toThrow();
});
it('S1: a pin created after the zero-pin proof refuses the held send',async()=>{
  const readiness=new RecallReadiness();await expect(readiness.access(pending,new AbortController().signal)).rejects.toBeInstanceOf(RecallHeld);
  database().exec("INSERT INTO memory_scopes VALUES('fixture-scope','bot','fixture-reader','{}',0); INSERT INTO memory_records VALUES('fixture-pin',1,'fixture-scope','constraint','Fixture rule','owner-statement','active',1,1,NULL,NULL,1)");
  expect(()=>readiness.assertHeld()).toThrow(MemoryPinProjectionPending);
});
it('S1: a missing pin index is unknown and never a zero-pin proof',async()=>{
  database().exec('DROP INDEX memory_records_pinned');
  const readiness=new RecallReadiness();const controller=new AbortController();
  const result=readiness.access(pending,controller.signal);controller.abort(stop);
  await expect(result).rejects.toBe(stop);
  expect(()=>readiness.assertHeld()).toThrow(MemoryPinProjectionPending);
});
it('S1: Stop detaches a waiting send and later readiness cannot resume it',async()=>{
  database().exec("INSERT INTO memory_scopes VALUES('fixture-scope','bot','fixture-reader','{}',0); INSERT INTO memory_records VALUES('fixture-record',1,'fixture-scope','constraint','Fixture rule','owner-statement','active',0,1,NULL,NULL,1)");
  const readiness=new RecallReadiness(),controller=new AbortController();let probes=0;
  const result=readiness.access(()=>{probes++;return pending();},controller.signal);controller.abort(stop);
  await expect(result).rejects.toBe(stop);expect(probes).toBe(1);
});
it('S1: dispatch rejects missing mode, empty persona, missing integrations and lost follow-up history',()=>{
  const input={recall:'full' as const,system:'Fixture persona',integrations:{agents:{}},transcript:[{role:'user',text:'Earlier fixture'}],recallPrepared:{system:'Fixture persona',integrations:['agents'],historyPrepared:true,resumed:false}};
  expect(()=>assertRecallDispatch(input)).not.toThrow();
  for(const delta of [{recall:undefined},{system:''},{integrations:{}},{transcript:[]}])expect(()=>assertRecallDispatch({...input,...delta})).toThrow();
});

for(const pinned of [false,true])it(`S1: readiness waits ${pinned?2000:300} ms once, with the 0, 50, 300, 2000 ms probe schedule`,async()=>{
  database().exec("INSERT INTO memory_scopes VALUES('fixture-scope','bot','fixture-reader','{}',0)");
  database().prepare("INSERT INTO memory_records VALUES('fixture-record',1,'fixture-scope','constraint','Fixture rule','owner-statement','active',?,1,NULL,NULL,1)").run(pinned?1:0);
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const readiness=new RecallReadiness();let probes=0;
  const result=readiness.access(()=>{probes++;return pending();},new AbortController().signal).catch(error=>error);
  await vi.advanceTimersByTimeAsync((pinned?2000:300)-1);expect(probes).toBe(pinned?3:2);
  await vi.advanceTimersByTimeAsync(1);expect(probes).toBe(pinned?4:3);
  expect(await result).toBeInstanceOf(pinned?MemoryPinProjectionPending:RecallHeld);
});
it('S1: close and restart invalidate a held zero-pin proof',async()=>{
  const readiness=new RecallReadiness();await expect(readiness.access(pending,new AbortController().signal)).rejects.toBeInstanceOf(RecallHeld);
  closeDatabase();database();expect(()=>readiness.assertHeld()).toThrow(MemoryPinProjectionPending);
});

it('review H1: each reply carrying capacity or withheld omissions gets its own notice',()=>{
 const pin={id:'fixture-pin',version:1};const bundle={droppedPins:[pin],withheldPins:[pin]} as unknown as MemoryBundle;
 expect(droppedPinLine('fixture-thread',bundle)).toBeTruthy();expect(droppedPinLine('fixture-thread',bundle)).toBeTruthy();
 expect(withheldPinLine('fixture-thread',bundle)).toBeTruthy();expect(withheldPinLine('fixture-thread',bundle)).toBeTruthy();
});

it('S1-T11: no configured integrations and a resumed history are legitimate',()=>{
 const input={recall:'off' as const,system:'Fixture persona',integrations:{},transcript:[],recallPrepared:{system:'Fixture persona',integrations:[],historyPrepared:true,resumed:true}};
 expect(()=>assertRecallDispatch(input)).not.toThrow();
});

it('S1-T7: missing pin index uses all four probes and the 2000 ms refusal bound',async()=>{
 database().exec('DROP INDEX memory_records_pinned');
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness();let probes=0;
 const result=readiness.access(()=>{probes++;return pending();},new AbortController().signal).catch(error=>error);
 await vi.advanceTimersByTimeAsync(1999);expect(probes).toBe(3);
 await vi.advanceTimersByTimeAsync(1);expect(probes).toBe(4);expect(await result).toBeInstanceOf(MemoryPinProjectionPending);
});
it('PIN-9/HELD-5: an undefined stamp inside a transaction is not a zero-pin refusal',async()=>{
 const db=database();db.exec('BEGIN');
 try{const readiness=new RecallReadiness();await expect(readiness.access(pending,new AbortController().signal)).rejects.toBeInstanceOf(RecallHeld);expect(()=>readiness.assertHeld()).not.toThrow();}
 finally{db.exec('ROLLBACK');}
});
it('HELD-2: one logical readiness object never issues a second held redispatch',async()=>{
 const readiness=new RecallReadiness();await expect(readiness.access(pending,new AbortController().signal)).rejects.toBeInstanceOf(RecallHeld);
 await expect(readiness.access(pending,new AbortController().signal)).rejects.toThrow('This reply is still being prepared');
});
