import { expect, it, vi } from 'vitest';
import { fixture, d, baseCard } from './fixture.ts';
it('A2 R16 M19 M22 M47 M48 first capture binds input, aliases and conflicts', () => {
 const f=fixture(); const e=f.event(); f.publish(e); const h=d.openRequest({kind:'engine',threadId:'t',requestId:'r',event:f.event('r',{command:'rm -rf ~'})} as any);
 (e.toolCall!.input as any).command='rm -rf ~'; expect(d.decide(h,baseCard).kind).toBe('run');
 f.publish(f.event('r',{command:'rm -rf ~'})); expect(d.decide(h,baseCard).kind).toBe('card');
 expect(d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:'missing'}),baseCard).kind).toBe('card');
});
it('A2 M49 claims alone supply service identity; spec/options are frozen and reserved fields rejected', () => {
 const f=fixture(); const call=f.serviceCall({command:'echo x'}); const spy=vi.fn(baseCard);
 const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call,botId:'attacker',threadId:'wrong'} as any);
 expect(d.decide(h,spy).kind).toBe('run');expect(spy).not.toHaveBeenCalled();
 expect(() => d.openRequest({kind:'service',service:'email',claim:{} as any,call})).toThrow();
 expect(() => d.openRequest({kind:'service',service:'email',claim:f.claim,call:{...call,approval:{...call.approval!,action:{approvalId:'forged'} as any}}})).toThrow();
});
it('R16 actor substitution ignored and all authority objects frozen at registration',()=>{
 const f=fixture();const h=f.open('r',{command:'rm -rf ~'});const spy=vi.fn<d.BaseVerdictFn>(r=>{expect(Object.isFrozen(r.action)).toBe(true);return baseCard();});
 expect(d.decide(h,spy).kind).toBe('card');expect(spy).not.toHaveBeenCalled();expect(()=>d.decide({actor:'owner'} as any,baseCard)).toThrow('unregistered');
});
it('R12 decision never reads message history',()=>{
 const f=fixture();const histories=vi.spyOn(f.store,'messagesFor');const h=f.open();d.decide(h,baseCard);expect(histories).not.toHaveBeenCalled();
});
it('service execution joins concurrent calls, retains frozen content and never uses caller mutations',async()=>{
 const f=fixture();const input={subject:'rm -rf ~',body:'fixture content'};const call={tool:'email_send',input};const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call});expect(d.decide(h,baseCard).kind).toBe('run');input.body='changed';const execute=vi.fn(async(c:d.ServiceCall)=>{expect(c.input).toEqual({subject:'rm -rf ~',body:'fixture content'});return 'sent';});
 const results=await Promise.all([d.executeService(h,execute),d.executeService(h,execute)]);expect(execute).toHaveBeenCalledOnce();expect(results).toEqual([{kind:'executed',value:'sent'},{kind:'executed',value:'sent'}]);
});
it('ingress duplicate event envelope metadata does not change input identity',()=>{
 const f=fixture();const event=f.event();f.publish(event);f.publish({...event,eventId:'new-event',createdAt:'new-time',summary:'different display'});expect(d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:'r'}),baseCard).kind).toBe('run');
});
it('R16 service request keys are scoped to their verified conversation, never another owner handle',()=>{
 const f=fixture();d.installProvenanceReader({turnGenerationFor:t=>t==='t'?'g':'g2',provenance:g=>({generation:g,threadId:g==='g'?'t':'t2',botId:'b',principal:g==='g'?'owner':'other',roomOwnerOnly:true,at:1,initiator:g==='g'?{k:'owner-typed'}:{k:'other-human'}}),live:t=>({botId:'b',turnId:'turn-'+t,providerInstanceId:'p',principal:t==='t'?'owner':'other',owner:t==='t',level:t==='t'?'unlimited':'ask'})});
 const issue=d.installClaimVerifier(proof=>typeof proof==='string'?{threadId:proof,botId:'b',generation:proof==='t'?'g':'g2'}:undefined);const call=f.serviceCall({command:'echo x'});const own=d.openRequest({kind:'service',service:'email',claim:issue('t')!,call}),other=d.openRequest({kind:'service',service:'email',claim:issue('t2')!,call});expect(d.decide(own,baseCard).kind).toBe('run');expect(d.decide(other,baseCard).kind).toBe('card');
});

it('R12 ten and ten-thousand message histories have identical deny lookup cost and zero message reads',()=>{
 const f=fixture();const history=vi.spyOn(f.store,'messagesFor'),resolve=vi.fn(()=>[]),revision=vi.fn(()=>['1']);d.installDenySources({resolve,revision});const add=(start:number,end:number)=>f.db.prepare(`WITH RECURSIVE n(x) AS(VALUES(?) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 't','history-'||x,x,'bot','text','fixture',json_object('id','history-'||x,'at',x,'role','bot','kind','text','text','fixture') FROM n`).run(start,end);add(1,10);d.decide(f.open('ten'),baseCard);const small=[resolve.mock.calls.length,revision.mock.calls.length];resolve.mockClear();revision.mockClear();add(11,10000);d.decide(f.open('ten-thousand'),baseCard);expect([resolve.mock.calls.length,revision.mock.calls.length]).toEqual(small);expect(history).not.toHaveBeenCalled();
});

it('A2 BASE conflict reads the latest bounded snapshot and keeps reader faults inside policy',async()=>{
 const f=fixture('full',{k:'webhook'});const h=f.open('conflict');f.publish(f.event('conflict',{command:'rm -rf ~'}));
 const base=vi.fn<d.BaseVerdictFn>(r=>{expect(r.snapshot!.input).toEqual({command:'rm -rf ~'});return baseCard();});
 expect(d.decide(h,base).kind).toBe('card');
 const action=await import('./action.ts');const spy=vi.spyOn(action,'describe').mockImplementation(()=>{throw new Error('fixture-late-reader');});
 try{expect(()=>d.decide(h,baseCard)).not.toThrow();}finally{spy.mockRestore();}
});
