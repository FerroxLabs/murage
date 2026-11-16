// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only inside the networkless job container. Payloads stay inert.
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve('.'), evidence=resolve('evidence/bld7-toolid-s4b');
mkdirSync(evidence,{recursive:true});
const scratch=mkdtempSync(join(tmpdir(),'toolid-r13b-mutants-'));
const mutations=[
 ['image-direct','server/image-approval.ts','return { reads: [cleanRead("image-approval")], basis };','return { ask: false, basis };','P2 image'],
 ['owner-cut-wipe-run','shared/no-limits-decision.ts','const owner = context.kind === "clean-owner";','const owner = context.kind === "clean-owner"; if (owner && reads.some(read => read.state === "cut")) return { verdict: "run", cls: "", approve: "mutant" };','P1b unreadable plus wipe'],
 ['routine-not-base','server/auto-approve.ts','return finalDecision([], tool, { kind: "base", verdict });','return finalDecision([], tool, { kind: "base", verdict: { ...verdict, ...(initiator === "routine" ? { rule: "mutant" } : {}) } });','routine-'],
];
mutations.push(['routine-waiver','server/auto-approve.ts',
 'return finalDecision([], tool, { kind: "base", verdict });',
 'return finalDecision([], tool, { kind: "base", verdict: initiator === "routine" ? { approve: "mutant routine allow", source: "no-limits" } : verdict });',
 'manualRoutine-']);
const results=[];
try {
 for (const mutation of [null,...mutations]) {
  assert.ok(Number(readFileSync('/proc/loadavg','utf8').split(' ')[0])<85);
  const [id,file,before,after,witness]=mutation??['baseline'];
  const work=join(scratch,id); mkdirSync(work);
  for(const dir of ['server','shared']) cpSync(join(root,dir),join(work,dir),{recursive:true});
  mkdirSync(join(work,'scripts'));
  for(const name of ['inventory-toolid-r13.mjs','toolid-approval-sites.json','toolid-typed-returns.json']) cpSync(join(root,'scripts',name),join(work,'scripts',name));
  symlinkSync(join(root,'node_modules'),join(work,'node_modules'),'dir');
  symlinkSync(join(root,'electron'),join(work,'electron'),'dir');
  writeFileSync(join(work,'package.json'),' {"type":"module"}\n');
  writeFileSync(join(work,'vitest.config.mjs'),"export default {test:{environment:'node',include:['server/no-limits-r13b.test.ts'],maxWorkers:1,fileParallelism:false}};\n");
  if(mutation) {
   const path=join(work,file), source=readFileSync(path,'utf8');
   assert.equal(source.split(before).length,2,'unique source mutation');
   writeFileSync(path,source.replace(before,after));
   writeFileSync(join(evidence,id+'-mutation.json'),JSON.stringify({file,before,after},null,2)+'\n');
   if(id==='image-direct') {
    const index=join(work,'server/index.ts'), source=readFileSync(index,'utf8');
    const before='const permission = finalDecision(decision.reads, "generate_image");\n  return permission.verdict === "run" && "basis" in decision ? { basis: decision.basis } : null;';
    const after='return decision.ask ? null : { basis: decision.basis };';
    assert.equal(source.split(before).length,2);
    writeFileSync(index,source.replace(before,after));
    writeFileSync(join(evidence,id+'-consumer-mutation.json'),JSON.stringify({file:'server/index.ts',before,after},null,2)+'\n');
   }
  }
  const report=join(evidence,id+'-mutant-tests.json');
  const run=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--root',work,'--config',join(work,'vitest.config.mjs'),'--reporter=json','--outputFile='+report],{cwd:work,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
  writeFileSync(join(evidence,id+'-mutant.log'),run.stdout+run.stderr);
  assert.equal(run.error,undefined);
  const tests=JSON.parse(readFileSync(report,'utf8'));
  assert.equal(tests.numRuntimeErrorTestSuites??0,0);
  const failed=tests.testResults.flatMap(s=>s.assertionResults).filter(t=>t.status==='failed');
  if(mutation) { assert.equal(run.status,1); assert.ok(failed.some(t=>t.title.includes(witness))); if(id==='routine-waiver') assert.ok(failed.some(t=>t.title.includes('scheduledRoutine-'))); }
  else { assert.equal(run.status,0); assert.equal(failed.length,0); }
  let inventory;
  if(!mutation||id==='image-direct') {
   const inv=spawnSync(process.execPath,['scripts/inventory-toolid-r13.mjs','.',join(evidence,id+'-mutant-inventory.json')],{cwd:work,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
   writeFileSync(join(evidence,id+'-mutant-inventory.log'),inv.stdout+inv.stderr);
   inventory=inv.status;
   assert.equal(inventory,mutation?1:0);
  }
  results.push({id,result:mutation?'KILLED':'PASS',tests:tests.numTotalTests,failed:failed.length,inventory_exit:inventory});
 }
 writeFileSync(join(evidence,'mutants.json'),JSON.stringify(results,null,2)+'\n');
 console.log(join(evidence,'mutants.json'));
} finally {
 assert.ok(scratch.startsWith(join(tmpdir(),'toolid-r13b-mutants-')));
 safeWipeSync(scratch);
}
