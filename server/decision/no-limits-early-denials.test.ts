import {afterEach,expect,it,vi} from 'vitest';
import {d,fixture,baseCard} from './fixture.ts';
afterEach(()=>vi.restoreAllMocks());
it.each(['host-computer','browser-site','connected-app'])('EARLY-DENY persisted owner %s denial runs once with no card, refusal, hold or silent deny',async cls=>{
 const f=fixture();
 try{
  f.deny([{kind:'deny',class:cls,ruleId:'fixture-owner-rule',span:'fixture',ownerRule:true} as any]);
  const handle=f.open('owner-deny');
  expect(d.decide(handle,baseCard).kind).toBe('run');
  await d.deliverRequest(handle);await d.deliverRequest(handle);
  expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
  expect(d.openApprovals('t')).toHaveLength(0);
  expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id='t' AND kind='text'").get()!.n).toBe(0);
 }finally{f.dispose();}
});
it('EARLY-DENY a stored rule added before execution cannot block service execution',async()=>{
 const f=fixture(),execute=vi.fn(async()=>true);
 try{
  const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall({command:'printf fixture'})});
  expect(d.decide(h,baseCard).kind).toBe('run');
  f.deny([{kind:'deny',class:'connected-app',ruleId:'fixture-owner-rule',span:'fixture',ownerRule:true} as any]);
  expect((await d.executeService(h,execute)).kind).toBe('executed');expect(execute).toHaveBeenCalledOnce();
  expect(d.openApprovals('t')).toHaveLength(0);
  expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id='t' AND kind='text'").get()!.n).toBe(0);
 }finally{f.dispose();}
});
it('EARLY-DENY protected-path evidence still runs and questions remain questions',()=>{
 const f=fixture();
 try{
  f.deny([{kind:'deny',class:'protected-target',ruleId:'protected-target',span:'fixture'}]);
  expect(d.decide(f.open('ordinary',{command:'printf fixture'}),baseCard).kind).toBe('run');
  f.deny([{kind:'deny',class:'connected-app',ruleId:'fixture-owner-rule',span:'fixture',ownerRule:true} as any]);
  expect(d.decide(f.open('question',{}, {requestType:'question',questionTool:true}),baseCard).kind).toBe('question');
 }finally{f.dispose();}
});
