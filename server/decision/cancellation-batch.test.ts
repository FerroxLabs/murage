import {expect,it,vi} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
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
