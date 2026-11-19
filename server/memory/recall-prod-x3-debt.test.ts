// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable publication owner: recall-fix-j; retry/scheduling consumer owner: recall-prod-x3.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDatabase, database, holdSearchIndexUntil, transaction } from '../database.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { ioBudget } from '../io-budget.ts';
import { ownerFirst } from '../owner-first.ts';
import { checkpointCeiling } from '../io-meter.ts';
import { walIndexReader } from '../io-written.ts';
import * as walMaintenance from '../wal-maintenance.ts';
import { captureSource } from './capture.ts';
import { captureWork } from './chunks.ts';
import { claimMemoryJob } from './jobs.ts';
import { MemoryWorkerController } from './worker-controller.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';

const fault=vi.hoisted(()=>({checking:false,checkingJobs:new Set<string>(),deferred:false,calls:[] as string[]}));
vi.mock('./consolidate.ts',async original=>{
  const actual=await original<typeof import('./consolidate.ts')>();
  const {BgDeferred}=await import('../bg-admission.ts');
  return {...actual,refreshMemoryCheckpoint:(id:string)=>{
    fault.calls.push(id);
    if(fault.deferred)throw new BgDeferred(3000);
    if(fault.checking||fault.checkingJobs.has(id))return {status:'deferred' as const,reason:'evidence-checking'};
    return actual.refreshMemoryCheckpoint(id);
  }};
});
type State={owner:string;child:unknown;ready:boolean;started:boolean;work:NonNullable<ReturnType<typeof claimMemoryJob>>|null;nextEligibleWorkAt:number;bgRetryAt:number;heldCompletions:Set<string>;tick():void;recoverCheckpoints():void;pendingProjection():boolean;maintain(dispatched:boolean):void;later(step:()=>void,delay?:number):void;onWorkerMessage(child:unknown,event:unknown):void};
let controller:MemoryWorkerController,state:State,pending:Array<{step:()=>void;delay:number}>;
function setupController(){
  controller=new MemoryWorkerController();state=controller as unknown as State;
  state.child={kill(){},on(){},send(){}};state.ready=true;
  vi.spyOn(state,'pendingProjection').mockReturnValue(false);vi.spyOn(state,'maintain').mockImplementation(()=>{});
  pending=[];state.later=(step,delay=0)=>{pending.push({step,delay});};
}
beforeEach(()=>{
  freshDataDir('active');new WritetimeFixture(database()).cert(true).ready(THREAD,true);
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE id IN ('s-room','s-bot','s-other','s-project')");
  fault.checking=false;fault.checkingJobs.clear();fault.deferred=false;fault.calls=[];
  setupController();
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});
});
afterEach(async()=>{state.child=null;state.work=null;await controller.stop();vi.useRealTimers();vi.restoreAllMocks();});
function publish(n:number,threadFor:(i:number)=>string=()=>THREAD){
  const ids:string[]=[];
  transaction(()=>{for(let i=0;i<n;i++){
    const id=`source-${i}`,message=`message-${i}`,text='Fixture evidence is recorded.',thread=threadFor(i);
    if(thread!==THREAD)new WritetimeFixture(database()).ready(thread,true);
    storeAnchorMessage(database(),thread,message,text);
    captureSource(database(),{id,threadId:thread,messageId:message,kind:'text',speaker:'owner',outcome:'recorded',text});
    const work=claimMemoryJob(state.owner)!;expect(work).toBeTruthy();state.work=work;
    state.onWorkerMessage(state.child,{type:'result',result:captureWork(work)});
    expect(pending).toHaveLength(1);pending.shift()!.step();ids.push(work.id);
  }});
  return ids;
}
function tick(){state.nextEligibleWorkAt=0;ioBudget.withSource('memory-worker',()=>state.tick());}
const owed=()=>Number(database().prepare("SELECT count(*) n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending'").get()!.n);

it.each([1,16,256])('%i capture completions under persistent checking retain one continuation and refresh at most two jobs per tick',n=>{
  fault.checking=true;state.started=true;
  const wake=vi.spyOn(controller,'wake');
  publish(n);expect(wake).toHaveBeenCalledTimes(n);
  expect(owed()).toBe(n);expect(pending).toHaveLength(0);
  expect(fault.calls).toHaveLength(0);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  for(let i=0;i<3;i++){
    const before=fault.calls.length;tick();
    expect(fault.calls.length-before).toBeLessThanOrEqual(2);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    expect(owed()).toBe(n);
  }
});
it.each([1,16,256])('restart with %i owed captures drains only through bounded durable driver pages',async n=>{
  let clock=Math.floor(Date.now()/60_000)*60_000+1000;
  vi.spyOn(Date,'now').mockImplementation(()=>clock);
  vi.spyOn(performance,'now').mockImplementation(()=>clock);
  const ids=publish(n);expect(pending).toHaveLength(0);expect(fault.calls).toHaveLength(0);
  state.child=null;closeDatabase();
  vi.useRealTimers();
  expect(await Promise.all([walMaintenance.stopWalMaintenance(),stopSearchIndex()])).toEqual([true,true]);
  setupController();
  const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
  // This fixture supplies the admitted copy itself. An unrelated SQLite reader can make PASSIVE copy only a prefix.
  holdSearchIndexUntil(new Promise<void>(()=>{}));
  const copyWorker=vi.spyOn(walMaintenance,'startWalMaintenance').mockImplementationOnce(()=>{});
  let db:ReturnType<typeof database>;
  try{db=database();}
  finally{copyWorker.mockRestore();holdSearchIndexUntil(null);}
  expect(walMaintenance.walMaintenanceCounters(), 'the paging fixture owns its admitted copies').toBeNull();
  const file=String(db.prepare('PRAGMA database_list').get()!.file),read=walIndexReader(file);
  try{
    for(let i=0;owed()&&i<=Math.ceil(n/2)+2;i++){
      // Each page gets a later real-size admission window; neither the budget nor checkpoint construction is mocked.
      clock+=60_000;
      const before=fault.calls.length;tick();expect(fault.calls.length-before).toBeLessThanOrEqual(2);
      // A real admitted copy clears this page's WAL debt before the fixture advances its clock again.
      const mark=read()!;
      const copied=ioBudget.foregroundCopy(checkpointCeiling(mark.mxFrame-mark.nBackfill),()=>db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get())!;
      expect(copied).toBeTruthy();expect(copied.checkpointed).toBe(copied.log);
      ioBudget.backfilled({salt:mark.salt,frame:Number(copied.checkpointed),complete:true});
    }
    expect(owed()).toBe(0);expect(new Set(fault.calls)).toEqual(new Set(ids));
    expect(fault.calls.length).toBeLessThanOrEqual(n+2);
    expect(completed).toHaveBeenCalledTimes(n);
    expect(db.prepare("SELECT count(*) n FROM memory_scope_bindings WHERE subject_id='checkpoint-disposition'").get()!.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM memory_checkpoint_heads h JOIN memory_records r ON r.id=h.record_id AND r.version=h.record_version WHERE r.state='active' AND r.kind='checkpoint'").get()!.n).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM memory_checkpoint_publications').get()!.n).toBe(n);
    expect(db.prepare("SELECT count(*) n FROM memory_sources WHERE kind='text' AND state='active'").get()!.n).toBe(n);
    expect(pending).toHaveLength(0);
  }finally{closeDatabase();read.close();}
},120_000);
it.each([1,16,256])('WAL deferral with %i owed captures requests one admitted checkpoint and waits for admission',async n=>{
  publish(n);fault.deferred=true;
  state.started=true;
  vi.spyOn(ioBudget,'nextAdmissionMs').mockReturnValue(2000);
  let finish!:(ok:boolean)=>void;
  const checkpoint=vi.spyOn(controller,'requestCheckpoint').mockReturnValue(new Promise<boolean>(resolve=>{finish=resolve;}));
  tick();tick();
  expect(checkpoint).toHaveBeenCalledTimes(1);
  expect(fault.calls).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(fault.calls).toHaveLength(1);expect(checkpoint).toHaveBeenCalledTimes(1);
  expect(owed()).toBe(n);
  finish(false);await Promise.resolve();
});
it('held completions coalesce by job and drain only one two-job page on each tick',()=>{
  const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
  expect(state.heldCompletions).toBeInstanceOf(Set);
  for(let i=0;i<16;i++){state.heldCompletions.add(`job-${i}`);state.heldCompletions.add(`job-${i}`);}
  state.started=true;
  for(let i=0;i<8;i++){tick();expect(completed).toHaveBeenCalledTimes((i+1)*2);}
  expect(state.heldCompletions.size).toBe(0);
});

it.each([1,16,256])('a starting prompt bypasses %i older debts only through one bounded driver page',n=>{
  const ids=publish(n),latest=ids.at(-1)!;
  const release=ownerFirst.beginStart(THREAD);
  try{
    state.started=true;tick();
    expect(fault.calls).toEqual([latest]);
    expect(database().prepare('SELECT job_id FROM memory_checkpoint_publications').all()).toEqual([{job_id:latest}]);
    expect(owed()).toBe(n-1);
    expect(state.heldCompletions.has(latest)).toBe(true);
    expect(pending).toHaveLength(0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  }finally{release();}
});

it('three simultaneous starting prompts each publish through bounded point pages',()=>{
  const threads=['starting-0','starting-1','starting-2'],ids=publish(3,i=>threads[i]!);
  const releases=threads.map(thread=>ownerFirst.beginStart(thread));
  try{
    state.started=true;tick();
    expect(fault.calls).toEqual(ids.slice(0,2));expect(owed()).toBe(1);
    tick();
    expect(fault.calls).toEqual(ids);expect(owed()).toBe(0);
    expect(database().prepare('SELECT count(*) n FROM memory_checkpoint_publications').get()!.n).toBe(3);
  }finally{for(const release of releases)release();}
});
it('checking starting prompts cannot starve a third admitted starting checkpoint',()=>{
  const threads=['checking-0','checking-1','checking-2'],ids=publish(3,i=>threads[i]!);
  const releases=threads.map(thread=>ownerFirst.beginStart(thread));
  fault.checkingJobs=new Set(ids.slice(0,2));
  try{
    state.started=true;tick();expect(fault.calls).toEqual(ids.slice(0,2));expect(owed()).toBe(3);
    const before=fault.calls.length;tick();
    expect(fault.calls.length-before).toBeLessThanOrEqual(2);
    expect(fault.calls.slice(before)).toContain(ids[2]);expect(owed()).toBe(2);
    expect(database().prepare('SELECT job_id FROM memory_checkpoint_publications').all()).toEqual([{job_id:ids[2]}]);
  }finally{for(const release of releases)release();}
});
