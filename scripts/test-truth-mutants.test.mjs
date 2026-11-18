// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {mutantKilled} from './test-truth/mutant-verdict.mjs';
const test={file:'server/fixture.test.ts',id:'intended assertion'};
const green={code:0,passed:1,details:{reason:'passed',errors:[],tests:[{...test,state:'passed',errors:[]}]}};
const red=()=>({code:1,passed:0,details:{reason:'failed',errors:[],tests:[{...test,state:'failed',errors:[{name:'AssertionError',message:'expected false to be true'}]}]}});
it('certifies only the intended assertion with green restoration',()=>{
 expect(mutantKilled(green,red(),green)).toBe(true);
 for(const field of ['file','id']){const run=red();run.details.tests[0][field]='unrelated';expect(mutantKilled(green,run,green)).toBe(false);}
 expect(mutantKilled(green,red(),{...green,code:1})).toBe(false);
 expect(mutantKilled(green,{...red(),code:null},green)).toBe(false);
 expect(mutantKilled(green,{...red(),details:null},green)).toBe(false);
});
it.each(['Error','TypeError','TimeoutError'])('rejects fixture or timeout exception %s',name=>{
 const run=red();run.details.tests[0].errors=[{name,message:'fixture failed'}];
 expect(mutantKilled(green,run,green)).toBe(false);
});
it('rejects assertion plus hook, unhandled, or individual timeout failures',()=>{
 for(const error of [{name:'Error',message:'fixture setup'},{name:'AssertionError',message:'Test timed out in 5000ms'},{name:'AssertionError',message:'fixture hook',code:'ERR_HOOK_TIMEOUT'}]){
  const run=red();run.details.tests[0].errors.push(error);expect(mutantKilled(green,run,green)).toBe(false);
 }
 const run=red();run.details.errors.push({name:'Error',message:'unhandled fixture error'});
 expect(mutantKilled(green,run,green)).toBe(false);
});

it('rejects assertion errors from failed setup or teardown hooks',()=>{
 for(const state of ['run','fail']){const run=red();run.details.tests[0].hooks=[state];expect(mutantKilled(green,run,green)).toBe(false);}
});
