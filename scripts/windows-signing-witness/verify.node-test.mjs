// Witness validation/tests owner: win-sac-sign; actual Windows collectors and execution owner: MAIN.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { loadEnrollment, main, verifyCase, verifyRun } from './run.mjs';
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'signing-witness-'));roots.push(root);
 const request={schema:1,caseId:'crash-driver-death',runNonce:'a'.repeat(64),nonce:'b'.repeat(64),sourceRevision:'c'.repeat(40),identity:{runId:'1',runAttempt:'1'}};
 const spec={id:request.caseId,expect:{faultReached:true,successReceipts:0,uncontainedChildren:0},captures:['fault','processes','cleanup']};
 const captures=spec.captures.map(kind=>{const file=kind+'.json',bytes=JSON.stringify({kind,observations:['measured']});fs.writeFileSync(path.join(root,file),bytes);return {kind,file,sha256:hash(bytes)};});
 const result={...request,status:'PASS',observed:{...spec.expect},captures,resources:{created:[{type:'process',id:'fixture-child'}],destroyed:[{type:'process',id:'fixture-child'}],remaining:[]}};
 const save=()=>fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result));save();
 return {root,request,spec,result,save};
}
test('accepts a complete measured case and independent cleanup captures',()=>{const f=fixture();assert.equal(verifyCase(f.root,f.request,f.spec).status,'PASS');});
for(const [name,mutate] of [
 ['skipped case',f=>{f.result.status='SKIP';}],
 ['replay from another case',f=>{f.result.caseId='crash-service-death';}],
 ['stale nonce',f=>{f.result.nonce='d'.repeat(64);}],
 ['foreign run',f=>{f.result.runNonce='d'.repeat(64);}],
 ['wrong attempt',f=>{f.result.identity={runId:'1',runAttempt:'2'};}],
 ['wrong build',f=>{f.result.sourceRevision='d'.repeat(40);}],
 ['boolean substituted for numeric zero',f=>{f.result.observed.successReceipts=false;}],
 ['missing observation',f=>{delete f.result.observed.faultReached;}],
 ['living child',f=>{f.result.observed.uncontainedChildren=1;}],
 ['missing capture category',f=>{f.result.captures.pop();}],
 ['duplicate category',f=>{f.result.captures.push(f.result.captures[0]);}],
 ['path traversal',f=>{f.result.captures[0].file='../fault.json';}],
 ['changed captured bytes',f=>{fs.appendFileSync(path.join(f.root,'fault.json'),'changed');}],
 ['unremoved resource',f=>{f.result.resources.destroyed=[];}],
 ['unknown remaining resource',f=>{f.result.resources.remaining=[{type:'disk',id:'fixture-disk'}];}],
 ['cleanup assertion without ledger',f=>{delete f.result.resources;}],
 ['reparse ancestor',f=>{const target=f.root+'-target';fs.renameSync(f.root,target);roots.push(target);fs.symlinkSync(target,f.root,'junction');}],
 ['hardlinked capture',f=>{fs.linkSync(path.join(f.root,'fault.json'),path.join(f.root,'alias.json'));}]
])test('rejects '+name,()=>{const f=fixture();mutate(f);f.save();assert.throws(()=>verifyCase(f.root,f.request,f.spec));});
test('requires a separately selected enrollment digest before reading executable inputs',()=>{
 const f=fixture(),file=path.join(f.root,'enrollment.json');fs.writeFileSync(file,JSON.stringify({schema:1}));
 assert.throws(()=>loadEnrollment(file,'0'.repeat(64)),/ENROLLMENT_DIGEST/);
});

test('verifies every plan case from captures and rejects a missing cleanup or summary-only success',()=>{
 const f=fixture(),plan=JSON.parse(fs.readFileSync(new URL('./plan.json',import.meta.url))),run={schema:1,enrollmentSha256:'d'.repeat(64),sourceRevision:f.request.sourceRevision,planSha256:'e'.repeat(64),nonce:'f'.repeat(64)};
 const enrollment={sourceRevision:run.sourceRevision,planSha256:run.planSha256,identity:f.request.identity,inputs:{candidateSha256:'1'.repeat(64)}};
 fs.writeFileSync(path.join(f.root,'run.json'),JSON.stringify(run));
 for(const spec of plan.cases){
  const root=path.join(f.root,spec.id);fs.mkdirSync(root);
  const request={schema:1,caseId:spec.id,runNonce:run.nonce,nonce:'2'.repeat(64),sourceRevision:run.sourceRevision,identity:enrollment.identity,inputs:enrollment.inputs};
  const captures=spec.captures.map(kind=>{const file=kind+'.json',bytes=JSON.stringify({measured:kind});fs.writeFileSync(path.join(root,file),bytes);return {kind,file,sha256:hash(bytes)};});
  fs.writeFileSync(path.join(root,'request.json'),JSON.stringify(request));
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({...request,status:'PASS',observed:spec.expect,captures,resources:{created:[],destroyed:[],remaining:[]}}));
 }
 assert.equal(verifyRun(f.root,enrollment,run.enrollmentSha256).cases.length,21);
 fs.writeFileSync(path.join(f.root,'summary.json'),JSON.stringify({status:'PASS'}));
 fs.unlinkSync(path.join(f.root,'cleanup','result.json'));
 assert.throws(()=>verifyRun(f.root,enrollment,run.enrollmentSha256));
});
function enrolledFixture(){
 const f=fixture(),file=path.join(f.root,'enrollment.json'),collector=path.join(f.root,'collector.exe'),tag=path.join(f.root,'tag.json');
 fs.writeFileSync(collector,'neutral collector fixture, never executed');fs.writeFileSync(tag,'neutral tagged-box fixture');
 const value={schema:1,sourceRevision:f.request.sourceRevision,planSha256:hash(fs.readFileSync(new URL('./plan.json',import.meta.url))),checkout:f.root,systemRoot:f.root,
  collector:{file:collector,sha256:hash(fs.readFileSync(collector))},machineTag:{file:tag,sha256:hash(fs.readFileSync(tag))},
  identity:{repositoryId:'1',workflowSha:'a'.repeat(40),sourceRevision:f.request.sourceRevision,version:'1.0.19',target:'win32-x64',runId:'1',runAttempt:'1'},
  inputs:{assetsDir:f.root,signingOutputDir:f.root,candidateFile:path.join(f.root,'candidate.json'),candidateSha256:'1'.repeat(64),evidenceFile:path.join(f.root,'evidence.json'),evidenceSha256:'2'.repeat(64),publicationRunId:'2',publicationRunAttempt:'1'}};
 const save=()=>{fs.writeFileSync(file,JSON.stringify(value));return hash(fs.readFileSync(file));};
 return {...f,file,collector,tag,value,save};
}
test('accepts separately pinned MAIN enrollment without executing any Windows code',()=>{const f=enrolledFixture();assert.deepEqual(loadEnrollment(f.file,f.save()),f.value);});
for(const [name,mutate]of [
 ['changed collector',f=>{fs.appendFileSync(f.collector,'changed');}],
 ['wrong existing box tag',f=>{fs.appendFileSync(f.tag,'changed');}],
 ['changed plan pin',f=>{f.value.planSha256='0'.repeat(64);}],
 ['relative candidate path',f=>{f.value.inputs.candidateFile='candidate.json';}],
 ['incomplete build identity',f=>{delete f.value.identity.runAttempt;}],
 ['unapproved version',f=>{f.value.identity.version='1.0.20';}]
])test('rejects enrollment with '+name,()=>{const f=enrolledFixture();mutate(f);assert.throws(()=>loadEnrollment(f.file,f.save()));});

for(const name of ['CI','GITHUB_ACTIONS','GITHUB_RUN_ID','GITHUB_WORKFLOW','GITHUB_JOB','RUNNER_ENVIRONMENT','TF_BUILD','BUILD_BUILDID'])
 test('refuses witness run and cleanup before reading enrollment in '+name,()=>{
  const previous=process.env[name];process.env[name]='false';
  try{for(const mode of ['run','cleanup'])assert.throws(()=>main([mode,path.resolve('absent-enrollment.json'),'0'.repeat(64),path.resolve('absent-output')]),/WITNESS_IN_CI/);}
  finally{if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
 });
