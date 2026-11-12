// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN 2026-11-12 C1: protected-only cards are retired at No limits.
// Queue release uses the same wipe-only rule as native release.
import {mkdtempSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it,vi} from 'vitest';
import {fixture,d,card,baseRun,baseCard} from './fixture.ts';
import {removeTempDir} from '../testing/cleanup.ts';
async function queue(wipe=false){
 const f=fixture(wipe?'unlimited':'ask'),root=mkdtempSync(join(tmpdir(),'nlsym-queue-'));mkdirSync(join(root,'out'));const target=join(root,'out','notes');
 const call=wipe?f.serviceCall({command:'rm -rf /'}):{...f.serviceCall({path:target,content:'fake-only'}),tool:'write_file'};
 const handle=d.openRequest({kind:'service',service:'email',claim:f.claim,call});
 const ref=card(d.decide(handle,baseCard));
 let item={kind:'email' as const,approvalId:ref.approvalId,ref:'q',epoch:'e',call:call as d.PendingQueueApproval['call'],view:{title:'Fixture',subtitle:'Queue'},proof:'trusted'};
 const respond=vi.fn(async()=>({state:'accepted' as const}));
 const source:d.QueueRecoverySource={kind:'email',pendingApprovals:()=>[item],base:baseRun,reopen:current=>({kind:'service',service:'email',claim:f.claim,call:current.call}),respond,cancel:async()=>{},renew:async(_current,identity)=>{item={...item,...identity,call:{...item.call,approval:{...item.call.approval,epoch:identity.epoch}}};return item;}};
 const off=d.installQueueSources([source]);d.attachQueue(ref,{kind:'email',ref:'q',call});await d.presentApproval(ref,item.view);
 return {f,root,target,ref,item,source,respond,off};
}
it.each([false,true])('C7 synchronous No limits queue upgrade releases non-wipe changed=%s',async changed=>{
 const q=await queue(),respondNow=vi.fn(()=>({state:'accepted' as const})),off=d.installSynchronousQueueDeliveries([{kind:'email',respondNow}]);
 try{
  if(changed)symlinkSync('/etc/hosts',q.target);q.f.setLevel('unlimited');
  d.presentApprovalSync(q.ref,q.item.view);
  expect(respondNow).toHaveBeenCalledTimes(1);expect(q.respond).not.toHaveBeenCalled();expect(d.openApprovals('t')).toEqual([]);
  d.presentApprovalSync(q.ref,q.item.view);expect(respondNow).toHaveBeenCalledTimes(1);
 }finally{off();q.off();q.f.dispose();await removeTempDir(q.root);}
});
it.each([false,true])('C7 asynchronous No limits queue upgrade releases non-wipe changed=%s',async changed=>{
 const q=await queue(),respondNow=vi.fn(()=>({state:'accepted' as const})),off=d.installSynchronousQueueDeliveries([{kind:'email',respondNow}]);
 try{
  if(changed)symlinkSync('/etc/hosts',q.target);q.f.setLevel('unlimited');
  await d.onLevelChange('b');d.presentApprovalSync(q.ref,q.item.view);
  expect(q.respond).toHaveBeenCalledTimes(1);expect(respondNow).not.toHaveBeenCalled();expect(d.openApprovals('t')).toEqual([]);
 }finally{off();q.off();q.f.dispose();await removeTempDir(q.root);}
});
it('C7 a visible queue catastrophe remains pending until owner Allow',async()=>{
 const q=await queue(true),respondNow=vi.fn(()=>({state:'accepted' as const})),off=d.installSynchronousQueueDeliveries([{kind:'email',respondNow}]);
 try{
  expect(d.openApprovals('t')).toContainEqual(expect.objectContaining({why:'wipe'}));expect(respondNow).not.toHaveBeenCalled();
  expect(d.answerApprovalSync(q.ref,{behavior:'allow'}).state).toBe('accepted');expect(respondNow).toHaveBeenCalledTimes(1);
 }finally{off();q.off();q.f.dispose();await removeTempDir(q.root);}
});
it('C7 approved durable wipe queue retries a failed fake delivery after restart',async()=>{
 const q=await queue(true);
 try{
  q.respond.mockImplementation(async()=>({state:'failed'} as any));await d.answerApproval(q.ref,{behavior:'allow'});
  expect(d.readApproval(q.ref.approvalId)).toMatchObject({state:'answered',delivery:'failed'});
  q.respond.mockReset().mockResolvedValue({state:'accepted'});
  d.installDecisionHost({store:q.f.store,view:()=>q.item.view});await d.recover();
  expect(q.respond).toHaveBeenCalledTimes(1);
 }finally{q.off();q.f.dispose();await removeTempDir(q.root);}
});
