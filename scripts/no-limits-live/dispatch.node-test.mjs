import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runScenario} from './run.mjs';
test('an unavailable-input witness cannot pass by running an ordinary command',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-no-substitution-'));let sends=0;
 const home=join(root,'home'),work=join(root,'work'),empty=join(root,'gitconfig');
 mkdirSync(home);mkdirSync(join(home,'.ssh'));mkdirSync(work);writeFileSync(empty,'');
 const c={bot:async()=>({id:'fixture',threadId:'thread'}),turn:async()=>{sends++;throw Error('ordinary command substitution');},
  messages:async()=>[],stop:async()=>{},decisions:()=>[],ledger:{forThreads:()=>[],problems:()=>[]}};
 try{
  const row=await runScenario({root,home,work,client:c,gitEnv:{...process.env,GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty}},
   {id:'fixture'},{id:'unavailable-shell-missing-input',actor:'owner',level:'unlimited',expected:'RUN',availabilityWitness:{tool:'shell',shape:'missing-input'}},{});
  assert.equal(sends,0);assert.equal(row.verdict,'FAIL');assert.equal(row.skipped,true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('a dedicated field binding retains its action proof and witness without a substitute marker',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-bound-field-')),home=join(root,'home'),work=join(root,'work'),empty=join(root,'gitconfig');
 mkdirSync(home);mkdirSync(join(home,'.ssh'));mkdirSync(work);writeFileSync(empty,'');
 const c={bot:async()=>({id:'fixture',threadId:'thread'}),messages:async()=>[],stop:async()=>{},decisions:()=>[],ledger:{forThreads:()=>[],problems:()=>[]}};
 const spec={id:'unavailable-shell-missing-input',actor:'owner',level:'unlimited',expected:'RUN',availabilityWitness:{tool:'shell',shape:'missing-input'}};
 const obs={complete:true,ended:true,cards:[],errors:[],threadIds:['thread'],events:[{type:'item.completed',itemType:'tool',ok:true}]};
 try{
  const row=await runScenario({root,home,work,client:c,gitEnv:{...process.env,GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty},
   observeRow:async()=>({verdict:'PASS'}),workflowFixtures:{[spec.id]:async()=>({obs,proof:true,originWitness:{kind:'exact-input'}})}},{id:'fixture'},spec,{});
  assert.equal(row.verdict,'PASS',row.errors.join('; '));assert.equal(row.originWitness.kind,'exact-input');
 }finally{rmSync(root,{recursive:true,force:true});}
});
