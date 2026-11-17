// SPDX-License-Identifier: AGPL-3.0-or-later
import "../../../shared/win-hide-child-process.mjs";
import { withHideInherit } from "../../../shared/win-hide-child-process.mjs";
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
assert.ok(process.env.CI&&existsSync('/source.git'),'Use the isolated network-none test container');
const evidence=process.env.WIPE_RED_EVIDENCE??'/evidence/red';
assert.ok(!resolve(evidence).startsWith(process.cwd()+'/'),'Evidence stays outside the repository');
mkdirSync(evidence,{recursive:true});const scratch=join(evidence,'scratch');mkdirSync(scratch,{recursive:true});
const config=join(scratch,'gitconfig');writeFileSync(config,'[safe]\n directory = /source.git\n');
const env={...process.env,GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:config};
class RunnerError extends Error {}
const git=(args,cwd=process.cwd())=>{const r=spawnSync('git',[...args],withHideInherit({cwd,env,encoding:'utf8',maxBuffer:32<<20}));if(r.status!==0)throw new RunnerError('git '+args[0]+': '+r.stderr);return r.stdout.trim();};
const head=process.env.WIPE_RED_HEAD??git(['--git-dir=/source.git','rev-parse','dev/1019-wipe-v3']);
const commits={'w0-base':'43fa28a851386e2afe6b6fdc380e67ff7fdf62f5','v3-base':'11bb08513e3af432e243ea98290d6131b509c552',df48:'df48c2f667f5622b2b988b51bab142bbecc95d6e',b8e1:'b8e1a54af857531f56c327b27375a5e53345735b',c1:'728ff2ab8a976939121f4ca1d97b1d26320f586b',rd1:'074c4b61abc9b2d9438c637660e8327dfd75025a',head};
const expected=JSON.parse(readFileSync('server/wipe/red/expected.json','utf8'));
const required={'w0-base':[],'v3-base':[],df48:['R1-H1a','R1-H2a','R1-H3a','R1-H3b','R1-H4','R1-H5'],b8e1:['R2-H1a','R2-H1b','R2-H2a'],c1:['R2-H3'],rd1:[],head:[]};
const v2Files=['server/wipe/v2.test.ts','server/wipe/events-v2.test.ts','server/wipe/mount-v2.test.ts','server/wipe/fault-v2.test.ts','server/wipe/proof-v2.test.ts','server/wipe/workflow-v2.test.ts','server/wipe/nonexecuting-v2.test.ts'];
const v3Files=['server/wipe/v3-regressions.test.ts','server/wipe/fault-v3.test.ts','server/wipe/perf-v3.test.ts','server/wipe/mutant-v3-witness.test.ts'];
const v3Sources=[...v3Files,'server/wipe/corpus/wipe-corpus-v3.json','server/wipe/corpus/v3-context.fixture.ts','server/wipe/corpus/v3-faults.fixture.ts','server/wipe/v3-fault-scenarios.fixture.ts'];
const sources=['server/wipe-acceptance.test.ts','server/wipe/red/fixture-support.ts','server/wipe/red/production-support.ts','server/wipe/perf.test.ts'];
const clone=join(scratch,'repo'),report={commits:{},observed:{},performance:{},equivalence:{},failures:[]};
function tests(label,tree,files,extra=[]){
 const file=join(evidence,label+'.json');const r=spawnSync(process.execPath,['/work/node_modules/vitest/vitest.mjs','run',...files,...extra,'--reporter=json','--outputFile='+file],withHideInherit({cwd:tree,env:{...env,WIPE_RED_COMMIT:label.split('-')[0]},encoding:'utf8',timeout:600000,maxBuffer:64<<20}));
 writeFileSync(join(evidence,label+'.log'),(r.stdout??'')+(r.stderr??''));
 if(r.error||![0,1].includes(r.status)||!existsSync(file))throw new RunnerError(label+': test process did not complete');
 const json=JSON.parse(readFileSync(file,'utf8'));const rows=json.testResults.flatMap(f=>f.assertionResults);
 if(!rows.length||json.testResults.some(f=>f.status==='failed'&&!f.assertionResults.length)||json.numRuntimeErrorTestSuites)throw new RunnerError(label+': setup/module error');
 for(const row of rows)if(row.status==='failed'&&!/AssertionError/.test(row.failureMessages.join('\n')))throw new RunnerError(label+' '+row.fullName+': non-assertion failure');
 return rows.filter(row=>row.status!=='pending'&&row.status!=='skipped');
}
try{
 git(['clone','--shared','--no-checkout','/source.git',clone]);
 for(const [label,sha]of Object.entries(commits)){
  const tree=join(scratch,'tree-'+label);git(['worktree','add','--detach',tree,sha],clone);
  try{
   mkdirSync(join(tree,'server/wipe/red'),{recursive:true});for(const file of [...sources,...(['rd1','head'].includes(label)?v2Files:[]),...(['w0-base','v3-base','head'].includes(label)?v3Sources:[])]){mkdirSync(join(tree,file,'..'),{recursive:true});copyFileSync(file,join(tree,file));}
   const adapter=['w0-base','v3-base','rd1','head'].includes(label)?'head':label==='df48'?'df48c2f6':'b8e1a54a';
   copyFileSync('server/wipe/red/adapter.'+adapter+'.ts',join(tree,'server/wipe/red/adapter.selected.ts'));
   writeFileSync(join(tree,'server/wipe-acceptance-adapter.ts'),"export * from './wipe/red/adapter.selected.ts';\n");symlinkSync('/work/node_modules',join(tree,'node_modules'),'dir');
   const rows=tests(label,tree,['w0-base','v3-base'].includes(label)?v3Files:['server/wipe-acceptance.test.ts',...(['rd1','head'].includes(label)?v2Files:[]),...(label==='head'?v3Files:[])]);assert.ok(rows.length>=(['w0-base','v3-base'].includes(label)?45:170),label+': missing rows');
   for(const row of rows){if(label==='head'){if(row.status!=='passed')report.failures.push('HEAD '+row.fullName+': '+row.status);assert.equal(expected[row.fullName]?.head,'PASS','Missing HEAD cell '+row.fullName);}}
   for(const [id,cells]of Object.entries(expected)){
    for(const key of Object.keys(commits))assert.ok(['PASS','FAIL-assert','observed','n/a'].includes(cells[key]),id+': missing cell '+key);
    const want=cells[label];if(want==='n/a'){(report.observed[id]??={})[label]='n/a';continue;}const row=rows.find(row=>row.fullName===id);assert.ok(row,label+': missing '+id);
    const observed=row.status==='passed'?'PASS':'FAIL-assert';(report.observed[id]??={})[label]=observed;
    if(want!=='observed'&&observed!==want)report.failures.push(label+' '+id+': '+observed+' expected '+want);if(required[label].includes(id))assert.equal(want,'FAIL-assert');
   }
   for(const id of required[label])assert.ok(rows.some(row=>row.fullName===id&&row.status==='failed'),label+': missing named RED '+id);
   report.commits[label]={sha,total:rows.length,passed:rows.filter(row=>row.status==='passed').length};
   if(label==='c1'||label==='head'){
    const perf=tests(label+'-perf',tree,['server/wipe/perf.test.ts'],['-t','^P-1 ']);assert.equal(perf.length,1);assert.equal(perf[0].status,label==='head'?'passed':'failed');report.performance[label]={sha,rows:perf.map(row=>({name:row.fullName,status:row.status}))};
   }
  }finally{git(['worktree','remove','--force',tree],clone);}
 }
 // Run the exact pre-existing consumers at both sides of the move-only extraction.
 const files=git(['--git-dir=/source.git','grep','-l','-E','wipe-project-roots|registerBotWipeRoots|root-wiring',commits.b8e1,'--','*.test.ts']).split('\n').filter(Boolean).map(line=>line.slice(line.indexOf(':')+1));
 assert.ok(files.length,'No pre-existing wiring consumers found');
 for(const label of ['b8e1','c1']){
  const tree=join(scratch,'equivalence-'+label);git(['worktree','add','--detach',tree,commits[label]],clone);
  try{symlinkSync('/work/node_modules',join(tree,'node_modules'),'dir');const rows=tests(label+'-equivalence',tree,files);report.equivalence[label]=rows.map(row=>({name:row.fullName,status:row.status})).sort((a,b)=>a.name.localeCompare(b.name));}finally{git(['worktree','remove','--force',tree],clone);}
 }
 assert.deepEqual(report.equivalence.b8e1,report.equivalence.c1,'Move-only consumer results differ');
 writeFileSync(join(evidence,'c1-color-moved.diff'),git(['--git-dir=/source.git','diff','--color-moved=zebra',commits.b8e1,commits.c1]));
 writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');if(report.failures.length){console.error(JSON.stringify(report.failures,null,2));process.exitCode=1;}else console.log('RED matrix, perf and C1 equivalence verified');
}catch(error){console.error(error);process.exitCode=error instanceof RunnerError?2:1;}
finally{writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');rmSync(scratch,{recursive:true,force:true});}
