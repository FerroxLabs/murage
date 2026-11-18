// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it,vi} from 'vitest';
import type {RequestDelivery} from '../contracts.ts';
import type {PendingQueueApproval} from './index.ts';

// Control scheduler turns and transport completion separately, without timers or
// a guessed number of microtask flushes. Production uses Promise.then dispatch.
const scheduler=vi.hoisted(()=>{
 const jobs:Array<()=>void>=[];
 let ready:(()=>void)|undefined;
 return {
  schedule<T>(dispatch:()=>T|Promise<T>):Promise<T>{
   return new Promise<T>((resolve,reject)=>{
    jobs.push(()=>{try{resolve(dispatch());}catch(error){reject(error);}});
    ready?.();ready=undefined;
   });
  },
  async next(){if(!jobs.length)await new Promise<void>(resolve=>{ready=resolve;});return jobs.shift()!;},
  count:()=>jobs.length,
 };
});
vi.mock('./dispatch.ts',()=>({scheduleDelivery:scheduler.schedule}));
// setup.ts imports the decision module through the database; reload that graph
// so this test's scheduler owns the same dispatch instance as the implementation.
vi.resetModules();
const {fixture,d,card,baseCard}=await import('./fixture.ts');

for(const kind of ['engine','queue'] as const)
for(const point of ['before-check','atomic-dispatch','during-transport','before-retry'] as const)
for(const result of point==='before-check'?['accepted'] as const:point==='before-retry'?['failed','reject'] as const:['accepted','failed','reject'] as const)
it(`atomic cancellation ${kind} ${point} ${result}`,async()=>{
 const f=fixture(),call=f.serviceCall();
 const handle=kind==='engine'?f.open('atomic',{command:'rm -rf ~'}):d.openRequest({kind:'service',service:'email',claim:f.claim,call});
 const ref=card(d.decide(handle,baseCard));
 const item:PendingQueueApproval={kind:'email',ref:'q',approvalId:ref.approvalId,epoch:'e',proof:'trusted',call:call as PendingQueueApproval['call'],view:{title:'Fixture',subtitle:'x'}};
 let pending=[item];
 let finish!:(value:RequestDelivery)=>void,fail!:(error:Error)=>void;
 const respond=vi.fn(()=>new Promise<RequestDelivery>((resolve,reject)=>{finish=resolve;fail=reject;}));
 const cancelQueue=vi.fn(async()=>{pending=[];});
 f.respond.mockImplementation(respond);
 const dispose=kind==='queue'?d.installQueueSources([{kind:'email',pendingApprovals:()=>pending,reopen:()=>({kind:'service',service:'email',claim:f.claim,call}),respond,cancel:cancelQueue,renew:async()=>item,base:baseCard}]):()=>{};
 let cancellation:Promise<void>|undefined;
 const cancel=()=>cancellation=d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 try{
  if(kind==='queue')d.attachQueue(ref,{kind:'email',ref:'q',call});
  await d.presentApproval(ref,item.view);
  const work=d.answerApproval(ref,{behavior:'allow'});
  const first=await scheduler.next();
  if(point==='before-check'){
   await cancel();first();
  }else if(point==='atomic-dispatch'){
   // Request cancellation in the next microtask before running this job. There
   // must be no yield between its fence and transport invocation: dispatch wins.
   queueMicrotask(()=>{void cancel();});first();
   expect(respond).toHaveBeenCalledOnce();
   await cancellation;
  }else{
   first();expect(respond).toHaveBeenCalledOnce();
   if(point==='before-retry'){
    if(result==='reject')fail(new Error('fixture-first-attempt-failure'));
    else finish({state:'failed'});
    // Precisely the review ordering: first failure checked, retry scheduled,
    // cancellation wins before the retry job can check and invoke transport.
    // MAIN RULING 2026-11-14 R1: a definite native failure is terminal; cancellation retains its state without scheduling a resend.
    if(kind==='engine'&&result==='failed')await cancel();
    else {const retry=await scheduler.next();await cancel();retry();}
   }else await cancel();
  }
  if(point==='atomic-dispatch'||point==='during-transport'){
   await cancellation;
   if(result==='reject')fail(new Error('fixture-transport-failure'));
   else finish({state:result});
  }
  await work;
  const row=d.readApproval(ref.approvalId)!;
  const accepted=(point==='atomic-dispatch'||point==='during-transport')&&result==='accepted';
  // MAIN RULING 2026-11-14 R1: retain the definitive failed receipt alongside cancellation; no allow is confirmed.
  expect(row).toMatchObject(accepted?{state:'answered',delivery:'accepted'}:{state:'cancelled',delivery:point==='before-check'?'none':kind==='queue'||result==='failed'?'failed':'unconfirmed'});
  expect(respond).toHaveBeenCalledTimes(point==='before-check'?0:1);
  expect(f.store.messageById('t',row.chatMessageId)?.card).toMatchObject({answered:accepted?'Allowed':'Cancelled',dismissed:true,...(accepted?{}:{orphaned:true})});
  expect(scheduler.count()).toBe(0);
  if(kind==='queue'){
   expect(cancelQueue).toHaveBeenCalledTimes(accepted?0:1);
   if(!accepted)expect(pending).toEqual([]);
   await d.recover();expect(respond).toHaveBeenCalledTimes(point==='before-check'?0:1);
  }else expect(f.interrupt).toHaveBeenCalledTimes(!accepted&&point!=='before-check'?1:0);
 }finally{dispose();}
});
