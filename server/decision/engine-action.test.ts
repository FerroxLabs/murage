import {expect,it,vi} from 'vitest';
import {fixture,d,card,baseCard,baseRun} from './fixture.ts';
it('BASE engine builder receives frozen authority/verdict and binds grant keys and options once',async()=>{
 const f=fixture('ask');const result:any={options:['Allow','Allow for task','Deny'],taskAllowKey:'fixture-task-key'};const builder=vi.fn<d.EngineApprovalBuilder>((r,why,base)=>{expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(base)).toBe(true);expect(why).toBe('base');return result;});d.installEngineApprovalBuilder(builder);
 const ref=card(d.decide(f.open(),baseCard));result.taskAllowKey='mutated';await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});const row=d.readApproval(ref.approvalId)!;expect(row.action.taskAllowKey).toBe('fixture-task-key');expect(row.action.options).toEqual(['Allow','Allow for task','Deny']);expect(builder).toHaveBeenCalledOnce();
});
it('owner RUN never calls the engine builder or BASE callback',()=>{
 const f=fixture();const builder=vi.fn<d.EngineApprovalBuilder>(()=>{throw new Error('not called');});d.installEngineApprovalBuilder(builder);const base=vi.fn(baseCard);expect(d.decide(f.open(),base).kind).toBe('run');expect(builder).not.toHaveBeenCalled();expect(base).not.toHaveBeenCalled();
});
it('reserved engine action identities cannot create an approval',()=>{
 const f=fixture('ask');d.installEngineApprovalBuilder(()=>({options:['Allow'],approvalId:'forged'} as any));expect(d.decide(f.open(),baseCard).kind).toBe('refuse');expect(d.openApprovals()).toHaveLength(0);
});
it('cleared deny before engine presentation runs and leaves no card',async()=>{
 const f=fixture('full');let allowed=false;const base=()=>allowed?baseRun():baseCard();f.deny([{kind:'deny',class:'site',ruleId:'never',span:'fixture'}]);const h=f.open();const ref=card(d.decide(h,base));f.deny([]);allowed=true;await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});expect(f.respond).toHaveBeenCalledOnce();expect(d.openApprovals()).toHaveLength(0);expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);
});
it('a cleared service deny after queue persistence executes once without a new permission row',async()=>{
 const f=fixture('full');let allowed=false;const base=()=>allowed?baseRun():baseCard();f.deny([{kind:'deny',class:'site',ruleId:'never',span:'fixture'}]);const call=f.serviceCall({command:'echo x'}),ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),base));let pending=true;const item:any={approvalId:ref.approvalId,kind:'email',ref:'q',epoch:'e',call,view:{title:'Queue',subtitle:'x'},proof:'trusted'};const respond=vi.fn(async()=>{pending=false;return {state:'accepted' as const};});
 const dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>pending?[item]:[],reopen:()=>({kind:'service',service:'email',claim:f.claim,call}),base,respond,cancel:async()=>{pending=false;},renew:async()=>item}]);
 try{d.attachQueue(ref,{kind:'email',ref:'q',call});f.deny([]);allowed=true;await d.presentApproval(ref,item.view);await d.presentApproval(ref,item.view);expect(respond).toHaveBeenCalledOnce();expect(pending).toBe(false);expect(d.openApprovals()).toHaveLength(0);}finally{dispose();}
});
it('native posture retirement supersedes an answered identity without sending another answer',async()=>{
 const f=fixture('ask');const ref=card(d.decide(f.open(),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});await d.answerApproval(ref,{behavior:'allow'});await d.settle(ref,'superseded');expect(d.readApproval(ref.approvalId)!.state).toBe('superseded');expect(f.respond).toHaveBeenCalledOnce();
});
it('structured question parts keep their native choices and settle with one complete answer',async()=>{
 const f=fixture();const ref=card(d.decide(f.open('q',{}, {requestType:'question',choices:undefined,questions:[{id:'one',question:'Pick a color',options:[{label:'Red'},{label:'Blue'}],multiSelect:false,allowOther:false},{id:'two',question:'Add a note',options:[],multiSelect:false,allowOther:true}]}),baseCard));await d.presentApproval(ref,{title:'Question',subtitle:'x'});
 expect((await d.answerQuestionReply('t','Please do another task')).kind).toBe('send');await d.answerQuestionReply('t','2');expect(f.respond).not.toHaveBeenCalled();expect(d.readApproval(ref.approvalId)!.state).toBe('open');await d.answerQuestionReply('t','a note');expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0][1].answers).toEqual([{id:'one',selected:['Blue']},{id:'two',selected:[],other:'a note'}]);expect(d.readApproval(ref.approvalId)!.state).toBe('answered');
});

it.each(['ask','auto','full'] as const)('BASE native questions retain their original card path at %s',async level=>{
 const f=fixture(level);const base=vi.fn(baseCard);const outcome=d.decide(f.open('q',{}, {requestType:'question',choices:['Red','Blue']}),base);expect(outcome.kind).toBe('card');expect(base).toHaveBeenCalledOnce();await d.presentApproval(card(outcome),{title:'Question',subtitle:'x'});expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(1);
});

it('BASE native questions retain the guest card at Full access',async()=>{
 const f=fixture('full',{k:'other-human'});const outcome=d.decide(f.open('q',{}, {requestType:'question',choices:['Red','Blue']}),baseCard);expect(outcome.kind).toBe('card');await d.presentApproval(card(outcome),{title:'Question',subtitle:'x'});expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(1);expect((await d.answerQuestionReply('t','1')).kind).toBe('send');
});

it('missing production engine builder refuses visibly and logs ERROR once per process across host resets',async()=>{
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  for(let n=0;n<2;n++){
   const f=fixture('ask');
   d.installEngineApprovalBuilder(()=>({options:['Allow','Deny']}))();
   for(const id of ['missing-one','missing-two']){
    const handle=f.open(id);
    expect(d.decide(handle,baseCard)).toEqual({kind:'refuse',message:'Murage could not confirm this request. Nothing was run.'});
    await d.deliverRequest(handle);
   }
   expect(f.respond.mock.calls.every(call=>call[1].behavior==='deny')).toBe(true);
  }
  expect(log).toHaveBeenCalledExactlyOnceWith('[decision] ERROR engine-approval-builder-missing');
 }finally{log.mockRestore();}
});
