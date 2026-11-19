// Pack/validation producer owner: win-sac-sign; sealed collector, enrollment and Windows execution owner: MAIN.
import fs from 'node:fs';
import { WINDOWS_SIGNING_RELEASE_VERSION } from '../windows-signing-authority.mjs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const fail=code=>{throw Error(`WINDOWS_WITNESS_${code}`);};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>isDeepStrictEqual(a,b);
const directory=path.dirname(fileURLToPath(import.meta.url));
function regular(file,maxBytes=128*1024**2){
 if(!path.isAbsolute(file))fail('ABSOLUTE_PATH_REQUIRED');
 for(let current=file;;current=path.dirname(current)){
  const stat=fs.lstatSync(current);
  if(stat.isSymbolicLink()||(current===file?(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes):!stat.isDirectory()))fail('REGULAR_FILE_REQUIRED');
  if(current===path.dirname(current))break;
 }
 return fs.readFileSync(file);
}
function pinned(file,sha256){const bytes=regular(file);if(!digest(sha256)||hash(bytes)!==sha256)fail('PIN_MISMATCH');return bytes;}
const json=file=>JSON.parse(regular(file,8*1024**2));
function outside(root,file){const relative=path.relative(root,file);return relative==='..'||relative.startsWith('..'+path.sep);}
export function loadEnrollment(file,sha256){
 const bytes=regular(file,1024**2);
 if(!digest(sha256)||hash(bytes)!==sha256)fail('ENROLLMENT_DIGEST');
 const value=JSON.parse(bytes);
 if(value.schema!==1||!/^[a-f0-9]{40}$/.test(value.sourceRevision??'')||!digest(value.planSha256)
  ||!value.inputs||!value.identity||value.identity.sourceRevision!==value.sourceRevision)fail('ENROLLMENT_REQUIRED');
 const identity=value.identity,inputs=value.inputs;
 if(!/^[1-9][0-9]*$/.test(identity.repositoryId??'')||!/^[a-f0-9]{40}$/.test(identity.workflowSha??'')
  ||identity.version!==WINDOWS_SIGNING_RELEASE_VERSION||identity.target!=='win32-x64'
  ||['runId','runAttempt'].some(key=>!/^[1-9][0-9]*$/.test(identity[key]??''))
  ||['candidateSha256','evidenceSha256'].some(key=>!digest(inputs[key]))
  ||['publicationRunId','publicationRunAttempt'].some(key=>!/^[1-9][0-9]*$/.test(inputs[key]??''))
  ||['assetsDir','signingOutputDir','candidateFile','evidenceFile'].some(key=>!path.isAbsolute(inputs[key]??'')))fail('ENROLLMENT_REQUIRED');
 for(const name of ['checkout','systemRoot'])if(!path.isAbsolute(value[name]??'')||!fs.lstatSync(value[name]).isDirectory())fail('ENROLLMENT_PATH');
 for(const name of ['collector','machineTag'])if(!path.isAbsolute(value[name]?.file??'')||!digest(value[name]?.sha256))fail('ENROLLMENT_PATH');
 if(path.extname(value.collector.file).toLowerCase()!=='.exe')fail('NATIVE_COLLECTOR_REQUIRED');
 pinned(value.collector.file,value.collector.sha256);pinned(value.machineTag.file,value.machineTag.sha256);
 if(hash(regular(path.join(directory,'plan.json')))!==value.planSha256)fail('PLAN_DIGEST');
 return value;
}
function ledger(rows){
 if(!Array.isArray(rows))fail('RESOURCE_LEDGER_REQUIRED');
 const seen=new Set();
 for(const row of rows){
  if(typeof row?.type!=='string'||!row.type||typeof row.id!=='string'||!row.id)fail('RESOURCE_LEDGER_REQUIRED');
  const key=JSON.stringify([row.type,row.id]);if(seen.has(key))fail('DUPLICATE_RESOURCE');seen.add(key);
 }
 return [...seen].sort();
}
export function verifyCase(root,request,spec){
 const result=json(path.join(root,'result.json'));
 for(const key of ['schema','caseId','runNonce','nonce','sourceRevision','identity'])if(!same(result[key],request[key]))fail('CASE_BINDING');
 if(result.status!=='PASS'||result.caseId!==spec.id||!result.observed)fail('CASE_INCOMPLETE');
 for(const [key,value]of Object.entries(spec.expect))if(!same(result.observed[key],value))fail('OBSERVATION_MISMATCH');
 if(!Array.isArray(result.captures)||result.captures.length!==spec.captures.length)fail('CAPTURES_INCOMPLETE');
 const kinds=new Set(),files=new Set();
 for(const capture of result.captures){
  if(!spec.captures.includes(capture.kind)||kinds.has(capture.kind)||!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(capture.file??'')
   ||['request.json','result.json','collector.log'].includes(capture.file)||files.has(capture.file))fail('CAPTURE_INVALID');
  kinds.add(capture.kind);files.add(capture.file);
  const bytes=pinned(path.join(root,capture.file),capture.sha256);if(bytes.length===0)fail('CAPTURE_EMPTY');
 }
 const resources=result.resources;
 if(!resources||!same(ledger(resources.created),ledger(resources.destroyed))||ledger(resources.remaining).length)fail('CLEANUP_INCOMPLETE');
 return result;
}
function readRun(output,enrollment,sha256){
 const run=json(path.join(output,'run.json'));
 if(run.schema!==1||run.enrollmentSha256!==sha256||run.sourceRevision!==enrollment.sourceRevision
  ||run.planSha256!==enrollment.planSha256||!digest(run.nonce))fail('RUN_BINDING');
 return run;
}
export function verifyRun(output,enrollment,sha256){
 const run=readRun(output,enrollment,sha256),plan=json(path.join(directory,'plan.json'));
 const cases=plan.cases.map(spec=>{
  const root=path.join(output,spec.id),request=json(path.join(root,'request.json'));
  if(request.schema!==1||request.caseId!==spec.id||request.runNonce!==run.nonce||!digest(request.nonce)||request.sourceRevision!==run.sourceRevision
   ||!same(request.identity,enrollment.identity)||!same(request.inputs,enrollment.inputs))fail('RUN_BINDING');
  const result=verifyCase(root,request,spec);
  return {id:spec.id,resultSha256:hash(regular(path.join(root,'result.json'))),captures:result.captures};
 });
 return {schema:1,status:'PASS',release:'HOLD',sourceRevision:run.sourceRevision,enrollmentSha256:sha256,runNonce:run.nonce,cases};
}
function executeCase(output,enrollment,run,spec){
 const root=path.join(output,spec.id);fs.mkdirSync(root);
 const request={schema:1,caseId:spec.id,runNonce:run.nonce,nonce:randomBytes(32).toString('hex'),sourceRevision:run.sourceRevision,
  identity:enrollment.identity,inputs:enrollment.inputs};
 const requestFile=path.join(root,'request.json');fs.writeFileSync(requestFile,JSON.stringify(request,null,2)+'\n',{flag:'wx'});
 pinned(enrollment.collector.file,enrollment.collector.sha256);pinned(enrollment.machineTag.file,enrollment.machineTag.sha256);
 const child=spawnSync(enrollment.collector.file,['--witness-case',spec.id,'--request',requestFile,'--output',root],{
  cwd:path.dirname(enrollment.collector.file),shell:false,windowsHide:true,encoding:'utf8',timeout:20*60_000,maxBuffer:1024**2,
  env:{SystemRoot:enrollment.systemRoot,WINDIR:enrollment.systemRoot,
   PATH:[path.dirname(enrollment.collector.file),path.join(enrollment.systemRoot,'System32')].join(path.delimiter),TEMP:root,TMP:root}});
 fs.writeFileSync(path.join(root,'collector.log'),`${child.stdout??''}${child.stderr??''}`,{flag:'wx'});
 pinned(enrollment.collector.file,enrollment.collector.sha256);
 if(child.error||child.status!==0)fail('COLLECTOR_FAILED');
 return verifyCase(root,request,spec);
}
export function main(args){
 const [mode,file,sha256,rawOutput]=args;
 if(args.length!==4||!['run','verify','cleanup'].includes(mode)||!path.isAbsolute(file??'')||!path.isAbsolute(rawOutput??''))fail('USAGE');
 if(mode!=='verify'&&['CI','GITHUB_ACTIONS','GITHUB_RUN_ID','GITHUB_WORKFLOW','GITHUB_JOB','RUNNER_ENVIRONMENT','TF_BUILD','BUILD_BUILDID'].some(key=>Object.hasOwn(process.env,key)))fail('WITNESS_IN_CI');
 const enrollment=loadEnrollment(file,sha256),output=path.resolve(rawOutput),plan=json(path.join(directory,'plan.json'));
 // Resolve the existing parent so a junction cannot redirect captures into the checkout.
 if(fs.realpathSync(path.dirname(output))!==path.dirname(output)||!outside(fs.realpathSync(enrollment.checkout),output)
  ||!outside(enrollment.checkout,output)||!outside(output,enrollment.checkout))fail('EVIDENCE_OUTSIDE_CHECKOUT_REQUIRED');
 if(mode!=='verify'&&process.platform!=='win32')fail('EXISTING_WINDOWS_BOX_REQUIRED');
 if(mode==='verify')return verifyRun(output,enrollment,sha256);
 if(mode==='cleanup'){
  const run=readRun(output,enrollment,sha256),retry=path.join(output,'cleanup-retry-'+randomBytes(8).toString('hex'));fs.mkdirSync(retry);
  executeCase(retry,enrollment,run,plan.cases.at(-1));return {status:'CLEANUP_PASS',release:'HOLD'};
 }
 fs.mkdirSync(output);
 const run={schema:1,enrollmentSha256:sha256,sourceRevision:enrollment.sourceRevision,planSha256:enrollment.planSha256,nonce:randomBytes(32).toString('hex')};
 fs.writeFileSync(path.join(output,'run.json'),JSON.stringify(run,null,2)+'\n',{flag:'wx'});
 let failure;
 try{for(const spec of plan.cases.slice(0,-1)){executeCase(output,enrollment,run,spec);process.stdout.write(`PASS ${spec.id}\n`);}}
 catch(error){failure=error;}
 finally{try{executeCase(output,enrollment,run,plan.cases.at(-1));}catch(error){failure??=error;}}
 if(failure)throw failure;
 const result=verifyRun(output,enrollment,sha256);
 fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const result=main(process.argv.slice(2));process.stdout.write(`WINDOWS_WITNESS_${result.status} RELEASE_HOLD\n`);}
 catch(error){process.stderr.write(`${/^WINDOWS_WITNESS_[A-Z_]+$/.test(error.message)?error.message:'WINDOWS_WITNESS_FAILED'}\n`);process.exitCode=1;}
}
