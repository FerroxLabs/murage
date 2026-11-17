// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { removeTempDirSync } from '../server/testing/cleanup.ts';

it.skipIf(process.platform !== 'linux')('reports a new failing ID inside an already red file and refuses missing evidence', () => {
  const root=mkdtempSync(join(tmpdir(),'truth-compare-test-'));
  try {
    for(const side of ['base','head'])for(let shard=0;shard<8;shard++) {
      const dir=join(root,side,`shard-${shard}`);mkdirSync(dir,{recursive:true});
      const put=(name,data)=>writeFileSync(join(dir,name),JSON.stringify(data));
      put('source.json',{sha:side==='base'?'0'.repeat(40):'1'.repeat(40),tracked:2,checked:2,mismatches:[]});put('finished.json',{});writeFileSync(join(dir,'runner-exit'),'0\n');
      put('inventory.json',{all:['server/guard.test.ts'],own:shard===0?['server/guard.test.ts']:[]});
      put('receipts.json',shard===0?[{label:'batch-0',batch:['server/guard.test.ts'],timedOut:false}]:[]);
      if(shard===0)put('batch-0.json',{testResults:[{name:'/fixture/source/server/guard.test.ts',status:'failed',assertionResults:[
        {fullName:'previous defect',status:side==='base'?'failed':'passed',failureMessages:[]},
        {fullName:'new regression',status:side==='head'?'failed':'passed',failureMessages:[]},
        {fullName:'shared defect',status:'failed',failureMessages:[]},
      ]}]});
    }
    const command=['scripts/test-truth/compare.py','--base',join(root,'base'),'--head',join(root,'head'),'--base-sha','0'.repeat(40),'--head-sha','1'.repeat(40),'--output',join(root,'results')];
    const run=()=>spawnSync('python3',command,{encoding:'utf8'});
    expect(run().status).toBe(1);
    const summary=JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'));
    expect(summary).toMatchObject({complete:true,newRedIds:1,redOnBothIds:1,resolvedIds:1});
    expect(readFileSync(join(root,'results/new-reds.txt'),'utf8')).toBe('server/guard.test.ts :: new regression\n');
    expect(readFileSync(join(root,'results/red-on-both.txt'),'utf8')).toBe('server/guard.test.ts :: shared defect\n');
    const headReport=join(root,'head/shard-0/batch-0.json'),original=readFileSync(headReport,'utf8'),skipped=JSON.parse(original);
    skipped.testResults[0].assertionResults[0].status='pending';
    writeFileSync(headReport,JSON.stringify(skipped));
    expect(run().status).toBe(2);
    expect(JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'))).toMatchObject({complete:false,resolvedIds:0,newNonexecutionIds:1});
    expect(readFileSync(join(root,'results/new-nonexecution.txt'),'utf8')).toBe('server/guard.test.ts :: previous defect\n');
    const removed=JSON.parse(original);
    removed.testResults[0].status='passed';
    removed.testResults[0].assertionResults.shift();
    for(const assertion of removed.testResults[0].assertionResults)assertion.status='passed';
    writeFileSync(headReport,JSON.stringify(removed));
    expect(run().status).toBe(1);
    expect(JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'))).toMatchObject({complete:true,newRedIds:0,redOnBothIds:0,removedBaseRedIds:1});
    writeFileSync(headReport,original);
    const originalJson=JSON.parse(readFileSync(headReport,'utf8'));
    for(const field of ['added','updated','unchecked','filesRemoved']) {
      writeFileSync(headReport,JSON.stringify({...originalJson,snapshot:{[field]:1}}));
      expect(run().status,`snapshot ${field} must invalidate the comparison`).toBe(2);
      expect(JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8')).head.problems.join(' ')).toContain(`snapshots ${field}=1`);
    }
    writeFileSync(headReport,JSON.stringify(originalJson));
    const receiptsPath=join(root,'head/shard-0/receipts.json');
    const firstReceipt={label:'batch-0',batch:['server/guard.test.ts'],timedOut:false};
    const retryReport=join(root,'head/shard-0/retry-0.json');
    writeFileSync(retryReport,JSON.stringify({testResults:originalJson.testResults.map(file=>({...file,status:'passed',assertionResults:file.assertionResults.map(test=>({...test,status:'passed'}))}))}));
    writeFileSync(receiptsPath,JSON.stringify([firstReceipt,{...firstReceipt,label:'retry-0'}]));
    expect(run().status,'a passing retry cannot erase failed assertion IDs').toBe(1);
    expect(JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'))).toMatchObject({newRedIds:1,redOnBothIds:1});
    unlinkSync(retryReport);writeFileSync(receiptsPath,JSON.stringify([firstReceipt]));
    const inventory=join(root,'head/shard-0/inventory.json');
    writeFileSync(inventory,JSON.stringify({all:['server/guard.test.ts'],own:[]}));
    expect(run().status).toBe(2);
    expect(JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8')).head.problems.join(' ')).toContain('1 unscheduled');
    writeFileSync(inventory,JSON.stringify({all:['server/guard.test.ts'],own:['server/guard.test.ts']}));
    writeFileSync(join(root,'head/shard-0/receipts.json'),JSON.stringify([{label:'absent',batch:['server/guard.test.ts'],timedOut:true}]));
    expect(run().status).toBe(2);
    expect(JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8')).complete).toBe(false);
    expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toContain('<TIMEOUT>');
    const events=[
      {file:'/fixture/source/server/guard.test.ts',fullName:'completed before hang',status:'passed'},
      {file:'/fixture/source/server/guard.test.ts',fullName:'actual hung case',status:'running'},
      {file:'/fixture/source/server/guard.test.ts',fullName:'case after hang',status:'collected'},
      {file:'/fixture/source/server/guard.test.ts',fullName:'duplicate name',status:'failed',errors:[{message:'first instance failed'}]},
      {file:'/fixture/source/server/guard.test.ts',fullName:'duplicate name',status:'passed'},
    ];
    writeFileSync(join(root,'head/shard-0/absent.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n');
    // MAIN RULING INT-CONFLICT-DEFAULT 8a14184ce0 1c7864b39e: progress cannot prove completion; retain the timeout, failed duplicate and all three unverified IDs.
    expect(run().status).toBe(2);
    const report=JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'));
    // MAIN RULING INT-CONFLICT-DEFAULT 8a14184ce0 1c7864b39e: missing final JSON is incomplete, even after every body emitted progress.
    expect(report.complete).toBe(false);
    // MAIN RULING INT-CONFLICT-DEFAULT 8a14184ce0 1c7864b39e: keep concrete failure evidence separate from unverified progress; both remain blocking.
    expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: <TIMEOUT>\nserver/guard.test.ts :: duplicate name\n');
    expect(readFileSync(join(root,'results/head-unverified-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: actual hung case\nserver/guard.test.ts :: case after hang\nserver/guard.test.ts :: completed before hang\n');
    expect(report.head).toMatchObject({reportedFiles:0,unverifiedIds:3});
    expect(report.head.infrastructureFailures).toMatchObject([{timedOut:true,missingReports:['server/guard.test.ts']}]);
    expect(readFileSync(join(root,'results/head-test-ids.jsonl'),'utf8')).toContain('<TIMEOUT>');
    writeFileSync(retryReport,JSON.stringify({testResults:[{name:'/fixture/source/server/guard.test.ts',status:'passed',assertionResults:events.map(event=>({fullName:event.fullName,status:'passed',failureMessages:[]}))}]}));
    writeFileSync(receiptsPath,JSON.stringify([{label:'absent',batch:['server/guard.test.ts'],timedOut:true},{...firstReceipt,label:'retry-0'}]));
    expect(run().status,'a passing retry cannot erase timed-out incremental IDs').toBe(1);
    // MAIN RULING INT-CONFLICT-DEFAULT 8a14184ce0 1c7864b39e: real retry JSON resolves unknown bodies; the observed failure and timed-out attempt still block.
    expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: duplicate name\n');
    const recovered=JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'));
    expect(recovered.head.unverifiedIds).toBe(0);
    expect(recovered.head.infrastructureFailures).toMatchObject([{timedOut:true,missingReports:['server/guard.test.ts']}]);
    expect(recovered.head.recoveredAfterFailure).toContain('server/guard.test.ts :: duplicate name');

  } finally {removeTempDirSync(root);}
});

function withEvidence(check) {
  const root=mkdtempSync(join(tmpdir(),'truth-observations-'));
  const put=(side,name,data)=>writeFileSync(join(root,side,'shard-0',name),typeof data==='string'?data:JSON.stringify(data));
  const report=(names,status='passed')=>({testResults:[{name:'/fixture/source/server/guard.test.ts',status,assertionResults:names.map(fullName=>({fullName,status,failureMessages:status==='failed'?['missing old fixture']:[]}))}]});
  const execute=()=>spawnSync('python3',['scripts/test-truth/compare.py','--base',join(root,'base'),'--head',join(root,'head'),'--base-sha','0'.repeat(40),'--head-sha','1'.repeat(40),'--output',join(root,'results')],{encoding:'utf8'});
  const result=()=>JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'));
  try {
    for(const side of ['base','head'])for(let index=0;index<8;index++) {
      const dir=join(root,side,`shard-${index}`);mkdirSync(dir,{recursive:true});
      const write=(name,data)=>writeFileSync(join(dir,name),JSON.stringify(data));
      write('source.json',{sha:side==='base'?'0'.repeat(40):'1'.repeat(40),tracked:1,checked:1,mismatches:[]});
      write('finished.json',{});writeFileSync(join(dir,'runner-exit'),'0\n');
      write('inventory.json',{all:['server/guard.test.ts'],own:index===0?['server/guard.test.ts']:[]});
      write('receipts.json',index===0?[{label:'batch-0',batch:['server/guard.test.ts'],code:0,timedOut:false}]:[]);
      if(index===0)write('batch-0.json',report(['case']));
    }
    check({root,put,report,execute,result});
  } finally {removeTempDirSync(root);}
}
const event=(status,fullName,errors)=>JSON.stringify({status,file:'/fixture/source/server/guard.test.ts',fullName,...(errors?{errors}:{})})+'\n';

it.each([
  ['nonzero process exit', {code:1}, {}],
  ['failed report', {code:0}, {success:false}],
  ['unhandled report error', {code:0}, {numUnhandledErrors:1}],
  ['failed suite count', {code:0}, {numFailedTestSuites:1}],
  ['failed assertion count', {code:0}, {numFailedTests:1}],
])('retains %s with passing bodies, including after a green retry', (_name, receipt, fields)=>withEvidence(({put,report,execute,result})=>{
  const first={label:'batch-0',batch:['server/guard.test.ts'],timedOut:false,...receipt};
  put('head','receipts.json',[first]);
  put('head','batch-0.json',{...report(['case']),...fields});
  expect(execute().status).toBe(1);
  expect(result()).toMatchObject({complete:true,newRedIds:0});
  expect(result().head.infrastructureFailures).toMatchObject([{label:'batch-0',code:receipt.code}]);
  put('head','receipts.json',[first,{label:'retry-0',batch:['server/guard.test.ts'],code:0,timedOut:false}]);
  put('head','retry-0.json',report(['case']));
  expect(execute().status).toBe(1);
  expect(result().head.infrastructureFailures).toHaveLength(1);
}));

it.skipIf(process.platform !== 'linux')('keeps failed and unexecuted IDs when a killed file never returns JSON',()=>withEvidence(({root,put,report,execute,result})=>{
  const names=['passed before hang','failed before hang','still running','never reached'];
  put('base','batch-0.json',report(names));
  put('head','receipts.json',[{label:'killed',batch:['server/guard.test.ts'],code:null,signal:'SIGTERM',timedOut:true}]);
  put('head','killed.jsonl',names.map(name=>event('collected',name)).join('')+event('passed',names[0])+event('failed',names[1],[{message:'real failure before hang'}])+event('running',names[2]));
  expect(execute().status).toBe(2);
  const rows=readFileSync(join(root,'results/head-test-ids.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(rows.find(row=>row.id.endsWith(' :: failed before hang'))).toMatchObject({status:'failed',message:'real failure before hang'});
  expect(rows.find(row=>row.id.endsWith(' :: passed before hang'))).toMatchObject({status:'unverified',observedStatus:'passed'});
  expect(rows.find(row=>row.id.endsWith(' :: still running'))).toMatchObject({status:'unverified',observedStatus:'running'});
  expect(rows.find(row=>row.id.endsWith(' :: never reached'))).toMatchObject({status:'unverified',observedStatus:'collected'});
  expect(result().head).toMatchObject({reportedFiles:0,unverifiedIds:3});
}));

it.skipIf(process.platform !== 'linux')('a recovery pass cannot erase a failure observed before the first report was lost',()=>withEvidence(({root,put,execute,result})=>{
  put('head','receipts.json',[{label:'lost',batch:['server/guard.test.ts'],timedOut:true,signal:'SIGTERM'},{label:'batch-0',batch:['server/guard.test.ts'],code:0,timedOut:false}]);
  put('head','lost.jsonl',event('collected','case')+event('failed','case',[{message:'original assertion failed'}]));
  expect(execute().status).toBe(1);
  expect(result()).toMatchObject({complete:true,newRedIds:1});
  expect(result().head.recoveredAfterFailure).toEqual(['server/guard.test.ts :: case']);
  expect(result().head.infrastructureFailures).toHaveLength(1);
  expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: case\n');
}));

it.skipIf(process.platform !== 'linux')('corrected inputs replace the old cohort even when their new report is missing',()=>withEvidence(({put,report,execute,result})=>{
  put('base','batch-0.json',report(['case'],'failed'));
  put('base','batch-0.jsonl',event('failed','case',[{message:'old input missing'}]));
  put('base','receipts.json',[{label:'batch-0',batch:['server/guard.test.ts'],code:1,timedOut:false},{label:'fixture-0',batch:['server/guard.test.ts'],code:0,timedOut:false,fixtureRecheck:true}]);
  put('base','fixture-0.json',report(['case']));
  expect(execute().status).toBe(0);
  expect(result()).toMatchObject({complete:true,newRedIds:0,redOnBothIds:0});
  expect(result().base.correctedInputFiles).toEqual(['server/guard.test.ts']);
  put('base','batch-0.json',report(['case']));
  put('base','receipts.json',[{label:'batch-0',batch:['server/guard.test.ts'],code:0,timedOut:false},{label:'fixture-missing',batch:['server/guard.test.ts'],timedOut:true,fixtureRecheck:true}]);
  expect(execute().status).toBe(2);
  expect(result().base).toMatchObject({reportedFiles:0});
}));

it.skipIf(process.platform !== 'linux')('rejects unanimous wrong source revisions and a report from the wrong side',()=>withEvidence(({root,execute,result})=>{
  for(let index=0;index<8;index++)writeFileSync(join(root,'head',`shard-${index}`,'source.json'),JSON.stringify({sha:'0'.repeat(40),side:'head',tracked:1,checked:1,mismatches:[]}));
  expect(execute().status).toBe(2);
  expect(result().head).toMatchObject({sha:'0'.repeat(40),requestedSha:'1'.repeat(40)});
  expect(result().head.problems.some(problem=>problem.includes('differs from requested'))).toBe(true);
  for(let index=0;index<8;index++)writeFileSync(join(root,'head',`shard-${index}`,'source.json'),JSON.stringify({sha:'1'.repeat(40),side:index===0?'base':'head',tracked:1,checked:1,mismatches:[]}));
  expect(execute().status).toBe(2);
  expect(result().head.problems.some(problem=>problem.includes('wrong comparison side'))).toBe(true);
}));

it.skipIf(process.platform !== 'linux')('joins empty title components to their JSON ID without trimming literal title whitespace',()=>withEvidence(({root,put,execute,result})=>{
  const assertions=[
    {ancestorTitles:['suite'],title:'',fullName:'suite'},
    {ancestorTitles:['','nested'],title:'case',fullName:'nested case'},
    {ancestorTitles:['suite'],title:'value ',fullName:'suite value '},
  ].map(row=>({...row,status:'passed',failureMessages:[]}));
  for(const side of ['base','head'])put(side,'batch-0.json',{testResults:[{name:'/fixture/source/server/guard.test.ts',status:'passed',assertionResults:assertions}]});
  put('head','batch-0.jsonl',event('passed','suite ')+event('passed',' nested case')+event('failed','suite value ',[{message:'retained failure with literal trailing space'}]));
  expect(execute().status).toBe(1);
  expect(result()).toMatchObject({complete:true,newRedIds:1});
  expect(result().head).toMatchObject({testIds:3,unverifiedIds:0});
  expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: suite value \n');
}));

it.skipIf(process.platform !== 'linux')('keeps teardown timeouts blocking when every body passed and after a green retry',()=>withEvidence(({put,execute,result})=>{
  const first={label:'batch-0',batch:['server/guard.test.ts'],code:null,signal:'SIGTERM',timedOut:true};
  put('head','receipts.json',[first]);
  expect(execute().status).toBe(1);
  expect(result()).toMatchObject({complete:true,newRedIds:0});
  expect(result().head.infrastructureFailures).toMatchObject([{label:'batch-0',timedOut:true,signal:'SIGTERM'}]);
  put('head','receipts.json',[first,{label:'retry-0',batch:['server/guard.test.ts'],code:0,timedOut:false}]);
  put('head','retry-0.json',{testResults:[{name:'/fixture/source/server/guard.test.ts',status:'passed',assertionResults:[{fullName:'case',status:'passed',failureMessages:[]}]}]});
  expect(execute().status).toBe(1);
  expect(result()).toMatchObject({complete:true,newRedIds:0});
  expect(result().head.infrastructureFailures).toHaveLength(1);
}));
