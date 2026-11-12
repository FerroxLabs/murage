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
    const command=['scripts/test-truth/compare.py','--base',join(root,'base'),'--head',join(root,'head'),'--output',join(root,'results')];
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
    expect(run().status).toBe(1);
    const report=JSON.parse(readFileSync(join(root,'results/summary.json'),'utf8'));
    expect(report.complete).toBe(true);
    expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: actual hung case\nserver/guard.test.ts :: case after hang\nserver/guard.test.ts :: duplicate name\n');
    expect(readFileSync(join(root,'results/head-test-ids.jsonl'),'utf8')).toContain('<TIMEOUT>');
    writeFileSync(retryReport,JSON.stringify({testResults:[{name:'/fixture/source/server/guard.test.ts',status:'passed',assertionResults:events.map(event=>({fullName:event.fullName,status:'passed',failureMessages:[]}))}]}));
    writeFileSync(receiptsPath,JSON.stringify([{label:'absent',batch:['server/guard.test.ts'],timedOut:true},{...firstReceipt,label:'retry-0'}]));
    expect(run().status,'a passing retry cannot erase timed-out incremental IDs').toBe(1);
    expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: actual hung case\nserver/guard.test.ts :: case after hang\nserver/guard.test.ts :: duplicate name\n');

  } finally {removeTempDirSync(root);}
});
