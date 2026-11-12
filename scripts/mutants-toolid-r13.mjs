// Mutants live only in private container copies. Never edit the working tree.
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve('.'), evidence=join(root,'evidence/bld3-toolid-s4a');
const scratch=mkdtempSync(join(tmpdir(),'r13-mutants-'));
const results=[];
try {
  for (const mutant of ['baseline','producer-direct-approval','unreadable-to-run']) {
    const work=join(scratch,mutant); mkdirSync(work);
    for (const dir of ['server','shared']) cpSync(join(root,dir),join(work,dir),{recursive:true,filter:p=>!p.includes('__pycache__')});
    for (const dir of ['node_modules','electron','scripts','src','companion']) symlinkSync(join(root,dir),join(work,dir),'dir');
    cpSync(join(root,'package.json'),join(work,'package.json'));
    writeFileSync(join(work,'vitest.config.mjs'),"export default { test: { environment: 'node', include: ['server/no-limits-r13-gate.test.ts'], maxWorkers: 1, fileParallelism: false } };\n");
    if(mutant==='producer-direct-approval') {
      const file=join(work,'server/auto-approve.ts'), source=readFileSync(file,'utf8');
      const before='if (hasNoLimits(bot)) return { approve: null, source: "no-limits", noLimitsCandidate: true };';
      assert.equal(source.split(before).length,2);
      writeFileSync(file,source.replace(before,before.replace('approve: null','approve: "direct producer approval"')));
    }
    if(mutant==='unreadable-to-run') {
      const file=join(work,'server/auto-approve.ts'), source=readFileSync(file,'utf8');
      const before='if (found.rule === "unreadable" || found.readerFailed || found.couldNotRead) return cutRead("always-ask");';
      assert.equal(source.split(before).length,2);
      writeFileSync(file,source.replace(before,before.replace('cutRead','cleanRead')));
    }
    const inventory=spawnSync(process.execPath,[join(root,'scripts/inventory-toolid-r13.mjs'),work,join(evidence,`${mutant}-inventory.json`)],{cwd:work,encoding:'utf8',timeout:60000,maxBuffer:4000000});
    writeFileSync(join(evidence,`${mutant}-inventory.log`),inventory.stdout+inventory.stderr);
    const run=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--root',work,'--config',join(work,'vitest.config.mjs'),'--reporter=json',`--outputFile=${join(evidence,`${mutant}-gate.json`)}`],{cwd:work,encoding:'utf8',timeout:120000,maxBuffer:4000000});
    writeFileSync(join(evidence,`${mutant}-gate.log`),run.stdout+run.stderr);
    assert.equal(inventory.error,undefined); assert.equal(run.error,undefined);
    const report=JSON.parse(readFileSync(join(evidence,`${mutant}-gate.json`),'utf8'));
    assert.equal(report.numRuntimeErrorTestSuites??0,0);
    if(mutant==='baseline') { assert.equal(inventory.status,0); assert.equal(run.status,0); }
    if(mutant==='producer-direct-approval') {assert.equal(inventory.status,1); assert.match(inventory.stdout,/producer approving directly/);}
    if(mutant==='unreadable-to-run') {assert.equal(run.status,1); assert.ok(report.numFailedTests>0);}
    results.push({mutant,result:mutant==='baseline'?'PASS':'KILLED',inventory_status:inventory.status,test_status:run.status,tests:report.numTotalTests,failed:report.numFailedTests});
  }
  writeFileSync(join(evidence,'mutants.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results));
} finally { assert.ok(scratch.startsWith(join(tmpdir(),'r13-mutants-'))); safeWipeSync(scratch); }
