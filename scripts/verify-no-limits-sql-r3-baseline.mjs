import { evidencePath } from './evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
import {cpSync,mkdtempSync,readdirSync,symlinkSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Requires isolated container');
const source=process.cwd(),out=resolve(evidencePath('evidence/nolim-sql-r3'));mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'nolim-sql-r3-baseline-'));
const files=['server/no-limits-review-fix.test.ts','server/full-access.test.ts','server/auto-approve.test.ts','server/decision/no-limits-x2-full-access.test.ts','scripts/no-limits-live/ruling-1019.test.mjs'];
const report={base:'a887f3e470b42caf99969f505f41db8d4b3a1dda',verdict:'FAIL',sourceSha256:Object.fromEntries(['server/no-limits-wipe.ts','server/no-limits-wipe-sql.ts','server/no-limits-database-input.ts'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))};
function parse(file){
 const data=JSON.parse(readFileSync(file,'utf8'));
 if(!data.testResults?.length||data.numTotalTests===0||data.testResults.some(f=>!f.assertionResults.length))throw Error('Incomplete test report '+file);
 return {passed:data.numPassedTests,failed:data.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName)).sort()};
}
try{
 for(const entry of readdirSync(source))if(!/^(?:node_modules|\.git|evidence|dist|build|\.cache)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 for(const name of ['no-limits-wipe.ts','no-limits-wipe-sql.ts'])writeFileSync(join(root,'server',name),readFileSync(join(out,'base-source',name)));
 const json=join(out,'final-base.json');
 const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=6','--fileParallelism','--reporter=json','--outputFile='+json],{cwd:root,env:process.env,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
 writeFileSync(join(out,'final-base.log'),(r.stdout??'')+(r.stderr??''));
 if(r.error||r.signal||r.status!==1)throw Error('Expected completed RED baseline');
 report.baseResult=parse(json);report.headResult=parse(join(out,'final-targeted.json'));
 report.newFailures=report.headResult.failed.filter(name=>!report.baseResult.failed.includes(name));
 report.corpusFailures=report.headResult.failed.filter(name=>name.startsWith('truly-review-'));
 // Every newly introduced fail-closed boundary must be RED at all layers.
 const required=['r3-template-unknown','r3-variable-native','r3-unknown-stdin','r3-percent','r2-template-js','r2-template-py','r2-printf-literal-backslash','r2-resp-euro','r2-psql-short','r2-psql-long'];
 report.requiredRed=required.every(id=>['direct','approval','registered'].every(layer=>report.baseResult.failed.some(name=>name.includes('truly-review-'+id+' ')&&name.endsWith(layer))));
 if(report.newFailures.length||report.corpusFailures.length||!report.requiredRed||report.headResult.passed===0)throw Error('Baseline/HEAD comparison failed');
 report.verdict='PASS';
}finally{
 writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n');
 safeWipeSync(root,{reason:'isolated exact starting-HEAD SQL comparison'});
}
console.log(JSON.stringify(report));
