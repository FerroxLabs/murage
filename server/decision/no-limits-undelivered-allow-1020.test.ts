// SPDX-License-Identifier: AGPL-3.0-or-later
// 1020 perm-deliver (real Claude Sonnet, Linux gate, a2d7e660 s2): at No limits a 72-step owner turn was ended after 27 tool
// rows by "The tool permission could not be delivered. Nothing was confirmed." and a "Stopped by you" chip nobody pressed.
// The engine had already settled the ask (broker answer refused -> adapter "unavailable" -> state failed), so the allow never
// ran; the decision builder still interrupted the turn through the owner-Stop path. Only the fake transport receives replies.
import {expect,it,vi} from 'vitest';
import {fixture,d,baseRun,baseCard,card} from './fixture.ts';
import {decisionInterrupt,PERMISSION_UNDELIVERED_STOP_REASON} from './host-stop-interrupt.ts';
import {hostStoppedActivityName,hostStoppedReason} from '../../shared/host-stop.ts';

const undelivered=(f:ReturnType<typeof fixture>)=>f.store.messagesFor('t').filter(m=>m.text?.includes('could not be delivered'));

it('No limits: an auto-allow the engine already settled (delivery failed) never ends the owner turn and posts no failure row',async()=>{
 const f=fixture();f.respond.mockResolvedValueOnce({state:'failed'});
 const first=f.open('gone',{command:'printf one'});expect(d.decide(first,baseRun).kind).toBe('run');await d.deliverRequest(first);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 expect(f.interrupt).not.toHaveBeenCalled();
 expect(undelivered(f)).toEqual([]);
 expect(d.readRequestExecution(first)).toMatchObject({delivery:'failed'});
 // the turn goes on: the next step of the same turn is delivered as usual
 const next=f.open('next',{command:'printf two'});expect(d.decide(next,baseRun).kind).toBe('run');await d.deliverRequest(next);
 expect(f.respond).toHaveBeenCalledTimes(2);expect(d.readRequestExecution(next)).toMatchObject({delivery:'accepted'});
 expect(f.interrupt).not.toHaveBeenCalled();f.dispose();
});

it('No limits: an unconfirmed allow still stops the turn (fail-closed), as a host stop with its reason, never as the owner\'s Stop',async()=>{
 vi.useFakeTimers();
 try{
  const f=fixture();f.respond.mockImplementation(()=>new Promise(()=>{}));
  const h=f.open('hung',{command:'printf hung'});expect(d.decide(h,baseRun).kind).toBe('run');const delivered=d.deliverRequest(h);
  await vi.advanceTimersByTimeAsync(20001);await delivered;
  expect(f.interrupt).toHaveBeenCalledOnce();
  expect(f.interrupt.mock.calls[0]).toEqual([expect.objectContaining({threadId:'t',requestId:'hung'}),expect.stringMatching(/^a tool permission could not be delivered/)]);
  expect(String((f.interrupt.mock.calls[0] as unknown[])[1])).not.toMatch(/by you/i);
  expect(undelivered(f)).toHaveLength(1);f.dispose();
 }finally{vi.useRealTimers();}
});

it('Ask level: an owner allow the engine could not take stops the turn as a host stop with its reason',async()=>{
 const f=fixture('ask');f.respond.mockResolvedValueOnce({state:'failed'});
 const ref=card(d.decide(f.open('asked',{command:'printf asked'}),baseCard));
 await d.presentApproval(ref,{title:'Action',subtitle:'Fixture'});
 await d.answerApproval(ref,{behavior:'allow'}).catch(()=>{});
 expect(f.interrupt).toHaveBeenCalledOnce();
 expect((f.interrupt.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual(expect.stringMatching(/^a tool permission could not be delivered/));
 expect(undelivered(f).length).toBeGreaterThanOrEqual(1);f.dispose();
});

// The server wiring (server/index.ts installDecisionTransport): the host note lands before the engine interrupt, so the turn
// that settles after it finds a host-stop row (hostStopNotedSinceLastUserMessage) and writes no "Stopped by you" chip.
it('a decision-builder interrupt notes the host stop in the thread before the engine is interrupted; an owner Stop (no reason) notes nothing',async()=>{
 const f=fixture();const order:string[]=[];
 const target={providerInstanceId:'p',threadId:'t',generation:'g',turnId:'turn',requestId:'r'};
 const interrupt=decisionInterrupt({
  adapter:()=>({interruptTurn:async()=>{order.push('interrupt');}}),
  botFor:()=>'b',
  noteHostStop:(threadId,_botId,reason)=>{order.push('note');f.store.appendMessage(threadId,{role:'bot',kind:'activity',tool:{name:hostStoppedActivityName(reason),ok:false}});},
 });
 await interrupt(target,PERMISSION_UNDELIVERED_STOP_REASON);
 expect(order).toEqual(['note','interrupt']);
 const noted=f.store.messagesFor('t').filter(m=>hostStoppedReason(m.tool?.name));
 expect(noted.map(m=>hostStoppedReason(m.tool?.name))).toEqual([PERMISSION_UNDELIVERED_STOP_REASON]);
 order.length=0;await interrupt(target);
 expect(order).toEqual(['interrupt']);
 expect(f.store.messagesFor('t').filter(m=>hostStoppedReason(m.tool?.name))).toHaveLength(1);
 // a stale target is a no-op: nothing noted, nothing interrupted
 order.length=0;await decisionInterrupt({adapter:()=>undefined,botFor:()=>'b',noteHostStop:()=>{order.push('note');}})(target,PERMISSION_UNDELIVERED_STOP_REASON);
 expect(order).toEqual([]);f.dispose();
});
