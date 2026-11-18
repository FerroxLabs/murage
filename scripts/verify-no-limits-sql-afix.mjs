import {mkdtempSync,readFileSync,writeFileSync,cpSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Requires isolated container');
const out=resolve('evidence/afix-nolim-sql');
const root=mkdtempSync(join(tmpdir(),'afix-base-'));
const gate=['server/full-access.test.ts','server/auto-approve.test.ts','server/decision/no-limits-x2-full-access.test.ts','scripts/no-limits-live/ruling-1019.test.mjs'];
const targeted=['server/no-limits-review-fix.test.ts','server/no-limits-wipe-r3.test.ts','server/no-limits-truly.test.ts','server/decision/no-limits-truly.test.ts','server/decision/no-limits-review-fixes.test.ts','server/decision/no-limits-release-rulings-1019.test.ts'];
function run(id,cwd,files,pattern){
 const json=join(out,id+'.json');
 const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=1',...(pattern?['-t',pattern]:[]),'--reporter=json','--outputFile='+json],{cwd,env:process.env,encoding:'utf8',maxBuffer:32*1024*1024});
 writeFileSync(join(out,id+'.log'),(r.stdout??'')+(r.stderr??''));
 if(r.error||r.signal||![0,1].includes(r.status))throw Error('Incomplete test process '+id);
 const d=JSON.parse(readFileSync(json,'utf8'));if(!d.testResults?.length||d.numTotalTests===0||d.numFailedTestSuites>d.testResults.filter(f=>f.assertionResults.some(t=>t.status==='failed')).length)throw Error('Incomplete test report '+id);return {code:r.status,passed:d.numPassedTests,failed:d.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName)).sort()};
}
const report={base:'fc0b8d71619424468b6f1e17d99ac3a475da7a4f',startingHead:'d66dfcf6c93df5af60c9d2c0ae92a9531b6e9fc8',sourceSha256:createHash('sha256').update(readFileSync('server/no-limits-wipe.ts')).digest('hex')};
try{
 spawnSync('tar',['-xf',join(out,'base.tar'),'-C',root]);
 symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
 cpSync('scripts/no-limits-live/truly-review-rows.mjs',join(root,'scripts/no-limits-live/truly-review-rows.mjs'));
 cpSync('server/no-limits-review-fix.test.ts',join(root,'server/no-limits-review-fix.test.ts'));
 report.baseCorpus=run('exact-base-corpus',root,['server/no-limits-review-fix.test.ts']);
 report.baseGate=run('exact-base-gate',root,gate);
 writeFileSync(join(root,'server/no-limits-wipe.ts'),spawnSync('tar',['-xOf',join(out,'start.tar'),'server/no-limits-wipe.ts'],{encoding:'utf8'}).stdout);
 writeFileSync(join(root,'server/no-limits-code.ts'),spawnSync('tar',['-xOf',join(out,'start.tar'),'server/no-limits-code.ts'],{encoding:'utf8'}).stdout);
 report.startRed=run('starting-head-red',root,['server/no-limits-review-fix.test.ts'],'truly-review-afix-');
 report.headGate=run('head-gate',process.cwd(),gate);
 report.newFailures=report.headGate.failed.filter(x=>!report.baseGate.failed.includes(x));
 report.headTargeted=run('head-targeted',process.cwd(),targeted);
 report.verdict=report.newFailures.length===0&&report.headTargeted.code===0&&report.headTargeted.passed>0&&report.baseCorpus.passed>0&&report.startRed.code===1&&['template-js','template-py','printf-newline'].every(id=>['direct','approval','registered'].every(layer=>report.startRed.failed.some(name=>name.includes('afix-'+id)&&name.endsWith(layer))))?'PASS':'FAIL';
}finally{writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n');safeWipeSync(root,{reason:'isolated exact-base comparison'});}
console.log(JSON.stringify(report));
if(report.verdict!=='PASS')process.exitCode=1;
