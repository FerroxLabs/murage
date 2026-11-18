// SPDX-License-Identifier: AGPL-3.0-or-later
// A copied tree and isolated fake relay never touch live application data.
import {cpSync,mkdtempSync,readdirSync,symlinkSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Requires isolated container');
const source=process.cwd(),out=resolve('evidence/nolim-sql-r4');mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'nolim-sql-r4-'));
const names=['no-limits-wipe-sql.ts','no-limits-database-input.ts'];
const originals=Object.fromEntries(names.map(name=>[name,readFileSync(join(source,'server',name),'utf8')]));
const report={base:readFileSync(join(out,'base-sha.txt'),'utf8').trim(),sourceSha256:Object.fromEntries(names.map(name=>[name,createHash('sha256').update(originals[name]).digest('hex')])),verdict:'FAIL'};
function unit(id,filter,files=['server/no-limits-review-fix.test.ts']){
 const json=join(out,id+'.json');
 const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=1',...(filter?['-t',filter]:[]),'--reporter=json','--outputFile='+json],{cwd:root,env:process.env,encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});
 writeFileSync(join(out,id+'.log'),(r.stdout??'')+(r.stderr??''));
 const d=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):undefined;
 if(r.error||r.signal||!d?.numTotalTests)throw Error('Incomplete test report '+id);
 return {code:r.status,failed:d.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName)),passed:d.numPassedTests};
}
try{
 for(const entry of readdirSync(source))if(!/^(?:node_modules|\.git|evidence|dist|build|\.cache)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 for(const name of names)writeFileSync(join(root,'server',name),readFileSync(join(out,'base-source',name)));
 report.baseline=unit('final-baseline');
 report.baselineGates=unit('baseline-gates',undefined,['server/full-access.test.ts','server/auto-approve.test.ts']);
 const required=['r4-mysql-dash','r4-delete-block','r4-mongo-spread','r4-optional-query','r4-raw-comment','r4-delete-one-equals-one','r4-mongo-call','r4-unknown-method'];
 if(report.baseline.code!==1||!required.every(id=>['direct','approval','registered'].every(layer=>report.baseline.failed.some(name=>name.includes(id+' ')&&name.endsWith(layer)))))throw Error('Missing required baseline RED assertions');
 for(const name of names)writeFileSync(join(root,'server',name),originals[name]);
 const file=join(root,'server/no-limits-wipe-sql.ts');
 // Disable the common raw scan while leaving all later SQL/Mongo/client
 // parsing intact. The regressions must kill this substantive bypass.
 const changed=originals[names[0]].replace(/(export function rawDatabaseWipe\(text:string\):boolean \{\n) [^\n]+/, '$1 return false;');
 if(changed===originals[names[0]])throw Error('Missing raw-scan mutation anchor');
 writeFileSync(file,changed);
 const filter='r4-raw-comment|r4-raw-dropdatabase|r4-raw-flushall';
 report.mutant=unit('mutant-red',filter);
 const live=join(out,'mutant-live');
 const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/no-limits-live/truly-proof.mjs',live],{cwd:root,env:{...process.env,TRULY_ONLY:'truly-review-r4-raw-comment'},encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 writeFileSync(join(out,'mutant-live.log'),(r.stdout??'')+(r.stderr??''));
 report.liveMutant={code:r.status,...(existsSync(join(live,'report.json'))?JSON.parse(readFileSync(join(live,'report.json'),'utf8')):{})};
 writeFileSync(file,originals[names[0]]);
 report.restored=unit('mutant-restored',filter);
 if(report.mutant.code!==1||!['direct','approval','registered'].every(layer=>report.mutant.failed.some(name=>name.endsWith(layer)))||report.restored.code!==0||report.restored.passed!==9||report.liveMutant.code!==1||!report.liveMutant.rows?.some(row=>row.cards!==row.expectedCards&&row.complete&&row.ended))throw Error('Raw-scan mutant was not killed and restored');
 report.verdict='PASS';
}finally{
 writeFileSync(join(out,'proof.json'),JSON.stringify(report,null,2)+'\n');
 safeWipeSync(root,{reason:'isolated raw database scan baseline and mutation proof'});
}
console.log(JSON.stringify({verdict:report.verdict,baseline:report.baseline,mutant:report.mutant,restored:report.restored}));
