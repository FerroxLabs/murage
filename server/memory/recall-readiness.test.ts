// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (typed readiness and zero-pin proof).
// Consumer owner: recall-smoke (direct and room send fences).
import { droppedPinLine, withheldPinLine } from './dispatch.ts';
import type { MemoryBundle } from '../../shared/memory.ts';
import { mkdirSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, databaseGeneration } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { OWNER_PIN } from './schema.ts';
import { RecallPreparationPending, RecallViewLost, recallPreparationFailure, MemoryPinProjectionPending } from './recall-recovery.ts';
import { RecallReadiness, RecallHeld, RecallDispatchPending, RecallWait, RecallViewNotReady, REBUILD_VIEW_WAIT_MS, assertRecallDispatch } from './recall-readiness.ts';
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
it('TRAINRED-FENCE: a memory-free rebuild dispatches only under the withheld label, prepared memory-free, with an empty system and no memory tools',()=>{
  const prepared={system:'Fixture persona',integrations:['agents','memory'],historyPrepared:true,resumed:false,memoryFree:true as const};
  const input={recall:'withheld' as const,system:'',integrations:{agents:{}},transcript:[],recallPrepared:prepared};
  expect(()=>assertRecallDispatch(input)).not.toThrow();
  for(const delta of [{recall:undefined},{recall:'off' as const},{recall:'full' as const},{recall:'held' as const},{recall:'pins' as const},{system:'Fixture persona'},{system:' '},{system:undefined},{integrations:{agents:{},memory:{}}},{integrations:{}},{integrations:{agents:{},browser:{}}},{recallPrepared:undefined}])
    expect(()=>assertRecallDispatch({...input,...delta}),JSON.stringify(delta)).toThrow('still being prepared');
  // The label and the fact only work together: the same dispatch without the memory-free fact is refused, and so is
  // a fully prepared request that only puts the label on.
  expect(()=>assertRecallDispatch({...input,recallPrepared:{...prepared,memoryFree:undefined}})).toThrow('still being prepared');
  expect(()=>assertRecallDispatch({recall:'withheld',system:'Fixture persona',integrations:{agents:{},memory:{}},transcript:[{role:'user',text:'Earlier fixture'}],recallPrepared:{...prepared,memoryFree:undefined}})).toThrow('still being prepared');
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

// MA-REBUILD: the probe schedule belongs to one dispatch attempt (RecallWait), never to the logical send.
type Publish=(event:{databaseGeneration:number})=>void;
const publications=()=>{const listeners=new Set<Publish>();return{listeners,subscribe:(listener:Publish)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},publish:(generation=databaseGeneration())=>{for(const listener of [...listeners])listener({databaseGeneration:generation});}};};
it('MA-REBUILD (a): a second RecallWait on the same send gets the full 0, 50, 300 ms schedule again',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness();let first=0,second=0;
 const one=readiness.access(()=>{first++;return pending();},new AbortController().signal,new RecallWait()).catch(error=>error);
 await vi.advanceTimersByTimeAsync(300);expect(first).toBe(3);expect(await one).toBeInstanceOf(RecallHeld);
 const two=readiness.access(()=>{second++;return pending();},new AbortController().signal,new RecallWait()).catch(error=>error);
 expect(second).toBe(1);await vi.advanceTimersByTimeAsync(299);expect(second).toBe(2);
 await vi.advanceTimersByTimeAsync(1);expect(second).toBe(3);expect(await two).toBeInstanceOf(RecallDispatchPending);
});
it('MA-REBUILD (b): a rebuild never takes the receipt-less held path, however many probes were spent',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness(),bus=publications();
 const result=readiness.access(pending,new AbortController().signal,new RecallWait(),{rebuild:true,publications:bus.subscribe}).catch(error=>error);
 await vi.advanceTimersByTimeAsync(REBUILD_VIEW_WAIT_MS);
 const error=await result;expect(error).toBeInstanceOf(RecallViewNotReady);expect(error).not.toBeInstanceOf(RecallHeld);
 expect(()=>readiness.assertHeld()).toThrow(MemoryPinProjectionPending);
});
it('MA-REBUILD (c): the rebuild wait expires at REBUILD_VIEW_WAIT_MS with the last-resort marker, and releases its subscription',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness(),bus=publications();let probes=0,settled=false;
 const result=readiness.access(()=>{probes++;return pending();},new AbortController().signal,new RecallWait(),{rebuild:true,publications:bus.subscribe}).catch(error=>{settled=true;return error;});
 await vi.advanceTimersByTimeAsync(REBUILD_VIEW_WAIT_MS-1);expect(settled).toBe(false);expect(bus.listeners.size).toBe(1);
 await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);expect(await result).toBeInstanceOf(RecallViewNotReady);expect(bus.listeners.size).toBe(0);expect(probes).toBeGreaterThan(0);
});
it('MA-REBUILD (d): a publication wakes the rebuild wait into a fresh read; a stale database generation does not',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness(),bus=publications();let probes=0,ready=false;
 const result=readiness.access(()=>{probes++;if(!ready)throw new RecallPreparationPending();return 'view';},new AbortController().signal,new RecallWait(),{rebuild:true,publications:bus.subscribe});
 await vi.advanceTimersByTimeAsync(10);const before=probes;
 bus.publish(databaseGeneration()+1);await vi.advanceTimersByTimeAsync(1);expect(probes).toBe(before);
 ready=true;bus.publish();await vi.advanceTimersByTimeAsync(1);expect(await result).toBe('view');expect(bus.listeners.size).toBe(0);
});
it('MA-REBUILD (e): Stop aborts the rebuild wait and releases its subscription',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness(),bus=publications(),controller=new AbortController();
 const result=readiness.access(pending,controller.signal,new RecallWait(),{rebuild:true,publications:bus.subscribe}).catch(error=>error);
 await vi.advanceTimersByTimeAsync(10);expect(bus.listeners.size).toBe(1);controller.abort(stop);
 await vi.advanceTimersByTimeAsync(1);expect(await result).toBe(stop);expect(bus.listeners.size).toBe(0);
});
for(const pinned of [false,true])it(`S1: time spent outside access() does not use up the ${pinned?2000:300} ms wait budget, and the summed wait stays within it`,async()=>{
 database().exec("INSERT INTO memory_scopes VALUES('fixture-scope','bot','fixture-reader','{}',0)");
 database().prepare("INSERT INTO memory_records VALUES('fixture-record',1,'fixture-scope','constraint','Fixture rule','owner-statement','active',?,1,NULL,NULL,1)").run(pinned?1:0);
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness(),signal=new AbortController().signal;let probes=0;
 expect(await readiness.access(()=>'ready',signal)).toBe('ready');
 await vi.advanceTimersByTimeAsync(5000);
 const at=performance.now();
 const result=readiness.access(()=>{probes++;return pending();},signal).catch(error=>error);
 await vi.advanceTimersByTimeAsync((pinned?2000:300)-1);
 expect(probes).toBe(pinned?2:1);
 await vi.advanceTimersByTimeAsync(1);
 expect(probes).toBe(pinned?3:2);
 expect(await result).toBeInstanceOf(pinned?MemoryPinProjectionPending:RecallHeld);
 expect(performance.now()-at).toBe(pinned?2000:300);
});
it('S1: the wait budget is shared by two accesses of one logical send',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness(),signal=new AbortController().signal;
 let reads=0;const first=readiness.access(()=>{if(reads++<1)pending();return 'ready';},signal);
 await vi.advanceTimersByTimeAsync(50);expect(await first).toBe('ready');
 await vi.advanceTimersByTimeAsync(1000);
 const at=performance.now();
 let settled=false;
 const second=readiness.access(pending,signal).catch(error=>error).then(error=>{settled=true;return error;});
 await vi.advanceTimersByTimeAsync(249);
 expect(settled).toBe(false);
 await vi.advanceTimersByTimeAsync(1);
 expect(await second).toBeInstanceOf(RecallHeld);
 expect(performance.now()-at).toBe(250);
});
// MAIN RULING 1117T01:23Z (a): a redispatch after a roster or authority change re-proves a new context on a fresh probe schedule, with the
// same 300 ms per wait. The held ticket stays spent, so a second exhausted schedule refuses instead of holding again.
it('S1: a redispatch after a context change gets a fresh probe schedule with the same 300 ms wait',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 const readiness=new RecallReadiness(),signal=new AbortController().signal;
 let reads=0;const first=readiness.access(()=>{if(reads++<2)pending();return 'ready';},signal);
 await vi.advanceTimersByTimeAsync(300);expect(await first).toBe('ready');
 readiness.renewAfterContextChange();
 const at=performance.now();let probes=0;
 const second=readiness.access(()=>{if(probes++<1)pending();return 'renewed';},signal);
 expect(probes).toBe(1);
 await vi.advanceTimersByTimeAsync(50);
 expect(await second).toBe('renewed');
 expect(performance.now()-at).toBe(50);
 readiness.renewAfterContextChange();
 const third=readiness.access(pending,signal).catch(error=>error);
 await vi.advanceTimersByTimeAsync(299);
 let settled=false;void third.then(()=>{settled=true;});await Promise.resolve();
 expect(settled).toBe(false);
 await vi.advanceTimersByTimeAsync(1);
 expect(await third).toBeInstanceOf(RecallHeld);
 readiness.renewAfterContextChange();
 const fourth=readiness.access(pending,signal).catch(error=>error);
 await vi.advanceTimersByTimeAsync(300);
 expect(await fourth).toBeInstanceOf(RecallDispatchPending);
});
