import {expect,it,vi} from 'vitest';
import {performance} from 'node:perf_hooks';
import {fixture,d,baseCard} from './fixture.ts';
import * as action from './action.ts';
import * as code from '../no-limits-code.ts';
import * as records from './records.ts';
import {faultSites as sites} from '../testing/decision-faults.ts';
const cases=['owner-clean','owner-wipe','guest-full'] as const;
for(const site of sites)for(const scenario of cases)it(`R9 retained fault grid ${site} / ${scenario}`,async()=>{
 const guest=scenario==='guest-full',wipe=scenario==='owner-wipe';
 const f=fixture(guest?'full':'unlimited',guest?{k:'webhook'}:{k:'owner-typed'});
 const spies:Array<{mockRestore():void}>=[];let dispose:undefined|(()=>void),accepted=0;
 const fault=()=>{throw new Error('fixture-injected-fault');};
 f.respond.mockImplementation(async()=>{accepted++;return {state:'accepted'};});
 if(site==='actor')d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:fault,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:guest?'full':'unlimited'})});
 if(site==='deny')d.installDenySources({revision:()=>['fault'],resolve:fault});
 if(site==='shell'||site==='python')spies.push(vi.spyOn(code,guest?'readExecutable':'readExecutableOwnerNl').mockImplementation(fault));
 if(site==='guard')spies.push(vi.spyOn(records,'assertCardAuthorized').mockImplementationOnce(fault));
 if(site==='row')spies.push(vi.spyOn(f.store,'appendMessage').mockImplementationOnce(fault));
 if(site==='answer')f.respond.mockRejectedValueOnce(new Error('fixture-lost-send'));
 if(site==='observer')dispose=d.installDecisionObserver(fault);
 const command=wipe?'rm -rf ~':'echo fixture';
 const event=site==='python'?{tool:'python',toolCall:{name:'python',input:{code:wipe?"import shutil; shutil.rmtree('/')":"print('fixture')"}}}:{};
 const start=performance.now();
 try{
  const h=f.open('grid',{command},event);d.decide(h,site==='base'?fault:baseCard);await d.deliverRequest(h);
  for(const row of d.openApprovals())await d.answerApproval(row.ref,{behavior:'allow'});
  const expectedCards=site==='guard'||site==='row'?0:guest||wipe||site==='actor'?1:0;
  expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(expectedCards);
  expect(accepted).toBe(1);expect(new Set(f.respond.mock.calls.map(call=>call[2].answerId)).size).toBe(1);
  expect(performance.now()-start).toBeLessThan(2000);expect(d.openApprovals()).toHaveLength(0);
 }finally{dispose?.();for(const spy of spies)spy.mockRestore();}
});
it('protected matching is total over malformed and escaped paths',()=>{
 for(const path of ['', '/', '../etc/cron.d/x', '/etc/cron.d/x', '\0', '😀'.repeat(5000), 'C:\\Windows\\x'])expect(()=>action.protectedEvidence({tool:'write',codeIdentity:'x',executables:[],deletes:[],content:[],targets:[{kind:'path',path,op:'write'}]})).not.toThrow();
});
