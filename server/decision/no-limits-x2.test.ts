// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { d,fixture,baseRun } from './fixture.ts';
import { r2Rows } from '../testing/no-limits-r2-cases.ts';
for(const routine of [false,true])for(const row of r2Rows)it(`r2 ingress ${routine?'routine':'owner'} ${row.id}`,()=>{
 const f=fixture();
 if(routine)d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'routine-run',form:'run',sourceRunId:'run',sourceBotId:'b',recipientGeneration:'g',trigger:'manual'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited',routine:{owner:true,sourceRunId:'run',sourceBotId:'b',recipientGeneration:'g'}})});
 const out=d.decide(f.open('r',{command:row.command,cwd:row.cwd}),baseRun);
 // Sean 2026-11-12 02:05Z: protected paths do not card at No limits.
 expect(out.kind,row.id).toBe('run');f.dispose();
},30000);
it('r2.1 stored deny raw targets survive the presentation cap',async()=>{
 const f=fixture();const calls:unknown[]=[];let revision=1;
 d.installDenySources({revision:()=>[String(revision)],resolve:(_bot,targets)=>{calls.push(targets);return targets.some(t=>t.kind==='path'&&t.path==='/w/n299')?[{kind:'deny',class:'stored',ruleId:'tail',span:'/w/n299'}]:[];}});
 const command='touch '+Array.from({length:300},(_,i)=>`/w/n${i}`).join(' ');
 const handle=f.open('r',{command,cwd:'/w'});expect(d.decide(handle,baseRun).kind).toBe('run');revision++;await d.deliverRequest(handle);
 expect(calls).toHaveLength(2);for(const targets of calls)expect(targets).toHaveLength(300);
 expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
