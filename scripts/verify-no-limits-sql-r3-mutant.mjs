// SPDX-License-Identifier: AGPL-3.0-or-later
// A copied tree and the fake relay keep mutation proof away from live data.
import {cpSync,mkdtempSync,readdirSync,symlinkSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Requires isolated container');
const source=process.cwd(),out=resolve('evidence/nolim-sql-r3/mutant');mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'nolim-sql-r3-mutant-'));
for(const entry of readdirSync(source))if(!/^(?:node_modules|\.git|evidence|dist|build|\.cache)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
const file=join(root,'server/no-limits-database-input.ts'),original=readFileSync(file,'utf8');
const report={sourceSha256:createHash('sha256').update(original).digest('hex'),verdict:'FAIL'};
function unit(id){
 const json=join(out,id+'.json');
 const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/no-limits-review-fix.test.ts','--maxWorkers=1','-t','r3-template-unknown|r3-variable-native|r3-unknown-stdin|r3-percent','--reporter=json','--outputFile='+json],{cwd:root,env:process.env,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 writeFileSync(join(out,id+'.log'),(r.stdout??'')+(r.stderr??''));
 const d=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):undefined;
 return {code:r.status,failed:d?.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName))??[],passed:d?.numPassedTests??0};
}
try{
 const changed=original.replace('value===undefined||read(value)','value===undefined?false:read(value)');
 if(changed===original)throw Error('Missing fail-closed mutation anchor');
 writeFileSync(file,changed);
 report.red=unit('red');
 const live=join(out,'live-red');
 const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/no-limits-live/truly-proof.mjs',live],{cwd:root,env:{...process.env,TRULY_ONLY:'truly-review-r3-template-unknown'},encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 writeFileSync(join(out,'live-red.log'),(r.stdout??'')+(r.stderr??''));
 report.live={code:r.status,...(existsSync(join(live,'report.json'))?JSON.parse(readFileSync(join(live,'report.json'),'utf8')):{})};
 writeFileSync(file,original);report.restored=unit('restored');
 const killed=report.red.code===1&&['direct','approval','registered'].every(layer=>report.red.failed.some(name=>name.endsWith(layer)))&&report.restored.code===0&&report.restored.passed===12&&report.live.code===1&&report.live.rows?.some(row=>row.cards!==row.expectedCards&&row.complete&&row.ended);
 if(!killed)throw Error('Fail-closed mutant was not killed and restored');
 report.verdict='PASS';
}finally{
 writeFileSync(file,original);
 writeFileSync(join(out,'proof.json'),JSON.stringify(report,null,2)+'\n');
 safeWipeSync(root,{reason:'isolated fail-closed SQL mutation proof'});
}
console.log(JSON.stringify({verdict:report.verdict,red:report.red,restored:report.restored}));
