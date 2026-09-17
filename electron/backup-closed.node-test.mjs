import assert from "node:assert/strict";
import {test,afterEach} from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync,symlinkSync,chmodSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {CLOSED_DUE_FLAG,CLOSED_DESCRIPTOR_FLAG,parseClosedBackupDescriptor,closedInstallationIdentity,closedDescriptorDigest,closedProfileId,closedInvocation,parseClosedBackupArguments,closedProfileEnvironment,assertClosedProfileBinding,readClosedBackupDescriptor,closedTriggerDigest} from "./backup-closed-profile.mjs";
import {buildClosedBackupJob,stageClosedBackupJob,readClosedBackupStage,removeClosedBackupStage,installClosedBackupJob,disableClosedBackupJob} from "./backup-closed-jobs.mjs";
import {runClosedBackupTrigger} from "./backup-closed-trigger.mjs";
// Closed backup is POSIX-only: win32 descriptors are refused (backup-closed-profile.mjs,
// backup-closed-jobs.mjs). These cases need real POSIX owner uids and mode bits,
// which NTFS does not have; they run on the macOS and Ubuntu CI legs.
const POSIX_ONLY=process.platform==="win32"&&"closed backup owner and mode checks are POSIX-only";
const roots=[];afterEach(()=>{for(const root of roots.splice(0))safeWipeSync(root);});
function fixture(){
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-closed-job-fixture-")));roots.push(root);
  const requestedRoot=path.join(root,"data"),userData=path.join(root,"user"),stagingRoot=path.join(root,"staged"),executable=path.join(root,"Murage executable"),triggerEntry=path.join(root,"trigger.cjs");
  for(const directory of [requestedRoot,userData,stagingRoot])mkdirSync(directory,{mode:0o700});
  writeFileSync(executable,"Synthetic never-executed binary",{mode:0o700});writeFileSync(triggerEntry,"throw Error('Synthetic trigger must never execute');",{mode:0o600});
  const descriptor={version:1,platform:process.platform,requestedRoot,userData,installation:requestedRoot,installationIdentity:closedInstallationIdentity(requestedRoot),owner:{uid:process.getuid()},executable,triggerEntry,triggerSha256:closedTriggerDigest(triggerEntry)};
  return{root,stagingRoot,descriptor,stage:()=>stageClosedBackupJob(descriptor,{stagingRoot,backupSupported:true})};
}
test("strict descriptor binds only canonical profile, owner and trigger facts",{skip:POSIX_ONLY},()=>{
 const f=fixture(),d=f.descriptor;assert.deepEqual(parseClosedBackupDescriptor(d),d);assert.equal(closedDescriptorDigest(d),closedDescriptorDigest(JSON.stringify(d)));assert.equal(closedProfileId(d),closedProfileId({...d,triggerSha256:"a".repeat(64)}));
 for(const bad of [{...d,key:"PRIVATE_KEY_CANARY"},{...d,destination:"/private/archive"},{...d,owner:{uid:0}},{...d,userData:d.requestedRoot},{...d,installationIdentity:"bad"},{...d,triggerSha256:"bad"},{...d,requestedRoot:"/safe/../other"},{...d,triggerEntry:"/tmp/.mount_fixture/trigger.cjs"},{...d,executable:"/private/AppTranslocation/id/Murage"},{...d,userData:"/bad\nInjected=1"},"x".repeat(16385)])assert.throws(()=>parseClosedBackupDescriptor(bad));
 const win={...d,platform:"win32",requestedRoot:"C:\\Data",userData:"C:\\User",installation:"C:\\Data",owner:{sid:"S-1-5-21-1-2-3-1001"},executable:"C:\\App\\Murage.exe",triggerEntry:"C:\\User\\trigger.cjs"};assert.deepEqual(parseClosedBackupDescriptor(win),win);assert.equal(buildClosedBackupJob(win,"C:\\User\\descriptor.json",{backupSupported:true}).supported,false);
});
test("closed argv and environments reproduce both profile selectors and refuse drift",{skip:POSIX_ONLY},()=>{
 const f=fixture(),descriptorPath=path.join(f.root,"descriptor.json"),d=f.descriptor;
 const capture=closedInvocation(d,descriptorPath,{environment:{HOME:f.root,PATH:"/usr/bin",ELECTRON_RUN_AS_NODE:"1",NODE_OPTIONS:"PRIVATE_FLAGS",TOKEN:"PRIVATE_SECRET"}});
 assert.deepEqual(capture.args,[CLOSED_DUE_FLAG,CLOSED_DESCRIPTOR_FLAG,descriptorPath,"--murage-data-dir",d.requestedRoot,"--murage-user-data",d.userData]);assert.equal(capture.env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(capture.env.NODE_OPTIONS,undefined);assert.equal(capture.env.TOKEN,undefined);
 const parsed=parseClosedBackupArguments(capture.args);assert.deepEqual(closedProfileEnvironment(parsed,d,{}),{MURAGE_DATA_DIR:d.requestedRoot,MURAGE_USER_DATA:d.userData});assert.throws(()=>closedProfileEnvironment(parsed,d,{MURAGE_DATA_DIR:"/foreign"}));assert.throws(()=>closedInvocation(d,descriptorPath,{environment:{MURAGE_USER_DATA:"/foreign"}}));
 for(const args of [[...capture.args,"--murage-login"],[...capture.args,CLOSED_DUE_FLAG],[CLOSED_DESCRIPTOR_FLAG,descriptorPath],[CLOSED_DUE_FLAG,"--unknown","x"],capture.args.map(value=>value===d.userData?"relative":value)])assert.throws(()=>parseClosedBackupArguments(args));
 assert.equal(parseClosedBackupArguments(Array(30).fill("--ordinary")),null);
 const trigger=closedInvocation(d,descriptorPath,{mode:"trigger"});assert.deepEqual(trigger.args,[d.triggerEntry,CLOSED_DESCRIPTOR_FLAG,descriptorPath]);assert.deepEqual(trigger.env,{ELECTRON_RUN_AS_NODE:"1"});
});
test("profile validation re-resolves default and restored selection and checks current owner/artifact",{skip:POSIX_ONLY},()=>{
 const f=fixture(),d=f.descriptor;assert.deepEqual(assertClosedProfileBinding(d),d);
 const selected=path.join(f.root,"selected");mkdirSync(selected,{mode:0o700});const restored={...d,installation:selected,installationIdentity:closedInstallationIdentity(selected)};let calls=0;
 assert.deepEqual(assertClosedProfileBinding(restored,{resolveSelection:(user,requested)=>{calls++;assert.equal(user,d.userData);assert.equal(requested,d.requestedRoot);return{dataDirectory:selected,selected:true};}}),restored);assert.equal(calls,1);
 assert.throws(()=>assertClosedProfileBinding(restored));assert.throws(()=>assertClosedProfileBinding(d,{owner:{uid:d.owner.uid+1}}));assert.throws(()=>assertClosedProfileBinding({...d,installationIdentity:"a".repeat(64)}));
 writeFileSync(d.triggerEntry,"changed",{mode:0o600});assert.throws(()=>assertClosedProfileBinding(d));
});
test("private descriptor reader rejects links, broad permissions and oversized metadata",{skip:POSIX_ONLY},()=>{
 const f=fixture(),file=path.join(f.root,"descriptor.json");writeFileSync(file,JSON.stringify(f.descriptor),{mode:0o600});assert.deepEqual(readClosedBackupDescriptor(file),f.descriptor);
 const link=path.join(f.root,"linked.json");symlinkSync(file,link);assert.throws(()=>readClosedBackupDescriptor(link));chmodSync(file,0o644);assert.throws(()=>readClosedBackupDescriptor(file));chmodSync(file,0o600);writeFileSync(file,"x".repeat(16385));assert.throws(()=>readClosedBackupDescriptor(file));
});
test("per-user job definitions escape directives and never reuse sign-in/system-server jobs",{skip:POSIX_ONLY},()=>{
 const f=fixture(),d={...f.descriptor,platform:"darwin",executable:'/Applications/Murage & <safe> "quoted".app/Murage'};
 const mac=buildClosedBackupJob(d,path.join(f.root,"descriptor & file.json"),{backupSupported:true});assert.equal(mac.files.length,1);assert.match(mac.files[0].text,/&amp; &lt;safe&gt; &quot;quoted&quot;/);assert.match(mac.files[0].text,/<key>StartInterval<\/key><integer>60<\/integer>/);assert.match(mac.files[0].text,/<string>Aqua<\/string>/);assert.ok(!mac.files[0].text.includes("--murage-login"));
 const linux=buildClosedBackupJob({...f.descriptor,platform:"linux",executable:"/opt/Murage % edition/Murage",triggerEntry:"/home/owner/trigger $ safe.cjs"},"/home/owner/profile %/descriptor.json",{backupSupported:true});assert.equal(linux.files.length,2);assert.match(linux.files[0].text,/Murage %% edition/);assert.match(linux.files[0].text,/trigger \$\$ safe/);assert.match(linux.files[0].text,/Type=oneshot/);assert.match(linux.files[1].text,/OnStartupSec=10s\nOnUnitActiveSec=60s/);assert.match(linux.files[1].text,/WantedBy=timers.target/);
 assert.ok(!JSON.stringify(linux).match(/User=root|murage\.service|Restart=always|--murage-login|prune|password/i));assert.throws(()=>buildClosedBackupJob({...f.descriptor,platform:"linux",executable:'/opt/Murage "bad"'},"/home/owner/descriptor.json",{backupSupported:true}));assert.equal(buildClosedBackupJob(f.descriptor,"/safe/descriptor.json").supported,false);
});
test("private stages are idempotent, exact and never labelled installed",{skip:POSIX_ONLY},()=>{
 const f=fixture(),stage=f.stage();assert.equal(stage.state,"staged");assert.equal(stage.directory,realpathSync.native(stage.directory));assert.equal(lstatSync(stage.directory).mode&0o777,0o700);assert.equal(lstatSync(stage.descriptorPath).mode&0o777,0o600);assert.deepEqual(f.stage(),stage);
 assert.throws(()=>stageClosedBackupJob({...f.descriptor,triggerSha256:"a".repeat(64)},{stagingRoot:f.stagingRoot,backupSupported:true}));writeFileSync(path.join(stage.directory,stage.files[0].name),"FOREIGN",{mode:0o600});assert.throws(()=>readClosedBackupStage(stage.directory));assert.throws(()=>removeClosedBackupStage(stage.directory));
});
test("foreign stage collision is refused and narrow stage removal preserves sibling evidence",{skip:POSIX_ONLY},()=>{
 const f=fixture(),directory=path.join(f.stagingRoot,`closed-${closedProfileId(f.descriptor)}`);mkdirSync(directory,{mode:0o700});writeFileSync(path.join(directory,"foreign.txt"),"keep",{mode:0o600});assert.throws(()=>f.stage());assert.equal(readFileSync(path.join(directory,"foreign.txt"),"utf8"),"keep");
 const other=fixture(),stage=other.stage(),receipt=path.join(other.stagingRoot,"verified-receipt.json");writeFileSync(receipt,"preserve",{mode:0o600});assert.deepEqual(removeClosedBackupStage(stage.directory),{state:"removed"});assert.equal(existsSync(stage.directory),false);assert.equal(readFileSync(receipt,"utf8"),"preserve");
});
function registration(job,{registered=true,running=false}={}){return{jobId:job.jobId,owner:job.owner,files:job.files,registered,running};}
test("injected install requires exact OS readback and refuses foreign definitions",{skip:POSIX_ONLY},async()=>{
 const f=fixture(),stage=f.stage();let current=null,installs=0;const adapter={read:async()=>current,install:async(job,{expected})=>{assert.equal(expected,null);installs++;current=registration(job);}};
 assert.equal((await installClosedBackupJob(stage,adapter)).state,"installed");assert.equal((await installClosedBackupJob(stage,adapter)).state,"installed");assert.equal(installs,1);
 current={...current,files:[{name:"foreign",text:"FOREIGN"}]};await assert.rejects(installClosedBackupJob(stage,adapter));assert.equal(installs,1);
 current=null;await assert.rejects(installClosedBackupJob(stage,{read:async()=>null,install:async()=>{}}));
});
test("disable precedes exact removal, never kills running work and preserves stage/receipts",{skip:POSIX_ONLY},async()=>{
 const f=fixture(),stage=f.stage();let current=registration(stage),disabled=false,removed=0;const adapter={disableSchedule:async()=>{disabled=true;},read:async()=>{assert.equal(disabled,true);return current;},remove:async(job,{expected})=>{assert.deepEqual(expected,current);assert.equal(job.jobId,stage.jobId);removed++;current=null;}};
 assert.deepEqual(await disableClosedBackupJob(stage,adapter),{state:"disabled"});assert.equal(removed,1);assert.equal(existsSync(stage.descriptorPath),true);
 current=registration(stage,{running:true});assert.deepEqual(await disableClosedBackupJob(stage,adapter),{state:"disabled-removal-pending"});assert.equal(removed,1);
 current=registration(stage);assert.deepEqual(await disableClosedBackupJob(stage,{...adapter,remove:async()=>{throw Error("PRIVATE_OS_CANARY");}}),{state:"disabled-removal-pending"});assert.equal(existsSync(stage.descriptorPath),true);
});
test("lightweight trigger uses same coordinator hint and launches only admitted due work",{skip:POSIX_ONLY},async()=>{
 const f=fixture(),descriptorPath=path.join(f.root,"descriptor.json");writeFileSync(descriptorPath,JSON.stringify(f.descriptor),{mode:0o600});let launches=0,eligibility="disabled",registrationValid=true;
 const options={descriptorPath,environment:{TOKEN:"PRIVATE_SECRET",NODE_OPTIONS:"PRIVATE_FLAGS"},validateRegistration:async()=>registrationValid,createCoordinator:async()=>({closedEligibility:()=>({status:eligibility})}),launch:async invocation=>{launches++;assert.equal(invocation.executable,f.descriptor.executable);assert.equal(invocation.args[0],CLOSED_DUE_FLAG);assert.equal(invocation.env.TOKEN,undefined);assert.equal(invocation.env.NODE_OPTIONS,undefined);assert.equal(invocation.env.ELECTRON_RUN_AS_NODE,undefined);return{status:"verified"};}};
 for(const status of ["disabled","not-due","needs-review"]){eligibility=status;assert.deepEqual(await runClosedBackupTrigger(options),{status});}assert.equal(launches,0);
 eligibility="due";registrationValid=false;assert.deepEqual(await runClosedBackupTrigger(options),{status:"unavailable"});assert.equal(launches,0);registrationValid=true;assert.deepEqual(await runClosedBackupTrigger(options),{status:"verified"});assert.equal(launches,1);
 eligibility="unexpected";assert.deepEqual(await runClosedBackupTrigger(options),{status:"needs-review"});assert.equal(launches,1);eligibility="due";assert.deepEqual(await runClosedBackupTrigger({...options,launch:async()=>({exitCode:0})}),{status:"needs-review"});
});
