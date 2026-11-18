// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: MAIN defines decision defects; tafix-r4a verifies witness receipts.
import {existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadavg} from 'node:os';
import {setTimeout} from 'node:timers/promises';
import {withHideInherit} from '../../shared/win-hide-child-process.mjs';
import {intendedAssertionKilled} from './intended-assertion.test-helper.mjs';

export async function verifyDecisionMutant({id,dir,args,file,testFile=file,assertions,mutate,restore,env={},redEnv={},timeout=120000,maxBuffer=8*1024**2}) {
 const run=async phase=>{
  while(loadavg()[0]>76)await setTimeout(10000);
  const name=join(dir,id+'.'+phase),json=name+'.json',details=name+'.details.json';
  for(const path of [json,details])if(existsSync(path))unlinkSync(path);
  const result=spawnSync(process.execPath,[...args,'--reporter=json','--reporter=./scripts/test-truth/mutant-reporter.mjs','--outputFile='+json],withHideInherit({env:{...process.env,...env,...(phase==='red'?redEnv:{}),TEST_TRUTH_MUTANT_REPORT:details},encoding:'utf8',timeout,maxBuffer}));
  writeFileSync(name+'.log',(result.stdout??'')+(result.stderr??''));
  const report=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):null;
  return {code:result.status,signal:result.signal,error:result.error?.code,passed:report?.numPassedTests??0,details:existsSync(details)?JSON.parse(readFileSync(details,'utf8')):null};
 };
 const green=await run('green');
 let red;
 try{mutate();red=await run('red');}finally{restore();}
 const restored=await run('restored');
 const killed=intendedAssertionKilled(green,red,restored,{root:resolve('.'),file,testFile,assertions});
 const result={id,killed,exit:red.code,witness:{file,testFile,assertions},green,red,restored};
 writeFileSync(join(dir,id+'.verdict.json'),JSON.stringify(result,null,2)+'\n');
 return result;
}
