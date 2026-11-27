// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { fixture, card, d, baseCard } from '../decision/fixture.ts';
import { registeredChannelQuestions, answerRegisteredChannelQuestion } from './registered-questions.ts';
import { TelegramApprovals } from '../telegram-approvals.ts';
const questions=[{id:'q',question:'Which format?',options:[{label:'Summary'},{label:'Detailed'}],multiSelect:false,allowOther:true}];
async function pending(extra:object={}){
 const f=fixture('unlimited');
 const handle=f.open('question',{}, {tool:'AskUserQuestion',requestType:'question',questions,...extra});
 const ref=card(d.decide(handle,baseCard));await d.presentApproval(ref,{title:'Question',subtitle:'Which format?'});
 const bot={id:'b',name:'Mira',threadId:'t',modelSelection:{instanceId:'p'}};
 return {...f,ref,bot};
}
it('delivers a registered question through the real Telegram manager and answers it once',async()=>{
 const f=await pending();
 // Owner report 2026-11-21: a No limits question is its interactive card in the app (was a text row, 0 cards).
 expect(f.store.openRequestCardRows('t')).toHaveLength(1);
 const actions={pending:()=>registeredChannelQuestions(f.store,f.bot),resolve:vi.fn(async()=>false),answer:(offer:any,reply:any)=>answerRegisteredChannelQuestion('t','b',offer,reply)};
 const sendMessage=vi.fn(async()=>({chatId:'7',messageId:19}));
 const manager=new TelegramApprovals(actions,{sendMessage,answerCallbackQuery:vi.fn(async()=>{})});
 const owner={senderId:'7',chatId:'7'},signal=new AbortController().signal;
 await manager.publish(owner,()=>true,signal);
 expect(sendMessage).toHaveBeenCalledTimes(1);
 const offer=actions.pending()[0];expect(offer.approvalId).toBe(f.ref.approvalId);
 expect(await actions.answer(offer,{behavior:'answer',answers:[{id:'q',selected:['Detailed']}]})).toEqual({ok:true});
 expect(f.respond).toHaveBeenCalledTimes(1);
 expect(f.respond.mock.calls[0][1]).toMatchObject({behavior:'answer',answers:[{id:'q',selected:['Detailed']}]});
 expect(await actions.answer(offer,{behavior:'skip'})).toEqual({ok:false,error:'This question is no longer open.'});
 expect(f.respond).toHaveBeenCalledTimes(1);
});
it('keeps secrets, copied identities, other threads and invalid answers out of channel delivery',async()=>{
 const f=await pending();const offer=registeredChannelQuestions(f.store,f.bot)[0];
 for(const [thread,bot,changed] of [['other','b',offer],['t','other',offer],['t','b',{...offer,actionHash:'wrong'}]] as const)
  expect((await answerRegisteredChannelQuestion(thread,bot,changed,{behavior:'skip'})).ok).toBe(false);
 expect((await answerRegisteredChannelQuestion('t','b',offer,{behavior:'answer',answers:[{id:'q',selected:['Unknown']}]})).ok).toBe(false);
 expect(f.respond).not.toHaveBeenCalled();
 const secret=f.open('secret',{}, {tool:'AskUserQuestion',requestType:'question',questions:[{...questions[0],secret:true}]});
 await d.presentApproval(card(d.decide(secret,baseCard)),{title:'Secret',subtitle:'Hidden'});
 expect(registeredChannelQuestions(f.store,f.bot)).toHaveLength(1);
});
