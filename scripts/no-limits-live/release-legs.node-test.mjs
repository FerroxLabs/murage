import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteSuiteVerdict, mandatoryFiles } from './release-legs.mjs';
test('mandatory acceptance is absolute green, including suite execution and skipped assertions',()=>{
  const r={success:true,numTotalTests:4,testResults:mandatoryFiles.map(name=>({name,assertionResults:[{status:'passed'}]}))};
  assert.equal(absoluteSuiteVerdict(r,0),'PASS');
  for(const patch of [{success:false},{numTotalTests:0},{testResults:r.testResults.slice(1)},
    {testResults:r.testResults.map((f,i)=>i?f:{...f,assertionResults:[{status:'failed'}]})},
    {testResults:r.testResults.map((f,i)=>i?f:{...f,assertionResults:[{status:'pending'}]})}])
    assert.equal(absoluteSuiteVerdict({...r,...patch},0),'FAIL');
  assert.equal(absoluteSuiteVerdict(r,1),'FAIL');
});
