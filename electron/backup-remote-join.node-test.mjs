import assert from "node:assert/strict";
import test from "node:test";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {BackupCoordinator} from "../dist-server/backup-coordinator.js";
import {BackupRestic} from "../dist-server/backup-restic.js";
import {createBackupRemoteHost} from "../dist-server/backup-remote-host.js";
import {createBackupScheduleHost} from "./backup-schedule-host.mjs";
import {createRemotePasswordStore} from "./backup-remote-password.mjs";
import {remoteWorkDirectory} from "./backup-remote-runtime.mjs";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
async function fixture(t,uncertain=false){
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-join-test-")));let schedule;t.after(()=>{schedule?.stopPolling();safeWipeSync(root);});
 const installation=path.join(root,"installation"),destination=path.join(root,"archives"),control=path.join(root,".murage-backup-control","installation"),ageKey=path.join(root,"age-key.txt"),passwordFile=path.join(root,"repository-password.txt");
 mkdirSync(installation,{mode:0o700});mkdirSync(destination,{mode:0o700});writeFileSync(path.join(installation,"sentinel.txt"),"original fixture data");
 writeFileSync(ageKey,"# public key: age1"+"q".repeat(58)+"\nAGE-SECRET-KEY-1"+"A".repeat(60)+"\n",{mode:0o600});writeFileSync(passwordFile,"FAKE_REPOSITORY_PASSWORD\n",{mode:0o600});
 let document={},clock=Date.parse("2026-09-13T08:59:00Z"),captures=0;
 const readProtected=async()=>structuredClone(document),updateProtected=async derive=>{document=derive(structuredClone(document));};
 const createSchedule=()=>createBackupScheduleHost({coordinator:new BackupCoordinator({stateDirectory:control,now:()=>clock}),installation:()=>installation,now:()=>clock,supported:()=>true,
  readProtected:async key=>document[key],writeProtected:async(key,value)=>{document={...document,[key]:value};},chooseDestination:async()=>destination,chooseKey:async()=>ageKey,confirmReferences:async()=>true,
  prepare:async()=>async()=>{},cleanupIdle:async()=>{},relaunch:async()=>{},
  capture:async request=>{captures++;await request.readIdentity();const bytes=Buffer.from("synthetic ciphertext fixture, not an encryption proof");writeFileSync(request.output,bytes,{flag:"wx",mode:0o600});return{ok:true,operation:"backup-encrypted",path:request.output,sha256:digest(bytes),snapshotId:randomUUID(),coverage:{scope:"application-data",fullInstallation:false}};},
 });
 schedule=createSchedule();const selected=await schedule.selectReferences();
 await schedule.configure(0,{enabled:true,preUpgrade:false,installationRef:selected.refs.installationRef,destinationRef:selected.refs.destinationRef,recoveryRef:selected.refs.recoveryRef,timezone:"UTC",time:"09:00",catchupMs:60000,maxBytes:1048576,maxDurationMs:10000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},allowIdleRestart:true});schedule.stopPolling();
 for(let i=0;i<100&&schedule.isPreparing();i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(schedule.isPreparing(),false);
 clock=Date.parse("2026-09-13T09:00:30Z");await schedule.tick();assert.equal(schedule.internalStatus().phase,"handoff-armed");schedule=createSchedule();await schedule.resumeOffline();schedule.completeReturn();
 const local=await schedule.latestVerifiedArtifact(),snapshotId="d".repeat(64),repositoryId="e".repeat(64),calls=[];
 const runner=async request=>{
  assert.equal(Buffer.from(request.password).toString(),"FAKE_REPOSITORY_PASSWORD");assert.equal(request.s3.credentials.secretAccessKey,"FAKE_S3_SECRET");assert.equal(request.args.some(arg=>arg.includes("FAKE_")),false);
  const args=request.args,operation=["cat","backup","snapshots","restore"].find(op=>args.includes(op));calls.push(operation);
  if(operation==="cat")return{code:0,stdout:JSON.stringify({version:2,id:repositoryId})};
  if(operation==="backup")return uncertain?{code:null,stdout:"",uncertain:true}:{code:0,stdout:JSON.stringify({message_type:"summary",snapshot_id:snapshotId})};
  if(operation==="snapshots")return{code:0,stdout:JSON.stringify([{id:snapshotId,tags:[`murage-job:${local.receipt.jobId}`],paths:[path.join(request.cwd,"backup.age"),path.join(request.cwd,"receipt.json")]}])};
  if(operation==="restore"){const output=args[args.indexOf("--target")+1];for(const name of ["backup.age","receipt.json"])copyFileSync(path.join(request.cwd,name),path.join(output,name));return{code:0,stdout:""};}
  assert.fail("unexpected Restic operation");
 };
 const createRemote=()=>{
  const passwords=createRemotePasswordStore({chooseFile:async()=>passwordFile,excludedRoots:()=>[installation,control],readProtected,updateProtected});
  return createBackupRemoteHost({supported:()=>true,readProtected,updateProtected,selectPassword:()=>passwords.select(),latestVerified:()=>schedule.latestVerifiedArtifact(),latestReceipt:()=>schedule.internalStatus().lastVerified,
   createAdapter:binding=>new BackupRestic({executable:"/never-run-fixture",repository:binding.target,workDirectory:remoteWorkDirectory(control,binding.target.remoteRef,binding.target.revision),password:()=>passwords.read(binding.passwordRef),credentials:async()=>binding.credentials,runner}),
  });
 };
 const remote=createRemote();await remote.save(0,{label:"Fixture storage",endpoint:"https://storage.example.invalid",bucket:"fixture-bucket",prefix:"fixture",region:"auto",bucketLookup:"path",credentials:{accessKeyId:"FAKE_S3_ACCESS",secretAccessKey:"FAKE_S3_SECRET"}});assert.deepEqual(calls,[]);
 const ref=(await remote.status()).remoteRef;await remote.selectRepositoryPassword(ref,1);assert.deepEqual(calls,[]);await remote.connect(ref,2);assert.deepEqual(calls,["cat"]);
 return{root,installation,local,ref,remote,createRemote,calls,captures:()=>captures};
}
test("built remote host joins verified schedule artifact, protected password and adapter readback",async t=>{
 const f=await fixture(t);await assert.rejects(f.remote.uploadLatest(f.ref,2,"0".repeat(64)),/JOB_CHANGED/);assert.deepEqual(f.calls,["cat"]);
 const result=await f.remote.uploadLatest(f.ref,2,f.local.receipt.jobId);assert.equal(result.state,"verified");assert.deepEqual(f.calls,["cat","cat","backup","snapshots","restore","cat"]);
 const resumed=f.createRemote();const count=f.calls.length;assert.equal((await resumed.status()).lastUpload.state,"verified");assert.equal(f.calls.length,count);assert.equal((await resumed.uploadLatest(f.ref,2,f.local.receipt.jobId)).state,"verified");assert.equal(f.calls.filter(op=>op==="backup").length,1);
 assert.equal(f.captures(),1);assert.equal(digest(readFileSync(f.local.archivePath)),f.local.receipt.sha256);assert.equal(readFileSync(path.join(f.installation,"sentinel.txt"),"utf8"),"original fixture data");
});
test("joined unknown upload is retained across host reconstruction without another upload",async t=>{
 const f=await fixture(t,true);assert.equal((await f.remote.uploadLatest(f.ref,2,f.local.receipt.jobId)).state,"needs-review");assert.equal((await f.createRemote().uploadLatest(f.ref,2,f.local.receipt.jobId)).state,"needs-review");assert.equal(f.calls.filter(op=>op==="backup").length,1);assert.equal(f.captures(),1);assert.equal(digest(readFileSync(f.local.archivePath)),f.local.receipt.sha256);
 const count=f.calls.length;assert.equal((await f.createRemote().status()).lastUpload.state,"needs-review");assert.equal(f.calls.length,count);
 assert.equal((await f.createRemote().reconcileLatest(f.ref,2,f.local.receipt.jobId)).state,"verified");assert.equal(f.calls.filter(op=>op==="backup").length,1);assert.equal((await f.createRemote().status()).lastUpload.state,"verified");
});
test("built automatic policy survives reconstruction without uploading the historical verified backup",async t=>{
 const f=await fixture(t);const before=[...f.calls];
 assert.equal((await f.remote.runAutomaticUpload()).state,"disabled");
 await f.remote.setAutomaticUpload(f.ref,2,true);
 const resumed=f.createRemote();assert.equal((await resumed.status()).automaticUpload.state,"enabled");
 assert.equal((await resumed.runAutomaticUpload()).state,"not-due");
 assert.deepEqual(f.calls,before);assert.equal(f.captures(),1);
 await resumed.setAutomaticUpload(f.ref,2,false);
 assert.equal((await f.createRemote().runAutomaticUpload()).state,"disabled");assert.deepEqual(f.calls,before);
 assert.equal(digest(readFileSync(f.local.archivePath)),f.local.receipt.sha256);
});
