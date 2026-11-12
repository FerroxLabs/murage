// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { wiring, source } from './fixture.ts';
describe('R9/R17/A3a: registered delivery and terminal event forwarding', () => {
  it('transports only exact provider/generation/turn and requires strict ack', async () => {
    const respondToRequest = vi.fn(async()=>({state:'accepted'})); const interruptTurn=vi.fn();
    const target={providerInstanceId:'p',threadId:'t',generation:'g',turnId:'turn',requestId:'r'};
    const live={providerInstanceId:'p',generation:'g',turnId:'turn'};
    const decisionRequestTargets=new Map([[JSON.stringify(['p','t','g','turn','r']),{target,terminal:false}]]);
    const { decisionTargetAdapter }=wiring(['decisionTargetAdapter'], {decisionRequestTargets,decisionLiveIdentity:()=>live,registry:{get:()=>({decisionAdapter:{respondToRequest,interruptTurn}})}});
    expect(decisionTargetAdapter(target)).toBeDefined();
    for (const field of ['providerInstanceId','generation','turnId','threadId','requestId']) expect(decisionTargetAdapter({...target,[field]:'stale'})).toBeUndefined();
    const { decisionTargetAdapter: missing }=wiring(['decisionTargetAdapter'],{decisionRequestTargets,decisionLiveIdentity:()=>live,registry:{get:()=>({adapter:{respondToRequest}})}});
    expect(missing(target)).toBeUndefined();
  });
  it('answers old-posture records before entering the driver barrier', async () => {
    const order:string[]=[];
    const { changeDecisionLevel }=wiring(['changeDecisionLevel'],{decisionLiveIdentity:()=>({providerInstanceId:'p'}),onLevelChange:async()=>{order.push('answer');},registry:{get:()=>({decisionAdapter:{onPostureChange:async(t:string)=>order.push(t)}})},internalTurnOwners:new Map([['t',{botId:'b'}]])});
    await changeDecisionLevel('b'); expect(order).toEqual(['answer','t']);
  });
  it('does not filter terminal record patches at the server broadcaster (M52 integration pin)', () => {
    expect(source.includes('await recover()')).toBe(true);
    expect(source.includes('await cancelRequests({ kind: "generation", threadId, generation }')).toBe(true);
    expect(source.includes('state !== "open") return; // decision terminal patch')).toBe(false);
    expect(source.includes('if ((card as Partial<PermissionCard>).approvalId) continue;')).toBe(true);
  });
});

it('registered answers report the persisted acknowledgement and answer, including failures',async()=>{
  for(const [receipt,expected]of [
    [{delivery:'accepted',answer:{behavior:'allow'}},'allowed-once'],
    [{delivery:'accepted',answer:{behavior:'deny'}},'rejected'],
    [{delivery:'accepted',answer:{behavior:'answer'}},'answered'],
    [{delivery:'unconfirmed',answer:{behavior:'allow'}},'unavailable'],
    [{delivery:'failed',answer:{behavior:'allow'}},'unavailable'],
    [{delivery:'accepted'},'unavailable'],
  ] as const){
    const send=vi.fn(async()=>{});
    const {answerRegisteredApproval}=wiring(['answerRegisteredApproval'],{answerApproval:send,readApprovalExecution:()=>receipt});
    expect(await answerRegisteredApproval({approvalId:'real-issued-ref'}, {behavior:'allow'})).toBe(expected);
    expect(send).toHaveBeenCalledTimes(1);
  }
});
