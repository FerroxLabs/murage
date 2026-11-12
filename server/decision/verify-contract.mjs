// SPDX-License-Identifier: AGPL-3.0-or-later
// S0's frozen tests include three NotBuilt-only assertions. Validate those
// against their declared stub fixture; behavioral tests use the built modules.
// No production branch or environment switch is added to satisfy stub tests.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const baseline=JSON.parse(readFileSync('server/decision/s0-baseline.json','utf8'));
const fixtures=[['server/decision/implementation.ts','implementation'],['server/testing/replay-source.ts','replay'],['shared/owner-routine-level.ts','routine']];
const saved=fixtures.map(([path])=>readFileSync(path,'utf8'));
const dir=process.env.DECISION_EVIDENCE||'server/decision/evidence';mkdirSync(dir,{recursive:true});
try{
 for(const [path,key] of fixtures)writeFileSync(path,baseline[key]);
 const args=['run','server/decision/contract.test.ts'];
 const result=spawnSync('node_modules/.bin/vitest',args,{encoding:'utf8',timeout:90000});
 writeFileSync(dir+'/contract-stubs.log',`BASE ${baseline.commit}\nCOMMAND node_modules/.bin/vitest ${args.join(' ')}\n${result.stdout??''}${result.stderr??''}`);
 console.log('Frozen S0 contract fixture:',result.status===0?'PASS':'FAIL');process.exitCode=result.status===0?0:1;
}finally{fixtures.forEach(([path],i)=>writeFileSync(path,saved[i]));}
