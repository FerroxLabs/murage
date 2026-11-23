// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { fixture, d, baseRun, baseCard, card } from './fixture.ts';
import * as release from './provider-release.ts';
import { holdEnginePermissionReply } from './provider-release.ts';
import { OWNER_PERMISSION_REPLY_TOO_LARGE, PERMISSION_REPLY_TOO_LARGE } from '../permission-reply.ts';
const identity={threadId:'t',requestId:'r',turnId:'turn',providerInstanceId:'p'};
for(const priorCard of [false,true])it(`No limits oversized permission reply keeps a deny-only card: priorCard=${priorCard}`,async()=>{
 const f=fixture(priorCard?'ask':'unlimited');const h=f.open();
 const initial=d.decide(h,priorCard?baseCard:baseRun);
 if(priorCard)await d.presentApproval(card(initial),{title:'Original',subtitle:'Before transport'});
 expect(holdEnginePermissionReply({...identity,turnId:'stale'},PERMISSION_REPLY_TOO_LARGE)).toBe(false);
 expect(holdEnginePermissionReply(identity,PERMISSION_REPLY_TOO_LARGE)).toBe(priorCard);
 // MAIN RULING 2026-11-13 narrow-wipe (Sean)
 if(!priorCard){expect(d.openApprovals('t')).toHaveLength(0);expect(d.decide(h,baseRun).kind).toBe('run');await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(f.interrupt).not.toHaveBeenCalled();f.dispose();return;}
 const open=d.openApprovals('t');expect(open).toHaveLength(1);
 const row=open[0]!;expect(row.state).toBe('open');expect(row.action.options).toEqual(['Deny']);
 const message=f.store.messageById('t',row.chatMessageId)!;
 expect(message.card?.subtitle).toBe(PERMISSION_REPLY_TOO_LARGE);expect(message.card?.dismissed).not.toBe(true);
 expect(d.decide(h,baseRun).kind).toBe('card');
 await d.answerApproval(row.ref,{behavior:'allow'});expect(f.respond).not.toHaveBeenCalled();
 await d.answerApproval(row.ref,{behavior:'deny'});expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0]![1].behavior).toBe('deny');
 expect(d.openApprovals('t')).toEqual([]);expect(f.interrupt).not.toHaveBeenCalled();
});
// cause22 caps r3: an owner No limits card (a wipe check) whose changed allow is over the engine's reply cap. The transport below stands
// in for the Claude driver's three lines (drivers/claude.ts respondToRequest; the real ones run in cause22-owner-caps-reply-1021.test.ts):
// it asks this layer what the oversize reply becomes; `deny` = it denied that one ask at the broker and the deny landed (accepted),
// anything else = unavailable (failed). The layer must not interrupt the owner's turn, and the card's record must say deny, not allow.
it('No limits owner card: a changed allow over the reply cap is recorded as a deny for that one request and the turn is not interrupted',async()=>{
 const f=fixture('unlimited');const h=f.open('r',{command:'rm -rf ~'});
 const ref=card(d.decide(h,baseRun));
 await d.presentApproval(ref,{title:'Wipe check',subtitle:'Before transport'});
 f.respond.mockImplementation(async(_target,answer)=>{
  if(answer.behavior!=='allow')return {state:'accepted' as const};
  const settle=(release as {settleOversizePermissionReply?:(i:typeof identity,line:string)=>string}).settleOversizePermissionReply;
  const how=settle?settle(identity,PERMISSION_REPLY_TOO_LARGE):holdEnginePermissionReply(identity,PERMISSION_REPLY_TOO_LARGE)?'card':'none';
  return {state:how==='deny'?'accepted' as const:'failed' as const};
 });
 await d.answerApproval(ref,{behavior:'allow'});
 expect(f.respond.mock.calls.filter(call=>call[1].behavior==='allow'),'the owner allow reached the driver once').toHaveLength(1);
 expect(f.interrupt,"an allow over the reply cap does not interrupt the owner's turn").not.toHaveBeenCalled();
 const receipt=d.readApprovalExecution(ref);
 expect({delivery:receipt.delivery,answer:receipt.answer},'the record says what the engine got: a delivered deny, never an allow').toEqual({delivery:'accepted',answer:{behavior:'deny',message:OWNER_PERMISSION_REPLY_TOO_LARGE}});
 const texts=f.store.messagesFor('t').filter(m=>m.role==='bot'&&m.kind==='text').map(m=>m.text);
 expect(texts.filter(text=>text===OWNER_PERMISSION_REPLY_TOO_LARGE),'the owner reads the fixed too-large line once').toHaveLength(1);
 f.dispose();
});
