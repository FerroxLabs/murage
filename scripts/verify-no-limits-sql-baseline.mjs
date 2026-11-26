import { archivedEvidencePath, evidencePath } from './evidence-path.mjs';
// Compare only the unchanged approval assertions that failed the scoped gate.
import {cpSync,mkdtempSync,readdirSync,symlinkSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Requires isolated test container');
const source=process.cwd(),out=resolve(evidencePath('evidence/nolim-sql/approval-baseline'));mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'nolim-sql-baseline-'));
for(const entry of readdirSync(source))if(!/^(?:node_modules|\.git|evidence|dist|build|\.cache)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
const pattern='an uncut ACP summary|a non-command tool.s summary|lets the stop line go on a turn|runs key work on marked|keeps legacy unproven fallback';
function run(id){
 const json=join(out,id+'.json');
 const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/auto-approve.test.ts','server/full-access.test.ts','--maxWorkers=1','-t',pattern,'--reporter=json','--outputFile='+json],{cwd:root,env:process.env,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 writeFileSync(join(out,id+'.log'),(r.stdout??'')+(r.stderr??''));
 const d=JSON.parse(readFileSync(json,'utf8'));
 return {code:r.status,passed:d.numPassedTests,failed:d.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName)).sort()};
}
const report={base:'fc0b8d7161',verdict:'FAIL'};
try{
 report.head=run('head');
 for(const name of ['no-limits-wipe.ts','no-limits-code.ts'])writeFileSync(join(root,'server',name),readFileSync(archivedEvidencePath('evidence/nolim-sql/baseline-source/'+name)));
 report.baseResult=run('base');
 report.newFailures=report.head.failed.filter(name=>!report.baseResult.failed.includes(name));
 if(report.head.code!==1||report.baseResult.code!==1||report.head.failed.length!==5||JSON.stringify(report.head.failed)!==JSON.stringify(report.baseResult.failed))throw Error('Failure sets differ');
 report.verdict='PASS';
}finally{writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');safeWipeSync(root,{reason:'isolated SQL approval baseline comparison'});}
console.log(JSON.stringify(report));
