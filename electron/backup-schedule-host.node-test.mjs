import assert from "node:assert/strict";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,statSync,writeFileSync } from "node:fs";
import { createRequire,syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { BackupCoordinator } from "../server/backup-coordinator.ts";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { createBackupScheduleHost, setUpBackupsRequest } from "./backup-schedule-host.mjs";
import { backupRefusal } from "./backup-waiting.mjs";
import { backupFixture,testAgeKeys } from "../server/testing/backup-fixture.ts";
import { canonicalUpdateDescriptor } from "../shared/update-candidate.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { prepareBackedUpInstall, resumeBackedUpInstall } from "./preupgrade-continuation.mjs";
import { captureFailureSentence } from "../shared/backup-capture-failure.mjs";
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
  if(typeof overrides==="function")overrides=overrides({root,installation,destination,keyFile});
  let now=Date.parse("2026-09-13T08:00:00Z"),binding;
  const calls=[];const coordinator=()=>new BackupCoordinator({stateDirectory:path.join(root,"control"),now:()=>now});
  const host={coordinator:coordinator(),installation:()=>installation,now:()=>now,supported:()=>true,readProtected:async()=>binding,writeProtected:async(_key,value)=>{binding=value;},chooseDestination:async()=>destination,chooseKey:async()=>keyFile,confirmReferences:async()=>true,
    assertUpgradeAllowed:async()=>{},assertClosedAllowed:async()=>{},prepare:async()=>{calls.push("prepare");return async()=>calls.push("release");},cleanupIdle:async()=>calls.push("cleanup"),relaunch:async mode=>calls.push(mode),
    capture:async request=>{calls.push("capture");const identity=await request.readIdentity();assert.equal(identity===fakeKey,true);const bytes=Buffer.from("fictional immutable encrypted artifact");writeFileSync(request.output,bytes,{flag:"wx",mode:0o600});return{ok:true,operation:"backup-encrypted",path:request.output,sha256:digest(bytes),snapshotId:randomUUID(),coverage:{scope:"application-data",fullInstallation:false,credentialPolicy:"preserve-in-encrypted-fidelity"}};},...overrides};
  const create=(extra={})=>createBackupScheduleHost({...host,coordinator:coordinator(),...extra});const controller=create();
  return{root,installation,destination,keyFile,calls,host,controller,coordinator,create,setNow:value=>{now=value;},rotate:()=>{binding=JSON.stringify({...JSON.parse(binding),recipient:"changed"});},
    async enable(preUpgrade=false,closedApp=false){const status=await controller.selectReferences();await controller.configure(0,{...choices,preUpgrade,closedApp,...Object.fromEntries(["installationRef","destinationRef","recoveryRef"].map(key=>[key,status.refs[key]])),allowIdleRestart:true,allowClosedApp:closedApp});controller.stopPolling();for(let attempt=0;attempt<100&&controller.isPreparing();attempt++)await new Promise(resolve=>setImmediate(resolve));assert.equal(controller.isPreparing(),false,"initial tick must settle before fake-clock advance");},
    async arm(){await this.enable();now=Date.parse("2026-09-13T09:01:00Z");await controller.tick();},
    cleanup(){controller.stopPolling();safeWipeSync(root);}};
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
test("the worker may report the archive in another spelling of the same path, never another path",async()=>{
  // The recovery worker canonicalizes paths, which on Windows lowercases them.
  const spelled=output=>output.toLowerCase();
  const f=fixture(({destination})=>({capture:async request=>{const bytes=Buffer.from("fictional encrypted artifact");writeFileSync(request.output,bytes,{flag:"wx",mode:0o600});
    return{ok:true,operation:"backup-encrypted",path:spelled(request.output),sha256:digest(bytes),snapshotId:randomUUID(),coverage:{scope:"application-data",fullInstallation:false,credentialPolicy:"preserve-in-encrypted-fidelity"}};}}));
  try{
    await f.arm();const output=path.join(f.destination,f.coordinator().status().job.id+".age");
    const sameSpelling=process.platform==="win32"||spelled(output)===output;
    if(sameSpelling)await f.create().resumeOffline();
    else await assert.rejects(f.create().resumeOffline(),/REVIEW_REQUIRED/);
    assert.equal(f.coordinator().status().phase,sameSpelling?"return-pending":"needs-review");
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
    assert.equal(selected.archivePath,path.join(realpathSync.native(f.destination),selected.receipt.jobId+".age"));
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
// Windows hands this host its installation lowercased (data-dir-lease.mjs
// normalizedCanonicalPath) while the native realpath answers in the
// filesystem's casing, so the two resolvers never agree there. Use that exact
// spelling where the temp volume folds case (Windows, macOS). On a
// case-sensitive volume no real spelling splits them, so model the JavaScript
// resolver keeping a non-canonical spelling it was handed, the way it does on
// Windows, and restore it afterwards.
function foreignInstallationSpelling(installation){
  const canonical=realpathSync.native(installation),lower=canonical.toLowerCase();
  let folded=false;try{folded=lower!==canonical&&statSync(lower).ino===statSync(canonical).ino;}catch{/* Case-sensitive volume. */}
  if(folded)return{spelling:lower,restore(){}};
  const fs=createRequire(import.meta.url)("node:fs"),original=fs.realpathSync,spelling=path.dirname(canonical)+path.sep+path.sep+path.basename(canonical);
  const keepsSpelling=(value,...rest)=>value===spelling?spelling:original(value,...rest);keepsSpelling.native=original.native;
  fs.realpathSync=keepsSpelling;syncBuiltinESMExports();
  return{spelling,restore(){fs.realpathSync=original;syncBuiltinESMExports();}};
}
test("an installation the resolvers spell differently still selects, runs and serves its schedule",async()=>{
  let foreign;const f=fixture(({installation})=>{foreign=foreignInstallationSpelling(installation);return{installation:()=>foreign.spelling};});
  try{
    assert.notEqual(realpathSync(foreign.spelling),realpathSync.native(foreign.spelling),"fixture must split the two resolvers");
    // Containment is still judged natively: the canonical spelling of a folder
    // inside the installation is refused.
    const inside=path.join(realpathSync.native(f.installation),"archives");mkdirSync(inside);
    await assert.rejects(f.create({chooseDestination:async()=>inside}).selectReferences(),/DESTINATION_INVALID/);
    await f.arm();assert.equal(f.coordinator().status().phase,"handoff-armed");
    // The binding names the installation the way earlier releases did, so a
    // reselection keeps the reference remote copies are filed under.
    assert.equal((await f.controller.status()).refs.installationRef,"installation-"+digest(JSON.stringify(realpathSync(foreign.spelling))).slice(0,24));
    const resumed=f.create();await resumed.resumeOffline();assert.equal(f.coordinator().status().phase,"return-pending");resumed.completeReturn();
    const selected=await resumed.latestVerifiedArtifact();assert.equal(selected.receipt.jobId,f.coordinator().status().lastVerified.jobId);
    assert.equal(f.calls.filter(call=>call==="capture").length,1);
  }finally{foreign?.restore();f.cleanup();}
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
  }finally{owner?.release();rmSync(f.keyFile,{force:true});console.log("B21 safe worker diagnostic:",JSON.stringify(diagnostic));if(success){f.cleanup();safeWipeSync(data.parent);}else{writeFileSync(path.join(f.root,"safe-worker-diagnostic.json"),JSON.stringify(diagnostic),{mode:0o600});f.controller.stopPolling();console.error("B21 isolated failure artifacts retained:",f.root,data.parent);}}
});
test("back up now hands off through the armed restart and records the receipt a daily run would",async()=>{
  const f=fixture();try{
    await f.enable();const before=await f.controller.status();assert.equal(before.phase,"idle");
    const armed=await f.controller.runNow(before.revision);
    assert.equal(armed.phase,"handoff-armed");assert.deepEqual(f.calls,["prepare","cleanup","backup"]);
    const job=f.coordinator().status().job;assert.match(job.occurrence,/^\d+:manual:/);
    const resumed=f.create();await resumed.resumeOffline();assert.equal(f.coordinator().status().phase,"return-pending");
    resumed.completeReturn();assert.equal(f.coordinator().status().phase,"returned");
    const receipt=f.coordinator().status().lastVerified;assert.equal(receipt.jobId,job.id);assert.equal(receipt.destinationRef,before.refs.destinationRef);
    const selected=await resumed.latestVerifiedArtifact();assert.equal(selected.receipt.jobId,job.id);
    // Before the daily time nothing else runs; the manual request never replays.
    await resumed.tick();assert.equal(f.calls.filter(call=>call==="capture").length,1);assert.equal(f.calls.filter(call=>call==="backup").length,1);
  }finally{f.cleanup();}
});
test("a backup that stopped unconfirmed says so, and clearing it lets back up now run again",async()=>{
  const f=fixture();try{
    await f.enable();const before=await f.controller.status();
    await f.controller.runNow(before.revision);const job=f.coordinator().status().job;
    // Backup mode could not confirm its capture and handed the workspace back.
    f.coordinator().failHandoff(job.handoff.id);
    const stuck=await f.controller.status();assert.equal(stuck.phase,"needs-review");assert.equal(stuck.reviewReason,"capture-unconfirmed");
    await assert.rejects(f.controller.runNow(stuck.revision),/BACKUP_REVIEW_REQUIRED/);
    await assert.rejects(f.controller.clearReview(stuck.revision+1),/BACKUP_SCHEDULE_CHANGED/);
    await assert.rejects(f.controller.clearReview("1"),/INVALID_BACKUP_REQUEST/);
    const cleared=await f.controller.clearReview(stuck.revision);assert.equal(cleared.phase,"idle");assert.equal(cleared.reviewReason,undefined);
    const again=await f.create().runNow(cleared.revision);assert.equal(again.phase,"handoff-armed");
    assert.notEqual(f.coordinator().status().job.id,job.id);
  }finally{f.cleanup();}
});
test("back up now runs with the daily schedule off while saved references keep idle-restart consent",async()=>{
  const f=fixture();try{
    await f.enable();const enabled=await f.controller.status();
    const off=await f.controller.configure(enabled.revision,{...enabled.schedule,enabled:false});f.controller.stopPolling();assert.equal(off.enabled,false);
    await f.controller.runNow(off.revision);assert.equal(f.coordinator().status().phase,"handoff-armed");
    await f.create().resumeOffline();assert.equal(f.coordinator().status().phase,"return-pending");
    assert.equal(f.coordinator().status().lastVerified.jobId,f.coordinator().status().job.id);
  }finally{f.cleanup();}
});
test("back up now and a due daily run refuse before closing anything when this system cannot restart Murage",async()=>{
  const f=fixture();try{
    await f.enable(true);const before=await f.controller.status();
    const blocked=f.create({relaunchBlocked:()=>true});
    await assert.rejects(blocked.runNow(before.revision),/BACKUP_RELAUNCH_BLOCKED/);assert.deepEqual(f.calls,[]);
    assert.equal(f.coordinator().status().job,undefined);
    f.setNow(Date.parse("2026-09-13T09:01:00Z"));await blocked.tick();assert.deepEqual(f.calls,[]);
    assert.equal((await blocked.status()).error,"BACKUP_RELAUNCH_BLOCKED");
    await assert.rejects(blocked.requestUpgrade(updateCandidate()),/BACKUP_RELAUNCH_BLOCKED/);assert.deepEqual(f.calls,[]);
    blocked.stopPolling();
  }finally{f.cleanup();}
});
// 0.1.60 Linux re-test 2 D9: setup switched daily backups on where no backup
// could ever run, and said nothing until Back up now failed.
test("setup refuses before choosing a folder or writing a key when Murage can't reopen itself, and says why in the status",async()=>{
  for(const code of ["BACKUP_RELAUNCH_BLOCKED","BACKUP_RELAUNCH_APPIMAGE_MISSING"]){
    const asked=[];
    const f=fixture({relaunchBlocked:()=>code,chooseDestination:async()=>{asked.push("folder");return null;},chooseKey:async()=>{asked.push("key");return null;},
      createRecoveryKey:async()=>{asked.push("create");return null;},confirmReferences:async()=>{asked.push("confirm");return true;}});
    try{
      const status=await f.controller.status();
      assert.equal(status.relaunchBlocked,code);assert.equal(status.enabled,false);
      await assert.rejects(f.controller.setUpBackups({}),new RegExp(code));
      await assert.rejects(f.controller.selectReferences(),new RegExp(code));
      assert.deepEqual(asked,[]);assert.deepEqual(f.calls,[]);
      await assert.rejects(f.controller.configure(0,{...choices,installationRef:"a",destinationRef:"b",recoveryRef:"c",allowIdleRestart:true}),new RegExp(code));
      assert.equal(f.coordinator().status().enabled,false);
      // Turning backups off is never refused.
      const off=await f.controller.configure(0,{...choices,enabled:false});assert.equal(off.enabled,false);
    }finally{f.cleanup();}
  }
});
test("an older host that answers relaunchBlocked with true still refuses with the general code; an unknown string is not echoed",async()=>{
  for(const [answer,code] of [[true,"BACKUP_RELAUNCH_BLOCKED"],["not a code","BACKUP_RELAUNCH_BLOCKED"]]){
    const f=fixture({relaunchBlocked:()=>answer});
    try{assert.equal((await f.controller.status()).relaunchBlocked,code);await assert.rejects(f.controller.setUpBackups({}),new RegExp(code));}finally{f.cleanup();}
  }
});
// 0.1.60 Linux re-test 2 D6: a card left waiting blocked every backup and the
// page said only that Murage was busy. The refusal now names who.
test("a daily backup held up by a bot waiting on the person says who, keeps trying, and clears once it starts",async()=>{
  const ember={botId:"ember",name:"Ember",threadId:"t1",messageId:"m1"};
  let waiting=true;const occasions=[];
  const f=fixture(()=>({prepare:async occasion=>{occasions.push(occasion);if(waiting)throw backupRefusal({error:"BACKUP_WORK_ACTIVE",waitingOnYou:[ember,{name:"no id"}]});return async()=>{};}}));
  try{
    await f.enable();occasions.length=0;
    f.setNow(Date.parse("2026-09-13T09:01:00Z"));await f.controller.tick();
    let status=await f.controller.status();
    assert.equal(status.error,"BACKUP_WAITING_ON_YOU");
    assert.deepEqual(status.heldBy,{occasion:"daily",since:Date.parse("2026-09-13T09:01:00Z"),bots:[ember]});
    assert.equal(["due","waiting-idle","waiting-backup-mode"].includes(f.coordinator().status().phase),true,"still due, tried again next minute");
    // a minute later it tries again, and `since` stays when it first waited
    f.setNow(Date.parse("2026-09-13T09:02:00Z"));await f.controller.tick();
    status=await f.controller.status();assert.equal(status.heldBy.since,Date.parse("2026-09-13T09:01:00Z"));
    assert.deepEqual(occasions,["daily","daily"]);
    // answered: the next try starts the backup and the note goes
    waiting=false;f.setNow(Date.parse("2026-09-13T09:03:00Z"));await f.controller.tick();
    status=await f.controller.status();assert.equal(status.heldBy,undefined);assert.equal(f.coordinator().status().phase,"handoff-armed");
  }finally{f.cleanup();}
});
test("back up now held up by a waiting bot refuses naming who, as a Back up now",async()=>{
  const ember={botId:"ember",name:"Ember",threadId:"t1"};
  const f=fixture(()=>({prepare:async occasion=>{assert.equal(occasion,"manual");throw backupRefusal({waitingOnYou:[ember]});}}));
  try{
    await f.enable();const before=await f.controller.status();
    await assert.rejects(f.controller.runNow(before.revision),/BACKUP_WAITING_ON_YOU/);
    const status=await f.controller.status();
    assert.equal(status.heldBy.occasion,"manual");assert.deepEqual(status.heldBy.bots,[ember]);
    // other work only: the old refusal, and nobody named
    const g=fixture(()=>({prepare:async()=>{throw backupRefusal({error:"BACKUP_WORK_ACTIVE"});}}));
    try{await g.enable();await assert.rejects(g.controller.runNow((await g.controller.status()).revision),/BACKUP_WORK_ACTIVE/);assert.equal((await g.controller.status()).heldBy,undefined);}finally{g.cleanup();}
  }finally{f.cleanup();}
});
test("back up now and a due daily run refuse before closing anything while Murage runs as administrator",async()=>{
  const f=fixture();try{
    await f.enable();const before=await f.controller.status();
    const elevated=f.create({elevated:()=>true});
    await assert.rejects(elevated.runNow(before.revision),/BACKUP_ELEVATED/);assert.deepEqual(f.calls,[]);
    assert.equal(f.coordinator().status().job,undefined);
    f.setNow(Date.parse("2026-09-13T09:01:00Z"));await elevated.tick();assert.deepEqual(f.calls,[]);
    assert.equal((await elevated.status()).error,"BACKUP_ELEVATED");
    elevated.stopPolling();
  }finally{f.cleanup();}
});
test("back up now refuses without saved references, consent or the current revision, before any restart",async()=>{
  const fresh=fixture();try{await assert.rejects(fresh.controller.runNow(0),/BACKUP_SCHEDULE_CONSENT_REQUIRED/);assert.deepEqual(fresh.calls,[]);
    const selected=await fresh.controller.selectReferences();await assert.rejects(fresh.controller.runNow(selected.revision),/BACKUP_SCHEDULE_CONSENT_REQUIRED/);assert.deepEqual(fresh.calls,[]);assert.equal(fresh.coordinator().status().job,undefined);
  }finally{fresh.cleanup();}
  const f=fixture();try{await f.enable();const s=await f.controller.status();
    for(const stale of [s.revision-1,s.revision+1])await assert.rejects(f.controller.runNow(stale),/BACKUP_SCHEDULE_CHANGED/);
    await assert.rejects(f.controller.runNow("1"),/INVALID_BACKUP_REQUEST/);
    writeFileSync(f.keyFile,fakeKey+"# changed\n");await assert.rejects(f.controller.runNow(s.revision),/BACKUP_REFERENCE_CHANGED/);
    assert.deepEqual(f.calls,[]);assert.equal(f.coordinator().status().job,undefined);
  }finally{f.cleanup();}
  const u=fixture();try{await u.enable();const s=await u.controller.status();await assert.rejects(u.create({supported:()=>false}).runNow(s.revision),/BACKUP_UNAVAILABLE/);assert.deepEqual(u.calls,[]);}finally{u.cleanup();}
});
test("back up now with active work stays idle and its request never runs later on its own",async()=>{
  let busy=true;const f=fixture({prepare:async()=>{if(busy)throw Error("BACKUP_WORK_ACTIVE");f.calls.push("prepare");return async()=>f.calls.push("release");}});try{
    await f.enable();const s=await f.controller.status();
    await assert.rejects(f.controller.runNow(s.revision),/BACKUP_WORK_ACTIVE/);
    assert.equal(f.calls.includes("backup"),false);assert.equal(f.coordinator().status().phase,"skipped");assert.equal(f.controller.isPreparing(),false);
    busy=false;await f.controller.tick();assert.equal(f.calls.includes("backup"),false);assert.equal(f.coordinator().status().phase,"skipped");
    // The user can simply ask again once the work finishes.
    await f.controller.runNow(s.revision);assert.equal(f.coordinator().status().phase,"handoff-armed");
  }finally{f.cleanup();}
});
test("back up now is serialized with other backup work and refuses unresolved backups",async()=>{
  const waits=[],proceed=()=>{for(const resume of waits.splice(0))resume();};const f=fixture({prepare:async()=>{await new Promise(resolve=>{waits.push(resolve);});return async()=>{};}});try{
    await f.enable();const s=await f.controller.status();const first=f.controller.runNow(s.revision);
    for(let attempt=0;attempt<100&&!waits.length;attempt++)await new Promise(resolve=>setImmediate(resolve));assert.equal(waits.length,1);
    const second=f.controller.runNow(s.revision);second.catch(()=>{});
    for(let attempt=0;attempt<100;attempt++)await new Promise(resolve=>setImmediate(resolve));assert.equal(waits.length,1,"one workspace close at a time");
    proceed();await assert.rejects(second,/BACKUP_BUSY/);await f.controller.tick();await assert.rejects(f.controller.selectReferences(),/BACKUP_BUSY/);
    proceed();await first;assert.equal(f.coordinator().status().phase,"handoff-armed");
    await assert.rejects(f.create().runNow(s.revision),/BACKUP_BUSY/);
  }finally{proceed();f.cleanup();}
  const r=fixture();try{await r.enable();const s=await r.controller.status();
    const file=path.join(r.root,"control","backup-coordinator.json"),saved=JSON.parse(readFileSync(file));saved.job={id:"f".repeat(64),occurrence:`${s.revision}:daily:2026-09-12`,revision:s.revision,scheduledAt:0,phase:"needs-review",error:"interrupted"};writeFileSync(file,JSON.stringify(saved));
    await assert.rejects(r.create().runNow(s.revision),/BACKUP_REVIEW_REQUIRED/);assert.deepEqual(r.calls,[]);
  }finally{r.cleanup();}
});
test("back up now while a daily backup waits hands off that same job instead of a second one",async()=>{
  let busy=true;const f=fixture({prepare:async()=>{if(busy)throw Error("BACKUP_WORK_ACTIVE");f.calls.push("prepare");return async()=>{};}});try{
    await f.arm();const waiting=f.coordinator().status();assert.equal(waiting.phase,"waiting-backup-mode");assert.match(waiting.job.occurrence,/:daily:/);
    busy=false;await f.controller.runNow(waiting.revision);const armed=f.coordinator().status();
    assert.equal(armed.phase,"handoff-armed");assert.equal(armed.job.id,waiting.job.id);
    const resumed=f.create();await resumed.resumeOffline();resumed.completeReturn();await resumed.tick();
    assert.equal(f.coordinator().status().phase,"returned");assert.equal(f.calls.filter(call=>call==="capture").length,1);assert.equal(f.calls.filter(call=>call==="backup").length,1);
  }finally{f.cleanup();}
});

test("the log alone gets the redacted cause behind a failed capture (W-D1)",async()=>{
  const reported=[];
  const cause={step:"offline-open",errno:"EBUSY",syscall:"link",innerCode:"LEASE_IO",message:"EBUSY: resource busy or locked, link 'C:\\Users\\Sam Lee\\a' -> 'C:\\Users\\Sam Lee\\b'",path:"C:\\Users\\Sam Lee"};
  const f=fixture(()=>({capture:async()=>{throw Object.assign(Error("BACKUP_FILE_IN_USE"),{code:"BACKUP_FILE_IN_USE",captureCause:cause});}}));
  try{
    await f.arm();
    const next=f.create({reportCaptureFailure:failure=>reported.push(failure)});
    await assert.rejects(next.resumeOffline(),/BACKUP_SCHEDULE_REVIEW_REQUIRED/);
    assert.equal(reported.length,1);
    assert.deepEqual(reported[0],{stage:"capture",code:"BACKUP_FILE_IN_USE",cause:{step:"offline-open",errno:"EBUSY",syscall:"link",innerCode:"LEASE_IO",message:"EBUSY: resource busy or locked, link '<path>' -> '<path>'"}});
    assert.equal(JSON.stringify(reported).includes("Sam Lee"),false);
    // The durable record, which the window reads, never carries the cause.
    assert.deepEqual(f.coordinator().status().captureFailure,{stage:"capture",code:"BACKUP_FILE_IN_USE"});
  }finally{f.cleanup();}
});

test("a failed capture names its stage and reason, keeps it, and reopens the workspace",async()=>{
  const reported=[];
  const f=fixture(()=>({
    capture:async()=>{throw Error("BACKUP_UNCLASSIFIED_COMPONENT");},
    reportCaptureFailure:failure=>reported.push(failure),
  }));
  try{
    await f.arm();
    const next=f.create({reportCaptureFailure:failure=>reported.push(failure)});
    await assert.rejects(next.resumeOffline(),/BACKUP_SCHEDULE_REVIEW_REQUIRED/);
    // The real refusal is named, not flattened to UNKNOWN_CAPTURE_FAILURE.
    assert.deepEqual(reported,[{stage:"capture",code:"BACKUP_UNCLASSIFIED_COMPONENT"}]);
    // It survives for the workspace to show, and says something actionable.
    const status=f.coordinator().status();
    assert.equal(status.phase,"needs-review");
    assert.deepEqual(status.captureFailure,{stage:"capture",code:"BACKUP_UNCLASSIFIED_COMPONENT"});
    const sentence=captureFailureSentence(status.captureFailure);
    assert.equal(sentence.includes("while copying your workspace"),true);
    assert.equal(sentence.includes("doesn't recognise"),true);
    assert.equal(sentence.includes(f.root),false);
    assert.equal((await f.create().status()).captureFailure.code,"BACKUP_UNCLASSIFIED_COMPONENT");
    // The person is put back in the workspace rather than left on Backup mode.
    assert.equal(f.calls.filter(call=>call==="normal").length,1);
    // Clearing the review clears the note with it.
    const cleared=f.create();
    await cleared.clearReview(f.coordinator().status().revision);
    assert.equal(f.coordinator().status().captureFailure,undefined);
  }finally{f.cleanup();}
});

test("a closed-app capture failure records the reason without reopening a window",async()=>{
  const f=fixture(()=>({
    capture:async()=>{throw Error("SOURCE_CHANGED");},
    assertClosedStartup:async()=>{},
  }));
  try{
    await f.enable(false,true);
    f.setNow(Date.parse("2026-09-13T09:01:00Z"));
    const result=await f.create({assertClosedStartup:async()=>{}}).runClosedDue();
    assert.equal(result.status,"needs-review");
    assert.deepEqual(f.coordinator().status().captureFailure,{stage:"capture",code:"SOURCE_CHANGED"});
    assert.equal(f.calls.includes("normal"),false);
  }finally{f.cleanup();}
});

// ---- One act of setup.
//
// Turning on backups used to cost four native dialogs: create the key (its own
// save dialog), then "Choose backup folder and recovery key" asked for the
// folder AND for the key file the app had just written, then a confirmation —
// and daily backups were still off afterwards. The owner needed three attempts
// and still ended up with no verified backup. These tests pin the new shape and
// every safety check it must keep.
const madeKey=(root,name="made-key.txt")=>{const file=path.join(root,name);writeFileSync(file,fakeKey,{mode:0o600});return{file,label:name,publicKey:"age1"+"q".repeat(58)};};

test("setting up backups asks for the folder once, writes the key itself, and never asks for it back",async()=>{
  const dialogs=[];let offered;
  const f=fixture(({root,destination,keyFile})=>({
    chooseDestination:async()=>{dialogs.push("folder");return destination;},
    chooseKey:async()=>{dialogs.push("key-picker");return keyFile;},
    confirmReferences:async summary=>{dialogs.push("confirm");offered=summary;return true;},
    createRecoveryKey:async chosen=>{dialogs.push("create-key");assert.equal(chosen,realpathSync.native(destination));return madeKey(root);},
  }));
  try{
    const status=await f.controller.setUpBackups();
    assert.deepEqual(dialogs,["folder","create-key","confirm"]);
    // The one confirmation names both choices and where the key went.
    assert.equal(offered.destination,path.basename(realpathSync.native(f.destination)));
    assert.equal(offered.recoveryKey,"made-key.txt");
    assert.equal(offered.createdKey,true);
    assert.equal(offered.recoveryKeyFolder,realpathSync(f.root));
    // The key the app made is the key it bound, with no second selection.
    assert.equal(status.refs.recoveryLabel,"made-key.txt");
    assert.equal(status.created.label,"made-key.txt");
    assert.equal(status.created.publicKey,"age1"+"q".repeat(58));
    // Setup alone still does not enable: configure() remains the only switch.
    assert.equal(status.enabled,false);
    const encoded=JSON.stringify(status);
    assert.equal(encoded.includes("AGE-SECRET"),false);assert.equal(encoded.includes(f.root),false);
  }finally{f.cleanup();}
});

test("the old key picker survives as the existing-key branch, and both refuse a key with no recipient header",async()=>{
  const dialogs=[];
  const f=fixture(({root,destination,keyFile})=>({
    chooseDestination:async()=>{dialogs.push("folder");return destination;},
    chooseKey:async()=>{dialogs.push("key-picker");return keyFile;},
    confirmReferences:async()=>{dialogs.push("confirm");return true;},
    createRecoveryKey:async()=>madeKey(root),
  }));
  try{
    const status=await f.controller.setUpBackups({existingKey:true});
    assert.deepEqual(dialogs,["folder","key-picker","confirm"]);
    assert.equal(status.refs.recoveryLabel,"independent-key.txt");
    assert.equal(status.created,undefined);
  }finally{f.cleanup();}
  const headerless=fixture(({root})=>({createRecoveryKey:async()=>{const file=path.join(root,"no-header.txt");writeFileSync(file,"AGE-SECRET-KEY-1"+"A".repeat(60)+"\n",{mode:0o600});return{file,label:"no-header.txt",publicKey:null};}}));
  try{await assert.rejects(headerless.controller.setUpBackups(),/BACKUP_IDENTITY_HEADER_REQUIRED/);}finally{headerless.cleanup();}
});

test("one-act setup keeps every refusal the two-step selection had",async()=>{
  // A destination inside the installation makes the backup consume itself.
  const inside=fixture(({installation})=>{const folder=path.join(installation,"archives");mkdirSync(folder);return{chooseDestination:async()=>folder,createRecoveryKey:async()=>{assert.fail("no key may be written before the destination is accepted");}};});
  try{await assert.rejects(inside.controller.setUpBackups(),/BACKUP_DESTINATION_INVALID/);}finally{inside.cleanup();}
  // verifyIdentityAccess() runs before anything is created or bound.
  let created=false;
  const unverified=fixture(({root})=>({verifyEncrypted:async()=>{throw Error("AGE_TOOL_UNVERIFIED");},createRecoveryKey:async()=>{created=true;return madeKey(root);}}));
  try{await assert.rejects(unverified.controller.setUpBackups(),/AGE_TOOL_UNVERIFIED/);assert.equal(created,false);}finally{unverified.cleanup();}
  // Cancelling the folder picker writes nothing at all.
  const cancelled=fixture(({root})=>({chooseDestination:async()=>null,createRecoveryKey:async()=>{assert.fail("nothing is created before a folder is chosen");}}));
  try{assert.deepEqual(await cancelled.controller.setUpBackups(),{cancelled:true});assert.equal((await cancelled.controller.status()).refs,undefined);}finally{cancelled.cleanup();}
  // Declining the confirmation binds nothing. With no way to take the key
  // back, it says where the key was left.
  const declined=fixture(({root})=>({confirmReferences:async()=>false,createRecoveryKey:async()=>madeKey(root)}));
  try{const answer=await declined.controller.setUpBackups();assert.equal(answer.cancelled,true);assert.equal(answer.created.label,"made-key.txt");assert.equal((await declined.controller.status()).refs,undefined);}finally{declined.cleanup();}
});

// Mac customer re-test 2 (D10): cancelling the one confirmation left
// murage-recovery-key.txt behind, and the retry made murage-recovery-key-2.txt.
test("a cancelled or failed setup takes back the key it made, so a retry does not add another",async()=>{
  const discarded=[];
  const declined=fixture(({root})=>({confirmReferences:async()=>false,createRecoveryKey:async()=>madeKey(root),discardRecoveryKey:file=>{discarded.push(path.basename(file));return true;}}));
  try{const answer=await declined.controller.setUpBackups();assert.deepEqual(answer,{cancelled:true});assert.deepEqual(discarded,["made-key.txt"]);assert.equal((await declined.controller.status()).refs,undefined);}finally{declined.cleanup();}
  // A key that could not be taken back is named, as before.
  const kept=fixture(({root})=>({confirmReferences:async()=>false,createRecoveryKey:async()=>madeKey(root),discardRecoveryKey:()=>false}));
  try{assert.equal((await kept.controller.setUpBackups()).created.label,"made-key.txt");}finally{kept.cleanup();}
  // A setup that fails after the key was made takes it back too.
  discarded.length=0;
  const failing=fixture(({root})=>({createRecoveryKey:async()=>madeKey(root),writeProtected:async()=>{throw Error("BACKUP_BINDINGS_UNAVAILABLE");},discardRecoveryKey:file=>{discarded.push(path.basename(file));return true;}}));
  try{await assert.rejects(failing.controller.setUpBackups(),/BACKUP_BINDINGS_UNAVAILABLE/);assert.deepEqual(discarded,["made-key.txt"]);}finally{failing.cleanup();}
  // A setup that completes keeps its key.
  discarded.length=0;
  const done=fixture(({root})=>({createRecoveryKey:async()=>madeKey(root),discardRecoveryKey:file=>{discarded.push(path.basename(file));return true;}}));
  try{const answer=await done.controller.setUpBackups();assert.equal(answer.created.label,"made-key.txt");assert.deepEqual(discarded,[]);}finally{done.cleanup();}
});

test("setup is refused while a backup is running or a schedule is already on",async()=>{
  const f=fixture(({root})=>({createRecoveryKey:async()=>madeKey(root)}));
  try{
    await f.enable();
    await assert.rejects(f.controller.setUpBackups(),/BACKUP_BUSY/);
  }finally{f.cleanup();}
});

test("Turn on backups reaches setup when the bridge forwards an empty options slot", () => {
  // preload.cjs forwarded `options` even when it was undefined, and the old
  // check refused [undefined] as malformed: the ordinary setup never opened.
  assert.deepEqual(setUpBackupsRequest([undefined]), { existingKey: false });
  assert.deepEqual(setUpBackupsRequest([]), { existingKey: false });
  assert.deepEqual(setUpBackupsRequest([{}]), { existingKey: false });
  assert.deepEqual(setUpBackupsRequest([{ existingKey: true }]), { existingKey: true });
  for (const bad of [[null], ["x"], [[]], [{ existingKey: "yes" }], [{ other: true }], [undefined, undefined]]) assert.equal(setUpBackupsRequest(bad), null);
});

// 0.1.60 audit W-A2: on Windows a folder the backup helper can't use (a USB
// stick, a network folder, a non-NTFS drive) is refused when it is chosen,
// before a key is written or Murage restarts for a first backup that fails.
test("a folder the backup can't use is refused at folder choice, before anything is made",async()=>{
  for(const code of ["BACKUP_FOLDER_REMOVABLE","BACKUP_FOLDER_NETWORK","BACKUP_FOLDER_NOT_NTFS"]){
    const f=fixture(()=>({backupFolderRefusal:()=>code,createRecoveryKey:async()=>{assert.fail("no key may be written for a refused folder");}}));
    try{await assert.rejects(f.controller.setUpBackups(),new RegExp(code));assert.equal((await f.controller.status()).refs,undefined);}finally{f.cleanup();}
    const g=fixture(()=>({backupFolderRefusal:()=>code}));
    try{await assert.rejects(g.controller.selectReferences(),new RegExp(code));}finally{g.cleanup();}
  }
});
