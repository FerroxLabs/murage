import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,linkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {stripTypeScriptTypes} from 'node:module';
import {normalizedAgePayloadHash,AGE_PAYLOAD_SHA256,signedAgeOwnedByCurrentApp,trustedBackupAgeExecutable,normalizeBackupAgeDiagnostic} from './backup-age-attestation.mjs';
import {runInstallationRecoveryWorker} from './installation-recovery-runner.mjs';
import {createServerChildLifecycle} from './server-child-lifecycle.mjs';
import {captureFailureDiagnostic} from './backup-schedule-host.mjs';
import {backupAgePinForTarget} from '../shared/backup-age-pins.mjs';
const diagnostic=(operation='encrypt',predicate='app-verify')=>({operation,predicate,exitCode:null,timedOut:true,signal:'SIGTERM',errorCode:'ETIMEDOUT',elapsedMs:10001});
const bytes=readFileSync(process.env.MURAGE_BACKUP_TEST_AGE_FILE??new URL('../dist-native/backup-age/arm64/age',import.meta.url));
function fixture(work){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'murage-age-diagnostic-'))),app=path.join(root,'Murage.app'),file=path.join(app,'Contents/Resources/backup-tools/arm64/age'),exe=path.join(app,'Contents/MacOS/Murage');mkdirSync(path.dirname(file),{recursive:true});mkdirSync(path.dirname(exe),{recursive:true});writeFileSync(file,bytes);writeFileSync(exe,'test executable, never run');
 try{return work({root,app,file,exe});}finally{rmSync(root,{recursive:true,force:true});}
}
const good=()=>({status:0,stderr:'TeamIdentifier=ABCDEFGHIJ\n',attestationElapsedMs:3});
test('read and close errors retain the exact failed predicate without changing refusal',()=>{
 const source=readFileSync(new URL('./backup-age-attestation.mjs',import.meta.url),'utf8');
 const start=source.indexOf('export function trustedBackupAgeExecutable('),end=source.indexOf('\n/** Cheap identity only:',start);
 const body=source.slice(start,end).replace('export ','');
 for(const closeFails of [false,true]){
  let observed,closed=0;
  const error=()=>Object.assign(Error('PRIVATE'),{code:'EIO'}),stat={isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:1,dev:1,ino:2};
  const run=new Function('backupAgePinForTarget','lstatSync','openSync','fstatSync','readFileSync','closeSync','constants','process','ageFailure',body+';return trustedBackupAgeExecutable;')(
   ()=>({}),()=>stat,()=>42,()=>stat,()=>{throw error();},()=>{closed++;if(closeFails)throw error();},{O_RDONLY:0,O_NOFOLLOW:1},{platform:'darwin',arch:'arm64'},(_report,predicate,result)=>{observed={predicate,errorCode:result.error.code};return false;});
  assert.equal(run('/private'),false);assert.equal(closed,1);assert.deepEqual(observed,{predicate:closeFails?'file-close':'file-read',errorCode:'EIO'});
 }
});
test('controlled signing failure reports each predicate and preserves exact command policy',()=>fixture(({app,file,exe})=>{
 assert.equal(normalizedAgePayloadHash(bytes),AGE_PAYLOAD_SHA256,'Actual pinned payload fixture required');
 const calls=[],facts=[];assert.equal(signedAgeOwnedByCurrentApp(file,bytes,{currentExecutable:exe,run:args=>{calls.push(args);return good();},report:v=>facts.push(v)}),true);assert.deepEqual(facts,[]);
 assert.deepEqual(calls,[['--verify','--strict','-R','=anchor apple generic',app],['--display','--verbose=4',app],['--display','--verbose=4',file],['--verify','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "ABCDEFGHIJ"',file]]);
 for(const [index,predicate] of [[0,'app-verify'],[1,'app-info'],[2,'tool-info'],[3,'tool-verify']]){let at=0;const observed=[];assert.equal(signedAgeOwnedByCurrentApp(file,bytes,{currentExecutable:exe,run:()=>at++===index?{status:null,error:{code:'ETIMEDOUT',message:'PRIVATE-PATH'},signal:'SIGTERM',stderr:'PRIVATE-KEY',attestationElapsedMs:10001}:good(),report:v=>observed.push(v)}),false);assert.deepEqual(normalizeBackupAgeDiagnostic({...observed[0],operation:'encrypt'}),diagnostic('encrypt',predicate));assert(!JSON.stringify(observed).includes('PRIVATE'));}
 for(const [index,predicate] of [[1,'app-team'],[2,'tool-team']]){let at=0,last;assert.equal(signedAgeOwnedByCurrentApp(file,bytes,{currentExecutable:exe,run:()=>at++===index?{status:0,stderr:index===1?'no team':'TeamIdentifier=OTHERTEAM1\n'}:good(),report:v=>{last=v;}}),false);assert.equal(last.predicate,predicate);}
 let last;assert.equal(signedAgeOwnedByCurrentApp(file,bytes,{currentExecutable:process.execPath,run:()=>assert.fail('must refuse before codesign'),report:v=>{last=v;}}),false);assert.equal(last.predicate,'executable-binding');
 const corrupt=Buffer.from(bytes);corrupt[4096]^=1;assert.equal(signedAgeOwnedByCurrentApp(file,corrupt,{currentExecutable:exe,run:()=>assert.fail('must refuse payload'),report:v=>{last=v;}}),false);assert.equal(last.predicate,'payload');
 assert.equal(signedAgeOwnedByCurrentApp(file,bytes,{currentExecutable:exe,run:()=>({status:1}),report:()=>{throw Error('diagnostic failed');}}),false);
}));
test('unsafe/missing file refusals retain booleans and never invoke a tool',()=>fixture(({root})=>{
 let last;const report=v=>{last=v;};
 // Hosts without a pinned age build (Windows) refuse before touching the file.
 if(!backupAgePinForTarget(process.platform,process.arch)){for(const file of [path.join(root,'absent'),root]){assert.equal(trustedBackupAgeExecutable(file,{report}),false);assert.equal(last.predicate,'platform-pin');}return;}assert.equal(trustedBackupAgeExecutable(path.join(root,'absent'),{report}),false);assert.equal(last.predicate,'file-stat');assert.equal(last.errorCode,'ENOENT');
 assert.equal(trustedBackupAgeExecutable(root,{report}),false);assert.equal(last.predicate,'file-type');
 const bad=path.join(root,'bad');writeFileSync(bad,'not a binary');linkSync(bad,path.join(root,'hardlink'));assert.equal(trustedBackupAgeExecutable(bad,{report}),false);assert.equal(last.predicate,'file-links');
 symlinkSync(bad,path.join(root,'symbolic'));assert.equal(trustedBackupAgeExecutable(path.join(root,'symbolic'),{report}),false);assert.equal(last.predicate,'file-type');
}));
test('strict diagnostic schema drops raw fields, unknown values and hostile getters',()=>{
 assert.deepEqual(normalizeBackupAgeDiagnostic(diagnostic()),diagnostic());
 for(const bad of [{...diagnostic(),stderr:'SECRET'},{...diagnostic(),operation:'PRIVATE'},{...diagnostic(),predicate:'/private/path'},{...diagnostic(),exitCode:999999},{...diagnostic(),signal:'SECRET'},{...diagnostic(),errorCode:'SECRET'},{...diagnostic(),elapsedMs:-1}])assert.equal(normalizeBackupAgeDiagnostic(bad),null);
 assert.equal(normalizeBackupAgeDiagnostic({...diagnostic(),get predicate(){throw Error('secret');}}),null);
});
test('actual encryption assertion binds encrypt versus decrypt without changing public refusal',()=>{
 const source=readFileSync(new URL('../server/installation-backup-encryption.ts',import.meta.url),'utf8'),start=source.indexOf('export function assertBackupAgeTool('),end=source.indexOf('\n/** Private host policy:',start);
 const body=stripTypeScriptTypes(source.slice(start,end).replace('export ',''));class SnapshotError extends Error{constructor(code){super(code);this.code=code;}}
 const run=new Function('backupAgePinForTarget','trustedBackupAgeExecutable','normalizeBackupAgeDiagnostic','InstallationSnapshotError','process','fail',body+';return assertBackupAgeTool;')(()=>({}),(_file,{report})=>{const {operation,...facts}=diagnostic();report(facts);return false;},normalizeBackupAgeDiagnostic,SnapshotError,{platform:'darwin',arch:'arm64'},code=>{throw new SnapshotError(code);});
 for(const operation of ['encrypt','decrypt'])assert.throws(()=>run('/not-logged',operation),e=>e.code==='AGE_TOOL_UNVERIFIED'&&e.backupAgeAttestation.operation===operation);
 assert(source.includes('else assertBackupAgeTool(executable,"encrypt")'));assert(source.includes('assertBackupAgeTool(executable,"decrypt")'));
});
test('actual worker catch emits only validated finite attestation on matching errors',()=>{
 const source=readFileSync(new URL('../scripts/installation-recovery-worker.ts',import.meta.url),'utf8').replace(/\r\n/g,'\n'),start=source.indexOf('} catch (error) {')+'} catch (error) {'.length,end=source.indexOf('\n}\nif (parentPort)',start);
 const run=new Function('error','normalizeBackupAgeDiagnostic','process','let reply,exitCode;'+source.slice(start,end)+';return {reply,exitCode};');
 const goodError={code:'AGE_TOOL_UNVERIFIED',backupAgeAttestation:diagnostic(),message:'SECRET',stack:'SECRET'};assert.deepEqual(run(goodError,normalizeBackupAgeDiagnostic,{platform:'darwin'}),{reply:{ok:false,error:'AGE_TOOL_UNVERIFIED',backupAgeAttestation:diagnostic()},exitCode:1});
 for(const error of [{code:'OTHER',backupAgeAttestation:diagnostic()},{code:'AGE_TOOL_UNVERIFIED',backupAgeAttestation:{...diagnostic(),stderr:'SECRET'}},{code:'AGE_TOOL_UNVERIFIED',get backupAgeAttestation(){throw Error('SECRET');}}]){const result=run(error,normalizeBackupAgeDiagnostic,{platform:'darwin'});assert.equal(result.reply.backupAgeAttestation,undefined);assert.equal(result.exitCode,1);assert(!JSON.stringify(result).includes('SECRET'));}
});
test('private result transport retains safe details through actual child exit and capture logging',async()=>{
 for(const operation of ['encrypt','decrypt']){
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill(){},postMessage(){}});
  const pending=runInstallationRecoveryWorker({fork:()=>child,entry:'fixture',args:['backup-encrypted'],env:{},track:createServerChildLifecycle,timeoutMs:1000});
  let settled=false;const outcome=pending.catch(error=>{settled=true;return error;});
  child.emit('message',{type:'murage:recovery-result',nonce:'12345678-1234-1234-1234-123456789abc',result:{ok:false,error:'AGE_TOOL_UNVERIFIED',backupAgeAttestation:diagnostic(operation)}});
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);child.emit('exit',1);const error=await outcome;
  assert.equal(error.code,'AGE_TOOL_UNVERIFIED');assert.deepEqual(captureFailureDiagnostic('capture',error),{stage:'capture',code:'AGE_TOOL_UNVERIFIED',backupAgeAttestation:diagnostic(operation)});child.stdout.destroy();child.stderr.destroy();
 }
 assert.deepEqual(captureFailureDiagnostic('capture',{code:'AGE_TOOL_UNVERIFIED',backupAgeAttestation:{...diagnostic(),path:'SECRET'}}),{stage:'capture',code:'AGE_TOOL_UNVERIFIED'});
 assert.deepEqual(captureFailureDiagnostic('capture',{code:'BACKUP_UNAVAILABLE',backupAgeAttestation:diagnostic()}),{stage:'capture',code:'BACKUP_UNAVAILABLE'});
});
