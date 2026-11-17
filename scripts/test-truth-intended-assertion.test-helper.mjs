// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTempDirSync} from '../server/testing/cleanup.ts';
import {intendedAssertionKilled} from './test-truth/intended-assertion.test-helper.mjs';

it('a kill requires the pinned assertion, not another assertion, a fixture, timeout or infrastructure failure',()=>{
 const root=mkdtempSync(join(tmpdir(),'mutant-intent-')),file='fixture.test.ts',path=join(root,file),assertion='expect(actual).toBe(expected)',source=assertion+'; expect(setup).toBe(true);\n';
 writeFileSync(path,source);
 const test={file:path,id:'selected test',state:'passed',errors:[],hooks:['pass']};
 const green={code:0,passed:1,details:{reason:'passed',errors:[],tests:[test]}};
 const red=()=>({code:1,passed:0,details:{reason:'failed',errors:[],tests:[{...test,state:'failed',errors:[{name:'AssertionError',message:'expected false to be true',stack:`AssertionError: expected false to be true\n at ${path}:1:16`}]}]}});
 const killed=run=>intendedAssertionKilled(green,run,green,{root,file,assertion});
 try{
  expect(killed(red())).toBe(true);
  const unrelated=red();unrelated.details.tests[0].errors[0].stack=`AssertionError\n at ${path}:1:46`;
  expect(killed(unrelated)).toBe(false);
  for(const error of [{name:'TypeError',message:'fixture failed'},{name:'AssertionError',message:'Test timed out in 5000ms'},{name:'AssertionError',message:'fixture assertion',stack:'at setup.ts:1:1'}]){
   const run=red();run.details.tests[0].errors=[error];expect(killed(run)).toBe(false);
  }
  for(const extra of [{signal:'SIGTERM'},{error:'ETIMEDOUT'},{code:null}])expect(killed({...red(),...extra})).toBe(false);
  const skipped=red();skipped.details.tests[0].state='skipped';expect(killed(skipped)).toBe(false);
  const hook=red();hook.details.tests[0].hooks=['fail'];expect(killed(hook)).toBe(false);
  const missing=red();missing.details.tests.push({...test,id:'unrelated',state:'passed'});expect(killed(missing)).toBe(false);
  const unhandled=red();unhandled.details.errors=[{name:'Error',message:'unhandled'}];expect(killed(unhandled)).toBe(false);
 }finally{removeTempDirSync(root);}
});

// Keep recorded assertion locations stable.
import "./test-truth-decision-runners.test-helper.mjs";
