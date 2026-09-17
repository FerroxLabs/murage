import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { BackupCoordinator } from "../server/backup-coordinator.ts";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { createBackupScheduleHost } from "./backup-schedule-host.mjs";
import { backupFixture,testAgeKeys } from "../server/testing/backup-fixture.ts";
import { canonicalUpdateDescriptor } from "../shared/update-candidate.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { prepareBackedUpInstall, resumeBackedUpInstall } from "./preupgrade-continuation.mjs";
const digest=value=>createHash("sha256").update(value).digest("hex");
const fakeKey="# public key: age1"+"q".repeat(58)+"\nAGE-SECRET-KEY-1"+"A".repeat(60)+"\n";
const choices={enabled:true,timezone:"UTC",time:"09:00",catchupMs:86400000,maxBytes:100000000,maxDurationMs:60000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},preUpgrade:false};
function updateCandidate(version="9.0.0"){
  const sha512=Buffer.alloc(64,1).toString("base64"),candidate={schemaVersion:1,candidateId:"update-"+"0".repeat(64),version,platform:"darwin",arch:"arm64",artifacts:[{kind:"primary",sha512}],manifestDigests:[sha512]};
  return {...candidate,candidateId:"update-"+digest(canonicalUpdateDescriptor(candidate))};
}
function fixture(overrides={}){
  const root=mkdtempSync(path.join(tmpdir(),"murage-schedule-host-")),installation=path.join(root,"installation"),destination=path.join(root,"archives"),keyFile=path.join(root,"independent-key.txt");
  mkdirSync(installation);mkdirSync(destination);writeFileSync(keyFile,fakeKey,{mode:0o600});
  let now=Date.parse("2026-09-13T08:00:00Z"),binding;
  const calls=[];const coordinator=()=>new BackupCoordinator({stateDirectory:path.join(root,"control"),now:()=>now});
  const host={coordinator:coordinator(),installation:()=>installation,now:()=>now,supported:()=>true,readProtected:async()=>binding,writeProtected:async(_key,value)=>{binding=value;},chooseDestination:async()=>destination,chooseKey:async()=>keyFile,confirmReferences:async()=>true,
    assertUpgradeAllowed:async()=>{},assertClosedAllowed:async()=>{},prepare:async()=>{calls.push("prepare");return async()=>calls.push("release");},cleanupIdle:async()=>calls.push("cleanup"),relaunch:async mode=>calls.push(mode),
    capture:async request=>{calls.push("capture");const identity=await request.readIdentity();assert.equal(identity===fakeKey,true);const bytes=Buffer.from("fictional immutable encrypted artifact");writeFileSync(request.output,bytes,{flag:"wx",mode:0o600});return{ok:true,operation:"backup-encrypted",path:request.output,sha256:digest(bytes),snapshotId:randomUUID(),coverage:{scope:"application-data",fullInstallation:false,credentialPolicy:"preserve-in-encrypted-fidelity"}};},...overrides};
  const create=(extra={})=>createBackupScheduleHost({...host,coordinator:coordinator(),...extra});const controller=create();
  return{root,installation,destination,keyFile,calls,host,controller,coordinator,create,setNow:value=>{now=value;},rotate:()=>{binding=JSON.stringify({...JSON.parse(binding),recipient:"changed"});},
    async enable(preUpgrade=false,closedApp=false){const status=await controller.selectReferences();await controller.configure(0,{...choices,preUpgrade,closedApp,...Object.fromEntries(["installationRef","destinationRef","recoveryRef"].map(key=>[key,status.refs[key]])),allowIdleRestart:true,allowClosedApp:closedApp});controller.stopPolling();for(let attempt=0;attempt<100&&controller.isPreparing();attempt++)await new Promise(resolve=>setImmediate(resolve));assert.equal(controller.isPreparing(),false,"initial tick must settle before fake-clock advance");},
    async arm(){await this.enable();now=Date.parse("2026-09-13T09:01:00Z");await controller.tick();},
    cleanup(){controller.stopPolling();rmSync(root,{recursive:true,force:true});}};
}
test("disabled selection never enables, exposes only labels/refs, and needs explicit consent",async()=>{
  const f=fixture();try{await f.controller.tick();assert.deepEqual(f.calls,[]);const s=await f.controller.selectReferences();assert.equal(s.enabled,false);const encoded=JSON.stringify(s);assert.equal(encoded.includes(f.root),false);assert.equal(encoded.includes("AGE-SECRET"),false);assert.equal(encoded.includes("age1"),false);
    await assert.rejects(f.controller.configure(0,{...choices,...s.refs}),/CONSENT/);assert.equal(f.coordinator().status().enabled,false);
  }finally{f.cleanup();}
});
test("two owners complete armed restart, verified receipt then normal return without replay",async()=>{
  const f=fixture();try{await f.arm();assert.equal(f.coordinator().status().phase,"handoff-armed");assert.deepEqual(f.calls,["prepare","cleanup","backup"]);const next=f.create();await next.resumeOffline();assert.equal(f.coordinator().status().phase,"return-pending");assert.deepEqual(f.calls,["prepare","cleanup","backup","capture","normal"]);const last=f.create();last.completeReturn();await last.tick();assert.equal(f.coordinator().status().phase,"returned");assert.equal(f.calls.filter(x=>x==="capture").length,1);assert.equal(f.coordinator().status().lastVerified.destinationRef,(await last.status()).refs.destinationRef);
  }finally{f.cleanup();}
});
test("busy admission never closes work; failed cleanup releases only its prepared claim",async()=>{
  for(const phase of ["busy","cleanup"]){const f=fixture(phase==="busy"?{prepare:async()=>{throw Error("BACKUP_WORK_ACTIVE");}}:{cleanupIdle:async()=>{throw Error("cleanup unconfirmed");}});try{await f.arm();assert.equal(f.calls.includes("backup"),false);assert.equal(f.calls.includes("capture"),false);assert.equal(f.calls.includes("release"),phase==="cleanup");assert.equal(f.coordinator().status().phase,phase==="busy"?"waiting-backup-mode":"needs-review");}finally{f.cleanup();}}
});
test("remote artifact resolver uses only current verified host receipt and never recaptures",async()=>{
  const f=fixture();try{
    assert.equal(await f.controller.latestVerifiedArtifact(),null);
    await f.arm();await assert.rejects(f.controller.latestVerifiedArtifact(),/BUSY/);
    const resumed=f.create();await resumed.resumeOffline();resumed.completeReturn();
    const selected=await resumed.latestVerifiedArtifact();assert.equal(selected.receipt.jobId,f.coordinator().status().lastVerified.jobId);
    assert.equal(selected.archivePath,path.join(realpathSync(f.destination),selected.receipt.jobId+".age"));
    // Uploading existing ciphertext does not need the private decryption key.
    writeFileSync(f.keyFile,"unavailable private key");assert.deepEqual(await resumed.latestVerifiedArtifact(),selected);
    assert.equal(f.calls.filter(call=>call==="capture").length,1);
    writeFileSync(selected.archivePath,"tampered");await assert.rejects(resumed.latestVerifiedArtifact(),/RECEIPT_MISMATCH/);
  }finally{f.cleanup();}
});
test("remote artifact resolver refuses a replaced destination even with copied ciphertext",async()=>{
  const f=fixture();try{
    await f.arm();const resumed=f.create();await resumed.resumeOffline();resumed.completeReturn();const selected=await resumed.latestVerifiedArtifact();
    renameSync(f.destination,f.destination+"-original");mkdirSync(f.destination);copyFileSync(path.join(f.destination+"-original",path.basename(selected.archivePath)),selected.archivePath);
    await assert.rejects(resumed.latestVerifiedArtifact(),/REFERENCE_CHANGED/);assert.equal(f.calls.filter(call=>call==="capture").length,1);
    assert.equal(digest(readFileSync(path.join(f.destination+"-original",path.basename(selected.archivePath)))),selected.receipt.sha256);
  }finally{f.cleanup();}
});
test("expired, rotated, unavailable and replaced key references refuse unattended capture",async()=>{
  for(const mode of ["expired","rotated","unavailable","key","destination"]){const f=fixture();try{await f.arm();if(mode==="expired")f.setNow(Date.parse("2026-09-13T10:00:00Z"));if(mode==="rotated")f.rotate();if(mode==="key")writeFileSync(f.keyFile,"changed");if(mode==="destination"){renameSync(f.destination,f.destination+"-original");mkdirSync(f.destination);}const next=f.create(mode==="unavailable"?{readProtected:async()=>{throw Error("locked");}}:{});await assert.rejects(next.resumeOffline(),/REVIEW_REQUIRED/);assert.equal(f.calls.includes("capture"),false);assert.equal(f.coordinator().status().phase,"needs-review");}finally{f.cleanup();}}
});
test("duplicate resume cannot replace an in-flight claim or cause a second capture",async()=>{
  const f=fixture();let finish,running;try{await f.arm();const first=f.create({capture:async request=>{await new Promise(resolve=>{finish=resolve;});return f.host.capture(request);}});running=first.resumeOffline();void running.catch(()=>{});for(let attempt=0;attempt<100&&!finish;attempt++)await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finish,"function","capture must begin before duplicate attempt");assert.equal(f.coordinator().status().phase,"capturing");await assert.rejects(f.create().resumeOffline());assert.equal(f.coordinator().status().phase,"capturing");finish();await running;assert.equal(f.calls.filter(x=>x==="capture").length,1);}finally{finish?.();await running?.catch(()=>{});f.cleanup();}
});
test("mismatched result and unknown crash are not replayed; failed verified return does not recapture",async()=>{
  for(const mode of ["mismatch","crash","return"]){const f=fixture();try{await f.arm();const next=f.create({capture:async request=>{if(mode==="crash")throw Error("unknown worker exit");const result=await f.host.capture(request);return mode==="mismatch"?{...result,sha256:"0".repeat(64)}:result;},relaunch:async()=>{throw Error("return failed");}});await assert.rejects(next.resumeOffline());assert.equal(f.coordinator().status().phase,mode==="return"?"return-pending":"needs-review");const restarted=f.create();if(mode==="return")restarted.completeReturn();await restarted.tick();assert.equal(f.calls.filter(x=>x==="capture").length,mode==="crash"?0:1);}finally{f.cleanup();}}
});
test("prepared and capturing crash states need review, never acquire new capture authority",async()=>{
  for(const phase of ["handoff-prepared","offline-claimed","capturing"]){const f=fixture();try{await f.arm();const file=path.join(f.root,"control","backup-coordinator.json"),saved=JSON.parse(readFileSync(file));saved.job.phase=phase;writeFileSync(file,JSON.stringify(saved));await f.create().tick();assert.equal(f.coordinator().status().phase,"needs-review");assert.equal(f.calls.includes("capture"),false);}finally{f.cleanup();}}
});
test("native references are serialized and cancellation does not persist or start work",async()=>{
  let resolve;const f=fixture({chooseDestination:()=>new Promise(done=>{resolve=done;})});try{const selecting=f.controller.selectReferences();await assert.rejects(f.controller.selectReferences(),/BUSY/);resolve(null);assert.deepEqual(await selecting,{cancelled:true});assert.equal((await f.controller.status()).refs,undefined);assert.deepEqual(f.calls,[]);}finally{f.cleanup();}
});
test("packaged coordinator exports the same default-disabled production host seam",async()=>{
  const module=await import(new URL("../dist-server/backup-coordinator.js",import.meta.url));const f=fixture();try{const coordinator=new module.BackupCoordinator({stateDirectory:path.join(f.root,"built-control")});const host=createBackupScheduleHost({...f.host,coordinator});assert.equal((await host.status()).enabled,false);await host.tick();assert.deepEqual(f.calls,[]);}finally{f.cleanup();}
});

test("pre-upgrade explicit request binds two-process receipt and persists install CAS before one invocation",async()=>{
  const f=fixture(),candidate=updateCandidate();try{
    await f.enable(true);const request=f.controller.requestUpgrade(candidate);assert.equal(f.controller.requestUpgrade(candidate),request);
    await assert.rejects(f.controller.requestUpgrade(updateCandidate("9.0.1")),/PENDING/);
    assert.equal((await request).status,"deferred");assert.equal(f.coordinator().status().phase,"handoff-armed");assert.deepEqual(f.calls,["prepare","cleanup","backup"]);
    await f.create().resumeOffline();const next=f.create();assert.equal(next.pendingUpgrade().candidate.candidateId,candidate.candidateId);assert.equal(f.coordinator().status().job.receipt.candidateId,candidate.candidateId);
    assert.throws(()=>next.completeReturn(),/UPGRADE_PENDING/);await assert.rejects(next.verifyUpgrade(updateCandidate("9.0.1")),/REJECTED/);
    assert.equal((await next.markUpgradeInstallRequested(candidate)).status,"continue");let installerCalls=0;assert.equal(f.coordinator().status().phase,"install-requested");installerCalls++;
    await assert.rejects(f.create().markUpgradeInstallRequested(candidate),/CHANGED/);assert.throws(()=>f.create().returnUpgradeToWorkspace(),/CHANGED/);
    await assert.rejects(f.create().completeUpgrade("8.0.0"),/VERSION_MISMATCH/);await f.create().completeUpgrade(candidate.version);
    assert.equal(f.coordinator().status().phase,"upgrade-complete");assert.equal(f.create().pendingUpgrade(),null);assert.equal(installerCalls,1);assert.equal(f.calls.filter(x=>x==="capture").length,1);
  }finally{f.cleanup();}
});
test("joined updater and backup hosts defer candidate A then verify receipt and CAS before cleanup and one install",async()=>{
  const f=fixture();let installs=0;const order=[];
  try{
    await f.enable(true);
    const file=path.join(realpathSync(f.root),"candidate-A.zip"),bytes=Buffer.from("bounded fake update candidate A");
    writeFileSync(file,bytes);
    const info={version:"9.0.0",files:[{url:"candidate-A.zip",sha512:createHash("sha512").update(bytes).digest("base64")}]};
    const createUpdater=()=>{
      const updater=new EventEmitter();
      updater.checkForUpdates=async()=>({isUpdateAvailable:true,updateInfo:info});
      updater.downloadUpdate=async()=>{
        // Model the pinned normal verifier's completed-download metadata, not
        // a fabricated candidate adapter or a pre-seeded restored process.
        updater.downloadedUpdateHelper={file,versionInfo:info,fileInfo:{info:info.files[0]}};
        updater.emit("update-downloaded",info);return[file];
      };
      updater.quitAndInstall=()=>{
        assert.equal(f.coordinator().status().phase,"install-requested");
        assert.equal(f.coordinator().status().job.receipt.candidateId,f.coordinator().status().job.handoff.upgrade.candidateId);
        order.push("install");installs++;
      };
      return updater;
    };
    const initial=createUpdaterCoordinator(createUpdater(),()=>{}, {beforeInstall:candidate=>prepareBackedUpInstall(candidate,{
      backup:f.controller,prepareNormal:async()=>assert.fail("deferred backup must not run normal install cleanup"),
    })});
    await initial.download();await initial.install();await initial.install();
    assert.equal(installs,0);assert.equal(f.coordinator().status().phase,"handoff-armed");
    const candidate=f.controller.pendingUpgrade().candidate;
    assert.equal(candidate.artifacts[0].sha512,info.files[0].sha512);
    await f.create().resumeOffline();assert.equal(installs,0);
    const returned=f.create();assert.equal(returned.pendingUpgrade().candidate.candidateId,candidate.candidateId);
    assert.equal(f.coordinator().status().job.receipt.candidateId,candidate.candidateId);
    const resumed=createUpdaterCoordinator(createUpdater(),()=>{});
    assert.deepEqual(await resumeBackedUpInstall({backup:returned,updater:resumed,currentVersion:"8.0.0",cleanup:async()=>{
      assert.equal(f.coordinator().status().phase,"install-requested");order.push("cleanup-after-cas");
    }}),{status:"install-requested"});
    assert.deepEqual(order,["cleanup-after-cas","install"]);assert.equal(installs,1);
    assert.equal(f.calls.filter(call=>call==="capture").length,1);
    await assert.rejects(resumeBackedUpInstall({backup:f.create(),updater:resumed,currentVersion:"8.0.0",cleanup:async()=>assert.fail("unknown install must not clean up again")}),/REVIEW_REQUIRED/);
    assert.equal(installs,1);
  }finally{f.cleanup();}
});
test("pre-upgrade disabled and non-opted flow continues without acquiring backup authority",async()=>{
  const f=fixture();try{assert.deepEqual(await f.controller.requestUpgrade(null),{status:"continue"});assert.deepEqual(await f.controller.requestUpgrade(updateCandidate()),{status:"continue"});await f.enable();assert.deepEqual(await f.controller.requestUpgrade(null),{status:"continue"});assert.deepEqual(await f.controller.requestUpgrade(updateCandidate()),{status:"continue"});assert.deepEqual(f.calls,[]);}finally{f.cleanup();}
  const g=fixture();try{await g.enable(true);assert.throws(()=>g.controller.requestUpgrade(null),/metadata is invalid/);assert.deepEqual(g.calls,[]);}finally{g.cleanup();}
});
test("pre-upgrade busy, profile and unrelated daily work refuse without cleanup",async()=>{
  for(const mode of ["busy","profile","daily"]){const f=fixture(mode==="busy"?{prepare:async()=>{throw Error("BACKUP_WORK_ACTIVE");}}:{});try{
    await f.enable(true);if(mode==="daily"){f.setNow(Date.parse("2026-09-13T09:01:00Z"));await f.coordinator().tick();assert.equal(f.coordinator().status().phase,"waiting-backup-mode");}
    const requester=mode==="profile"?f.create({assertUpgradeAllowed:async()=>{throw Error("CUSTOM_PROFILE");}}):f.controller;
    await assert.rejects(requester.requestUpgrade(updateCandidate()));assert.equal(f.calls.includes("cleanup"),false);assert.equal(f.calls.includes("backup"),false);
  }finally{f.cleanup();}}
});
test("pre-upgrade missing policy cannot be opted in and policy is rechecked on continuation",async()=>{
  const f=fixture({assertUpgradeAllowed:undefined});try{await assert.rejects(f.enable(true),/UNAVAILABLE/);}finally{f.cleanup();}
  const g=fixture();try{await g.enable(true);await g.controller.requestUpgrade(updateCandidate());await g.create().resumeOffline();await assert.rejects(g.create({assertUpgradeAllowed:async()=>{throw Error("CUSTOM_PROFILE");}}).markUpgradeInstallRequested(updateCandidate()),/CUSTOM_PROFILE/);assert.equal(g.coordinator().status().phase,"return-pending");}finally{g.cleanup();}
});
test("pre-upgrade expired, rotated, missing or mismatched receipt stays pending without installer authority",async()=>{
  for(const mode of ["expiry","binding","receipt","artifact","candidate","disabled"]){const f=fixture();try{
    await f.enable(true);await f.controller.requestUpgrade(updateCandidate());await f.create().resumeOffline();
    const file=path.join(f.root,"control","backup-coordinator.json"),state=JSON.parse(readFileSync(file));
    if(mode==="expiry")f.setNow(Date.parse("2026-09-13T09:00:00Z"));
    if(mode==="binding")f.rotate();
    if(mode==="receipt"){delete state.job.receipt;writeFileSync(file,JSON.stringify(state));}
    if(mode==="candidate"){state.job.receipt.candidateId=updateCandidate("9.0.1").candidateId;writeFileSync(file,JSON.stringify(state));}
    if(mode==="artifact")writeFileSync(path.join(f.destination,state.job.id+".age"),"replaced");
    if(mode==="disabled")f.coordinator().configure(state.revision,{...state.schedule,enabled:false});
    await assert.rejects(f.create().markUpgradeInstallRequested(updateCandidate()));assert.equal(f.coordinator().status().phase,"return-pending");
    await assert.rejects(f.create().requestUpgrade(updateCandidate()),/PENDING/);assert.equal(f.calls.filter(x=>x==="capture").length,1);
  }finally{f.cleanup();}}
});
test("pre-upgrade explicit return preserves receipt and a new owner request creates fresh capture identity",async()=>{
  const f=fixture();try{await f.enable(true);await f.controller.requestUpgrade(updateCandidate());await f.create().resumeOffline();const old=f.coordinator().status().job;
    f.create().returnUpgradeToWorkspace();assert.equal(f.coordinator().status().phase,"upgrade-cancelled");assert.deepEqual(f.coordinator().status().job.receipt,old.receipt);
    await f.create().requestUpgrade(updateCandidate());assert.notEqual(f.coordinator().status().job.id,old.id);await f.create().resumeOffline();assert.equal(f.calls.filter(x=>x==="capture").length,2);
  }finally{f.cleanup();}
});
test("pre-upgrade arm or relaunch failure never returns a deferred success",async()=>{
  const f=fixture({relaunch:async()=>{throw Error("RELAUNCH_FAILED");}});try{await f.enable(true);await assert.rejects(f.controller.requestUpgrade(updateCandidate()),/RELAUNCH_FAILED/);assert.equal(f.coordinator().status().phase,"needs-review");assert.equal(f.calls.includes("release"),true);}finally{f.cleanup();}
});
test("pre-upgrade safe capability flag fences opt-in while unsupported saved schedules can be disabled",async()=>{
  const f=fixture();try{assert.equal((await f.controller.status()).preUpgradeSupported,true);await f.enable(true);
    const unsupported=f.create({assertUpgradeAllowed:async()=>{throw Error("CUSTOM_PROFILE");}}),s=f.coordinator().status();
    assert.equal((await unsupported.status()).preUpgradeSupported,false);
    await assert.rejects(unsupported.configure(s.revision,{...s.schedule,allowIdleRestart:true}),/CUSTOM_PROFILE/);
    const disabled=await unsupported.configure(s.revision,{...s.schedule,enabled:false});unsupported.stopPolling();assert.equal(disabled.enabled,false);assert.equal(disabled.schedule.preUpgrade,true);assert.equal(disabled.preUpgradeSupported,false);
    assert.equal((await f.create({assertUpgradeAllowed:undefined}).status()).preUpgradeSupported,false);
  }finally{f.cleanup();}
});

test("closed due captures through actual control and receipt with owner proof and no live prepare or relaunch",async()=>{
  const f=fixture();try{
    await f.enable(false,true);f.setNow(Date.parse("2026-09-13T09:01:00Z"));let admitted=0;
    const closed=f.create({assertClosedStartup:async()=>{admitted++;},prepare:async()=>assert.fail("closed startup has no live HTTP idle path"),cleanupIdle:async()=>assert.fail("closed startup must retain its owner"),relaunch:async()=>assert.fail("closed capture must exit without normal relaunch")});
    const result=await closed.runClosedDue();assert.equal(result.status,"verified");assert.equal(admitted,1);assert.equal(f.coordinator().status().phase,"returned");
    assert.deepEqual(f.create().internalStatus().lastClosedResult,result);assert.deepEqual(f.calls,["capture"]);
    assert.equal((await closed.runClosedDue()).status,"not-due");assert.equal(f.calls.filter(call=>call==="capture").length,1);
  }finally{f.cleanup();}
});
test("closed schedule is opt-in with explicit consent and disabled or not-due wakes never require owner or keys",async()=>{
  const f=fixture();try{
    assert.equal((await f.controller.runClosedDue()).status,"disabled");await f.enable();assert.equal((await f.controller.runClosedDue()).status,"disabled");
    const s=f.coordinator().status();await assert.rejects(f.controller.configure(s.revision,{...s.schedule,closedApp:true,allowIdleRestart:true}),/CLOSED_CONSENT/);
    await f.controller.configure(s.revision,{...s.schedule,closedApp:true,allowClosedApp:true,allowIdleRestart:true});f.controller.stopPolling();
    for(let attempt=0;attempt<100&&f.controller.isPreparing();attempt++)await new Promise(resolve=>setImmediate(resolve));
    const closed=f.create({assertClosedStartup:async()=>assert.fail("not due"),readProtected:async()=>assert.fail("not due")});
    assert.equal((await closed.runClosedDue()).status,"not-due");assert.deepEqual(f.calls,[]);
  }finally{f.cleanup();}
});
test("closed owner, locked store, missing key and changed destination refuse capture without fallback",async()=>{
  for(const mode of ["owner","unproven","locked","key","destination"]){const f=fixture();try{
    await f.enable(false,true);f.setNow(Date.parse("2026-09-13T09:01:00Z"));
    if(mode==="key")rmSync(f.keyFile);if(mode==="destination"){renameSync(f.destination,f.destination+"-original");mkdirSync(f.destination);}
    const closed=f.create({assertClosedStartup:mode==="unproven"?undefined:async()=>{if(mode==="owner")throw Object.assign(Error("owner busy"),{code:"BACKUP_CLOSED_BUSY"});},...(mode==="locked"?{readProtected:async()=>{throw Error("private locked store diagnostic");}}:{})});
    const result=await closed.runClosedDue();assert.equal(result.status,mode==="owner"?"busy":"unavailable");assert.equal(f.calls.includes("capture"),false);
    assert.deepEqual(f.coordinator().status().lastClosedResult,result);assert.equal(JSON.stringify(result).includes("private"),false);
  }finally{f.cleanup();}}
});
test("closed capture failure or a pending upgrade is held without replay",async()=>{
  for(const mode of ["capture","upgrade"]){const f=fixture();try{
    await f.enable(mode==="upgrade",true);
    if(mode==="upgrade")await f.controller.requestUpgrade(updateCandidate());
    f.setNow(Date.parse("2026-09-13T09:01:00Z"));let captures=0;
    const closed=f.create({assertClosedStartup:async()=>{},capture:async()=>{captures++;throw Error("unknown capture result");}});
    assert.equal((await closed.runClosedDue()).status,"needs-review");assert.equal((await closed.runClosedDue()).status,"needs-review");
    assert.equal(captures,mode==="capture"?1:0);assert.equal(f.coordinator().status().phase,mode==="capture"?"needs-review":"handoff-armed");
  }finally{f.cleanup();}}
});
test("closed policy cannot be enabled without support and disable preserves last receipt and result",async()=>{
  const f=fixture({assertClosedAllowed:undefined});try{await assert.rejects(f.enable(false,true),/CLOSED_UNAVAILABLE/);}finally{f.cleanup();}
  const g=fixture();try{
    await g.enable(false,true);g.setNow(Date.parse("2026-09-13T09:01:00Z"));await g.create({assertClosedStartup:async()=>{}}).runClosedDue();
    const before=g.coordinator().status();await g.controller.configure(before.revision,{...before.schedule,enabled:false});
    const after=g.coordinator().status();assert.deepEqual(after.lastVerified,before.lastVerified);assert.deepEqual(after.lastClosedResult,before.lastClosedResult);
    assert.equal((await g.controller.runClosedDue()).status,"disabled");assert.equal(g.calls.filter(call=>call==="capture").length,1);
  }finally{g.cleanup();}
});

test("scheduled key selection verifies the host before reading the key",async()=>{
  const f=fixture();let verified=0;
  try{
    writeFileSync(f.keyFile,"invalid fixture key that must not be read");
    const guarded=f.create({verifyEncrypted:async()=>{verified++;throw Error("AGE_TOOL_UNVERIFIED");}});
    await assert.rejects(guarded.selectReferences(),/AGE_TOOL_UNVERIFIED/);assert.equal(verified,1);
  }finally{f.cleanup();}
});
test("scheduled capture rechecks the host before the lazy identity read",async()=>{
  const f=fixture();let verified=0,received=false;
  try{
    await f.arm();
    const guarded=f.create({verifyEncrypted:async()=>{verified++;throw Error("AGE_TOOL_UNVERIFIED");},capture:async request=>{await request.readIdentity();received=true;}});
    await assert.rejects(guarded.resumeOffline(),/BACKUP_SCHEDULE_REVIEW_REQUIRED/);
    assert.equal(verified,1);assert.equal(received,false);
  }finally{f.cleanup();}
});

// The worker verifies its age tool against this host's pin, so it runs with the
// verified host tools from MURAGE_BACKUP_TEST_AGE_DIR. Windows has no pinned age
// build (its encrypted backups use the Windows helper suites instead).
test("real isolated private worker verifies an encrypted handoff under delegated ownership",{timeout:60000,skip:!backupAgePinForTarget(process.platform,process.arch)&&"no pinned age build for this host"},async()=>{
  const data=backupFixture(),keys=testAgeKeys();data.db.close();const f=fixture({installation:()=>data.data});let owner;let logs="",success=false;
  const diagnostic={stages:["fixture-ready"],workerCreated:false,inputCount:0,exitCode:null,resultOk:null,resultError:null,workerErrorCode:null,privateLogDetected:false};
  try{
    writeFileSync(f.keyFile,keys.identity,{mode:0o600});const original=readFileSync(path.join(data.data,"config.json"));
    const resources=path.join(f.root,"Resources","backup-tools",process.arch);mkdirSync(resources,{recursive:true});const age=path.join(resources,"age");copyFileSync(keys.ageExecutable,age);
    await f.arm();diagnostic.stages.push("armed");owner=acquireDataDirLease(data.data);diagnostic.stages.push("owner-acquired");
    const next=f.create({capture:async request=>{
      diagnostic.stages.push("capture-enter");assert.throws(()=>acquireDataDirLease(data.data));diagnostic.stages.push("exclusive-owner-proved");const identity=await request.readIdentity();diagnostic.stages.push("identity-read");const entry=pathToFileURL(path.resolve("dist-server/installation-recovery-worker.js")).href;
      const args=["backup-encrypted","--data-dir",data.data,"--output",request.output,"--age-tool",age,"--recipient",request.recipient,"--credential-policy","preserve-in-encrypted-fidelity","--max-bytes",String(request.maxBytes),"--max-duration-ms",String(request.maxDurationMs)];
      assert.equal(JSON.stringify(args).includes("AGE-SECRET"),false);
      const code=`import {parentPort} from 'node:worker_threads';const listeners=new Map();process.parentPort={on(name,fn){const wrap=data=>fn({data});listeners.set(fn,wrap);parentPort.on(name,wrap);},removeListener(name,fn){parentPort.removeListener(name,listeners.get(fn));},postMessage:value=>parentPort.postMessage(value)};process.argv=[process.execPath,'worker',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`;
      const env={PATH:path.dirname(process.execPath),HOME:f.root,USERPROFILE:f.root,...owner.utilityServerLeaseEnvironment()};assert.equal(JSON.stringify(env).includes("AGE-SECRET"),false);
      const child=new Worker(new URL("data:text/javascript,"+encodeURIComponent(code)),{stdout:true,stderr:true,env});let result,inputs=0;
      diagnostic.workerCreated=true;diagnostic.stages.push("worker-created");
      child.stdout.on("data",chunk=>{logs+=chunk;});child.stderr.on("data",chunk=>{logs+=chunk;});
      child.on("message",message=>{if(message.type==="murage:recovery-input-ready"){inputs++;diagnostic.inputCount=inputs;child.postMessage({type:"murage:recovery-input",nonce:message.nonce,identity});}if(message.type==="murage:recovery-result"){result=message.result;diagnostic.resultOk=typeof result?.ok==="boolean"?result.ok:null;diagnostic.resultError=typeof result?.error==="string"&&/^[A-Z][A-Z0-9_]{0,100}$/.test(result.error)?result.error:null;child.postMessage({type:"murage:recovery-result-ack",nonce:message.nonce});}});
      const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{void child.terminate().then(()=>reject(Error("fixture timeout")));},30000);child.once("error",error=>{diagnostic.workerErrorCode=typeof error.code==="string"&&/^ERR_[A-Z0-9_]{1,100}$/.test(error.code)?error.code:null;clearTimeout(timer);reject(error);});child.once("exit",code=>{diagnostic.exitCode=code;diagnostic.stages.push("worker-exited");clearTimeout(timer);resolve(code);});});
      diagnostic.privateLogDetected=logs.includes("AGE-SECRET")||logs.includes("FAKE-CREDENTIAL-CANARY");assert.equal(logs.includes("AGE-SECRET"),false);assert.equal(logs.includes("FAKE-CREDENTIAL-CANARY"),false);assert.equal(exit,0);assert.equal(inputs,1);assert.equal(result?.ok,true);assert.throws(()=>acquireDataDirLease(data.data));diagnostic.stages.push("worker-result-verified");return result;
    }});
    await next.resumeOffline();const s=f.coordinator().status();assert.equal(s.phase,"return-pending");assert.equal(digest(readFileSync(path.join(f.destination,s.job.id+".age"))),s.lastVerified.sha256);assert.equal(readFileSync(path.join(data.data,"config.json")).equals(original),true);next.completeReturn();assert.equal(f.coordinator().status().phase,"returned");diagnostic.stages.push("host-return-verified");success=true;
  }finally{owner?.release();rmSync(f.keyFile,{force:true});console.log("B21 safe worker diagnostic:",JSON.stringify(diagnostic));if(success){f.cleanup();rmSync(data.parent,{recursive:true,force:true});}else{writeFileSync(path.join(f.root,"safe-worker-diagnostic.json"),JSON.stringify(diagnostic),{mode:0o600});f.controller.stopPolling();console.error("B21 isolated failure artifacts retained:",f.root,data.parent);}}
});
