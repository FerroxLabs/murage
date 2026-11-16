// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in the isolated, network-none test container. Restore every source.
import {mkdirSync,readFileSync,writeFileSync,statSync,utimesSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const dir='.gnl-proof/r2/mutants';mkdirSync(dir,{recursive:true});
const inheritance='server/no-limits-inheritance.test.ts',email='server/email/no-limits-1019.test.ts',publish='server/publish/no-limits-1019.test.ts',integrity='server/no-limits-linked-files.test.ts';
const mutants=[
 ['H1-legacy-full-blocks-inheritance','server/permission-inheritance.ts','((value.permissionRev??0)>0)','((value.permissionRev??0)>0 || value.fullAccess===true)',inheritance],
 ['H2-publish-symlink-refusal','server/publish/site-files.ts','if (!noLimits) throw new PublishError("symlink",','if (true) throw new PublishError("symlink",',publish],
 ['H2-publish-hardlink-refusal','server/publish/site-files.ts','if (!noLimits && info.nlink > 1)','if (info.nlink > 1)',publish],
 ['H2-artifact-symlink-refusal','server/artifacts.ts','if (!noLimits || index < parts.length - 1)','if (true || index < parts.length - 1)',email],
 ['H2-artifact-hardlink-refusal','server/artifacts.ts','(!noLimits && stat.nlink !== 1)','stat.nlink !== 1',email],
 ['H2-reader-hardlink-refusal','server/artifacts.ts','(!noLimits && before.nlink !== 1)','before.nlink !== 1',email],
 ['H2-artifact-ignore-live-level','server/artifacts.ts',"const noLimits = !!scope.runId && readTurnPolicy({ threadId: input.threadId, generation: scope.runId })?.permission.noLimits === true;",'const noLimits = true;',email],
];
function run(name,files){
 const output=`${dir}/${name}.json`;
 const result=spawnSync('node_modules/.bin/vitest',['run',...files,'--maxWorkers=2','--reporter=json',`--outputFile=${output}`],{encoding:'utf8',timeout:180000});
 writeFileSync(`${dir}/${name}.log`,(result.stdout??'')+(result.stderr??''));
 let report;try{report=JSON.parse(readFileSync(output,'utf8'));}catch{}
 const failures=report?.testResults.flatMap(s=>s.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages})))??[];
 return {status:result.status,passed:report?.numPassedTests,failed:report?.numFailedTests,failures};
}
const baseline=run('baseline',[inheritance,email,publish,integrity]);
if(baseline.status!==0)throw Error('Candidate baseline failed');
const matrix=[];
for(const [name,file,from,to,test]of mutants){
 const original=readFileSync(file,'utf8'),stamp=statSync(file);
 if(original.split(from).length!==2)throw Error('Mutation anchor not unique: '+name);
 try{
  writeFileSync(file,original.replace(from,to));
  writeFileSync(`${dir}/${name}.source-change.json`,JSON.stringify({file,from,to,sourceSha256:createHash('sha256').update(original).digest('hex')},null,2)+'\n');
  const result=run(name,[test]);
  const killed=result.status===1&&result.failed>0&&result.failures.some(f=>/^H[12]/.test(f.name))&&!result.failures.some(f=>/SyntaxError|Transform failed|Failed to resolve/.test(f.messages.join('\n')));
  matrix.push({name,killed,...result});
 }finally{writeFileSync(file,original);utimesSync(file,stamp.atime,stamp.mtime);}
}
writeFileSync(`${dir}/matrix.json`,JSON.stringify({baseline,mutants:matrix},null,2)+'\n');
if(matrix.some(m=>!m.killed))process.exitCode=1;
