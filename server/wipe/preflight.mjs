// SPDX-License-Identifier: AGPL-3.0-or-later
import "../../shared/win-hide-child-process.mjs";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,symlinkSync,rmSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

/** Keep every test assertion intact. A pre-existing integration failure must
 * reproduce at that exact integration tip before it can be distinguished from
 * a regression in this change. No arbitrary failed suite is accepted. */
export function verifyPreflight(directory,status) {
 const report=JSON.parse(readFileSync(join(directory,'baseline.json'),'utf8'));
 const failures=report.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>({file:f.name,name:t.fullName})));
 if(!failures.length){assert.equal(status,0);return;}
 assert.equal(status,1);
 assert.equal(failures.length,6,'Only the six integration snapshot failures may be inherited');
 for(const f of failures){assert.ok(f.file.endsWith('/server/no-limits-symlink-r31.test.ts'));assert.match(f.name,/^'AR11[a-f]' 'HOLD' inspection$/);}
 const scratch=join(directory,'integration-scratch'),tree=join(scratch,'tree');mkdirSync(scratch,{recursive:true});
 assert.ok(!resolve(scratch).startsWith(process.cwd()+'/'));
 const config=join(scratch,'gitconfig');writeFileSync(config,'[safe]\n\tdirectory = /source.git\n');
 const env={...process.env,GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:config};
 const git=args=>{const r=spawnSync('git',[...args],withHideInherit({env,encoding:'utf8',maxBuffer:16<<20}));assert.equal(r.status,0,r.stderr);};
 try {
  git(['-c','safe.directory=/source.git','clone','--shared','--no-checkout','/source.git',tree]);
  git(['-C',tree,'checkout','--detach','9537dc821599e4c7cb8194b7e2db7dd72313a36a']);
  symlinkSync(resolve('node_modules'),join(tree,'node_modules'),'dir');
  const json=join(directory,'integration-baseline.json');
  const result=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','server/no-limits-symlink-r31.test.ts','--reporter=json',`--outputFile=${json}`],withHideInherit({cwd:tree,env,encoding:'utf8',timeout:180000,maxBuffer:32<<20}));
  writeFileSync(join(directory,'integration-baseline.log'),(result.stdout??'')+(result.stderr??''));
  assert.equal(result.status,1);
  const prior=JSON.parse(readFileSync(json,'utf8')).testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName));
  const inherited=failures.map(f=>f.name).sort();
  for(const name of inherited)assert.ok(prior.includes(name),'Inherited assertion must reproduce at the integration tip: '+name);
  writeFileSync(join(directory,'preflight-comparison.json'),JSON.stringify({passed:report.numPassedTests,total:report.numTotalTests,inherited,baselineFailures:prior,fixed:prior.filter(name=>!inherited.includes(name)),newFailures:0},null,2)+'\n');
 } finally {rmSync(scratch,{recursive:true,force:true});}
}

/** V3 gates the same current assertions against its W0 merge, including all
 * inherited failures; no failed ID is accepted without a reproduced baseline. */
export function verifyV3Preflight(directory,status,resultDirectory) {
 const report=JSON.parse(readFileSync(join(directory,'baseline.json'),'utf8'));
 const key=(file,test)=>file.split('/server/').at(-1)+'\0'+test.fullName;
 const checked=report=>{
  assert.equal(report.numRuntimeErrorTestSuites??0,0);
  assert.ok(report.testResults.length,'No preflight suites');
  for(const file of report.testResults){assert.ok(file.assertionResults.length||file.status!=='failed','Preflight setup failed');for(const test of file.assertionResults){assert.ok(['passed','failed'].includes(test.status),'No skipped preflight assertions');if(test.status==='failed')assert.match(test.failureMessages.join('\n'),/AssertionError/);}}
  const seen=new Map();return new Map(report.testResults.flatMap(file=>file.assertionResults.map(test=>{const id=key(file.name,test),count=seen.get(id)??0;seen.set(id,count+1);return [id+'\0'+count,test.status];})));
 };
 const current=checked(report),scratch=join(directory,'v3-preflight-scratch'),tree=join(scratch,'tree');
 mkdirSync(scratch,{recursive:true});assert.ok(!resolve(scratch).startsWith(process.cwd()+'/'));
 const config=join(scratch,'gitconfig');writeFileSync(config,'[safe]\n directory = /source.git\n');
 const env={...process.env,GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:config};
 const git=(args,cwd=process.cwd())=>{const result=spawnSync('git',args,{cwd,env,encoding:'utf8',maxBuffer:32<<20});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
 const candidate=git(['rev-parse','HEAD']),base='43fa28a851386e2afe6b6fdc380e67ff7fdf62f5';let prior;
 try{
  if(resultDirectory){
   const comparison=JSON.parse(readFileSync(join(resultDirectory,'comparison.json'),'utf8'));
   assert.equal(comparison.head,candidate);assert.equal(comparison.base,base);assert.deepEqual(comparison.setupErrors,[]);
   const measured=JSON.parse(readFileSync(join(resultDirectory,'head.json'),'utf8'));assert.deepEqual([...checked(measured)].sort(),[...current].sort(),'Mutation preflight must equal this SHA’s broad report');
   prior=JSON.parse(readFileSync(join(resultDirectory,'baseline.json'),'utf8'));
  }else{
   git(['clone','--shared','--no-checkout','/source.git',tree]);git(['checkout','--detach',base],tree);
   const files=report.testResults.map(file=>file.name.replace(process.cwd()+'/', ''));
   for(const file of [...files,'server/wipe/corpus','server/wipe/v3-fault-scenarios.fixture.ts','server/wipe/red/fixture-support.ts','server/wipe/red/production-support.ts']){mkdirSync(join(tree,file,'..'),{recursive:true});cpSync(file,join(tree,file),{recursive:true});}
   symlinkSync(resolve('node_modules'),join(tree,'node_modules'),'dir');
   const json=join(directory,'v3-baseline.json'),result=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run',...files,'--maxWorkers=2','--reporter=json','--outputFile='+json],{cwd:tree,env,encoding:'utf8',timeout:900000,maxBuffer:64<<20});
   writeFileSync(join(directory,'v3-baseline.log'),(result.stdout??'')+(result.stderr??''));assert.ok([0,1].includes(result.status));prior=JSON.parse(readFileSync(json,'utf8'));
  }
  const previous=checked(prior);assert.equal(current.size,previous.size,'Same assertion set at base and HEAD');
  const inherited=[],newFailures=[];for(const [id,state]of current){assert.ok(previous.has(id),'Missing base assertion '+id);if(state==='failed')(previous.get(id)==='failed'?inherited:newFailures).push(id);}
  assert.equal(status,inherited.length+newFailures.length?1:0);
  writeFileSync(join(directory,'preflight-comparison.json'),JSON.stringify({base,head:candidate,passed:report.numPassedTests,total:report.numTotalTests,inherited,newFailures},null,2)+'\n');
  assert.deepEqual(newFailures,[],'V3 mutation preflight has new broad failures');
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
