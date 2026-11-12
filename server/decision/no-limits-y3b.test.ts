// Sean 2026-11-12 02:05Z supersedes protected-target and reader-failure holds.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi, afterEach } from 'vitest';
import { d, fixture, baseRun, baseCard } from './fixture.ts';
import * as code from '../no-limits-code.ts';
import { ReaderBudget } from '../no-limits-budget.ts';
import { segmentRows } from '../testing/no-limits-archive-design-cases.ts';
vi.hoisted(()=>vi.resetModules());
vi.mock('../no-limits-code.ts',async original=>{
 const real=await original<typeof code>();
 return {...real,readExecutableOwnerNl:vi.fn((...args:Parameters<typeof code.readExecutable>)=>(real as any).readExecutableOwnerNl?.(...args)??real.readExecutable(...args))};
});
const ownerRead=()=>vi.mocked((code as any).readExecutableOwnerNl);
afterEach(()=>ownerRead().mockClear());
for(const [command,held] of segmentRows) it(`H1 owner openRequest protected=${held}: ${command}`,()=>{
 const f=fixture();const outcome=d.decide(f.open('r',{command,cwd:'/w'}),baseCard);
 expect(outcome.kind).toBe('run');expect(ownerRead()).toHaveBeenCalled();f.dispose();
});
it('H1 owner-routine reaches the owner reader',()=>{
 const f=fixture();d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'routine-run',form:'run',sourceRunId:'run',sourceBotId:'b',recipientGeneration:'g',trigger:'manual'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited',routine:{owner:true,sourceRunId:'run',sourceBotId:'b',recipientGeneration:'g'}})});
 expect(d.decide(f.open('r',{command:'set --; tar -xf ";" -C /etc',cwd:'/w'}),baseCard).kind).toBe('run');expect(ownerRead()).toHaveBeenCalled();f.dispose();
});
it.each(['full','auto','ask'] as const)('H1 %s never invokes the owner reader',level=>{
 const f=fixture(level);d.decide(f.open('r',{command:'cpio -idm -D /etc',cwd:'/w'}),baseRun);expect(ownerRead()).not.toHaveBeenCalled();f.dispose();
});
it.each([true,false])('H3 CAP-LEN wipe=%s inspects past 65536 bytes',async held=>{
 const f=fixture();const command='#'+'x'.repeat(70000)+'\n'+(held?'rm -rf ~':'printf x > ./notes');
 const out=d.decide(f.open('r',{command,cwd:'/w'}),baseCard);expect(out.kind).toBe(held?'card':'run');
 if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Fixture wipe',subtitle:'Inert tail'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe',evidence:[expect.objectContaining({kind:'wipe',class:'home'})]});}f.dispose();
});
it('H3 unread ordinary owner work runs after a reader fault',async()=>{
 const f=fixture();ownerRead().mockImplementationOnce(()=>{throw new Error('inspection overflow');});
 const handle=f.open('r',{command:'echo x'});expect(d.decide(handle,baseRun).kind).toBe('run');await d.deliverRequest(handle);
 expect(f.respond.mock.calls[0][1].behavior).toBe('allow');f.dispose();
});
it('H3 reader budget exhaustion is not swallowed',()=>{
 const budget=new ReaderBudget();budget.left=0;
 expect(()=> (code as any).readExecutableOwnerNl('sh','echo x',budget)).toThrow();
});
it('r2.1 authority survives ordinary spellings, projection caps, deny refresh and delivery',async()=>{
 const f=fixture();
 const authority={version:1,exhausted:false,decisions:[{kind:'deny',class:'system',ruleId:'alias-taint',span:'/w/ordinary',source:'alias',taint:{source:'/etc/hosts',destination:'/w/ordinary'},identity:{dev:'1',ino:'2'},resolution:'protected'}]};
 const inspected={classes:[],targets:Array.from({length:300},(_,i)=>({path:`/w/n${i}`,op:'write'})),authority};
 ownerRead().mockReturnValueOnce(inspected).mockReturnValueOnce(inspected);
 const handle=f.open('r',{command:'tee /w/ordinary',cwd:'/w'});expect(d.decide(handle,baseRun).kind).toBe('run');
 f.deny([]);await d.deliverRequest(handle);
 expect(d.openApprovals('t')).toHaveLength(0);
 expect(d.readRequestExecution(handle).ownerAuthority).toMatchObject(authority);
 expect(d.readRequestExecution(handle).evidence).toContainEqual(expect.objectContaining({ruleId:'alias-taint',ownerDecision:expect.objectContaining({source:'alias',taint:{source:'/etc/hosts',destination:'/w/ordinary'}})}));
 expect(f.respond.mock.calls[0][1].behavior).toBe('allow');f.dispose();
});
it('r2.1 exhausted structured authority runs ordinary work',async()=>{
 const f=fixture();ownerRead().mockReturnValueOnce({classes:[],targets:[],authority:{version:1,decisions:[],exhausted:true}});
 expect(d.decide(f.open('r',{command:'echo x'}),baseRun).kind).toBe('run');f.dispose();
});
it('r2.1 non-wipe /usr/local work runs on the owner path',()=>{
 const f=fixture();expect(d.decide(f.open('r',{command:'set --; tar -xf ./a -C /usr/local/share',cwd:'/w'}),baseRun).kind).toBe('run');f.dispose();
});
it('r2.1 authority uncapped decisions retain provenance beyond presentation limits',async()=>{
 const f=fixture();
 const decisions=Array.from({length:300},(_,i)=>({kind:'deny',class:'system',ruleId:`inode-${i}`,span:'/w/ordinary-'+i,source:'inode',identity:{dev:'1',ino:String(i)},resolution:'protected'}));
 const inspected={classes:[],targets:[],authority:{version:1,decisions,exhausted:false}};
 ownerRead().mockReturnValueOnce(inspected).mockReturnValueOnce(inspected);
 const handle=f.open('r',{command:'echo x'});expect(d.decide(handle,baseRun).kind).toBe('run');await d.deliverRequest(handle);
 expect(d.openApprovals('t')).toHaveLength(0);
 expect(d.readRequestExecution(handle).ownerAuthority).toMatchObject({version:1,decisions,exhausted:false});
 expect(d.readRequestExecution(handle).evidence).toHaveLength(300);
 expect(d.readRequestExecution(handle).evidence?.[299]).toMatchObject({ruleId:'inode-299',ownerDecision:{source:'inode',identity:{dev:'1',ino:'299'}}});
 expect(f.respond.mock.calls[0][1].behavior).toBe('allow');f.dispose();
});
it('r2.1 stored deny sources retain owner targets past the display cap',async()=>{
 const f=fixture();const targets=Array.from({length:300},(_,i)=>({path:`/w/n${i}`,op:'write' as const}));
 const inspected={classes:[],targets,authority:{version:1,decisions:[],exhausted:false}};
 // The wipe classifier and the action evidence inspect the same targets.
 ownerRead().mockReturnValueOnce(inspected).mockReturnValueOnce(inspected);
 const calls:unknown[]=[];let revision=1;
 d.installDenySources({revision:()=>[String(revision)],resolve:(_bot,inputs)=>{calls.push(inputs);return inputs.some(t=>t.kind==='path'&&t.path==='/w/n299')?[{kind:'deny',class:'stored',ruleId:'tail',span:'/w/n299'}]:[];}});
 const handle=f.open('r',{command:'echo x'});expect(d.decide(handle,baseRun).kind).toBe('run');revision++;await d.deliverRequest(handle);
 expect(calls).toHaveLength(2);for(const inputs of calls)expect(inputs).toHaveLength(300);
 expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});

it('H3 reader fault cannot hide a visible wipe',()=>{const f=fixture();ownerRead().mockImplementationOnce(()=>{throw new Error('fixture read fault');});const out=d.decide(f.open('fault-wipe',{command:'rm -rf ~'}),baseRun);expect(out.kind).toBe('card');f.dispose();});
