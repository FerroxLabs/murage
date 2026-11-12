// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {approvalDecision,setApprovalContextReader} from './approval-decision.ts';
import {awaitHostComputerConsent} from './host-computer-consent.ts';
import {requestPeerApproval,requestEventLimitApproval,type ApprovalBus} from './peer-approval.ts';
import type {BotRecord} from './store.ts';

const level={autoApprove:true,fullAccess:true,noLimits:true};
afterEach(()=>setApprovalContextReader(()=>({level:{},actor:{kind:'other'}})));
for(const kind of ['owner','owner-routine'] as const) {
 it(`${kind} host, peer and event requests run before any card or wait`,async()=>{
  setApprovalContextReader(()=>({level,actor:{kind}}));
  const appendMessage=vi.fn(()=>{throw Error('permission card created');});
  const opened=vi.fn(()=>{throw Error('approval wait created');});
  const bus={store:{appendMessage},routineCard:{opened}} as unknown as ApprovalBus;
  const from={id:'from',threadId:'thread',name:'From'} as BotRecord;
  const to={id:'to',threadId:'to-thread',name:'To'} as BotRecord;
  expect(await awaitHostComputerConsent(bus,from,'thread',10)).toBe('allowed');
  expect(await requestPeerApproval(bus,from,to,'fixture','ask_bot')).toBe('allow');
  expect(await requestEventLimitApproval(bus,from,'create',5,'event')).toBe('allow');
  expect(appendMessage).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
 });
}
it('service gate re-reads level and actor, preserving base and explicit deny',()=>{
 let current={level,actor:{kind:'owner' as 'owner'|'other'}};
 setApprovalContextReader(()=>current);
 expect(approvalDecision('thread','Bash',{command:'ssh host cmd'}).verdict).toBe('run');
 expect(approvalDecision('thread','Bash',{command:'rm -rf ~'}).verdict).toBe('card');
 expect(approvalDecision('thread','host',{},true,'host-declined').verdict).toBe('card');
 current={level:{...level,noLimits:false},actor:{kind:'owner'}};
 expect(approvalDecision('thread','Bash',{}).verdict).toBe('card');
 expect(approvalDecision('thread','Bash',{},false).verdict).toBe('run');
 current={level,actor:{kind:'other'}};
 expect(approvalDecision('thread','Bash',{}).verdict).toBe('card');
});
