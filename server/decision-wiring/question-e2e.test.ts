// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { wiring, source } from './fixture.ts';
describe('R9/M33: FIFO question reply routes',()=>{
  it('answers oldest through S1; ordinary instruction is sent then relisted',async()=>{
    let n=0; const calls:string[]=[];
    const answerQuestionReply=vi.fn(async()=>++n===1?{kind:'answered',ref:{approvalId:'first'}}:{kind:'send',pending:[{approvalId:'second'}]});
    const { routeDecisionQuestion }=wiring(['routeDecisionQuestion'],{assertQuestionDelivery:()=>{},answerQuestionReply,readApproval:()=>undefined,relistQuestions:async()=>calls.push('relist')});
    expect(await routeDecisionQuestion('t','1',true,async()=>{calls.push('send');return 'sent';})).toEqual({ok:true,threadId:'t',questionAnswered:true});
    expect(await routeDecisionQuestion('t','write the report',true,async()=>{calls.push('send');return 'sent';})).toBe('sent');
    expect(calls).toEqual(['send','relist']);
  });
  it('never consumes a question on an unproven send',async()=>{
    const answerQuestionReply=vi.fn(); const relistQuestions=vi.fn();
    const { routeDecisionQuestion }=wiring(['routeDecisionQuestion'],{answerQuestionReply,relistQuestions});
    expect(await routeDecisionQuestion('t','1',false,async()=>42)).toBe(42);
    expect(answerQuestionReply).not.toHaveBeenCalled();
  });
  it('both H4 entry points route through the FIFO API',()=>{
    expect(source.includes('return routeDecisionQuestion(threadId, text,')).toBe(true);
    expect(source.includes('const reply = await answerQuestionReply(threadId, text)')).toBe(true);
    expect(source.includes('pendingQuestions.set(')).toBe(false);
  });
});
