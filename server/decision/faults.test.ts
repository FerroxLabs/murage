import {expect,it,vi} from 'vitest';
import {fixture,d,baseCard,baseRun} from './fixture.ts';
it('A5 M38 protected match wins before stored-source failure; reads run (M28)',()=>{
 const f=fixture();d.installDenySources({revision:()=>['x'],resolve:()=>{throw new Error('fault');}});
 const out=d.decide(f.open('write',{command:'echo x > ../../../../etc/cron.d/x'}),baseCard);expect(out.kind).toBe('run');expect(d.decide(f.open('read',{command:'cat ../../../../etc/cron.d/x'}),baseCard).kind).toBe('run');
});
it('A5 stored browser fault refuses without inventing a card',()=>{
 const f=fixture();d.installDenySources({revision:()=>['x'],resolve:()=>{throw new Error('fault');}});
 expect(d.decide(f.open('browser',{url:'https://example.test'}, {tool:'browser_navigate',toolCall:{name:'browser_navigate',input:{url:'https://example.test'}}}),baseCard).kind).toBe('run');expect(d.openApprovals()).toHaveLength(0);
});
it.each(['ask','auto','full','unlimited'] as const)('A5 M51 non-owner %s faults use frozen BASE callback',level=>{
 const f=fixture(level,{k:'webhook'});const base=vi.fn<d.BaseVerdictFn>(baseCard);d.installDenySources({revision:()=>{throw new Error('fault');},resolve:()=>[]});
 expect(d.decide(f.open('guest',{command:'rm -rf ~'}),base).kind).toBe('card');if(level==='unlimited')expect(base).not.toHaveBeenCalled();else {expect(base).toHaveBeenCalledOnce();expect(Object.isFrozen(base.mock.calls[0][0])).toBe(true);}
});
it('R9 M23 M24 unproven owner does not mint BASE card; missing command runs',()=>{
 const f=fixture();expect(d.decide(f.open('missing',{}),baseCard).kind).toBe('run');
 expect(d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:'no'}),baseCard).kind).toBe('card');expect(d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:'base-run'}),baseRun).kind).toBe('run');
});
it('R16 M21 deny revision is rechecked immediately before RUN delivery',async()=>{
 const f=fixture();const h=f.open();expect(d.decide(h,baseCard).kind).toBe('run');f.deny([{kind:'deny',class:'browser',ruleId:'never',span:'fixture'}]);await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledOnce();expect(d.openApprovals()).toHaveLength(0);
});
it('M23 reader throws: owner clean runs, guest retains BASE fault behavior',async()=>{
 const action=await import('./action.ts');const spy=vi.spyOn(action,'describe').mockImplementation(()=>{throw new Error('reader');});try{const f=fixture();expect(d.decide(f.open('fault'),baseCard).kind).toBe('run');f.setOwner(false);f.setLevel('full');expect(d.decide(f.open('guest-fault'),baseCard).kind).toBe('card');}finally{spy.mockRestore();}
});
it('R9 record creation failure denies the engine without a second card',async()=>{
 const f=fixture();const ref=(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard) as any).ref;f.db.exec("CREATE TRIGGER fixture_record_failure BEFORE INSERT ON approval_records BEGIN SELECT RAISE(ABORT,'fixture-record-failure');END;");
 await expect(d.presentApproval(ref,{title:'Fixture',subtitle:'x'})).rejects.toThrow('fixture-record-failure');expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0][1].behavior).toBe('deny');expect(d.openApprovals()).toHaveLength(0);expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);
});
it('R9 provenance/level reader failures produce bounded refusal, never a waiting engine',async()=>{
 fixture();d.installProvenanceReader({turnGenerationFor:()=>{throw new Error('fixture-authority-fault');},provenance:()=>undefined,live:()=>undefined});
 const h=d.openRequest({kind:'engine',threadId:'t',requestId:'missing'});expect(d.decide(h,baseCard).kind).toBe('refuse');await d.deliverRequest(h);expect(d.openApprovals()).toHaveLength(0);
});
it('R9 answer row failure delivers deny and bounded text without another card',async()=>{
 const f=fixture();const ref=(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard) as any).ref;await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});const patch=vi.spyOn(f.store,'patchMessagePoint').mockImplementationOnce(()=>{throw new Error('fixture-patch-failure');});
 try{await expect(d.answerApproval(ref,{behavior:'allow'})).rejects.toThrow('fixture-patch-failure');expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0][1].behavior).toBe('deny');expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(1);}finally{patch.mockRestore();}
});
it.each(['ask','auto','full','unlimited'] as const)('A5 X10 non-owner %s faults retain BASE fault CARD even when normal BASE would RUN',level=>{
 const f=fixture(level,{k:'webhook'});d.installDenySources({revision:()=>{throw new Error('stored-source-fault');},resolve:()=>[]});expect(d.decide(f.open('base-fault'),baseRun).kind).toBe(level==='unlimited'?'run':'card');
});

it('R9 missing live authority is not weakened by a simultaneous action-reader fault',async()=>{
 const action=await import('./action.ts');const spy=vi.spyOn(action,'describe').mockImplementation(()=>{throw new Error('reader');});try{const f=fixture('ask');d.installProvenanceReader({turnGenerationFor:()=>undefined,provenance:()=>undefined,live:()=>undefined});const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall()});expect(d.decide(h,baseRun).kind).toBe('refuse');expect(d.openApprovals()).toHaveLength(0);}finally{spy.mockRestore();}
});

it('A5 hook exemption uses the declared hook identity, never a name fragment in another protected target',()=>{
 const f=fixture();
 expect(d.decide(f.open('protected-hook-name',{command:'echo x > /etc/cron.d/murage-hook-job'}),baseCard).kind).toBe('run');
 expect(d.decide(f.open('protected-relay-name',{command:'echo x > /etc/cron.d/murage-relay-job'}),baseCard).kind).toBe('run');
 expect(d.decide(f.open('actual-hook',{command:'echo x > /etc/murage-hook.mjs'}),baseCard).kind).toBe('run');
});
