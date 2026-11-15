import { completeDecisionGeneration } from "./generation-retirement.ts";
import {expect,it,vi} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
it.each(['release','terminal','stopped','failed'] as const)('%s retirement fences native and unqueued work; only natural completion retains queued cards',async path=>{
 const f=fixture(),native=card(d.decide(f.open('native',{command:'rm -rf ~'}),baseCard));
 await d.presentApproval(native,{title:'Native',subtitle:'Fixture'});
 const call=f.serviceCall(),queued=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));
 let pending:d.PendingQueueApproval[]=[{kind:'email',ref:'q',approvalId:queued.approvalId,epoch:'e',proof:'trusted',call:call as d.PendingQueueApproval['call'],view:{title:'Queued',subtitle:'Fixture'}}];
 const cancel=vi.fn(async()=>{pending=[];}),respond=vi.fn(async()=>({state:'accepted' as const}));
 const dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>pending,reopen:()=>({kind:'service',service:'email',claim:f.claim,call}),base:baseCard,respond,cancel,renew:async()=>pending[0]!}]);
 try{
  d.attachQueue(queued,{kind:'email',ref:'q',call});await d.presentApproval(queued,pending[0]!.view);
  const unqueued=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'fixture_read',input:{}}});
  d.decide(unqueued,baseCard);
  if(path==='release')await completeDecisionGeneration({threadId:'t',generation:'g'});
  else {f.publish({type:'turn.completed',threadId:'t',providerInstanceId:'p',turnId:'turn',ok:path!=='failed',...(path==='stopped'?{stopReason:'cancelled'}:{})});await expect.poll(()=>d.readApproval(native.approvalId)?.state).toBe('cancelled');}
  if(path==='stopped'||path==='failed'){
   await expect.poll(()=>d.readApproval(queued.approvalId)?.state).toBe('cancelled');expect(cancel).toHaveBeenCalledOnce();expect(pending).toEqual([]);expect(respond).not.toHaveBeenCalled();return;
  }
  expect(d.readApproval(native.approvalId)?.state).toBe('cancelled');
  const execute=vi.fn();expect(d.executeServiceSync(unqueued,execute).kind).toBe('refuse');expect(execute).not.toHaveBeenCalled();
  expect(d.readApproval(queued.approvalId)?.state).toBe('open');expect(pending).toHaveLength(1);expect(respond).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();
  // Explicit Stop still cancels that same durable card and cannot deliver it.
  await d.cancelRequests({kind:'generation',threadId:'t',generation:'g'},'cancelled');
  expect(d.readApproval(queued.approvalId)?.state).toBe('cancelled');expect(cancel).toHaveBeenCalledOnce();expect(pending).toEqual([]);expect(respond).not.toHaveBeenCalled();
 }finally{dispose();f.dispose();}
});
it('B4 cancelling a generation fences every scheduled service before the first await',async()=>{
 const f=fixture();
 f.open('first');
 const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input:{text:'later request'}}});
 d.decide(h,baseCard);const execute=vi.fn(async()=>42),work=d.executeService(h,execute);
 const cancellation=d.cancelRequests({kind:'generation',threadId:'t',generation:'g'},'cancelled');
 await cancellation;expect((await work).kind).toBe('refuse');expect(execute).not.toHaveBeenCalled();
});
it('B4 synchronous execution after cancellation does not run the registered call',async()=>{
 const f=fixture(),h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input:{text:'fixture'}}});
 d.decide(h,baseCard);await d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 const execute=vi.fn();expect(d.executeServiceSync(h,execute).kind).toBe('refuse');expect(execute).not.toHaveBeenCalled();
});
it('B4 cancelling a RUN before the transport microtask sends no Allow',async()=>{
 const f=fixture(),h=f.open();d.decide(h,baseCard);
 const delivery=d.deliverRequest(h);const cancellation=d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 await Promise.all([delivery,cancellation]);expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('deny');
});

it('B4 cancelling a persisted card after allow before yielding sends nothing',async()=>{
 const f=fixture(),ref=card(d.decide(f.open('persisted',{command:'rm -rf ~'}),baseCard));
 await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 const delivery=d.answerApproval(ref,{behavior:'allow'});
 const cancellation=d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 await Promise.all([delivery,cancellation]);
 expect(f.respond).not.toHaveBeenCalled();
 expect(d.readApproval(ref.approvalId)?.state).toBe('cancelled');
});

it('B4 cancellation after transport starts preserves an accepted delivery',async()=>{
 const f=fixture(),ref=card(d.decide(f.open('accepted',{command:'rm -rf ~'}),baseCard));
 await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 let accept!:(value:{state:'accepted'})=>void;
 f.respond.mockImplementation(()=>new Promise(resolve=>{accept=resolve;}));
 const delivery=d.answerApproval(ref,{behavior:'allow'});
 await Promise.resolve();expect(f.respond).toHaveBeenCalledTimes(1);
 await d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 accept({state:'accepted'});await delivery;
 expect(d.readApproval(ref.approvalId)).toMatchObject({state:'answered',delivery:'accepted'});
});

for(const result of ['failed','reject'] as const)it(`B4 cancelled in-flight engine ${result} finalizes failure without retry`,async()=>{
 const f=fixture(),ref=card(d.decide(f.open('failed',{command:'rm -rf ~'}),baseCard));
 await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 let finish!:()=>void;
 f.respond.mockResolvedValue({state:'failed'}).mockImplementationOnce(()=>new Promise((resolve,reject)=>{finish=()=>result==='failed'?resolve({state:'failed'}):reject(new Error('fixture-transport-failure'));}));
 const delivery=d.answerApproval(ref,{behavior:'allow'});
 await Promise.resolve();expect(f.respond).toHaveBeenCalledOnce();
 await d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 finish();await delivery;
 // MAIN RULING 2026-11-14 R1: definite native failure is terminal; cancellation and its exact delivery receipt both survive.
 expect(d.readApproval(ref.approvalId)).toMatchObject({state:'cancelled',delivery:result==='failed'?'failed':'unconfirmed'});
 expect(f.respond).toHaveBeenCalledOnce();expect(f.interrupt).toHaveBeenCalledOnce();
 const row=d.readApproval(ref.approvalId)!;
 expect(f.store.messageById('t',row.chatMessageId)?.card).toMatchObject({answered:'Cancelled',dismissed:true,orphaned:true});
 expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='text'").get()!.n).toBe(1);
});

for(const result of ['failed','reject'] as const)it(`B4 cancelled in-flight queue ${result} cleans up before recovery`,async()=>{
 const f=fixture(),call=f.serviceCall();
 const ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));
 const item:d.PendingQueueApproval={kind:'email',ref:'q',approvalId:ref.approvalId,epoch:'e',proof:'trusted',call:call as d.PendingQueueApproval['call'],view:{title:'Fixture',subtitle:'x'}};
 let pending=[item],finish!:()=>void;
 const respond=vi.fn<d.QueueRecoverySource['respond']>().mockResolvedValue({state:'failed'}).mockImplementationOnce(()=>new Promise((resolve,reject)=>{finish=()=>result==='failed'?resolve({state:'failed'}):reject(new Error('fixture-queue-failure'));}));
 const cancel=vi.fn(async()=>{pending=[];});
 const dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>pending,reopen:()=>({kind:'service',service:'email',claim:f.claim,call}),respond,cancel,renew:vi.fn(),base:baseCard}]);
 try{
  d.attachQueue(ref,{kind:'email',ref:'q',call});await d.presentApproval(ref,item.view);
  const delivery=d.answerApproval(ref,{behavior:'allow'});
  await Promise.resolve();expect(respond).toHaveBeenCalledOnce();
  await d.cancelRequests({kind:'thread',threadId:'t'},'superseded');
  finish();await delivery;
  expect(d.readApproval(ref.approvalId)).toMatchObject({state:'superseded',delivery:'failed'});
  expect(cancel).toHaveBeenCalledExactlyOnceWith(item,'delivery-failed');expect(pending).toEqual([]);
  expect(f.store.messageById('t',d.readApproval(ref.approvalId)!.chatMessageId)?.card).toMatchObject({answered:'Continued at the new level',dismissed:true,orphaned:true});
  await d.recover();expect(respond).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalledOnce();
 }finally{dispose();}
});
