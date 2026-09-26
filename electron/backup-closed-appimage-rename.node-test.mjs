// A hand-downloaded AppImage (0.1.60 audit L-F3). The closed-app job binds the
// exact AppImage path. The in-app updater keeps the path (electron-updater
// writes over process.env.APPIMAGE), but an AppImage fetched by hand carries a
// new versioned name (artifactName Murage-${version}-${arch}.AppImage), so the
// job used to be stranded: readStage refused the changed profile,
// restageForUpgrade swallowed it and disable() removed nothing.
import assert from "node:assert/strict";
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {BackupCoordinator} from "../server/backup-coordinator.ts";
import {createClosedBackupController,closedControlDirectory} from "./backup-closed-controller.mjs";
import {closedInstallationIdentity} from "./backup-closed-profile.mjs";
import {readClosedBackupStage} from "./backup-closed-jobs.mjs";

const POSIX_ONLY=process.platform==="win32"&&"closed backup owner and mode checks are POSIX-only";

function fixture(t){
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"closed-appimage-rename-")));t.after(()=>safeWipeSync(root));
  const installation=path.join(root,"data"),userData=path.join(root,"user"),triggerSource=path.join(root,"bundled-trigger.js");
  const oldImage=path.join(root,"Murage-0.1.60-x86_64.AppImage"),newImage=path.join(root,"Murage-0.1.61-x86_64.AppImage");
  for(const dir of [installation,userData])mkdirSync(dir,{mode:0o700});
  for(const file of [oldImage,newImage])writeFileSync(file,"never execute",{mode:0o755});
  writeFileSync(triggerSource,"export const fixture=true;",{mode:0o600});
  const profile={version:1,platform:process.platform,owner:{uid:process.getuid()},requestedRoot:installation,userData,installation,installationIdentity:closedInstallationIdentity(installation),executable:oldImage};
  const coordinator=new BackupCoordinator({stateDirectory:closedControlDirectory(installation),now:()=>Date.parse("2026-09-26T08:00:00Z")});
  const counts={installs:0,removes:0};let current=null;
  const provider={supported:true,read:async()=>current,install:async job=>{counts.installs++;current={jobId:job.jobId,owner:job.owner,files:job.files,registered:true,running:false};},remove:async()=>{counts.removes++;current=null;}};
  const controller=createClosedBackupController({profile:()=>profile,triggerSource,backupSupported:()=>true,provider,backup:()=>({internalStatus:()=>coordinator.status(),configure:async(rev,s)=>coordinator.configure(rev,s)}),confirmInstall:async()=>true});
  const control=closedControlDirectory(installation);
  const staged=()=>{const pointer=JSON.parse(readFileSync(path.join(control,"closed-job-pointer.json")));return readClosedBackupStage(path.join(control,pointer.directory));};
  const registeredFor=()=>current?.files?.[0]?.text.match(/Murage-0\.1\.6\d-x86_64\.AppImage/)?.[0];
  return{root,oldImage,newImage,profile,controller,counts,staged,registeredFor,getCurrent:()=>current};
}

test("opening a hand-downloaded AppImage moves the registered job to it, and disable still removes it",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);
  await f.controller.stage();await f.controller.install();
  assert.equal(f.staged().descriptor.executable,f.oldImage);assert.equal(f.registeredFor(),"Murage-0.1.60-x86_64.AppImage");
  // Before Murage restages, the page does not claim the job is fine.
  f.profile.executable=f.newImage;
  assert.deepEqual(await f.controller.status(),{supported:true,closedApp:false,lastClosedResult:undefined,state:"unconfigured",blocked:"app-moved"});
  // main.mjs runs this at every start: the job follows the file now running.
  const after=await f.controller.restageForUpgrade();
  assert.equal(after.state,"installed");assert.equal(after.blocked,undefined);
  assert.equal(f.registeredFor(),"Murage-0.1.61-x86_64.AppImage");
  assert.equal(f.staged().descriptor.executable,f.newImage);
  assert.deepEqual(f.counts,{installs:2,removes:1},"the old job was taken down once and the new one registered");
  // Turning it off from the Backups page takes the (new) job down.
  assert.equal((await f.controller.disable()).state,"disabled");
  assert.equal(f.counts.removes,2);assert.equal(f.getCurrent(),null);
});

test("disable removes a job whose AppImage was replaced and the old file deleted",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);
  await f.controller.stage();await f.controller.install();
  rmSync(f.oldImage);f.profile.executable=f.newImage;
  const off=await f.controller.disable();
  assert.equal(f.counts.removes,1);assert.equal(f.getCurrent(),null);
  // Nothing is left prepared for the deleted file; the current app can be set up.
  assert.deepEqual({state:off.state,blocked:off.blocked},{state:"unconfigured",blocked:undefined});
  await f.controller.stage();assert.equal((await f.controller.install()).state,"installed");
  assert.equal(f.registeredFor(),"Murage-0.1.61-x86_64.AppImage");
});

test("a move that can't finish takes the old job down and says why, never a silent stop",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);
  await f.controller.stage();await f.controller.install();
  // The new download was made executable under umask 002.
  chmodSync(f.newImage,0o775);f.profile.executable=f.newImage;
  const after=await f.controller.restageForUpgrade();
  assert.equal(f.getCurrent(),null,"the old job no longer runs the old app on this data");
  assert.deepEqual({state:after.state,blocked:after.blocked,appFile:after.appFile},{state:"unavailable",blocked:"app-file-shared",appFile:f.newImage});
  // The person runs the command the page gives them; then it can be set up again.
  chmodSync(f.newImage,0o755);
  const fixed=await f.controller.status();
  assert.equal(fixed.state,"unconfigured");assert.equal(fixed.blocked,"app-moved");
  await f.controller.stage();assert.equal((await f.controller.install()).state,"installed");
  assert.equal(f.registeredFor(),"Murage-0.1.61-x86_64.AppImage");
  assert.equal((await f.controller.status()).blocked,undefined);
});
