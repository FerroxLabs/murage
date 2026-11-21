// SPDX-License-Identifier: AGPL-3.0-or-later
// 1021 Retry on a delivery-failed approval card (RETRY-DESIGN-r2). An owner answer that did not reach the engine, while the
// engine provably still holds that exact ask and the stop did not land, offers "Send again". Send again re-sends the stored
// answer through the existing send() and its release gate (the OPUS High): never a second ask, never a second approval,
// never after acceptance, never on top of a stop. Real decision layer and records; only the engine transport is faked.
import {afterEach,expect,it,vi} from 'vitest';
import {fixture,d,baseCard,card} from './fixture.ts';

const FAILED='The tool permission could not be delivered. Nothing was confirmed.';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

function setup(level:'ask'|'unlimited'='ask'){
 const f=fixture(level);
 const canRedeliver=vi.fn((_t:unknown)=>true),rearmRetry=vi.fn((_t:unknown)=>true);
 d.installDecisionTransport({respond:f.respond,interrupt:f.interrupt,canRedeliver,rearmRetry});
 return {f,canRedeliver,rearmRetry};
}
type Fixture=ReturnType<typeof fixture>;
const cardOf=(f:Fixture,ref:d.ApprovalRef)=>{const r=d.readApproval(ref.approvalId)!;return f.store.messageById('t',r.chatMessageId)!.card!;};
const failedRows=(f:Fixture)=>f.store.messagesFor('t').filter(m=>m.kind==='text'&&m.text===FAILED);
const delivery=(ref:d.ApprovalRef)=>d.readApprovalExecution(ref).delivery;
/** An owner Allow on a card whose delivery fails; the stop is rejected unless `stop` says otherwise. */
const stopFailed=()=>Object.assign(new Error('stop-failed'),{stopFailed:true});
async function failedAllow(f:Fixture,opts:{stop?:'reject'|'throw'|'land'|'hang';input?:unknown;extra?:object}={}){
 const ref=card(d.decide(f.open('asked',opts.input,opts.extra),baseCard));
 await d.presentApproval(ref,{title:'Action',subtitle:'Fixture'});
 f.respond.mockResolvedValueOnce({state:'failed'});
 const stop=opts.stop??'reject';
 // the decision interrupt's rejection for a driver stop resolved {closeConfirmed:false, reason:'stop-failed'} (decisionInterrupt)
 if(stop==='reject')f.interrupt.mockRejectedValueOnce(stopFailed());
 else if(stop==='throw')f.interrupt.mockRejectedValueOnce(new Error('adapter-threw'));
 else if(stop==='hang')f.interrupt.mockImplementationOnce(()=>new Promise(()=>{}));
 await d.answerApproval(ref,{behavior:'allow'}).catch(()=>{});
 return ref;
}

it('W1 failed + stop rejected + ask still held: Send again is offered, attention kept, no failure row; the retry delivers ONE answer to the same request and the card reads Allowed',async()=>{
 const {f,rearmRetry}=setup();
 const ref=await failedAllow(f);
 expect(f.respond).toHaveBeenCalledTimes(1);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 expect(failedRows(f)).toEqual([]);
 expect(delivery(ref)).toBe('failed');
 f.respond.mockResolvedValueOnce({state:'accepted'});
 expect(await d.retryDelivery(ref)).toBe('accepted');
 expect(f.respond).toHaveBeenCalledTimes(2);
 const [target,answer,options]=f.respond.mock.calls[1];
 expect(target.requestId).toBe('asked');expect(answer.behavior).toBe('allow');
 expect(options.answerId).not.toBe(f.respond.mock.calls[0][2].answerId);
 // the driver re-arm ran once, inside send()'s respond closure, before the native respond
 expect(rearmRetry).toHaveBeenCalledOnce();
 expect(rearmRetry.mock.invocationCallOrder[0]).toBeLessThan(f.respond.mock.invocationCallOrder[1]);
 expect(delivery(ref)).toBe('accepted');
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(cardOf(f,ref).answered).toBe('Allowed');
 expect(failedRows(f)).toEqual([]);
 // no second ask, no second approval record
 expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(1);
 f.dispose();
});

it('W2 a stop that landed is terminal: read-only card with its one failure row, and a retry sends nothing',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f,{stop:'land'});
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(cardOf(f,ref).answered).toBe(FAILED);
 expect(failedRows(f)).toHaveLength(1);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');
 expect(f.respond).toHaveBeenCalledTimes(1);
 expect(failedRows(f)).toHaveLength(1);
 f.dispose();
});

it('W8 (r3 N1) a stop that threw is unknown (it may be held), never a failed stop: read-only, no Send again',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f,{stop:'throw'});
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(failedRows(f)).toHaveLength(1);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');expect(f.respond).toHaveBeenCalledTimes(1);
 f.dispose();
});

it('W2 the ask leaves the engine (turn.completed) while Send again is offered: the card ends read-only and a retry sends nothing',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 f.publish({type:'turn.completed',threadId:'t',turnId:'turn',providerInstanceId:'p',ok:true});
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(cardOf(f,ref).answered).toBe(FAILED);
 expect(failedRows(f)).toHaveLength(1);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');
 expect(f.respond).toHaveBeenCalledTimes(1);
 f.dispose();
});

it('W2 the driver no longer holds the ask (canRedeliver false): no Send again',async()=>{
 const {f,canRedeliver}=setup();canRedeliver.mockReturnValue(false);
 const ref=await failedAllow(f);
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(failedRows(f)).toHaveLength(1);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');expect(f.respond).toHaveBeenCalledTimes(1);
 f.dispose();
});

it('W2 (Opus r2 H3) a stale Send again after the ask left its generation ends the card and stops nothing',async()=>{
 const {f,canRedeliver}=setup();
 const ref=await failedAllow(f);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 canRedeliver.mockReturnValue(false);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.interrupt).toHaveBeenCalledTimes(1);
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 f.dispose();
});

it('W3 two concurrent Send again clicks send ONE answer; a third click after acceptance gets accepted and the card stays Allowed',async()=>{
 const {f,rearmRetry}=setup();
 const ref=await failedAllow(f);
 let release!:(v:{state:'accepted'})=>void;
 f.respond.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const a=d.retryDelivery(ref),b=d.retryDelivery(ref);
 await vi.waitFor(()=>expect(f.respond).toHaveBeenCalledTimes(2));
 expect(cardOf(f,ref).deliveryRetry).toBe('sending');
 release({state:'accepted'});
 expect(await a).toBe('accepted');expect(await b).toBe('accepted');
 expect(f.respond).toHaveBeenCalledTimes(2);expect(rearmRetry).toHaveBeenCalledOnce();
 expect(await d.retryDelivery(ref)).toBe('accepted');
 expect(f.respond).toHaveBeenCalledTimes(2);
 expect(cardOf(f,ref).answered).toBe('Allowed');expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 f.dispose();
});

it('W4 the bot raised to No limits while Send again is offered: the retry is refused, the card ends read-only, one more stop is tried',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 f.setLevel('unlimited');
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');
 expect(f.respond).toHaveBeenCalledTimes(1);
 expect(f.interrupt).toHaveBeenCalledTimes(2);
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(failedRows(f)).toHaveLength(1);
 f.dispose();
});

it('W4 No limits: an owner allow that failed has no record, so there is nothing to retry',async()=>{
 const {f}=setup('unlimited');
 f.respond.mockResolvedValueOnce({state:'failed'});
 const h=f.open('nl',{command:'printf nl'});expect(d.decide(h,()=>({approve:'BASE',source:'auto-mode' as const})).kind).toBe('run');
 await d.deliverRequest(h);
 expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(0);
 expect(f.store.messagesFor('t').filter(m=>m.card?.deliveryRetry)).toEqual([]);
 f.dispose();
});

it('W5 an unconfirmed answer is never retried',async()=>{
 vi.useFakeTimers();
 const {f}=setup();
 const ref=card(d.decide(f.open('asked'),baseCard));
 await d.presentApproval(ref,{title:'Action',subtitle:'Fixture'});
 f.respond.mockImplementationOnce(()=>new Promise(()=>{})).mockImplementationOnce(()=>new Promise(()=>{}));
 const answered=d.answerApproval(ref,{behavior:'allow'}).catch(()=>{});
 await vi.advanceTimersByTimeAsync(21000);await answered;
 expect(delivery(ref)).toBe('unconfirmed');expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 const shown={card:cardOf(f,ref).answered,rows:f.store.messagesFor('t').length};
 expect(await d.retryDelivery(ref)).toBe('delivery_unconfirmed');expect(f.respond).toHaveBeenCalledTimes(2);
 // the retry path never touches an unconfirmed answer: same card line, no new row
 expect({card:cardOf(f,ref).answered,rows:f.store.messagesFor('t').length}).toEqual(shown);
 f.dispose();
});

it('W5 restart: a card still offering Send again ends read-only at boot (no eligibility survives a restart)',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 // a fresh host is a restarted server: in-memory eligibility is gone, only the persisted card and record remain
 d.installDecisionHost({store:f.store,view:()=>({title:'Action',subtitle:'Fixture'})});
 const messageId=d.readApproval(ref.approvalId)!.chatMessageId;
 await d.recover();
 // the route reads the ref again after a restart (lookupApproval), as here
 const after=d.lookupApproval('t',messageId)!.ref;
 expect(cardOf(f,after).deliveryRetry).toBeUndefined();expect(cardOf(f,after).answered).toBe(FAILED);
 expect(failedRows(f)).toHaveLength(1);
 expect(await d.retryDelivery(after)).toBe('delivery_failed_terminal');expect(f.respond).toHaveBeenCalledTimes(1);
 f.dispose();
});

it('W6 a retry adds no record, card, notification row or second stop: counts before = after (one card message patched)',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f);
 const before={records:f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n,messages:f.store.messagesFor('t').length};
 f.respond.mockResolvedValueOnce({state:'failed'});f.interrupt.mockRejectedValueOnce(stopFailed());
 expect(await d.retryDelivery(ref)).toBe('delivery_retry');
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 f.respond.mockResolvedValueOnce({state:'accepted'});
 expect(await d.retryDelivery(ref)).toBe('accepted');
 expect({records:f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n,messages:f.store.messagesFor('t').length}).toEqual(before);
 f.dispose();
});

it('W7 (OPUS High) the owner saves Never for the host computer after the failed Allow: the retry runs the release gate, sends nothing, ends read-only',async()=>{
 const {f,rearmRetry}=setup();
 const ref=await failedAllow(f,{input:{action:'click'},extra:{tool:'mcp__host_computer__click',toolCall:{name:'mcp__host_computer__click',input:{action:'click'}}}});
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 f.deny([{kind:'deny',class:'host-computer',ruleId:'host-declined',span:'fixture'} as any]);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');
 expect(f.respond).toHaveBeenCalledTimes(1);expect(rearmRetry).not.toHaveBeenCalled();
 expect(delivery(ref)).toBe('failed');
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(cardOf(f,ref).answered).toBe(FAILED);
 expect(failedRows(f)).toHaveLength(1);
 f.dispose();
});

it('W8 a stop still pending at 1 s is terminal, and its late rejection does not bring Send again back',async()=>{
 vi.useFakeTimers();
 const {f}=setup();
 const ref=card(d.decide(f.open('asked'),baseCard));
 await d.presentApproval(ref,{title:'Action',subtitle:'Fixture'});
 f.respond.mockResolvedValueOnce({state:'failed'});
 let reject!:(e:Error)=>void;f.interrupt.mockImplementationOnce(()=>new Promise((_r,j)=>{reject=j;}));
 const answered=d.answerApproval(ref,{behavior:'allow'}).catch(()=>{});
 await vi.advanceTimersByTimeAsync(1500);await answered;
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(failedRows(f)).toHaveLength(1);
 reject(new Error('late'));await vi.advanceTimersByTimeAsync(10);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');
 expect(f.respond).toHaveBeenCalledTimes(1);expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 f.dispose();
});

it('W9 a retry whose first native pass outlasts 10 s re-arms once: the second pass joins the same answerId',async()=>{
 vi.useFakeTimers();
 const {f,rearmRetry}=setup();
 const ref=await failedAllow(f);
 f.respond.mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValueOnce({state:'accepted'});
 const retried=d.retryDelivery(ref);
 await vi.advanceTimersByTimeAsync(10500);
 expect(await retried).toBe('accepted');
 expect(f.respond).toHaveBeenCalledTimes(3);
 expect(rearmRetry).toHaveBeenCalledOnce();
 expect(f.respond.mock.calls[2][2].answerId).toBe(f.respond.mock.calls[1][2].answerId);
 expect(delivery(ref)).toBe('accepted');expect(cardOf(f,ref).answered).toBe('Allowed');expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 f.dispose();
});

it('W9 (Opus r2 H4) a slow first pass then a host decline at the second pass: the answer may have landed, so it is unconfirmed, never "nothing was run"',async()=>{
 vi.useFakeTimers();
 const {f,rearmRetry}=setup();
 const ref=await failedAllow(f,{input:{action:'click'},extra:{tool:'mcp__host_computer__click',toolCall:{name:'mcp__host_computer__click',input:{action:'click'}}}});
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 f.respond.mockImplementationOnce(()=>new Promise(()=>{}));
 const retried=d.retryDelivery(ref);
 await vi.advanceTimersByTimeAsync(100);
 expect(rearmRetry).toHaveBeenCalledOnce();
 f.deny([{kind:'deny',class:'host-computer',ruleId:'host-declined',span:'fixture'} as any]);
 await vi.advanceTimersByTimeAsync(10500);
 expect(await retried).toBe('delivery_unconfirmed');
 expect(f.respond).toHaveBeenCalledTimes(2);
 expect(delivery(ref)).toBe('unconfirmed');
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 f.dispose();
});

it('a turn cancelled during a retry ends the card: Send again never stays on "Sending..."',async()=>{
 vi.useFakeTimers();
 const {f}=setup();
 const ref=await failedAllow(f);
 f.respond.mockImplementationOnce(()=>new Promise(()=>{}));
 const retried=d.retryDelivery(ref);
 await vi.advanceTimersByTimeAsync(100);
 expect(cardOf(f,ref).deliveryRetry).toBe('sending');
 await d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 await vi.advanceTimersByTimeAsync(10500);
 await retried;
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 f.dispose();
});

it('a restart during a retry ends the card: the boot recovery drops "Sending..."',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f);
 f.respond.mockImplementationOnce(()=>new Promise(()=>{}));
 void d.retryDelivery(ref);
 await vi.waitFor(()=>expect(f.respond).toHaveBeenCalledTimes(2));
 expect(cardOf(f,ref).deliveryRetry).toBe('sending');
 const messageId=d.readApproval(ref.approvalId)!.chatMessageId;
 d.installDecisionHost({store:f.store,view:()=>({title:'Action',subtitle:'Fixture'})});
 await d.recover();
 const after=d.lookupApproval('t',messageId)!.ref;
 expect(cardOf(f,after).deliveryRetry).toBeUndefined();
 expect(d.readApprovalExecution(after).delivery).toBe('unconfirmed');
 f.dispose();
});

it('(Fable M5) an owner Stop while Send again is offered ends the card read-only, and a later click sends nothing',async()=>{
 const {f}=setup();
 const ref=await failedAllow(f);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 await d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();expect(failedRows(f)).toHaveLength(1);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');expect(f.respond).toHaveBeenCalledTimes(1);
 f.dispose();
});
