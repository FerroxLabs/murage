import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {chmodSync,existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {BackupCoordinator} from "../server/backup-coordinator.ts";
import {createClosedBackupController,closedControlDirectory} from "./backup-closed-controller.mjs";
import {closedInstallationIdentity} from "./backup-closed-profile.mjs";
import {readClosedBackupStage} from "./backup-closed-jobs.mjs";
import {launchClosedCapture,runBackupScheduleTrigger} from "../scripts/backup-schedule-trigger.ts";
// Closed backup is POSIX-only: win32 descriptors are refused (backup-closed-profile.mjs,
// backup-closed-jobs.mjs). These cases need real POSIX owner uids and mode bits,
// which NTFS does not have; they run on the macOS and Ubuntu CI legs.
const POSIX_ONLY=process.platform==="win32"&&"closed backup owner and mode checks are POSIX-only";

function fixture(t,{volume=()=>null}={}){
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-closed-controller-")));t.after(()=>safeWipeSync(root));
  const installation=path.join(root,"data"),userData=path.join(root,"user"),executable=path.join(root,"Murage"),triggerSource=path.join(root,"bundled-trigger.js");
  for(const dir of [installation,userData])mkdirSync(dir,{mode:0o700});
  writeFileSync(executable,"never execute this fixture",{mode:0o700});writeFileSync(triggerSource,"export const fixture=true;",{mode:0o600});
  const profile={version:1,platform:process.platform,owner:{uid:process.getuid()},requestedRoot:installation,userData,installation,installationIdentity:closedInstallationIdentity(installation),executable};
  let clock=Date.parse("2026-09-13T08:00:00Z");
  const coordinator=new BackupCoordinator({stateDirectory:closedControlDirectory(installation),now:()=>clock});let current=null,consent=true,installs=0,removes=0;
  const provider={supported:true,read:async()=>current,install:async job=>{installs++;current={jobId:job.jobId,owner:job.owner,files:job.files,registered:true,running:false};},remove:async()=>{assert.equal(coordinator.status().enabled,false);removes++;current=null;}};
  const controller=createClosedBackupController({profile:()=>profile,triggerSource,backupSupported:()=>true,provider,backup:()=>({internalStatus:()=>coordinator.status(),configure:async(rev,s)=>coordinator.configure(rev,s)}),confirmInstall:async()=>consent,volumeProblem:()=>volume()});
  const stage=()=>{const control=closedControlDirectory(installation),pointer=JSON.parse(readFileSync(path.join(control,"closed-job-pointer.json")));return readClosedBackupStage(path.join(control,pointer.directory));};
  return{root,profile,provider,controller,coordinator,stage,now:()=>clock,setNow:value=>{clock=value;},installs:()=>installs,removes:()=>removes,setConsent:value=>{consent=value;},setCurrent:value=>{current=value;},getCurrent:()=>current};
}
test("controller stages private stable trigger without registration and needs native confirmation/readback",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);assert.equal((await f.controller.status()).state,"unconfigured");assert.equal((await f.controller.stage()).state,"staged");assert.equal(f.installs(),0);
  const stage=f.stage();assert.ok(stage.descriptor.triggerEntry.startsWith(closedControlDirectory(f.profile.installation)));assert.match(path.basename(stage.descriptor.triggerEntry),/^closed-trigger-[a-f0-9]{64}\.mjs$/);
  assert.equal(JSON.stringify(await f.controller.status()).includes(f.root),false);
  f.setConsent(false);assert.equal((await f.controller.install()).cancelled,true);assert.equal(f.installs(),0);
  f.setConsent(true);assert.equal((await f.controller.install()).state,"installed");assert.equal(f.installs(),1);
  await f.controller.assertInvocation(stage.descriptor,stage.descriptorPath);
  await f.controller.install();assert.equal(f.installs(),1);
});
test("an upgrade re-stages the registered job onto the new trigger without asking again",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);
  await f.controller.stage();await f.controller.install();
  const before=f.stage();assert.equal(f.installs(),1);
  // The app is upgraded: the bundled trigger is now a different file.
  const upgraded="export const fixture='upgraded';";
  writeFileSync(path.join(f.root,"bundled-trigger.js"),upgraded,{mode:0o600});
  // Ordinary staging refuses a changed descriptor, which is why the job used
  // to keep running the previous version's trigger indefinitely.
  await assert.rejects(f.controller.stage());
  assert.equal(f.stage().descriptor.triggerSha256,before.descriptor.triggerSha256);
  // Nothing asks again: consent was given once and is not re-sought.
  f.setConsent(false);
  assert.equal((await f.controller.restageForUpgrade()).state,"installed");
  const after=f.stage();
  assert.notEqual(after.descriptor.triggerSha256,before.descriptor.triggerSha256);
  assert.equal(readFileSync(after.descriptor.triggerEntry,"utf8"),upgraded);
  // The superseded trigger is not left in the data folder.
  assert.equal(existsSync(before.descriptor.triggerEntry),false);
  // The job the system now holds is the new one.
  assert.equal(f.installs(),2);assert.equal(f.removes(),1);
  assert.deepEqual(f.getCurrent().files,after.files);
  await f.controller.assertInvocation(after.descriptor,after.descriptorPath);
  // Running it again with the same app changes nothing at all.
  assert.equal((await f.controller.restageForUpgrade()).state,"installed");
  assert.equal(f.installs(),2);assert.equal(f.removes(),1);
});
test("an upgrade re-stages a job that was prepared but never registered, and registers nothing",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);
  await f.controller.stage();const before=f.stage();
  writeFileSync(path.join(f.root,"bundled-trigger.js"),"export const fixture='second';",{mode:0o600});
  assert.equal((await f.controller.restageForUpgrade()).state,"staged");
  assert.notEqual(f.stage().descriptor.triggerSha256,before.descriptor.triggerSha256);
  assert.equal(f.installs(),0);assert.equal(f.removes(),0);
});
test("nothing staged is left alone by the upgrade re-stage",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);
  assert.equal((await f.controller.restageForUpgrade()).state,"unconfigured");
  assert.equal(f.installs(),0);
});
test("status names a data folder other accounts can write to instead of a generic refusal",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);chmodSync(f.profile.installation,0o775);
  assert.deepEqual(await f.controller.status(),{supported:true,closedApp:false,lastClosedResult:undefined,state:"unavailable",blocked:"data-folder-shared"});
  await assert.rejects(f.controller.stage());
  chmodSync(f.profile.installation,0o700);
  const status=await f.controller.status();assert.equal(status.state,"unconfigured");assert.equal("blocked" in status,false);
});
test("controller rejects changed registration/stage and disables before running removal is deferred",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);await f.controller.stage();await f.controller.install();
  f.setCurrent({...f.getCurrent(),running:true});assert.equal((await f.controller.disable()).state,"disabled-removal-pending");assert.equal(f.removes(),0);
  f.setCurrent({...f.getCurrent(),running:false,files:[{name:"foreign",text:"keep"}]});await assert.rejects(f.controller.assertInstalled());assert.equal((await f.controller.status()).state,"unavailable");
  const staged=f.stage();writeFileSync(path.join(staged.directory,staged.files[0].name),"changed",{mode:0o600});await assert.rejects(f.controller.stage());assert.equal(f.removes(),0);
});
test("real lightweight entry validates staged registration and same coordinator before due launch",{skip:POSIX_ONLY},async t=>{
  const f=fixture(t);await f.controller.stage();await f.controller.install();const staged=f.stage();let launches=0;
  const options={provider:f.provider,now:f.now,environment:{ELECTRON_RUN_AS_NODE:"1",TOKEN:"private",DISPLAY:":0"},launch:async invoke=>{launches++;assert.equal(invoke.env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(invoke.env.TOKEN,undefined);return{status:"verified"};}};
  assert.equal((await runBackupScheduleTrigger(["--murage-backup-descriptor",staged.descriptorPath],options)).status,"disabled");assert.equal(launches,0);
  f.coordinator.configure(0,{enabled:true,closedApp:true,installationRef:"installation",destinationRef:"destination",recoveryRef:"recovery",timezone:"UTC",time:"09:00",catchupMs:60000,maxBytes:1000,maxDurationMs:1000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}});
  f.setNow(Date.parse("2026-09-13T09:00:30Z"));
  assert.equal((await runBackupScheduleTrigger(["--murage-backup-descriptor",staged.descriptorPath],options)).status,"verified");assert.equal(launches,1);
  f.setCurrent({...f.getCurrent(),registered:false});assert.equal((await runBackupScheduleTrigger(["--murage-backup-descriptor",staged.descriptorPath],options)).status,"unavailable");assert.equal(launches,1);
});
test("capture launcher waits for actual close and accepts only bounded structured success",async()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;
  let resolved=false;const running=launchClosedCapture({executable:"never",args:[],env:{}},{spawnChild:()=>child}).then(value=>{resolved=true;return value;});
  child.stdout.emit("data",Buffer.from('{"type":"murage:closed-backup-result","status":"verified"}\n'));await Promise.resolve();assert.equal(resolved,false);
  child.emit("close",0);assert.deepEqual(await running,{status:"verified",confirmed:true});
});
test("capture launcher marks a launch that ends without its result line as unconfirmed",async()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;
  const running=launchClosedCapture({executable:"never",args:[],env:{}},{spawnChild:()=>child});
  child.emit("close",null,"SIGTRAP");assert.deepEqual(await running,{status:"needs-review",confirmed:false});
});
const dueFixture=t=>{const f=fixture(t);return f.controller.stage().then(()=>f.controller.install()).then(()=>{
  f.coordinator.configure(0,{enabled:true,closedApp:true,installationRef:"installation",destinationRef:"destination",recoveryRef:"recovery",timezone:"UTC",time:"09:00",catchupMs:60000,maxBytes:1000,maxDurationMs:1000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}});
  f.setNow(Date.parse("2026-09-13T09:00:30Z"));return f;});};
test("a due closed backup whose launch dies without a result is recorded as needing review",{skip:POSIX_ONLY},async t=>{
  const f=await dueFixture(t),descriptor=f.stage().descriptorPath;
  const crashed=async()=>({status:"needs-review",confirmed:false});
  assert.equal((await runBackupScheduleTrigger(["--murage-backup-descriptor",descriptor],{provider:f.provider,now:f.now,environment:{DISPLAY:":0"},launch:crashed})).status,"needs-review");
  assert.deepEqual(f.coordinator.status().lastClosedResult,{status:"needs-review",reason:"capture-unconfirmed",at:f.now(),revision:1});
  // A capture that recorded its own result before dying keeps that result.
  f.setNow(f.now()+1000);
  const recordedThenDied=async()=>{f.coordinator.recordClosedResult({status:"verified"});return{status:"needs-review",confirmed:false};};
  await runBackupScheduleTrigger(["--murage-backup-descriptor",descriptor],{provider:f.provider,now:f.now,environment:{DISPLAY:":0"},launch:recordedThenDied});
  assert.equal(f.coordinator.status().lastClosedResult.status,"verified");
});
test("on Linux a due closed backup with no desktop session waits and says why instead of launching",{skip:POSIX_ONLY},async t=>{
  const f=await dueFixture(t),descriptor=f.stage().descriptorPath;let launches=0;
  const launch=async()=>{launches++;return{status:"verified",confirmed:true};};
  const run=environment=>runBackupScheduleTrigger(["--murage-backup-descriptor",descriptor],{provider:f.provider,now:f.now,environment,launch,platform:"linux"});
  assert.deepEqual(await run({HOME:"/home/me"}),{status:"unavailable"});assert.equal(launches,0);
  const first=f.coordinator.status().lastClosedResult;
  assert.deepEqual(first,{status:"unavailable",reason:"capability-unavailable",at:f.now(),revision:1});
  // Checked again while it waits: the same result is not rewritten.
  f.setNow(f.now()+20000);await run({HOME:"/home/me"});assert.deepEqual(f.coordinator.status().lastClosedResult,first);
  assert.equal((await run({WAYLAND_DISPLAY:"wayland-0"})).status,"verified");assert.equal(launches,1);
  // Other platforms do not depend on these variables.
  assert.equal((await runBackupScheduleTrigger(["--murage-backup-descriptor",descriptor],{provider:f.provider,now:f.now,environment:{},launch,platform:"darwin"})).status,"verified");
});

const main=readFileSync(new URL("./main.mjs",import.meta.url),"utf8"),parsed=ts.createSourceFile("main.mjs",main,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function actualFunction(name){const found=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(found);return found.getText(parsed);}
test("actual closed finish waits for cleanup and exits once without recovery or relaunch",async()=>{
  const calls=[];let release;
  const traces=[];const context=vm.createContext({closedTrace:stage=>traces.push(stage),desktopCleanupStage:"",closedBackupFinish:null,cleanupDesktopForExit:()=>new Promise(resolve=>{release=resolve;}),writeClosedBackupResult:status=>calls.push({type:"murage:closed-backup-result",status}),app:{exit:code=>calls.push(code)}});
  vm.runInContext(actualFunction("finishClosedBackup"),context);
  const first=context.finishClosedBackup({status:"verified"});assert.equal(context.finishClosedBackup({status:"unavailable"}),first);assert.deepEqual(calls,[]);release();await first;
  assert.deepEqual(calls,[{type:"murage:closed-backup-result",status:"verified"},0]);
  // A closed run leaves how far it got in its own log (stage names only).
  assert.deepEqual(traces,["finishing","cleaned up"]);
});
test("actual startup fences closed invocation before normal writers and selected protected path precedes refs",async()=>{
  const start=main.slice(main.indexOf("const desktopStartup ="));assert.ok(start.indexOf("if(closedBackupRequested)")<start.indexOf("createServerConnections"));assert.ok(start.indexOf("if(closedBackupRequested)")<start.indexOf("migrateLegacyDataDirectory"));
  const initialize=actualFunction("initializeBackupScheduleHost");assert.ok(initialize.indexOf("CREDENTIALS_FILE=selectedProfile.credentialsFile")<initialize.indexOf("readProtected:"));assert.ok(initialize.includes("desktopDataOwner.utilityServerLeaseEnvironment()"));assert.ok(initialize.includes("assertInvocation(closedBackupDescriptor,closedBackupInvocation.descriptorPath)"));
  const second=main.slice(main.indexOf('app.on("second-instance"'),main.indexOf("// Packaged: the harness"));assert.ok(second.indexOf("CLOSED_DUE_FLAG")<second.indexOf("activateExistingWindow"));
  assert.ok(main.indexOf("parseClosedBackupArguments(process.argv.slice(1))")<main.indexOf("app.requestSingleInstanceLock()"));
  const declaration=parsed.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(value=>value.name.getText(parsed)==="desktopStartup"));assert.ok(declaration);
  const calls=[];
  const traced=[];
  const context=vm.createContext({closedTrace:stage=>traced.push(stage),app:{whenReady:()=>Promise.resolve()},assertDesktopStartupActive:()=>{},closedBackupRequested:true,desktopRecoveryMode:false,
    acquireDesktopDataOwner:()=>calls.push("owner"),initializeBackupScheduleHost:async()=>calls.push("host"),
    // A slow first tool check must not turn the closed-app run into "unavailable".
    desktopBackupTool:{waitReady:async()=>{calls.push("tool");}},
    backupScheduleHost:{runClosedDue:async()=>{calls.push("capture");return{status:"verified"};}},finishClosedBackup:result=>calls.push(result.status),
    createServerConnections:()=>assert.fail("normal startup must not run"),
  });
  vm.runInContext(declaration.getText(parsed),context);await vm.runInContext("desktopStartup",context);for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,["owner","host","tool","capture","verified"]);assert.equal(context.desktopRecoveryMode,true);
  assert.deepEqual(traced,["ready","owner","host","run","result verified"]);
  let handler,focused=0;const secondStatement=parsed.statements.find(node=>node.getText(parsed).startsWith('app.on("second-instance"'));
  vm.runInNewContext(secondStatement.getText(parsed),{app:{on:(_event,callback)=>{handler=callback;}},CLOSED_DUE_FLAG:"--murage-backup-due",CLOSED_DESCRIPTOR_FLAG:"--murage-backup-descriptor",activateExistingWindow:()=>focused++});
  handler({},["fixture-exe","--murage-backup-due"]);assert.equal(focused,0);
});

// Backups while Murage is closed, from a volume a background job can't read
// (electron/backup-closed-volume.mjs): the job used to hang on its first read
// of the app's or the data folder's files until the 32-minute timeout.
test("a background job on a volume launchd can't read is refused, taken down, and a registered run ends at once",{skip:POSIX_ONLY},async t=>{
  let volume=null;
  const f=fixture(t,{volume:()=>volume});
  volume="app";
  assert.deepEqual({state:(await f.controller.status()).state,blocked:(await f.controller.status()).blocked},{state:"unavailable",blocked:"volume-app"});
  await assert.rejects(f.controller.stage(),/BACKUP_CLOSED_VOLUME_UNREADABLE/);assert.equal(f.installs(),0);
  // Registered while the app was on this Mac's own disk, then moved: the next
  // start takes the job down instead of leaving it to hang every day.
  volume=null;await f.controller.stage();await f.controller.install();assert.equal(f.installs(),1);
  volume="data";await assert.rejects(f.controller.install(),/BACKUP_CLOSED_VOLUME_UNREADABLE/);
  const after=await f.controller.restageForUpgrade();assert.equal(f.removes(),1);assert.equal(after.blocked,"volume-data");
  assert.equal(f.getCurrent(),null);
});
test("a due closed run whose app is on another volume ends without launching and says why",{skip:POSIX_ONLY},async t=>{
  const f=await dueFixture(t),descriptor=f.stage().descriptorPath;let launches=0;
  const launch=async()=>{launches++;return{status:"verified",confirmed:true};};
  const started=Date.now();
  const result=await runBackupScheduleTrigger(["--murage-backup-descriptor",descriptor],{provider:f.provider,now:f.now,environment:{DISPLAY:":0"},launch,volumeProblem:()=>"app"});
  assert.equal(result.status,"unavailable");assert.equal(launches,0);assert.ok(Date.now()-started<5000);
  assert.deepEqual(f.coordinator.status().lastClosedResult,{status:"unavailable",reason:"volume-unreadable",at:f.now(),revision:1});
  // With the default check and real volume facts, this Mac's own disk passes.
  assert.equal((await runBackupScheduleTrigger(["--murage-backup-descriptor",descriptor],{provider:f.provider,now:f.now,environment:{DISPLAY:":0"},launch})).status,"verified");assert.equal(launches,1);
});
