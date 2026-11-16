// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it,vi,afterEach} from 'vitest';
import {d,fixture,baseRun,card} from './fixture.ts';
import {describe,describeOwnerNoLimits} from './action.ts';
import * as inspection from '../no-limits-taint.ts';
afterEach(()=>vi.restoreAllMocks());
it('owner ingress retains selected-write evidence without holding a non-wipe',async()=>{
 const f=fixture();
 try{
  const input={command:'ln -s /etc/hosts ./h; tee ./h',cwd:'/tmp'};
  const authority=describeOwnerNoLimits({tool:'Bash',input}).ownerAuthority;
  expect(authority?.decisions.some((decision:any)=>decision.protectedDecision?.reason==='alias-taint'&&decision.protectedDecision.op==='write'&&decision.protectedDecision.lexical==='/tmp/h'&&decision.protectedDecision.taintTriggers.length)).toBe(true);
  const handle=f.open('owner',input);expect(d.decide(handle,baseRun).kind).toBe('run');
  await d.deliverRequest(handle);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(d.openApprovals('t')).toEqual([]);
 }finally{f.dispose();}
});
it('a visible wipe still persists a wipe card',async()=>{
 const f=fixture();try{const ref=card(d.decide(f.open('wipe',{command:'rm -rf /',cwd:'/tmp'}),baseRun));await d.presentApproval(ref,{title:'Visible wipe',subtitle:'Fixture'});expect(d.readApproval(ref.approvalId)?.why).toBe('wipe');}finally{f.dispose();}
});
it('ordinary owner ingress automatically runs with no new card',async()=>{
 const f=fixture();
 try{
  const handle=f.open('ordinary',{command:'ln -s ./plain ./h; tee ./h',cwd:'/tmp'});
  expect(d.decide(handle,()=>{throw Error('owner must use authoritative branch');}).kind).toBe('run');
  await d.deliverRequest(handle);
  expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 }finally{f.dispose();}
});
it('authenticated Full access registration preserves legacy bytes and never invokes owner disk inspection',()=>{
 const f=fixture('full');
 const read=vi.spyOn(inspection,'inspectNoLimits').mockImplementation(()=>{throw Error('owner resolver on Full access');});
 try{
  const input={command:'tar -tf ./a.tar --index-file=./list',cwd:'/tmp'},expected=describe({tool:'Bash',input});
  let actual:any;
  const handle=f.open('full',input);
  expect(d.decide(handle,r=>{actual=r.action;return baseRun();}).kind).toBe('run');
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual.ownerAuthority).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
