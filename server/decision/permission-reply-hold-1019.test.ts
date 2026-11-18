// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { fixture, d, baseRun, baseCard, card } from './fixture.ts';
import { holdEnginePermissionReply } from './provider-release.ts';
import { PERMISSION_REPLY_TOO_LARGE } from '../permission-reply.ts';
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
