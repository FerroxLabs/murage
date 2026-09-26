import test from "node:test";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import assert from "node:assert/strict";
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir,userInfo} from "node:os";
import path from "node:path";
import vm from "node:vm";
import {buildClosedBackupJob} from "./backup-closed-jobs.mjs";
import {createNativeClosedBackupProvider,CLOSED_MAC_QUERY,selectedMacJobEnabled} from "./backup-closed-native.mjs";
// Closed backup is POSIX-only: win32 descriptors are refused (backup-closed-profile.mjs,
// backup-closed-jobs.mjs). These cases need real POSIX owner uids and mode bits,
// which NTFS does not have; they run on the macOS and Ubuntu CI legs.
const POSIX_ONLY=process.platform==="win32"&&"closed backup owner and mode checks are POSIX-only";

// Frozen native-provider checks: all commands injected; actual roots are
// private, task-only temp directories. No OS manager/osascript invocation.
function fixture(platform){
  const home=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-closed-native-"))),owner={uid:userInfo().uid};
  const descriptor={version:1,platform,requestedRoot:path.join(home,"data"),userData:path.join(home,"desktop"),installation:path.join(home,"data"),installationIdentity:"a".repeat(64),owner,executable:path.join(home,"Installed Murage"),triggerEntry:path.join(home,"trigger.mjs"),triggerSha256:"b".repeat(64)};
  const descriptorPath=path.join(home,"stage","descriptor.json"),job={...buildClosedBackupJob(descriptor,descriptorPath,{backupSupported:true}),descriptor,descriptorPath};
  const root=path.join(home,...(platform==="darwin"?["Library","LaunchAgents"]:[".config","systemd","user"]));
  const calls=[],state={loaded:false,enabled:false,timerActive:false,running:false,unknown:false,pidMissing:false,overrideUnknown:false,foreign:false,dropin:false,reload:false,fail:"",race:false,result:"success",runFails:false,starts:0};
  const run=async request=>{
    calls.push(request);const args=request.args;
    if(request.executable==="/usr/bin/osascript"){
      assert.equal(args[3],CLOSED_MAC_QUERY);assert.equal(args[4],"--");assert.equal(args[5],job.jobId);const spec=JSON.parse(args[6]);assert.equal(spec.Label,job.jobId);assert.equal(spec.Program,descriptor.executable);assert.deepEqual(Object.keys(spec).sort(),["Label","LimitLoadToSessionType","OnDemand","Program","ProgramArguments"]);assert.equal(spec.OnDemand,true);assert.match(job.files[0].text,/<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
      return{code:0,stdout:JSON.stringify(state.unknown?{version:1,status:"found"}:state.foreign?{version:1,status:"foreign"}:state.loaded?{version:1,status:"found",pid:state.pidMissing?null:state.running?1234:0}:{version:1,status:"absent"})};
    }
    if(request.executable==="/bin/launchctl"){
      if(args[0]==="print-disabled"){assert.deepEqual(args,["print-disabled",`gui/${owner.uid}`]);return{code:0,stdout:state.overrideUnknown?"unrecognized format":`disabled services = {\n "foreign-private-label" => disabled\n "${job.jobId}" => ${state.enabled?"enabled":"disabled"}\n}\n`};}
      if(args[0]===state.fail)return{code:1,stdout:""};assert.ok(["enable","bootstrap","disable","bootout"].includes(args[0]));assert.equal(args[1],args[0]==="bootstrap"?`gui/${owner.uid}`:`gui/${owner.uid}/${job.jobId}`);
      if(args[0]==="enable")state.enabled=true;if(args[0]==="bootstrap"){state.loaded=true;state.enabled=true;}if(args[0]==="disable"){state.enabled=false;if(state.race)state.running=true;}if(args[0]==="bootout"){assert.equal(state.running,false);state.loaded=false;}return{code:0,stdout:""};
    }
    assert.equal(request.executable,"/usr/bin/systemctl");assert.equal(args[0],"--user");
    if(args[1]==="show"){
      const name=args.at(-1),kind=name.endsWith(".timer")?"timer":"service";assert.equal(name,`${job.jobId}.${kind}`);const selected=args.find(arg=>arg.startsWith("--property=")).slice(11).split(",");assert.ok(args.includes("--all"));
      const values={Id:name,LoadState:state.loaded?"loaded":"not-found",ActiveState:kind==="timer"?(state.timerActive?"active":"inactive"):(state.running?"active":"inactive"),SubState:kind==="timer"?(state.timerActive?"waiting":"dead"):(state.running?"running":"dead"),UnitFileState:kind==="timer"?(state.enabled?"enabled":"disabled"):"static",FragmentPath:state.loaded?path.join(root,name):"",DropInPaths:state.dropin?"/foreign/override.conf":"",NeedDaemonReload:state.reload?"yes":"no",MainPID:state.running?"1234":"0",Result:state.result,Triggers:state.loaded?`${job.jobId}.service`:""};
      if(state.foreign)values.FragmentPath="/foreign/unit";if(state.unknown)delete values.LoadState;
      return{code:0,stdout:selected.filter(key=>values[key]!==undefined).map(key=>`${key}=${values[key]}`).join("\n")+"\n"};
    }
    if(args[1]===state.fail)return{code:1,stdout:""};assert.ok(["daemon-reload","enable","disable","stop","start","reset-failed"].includes(args[1]));
    if(args[1]==="daemon-reload")state.loaded=job.files.every(file=>existsSync(path.join(root,file.name)));
    else if(args[1]==="start"){assert.equal(args.at(-1),`${job.jobId}.service`);assert.ok(request.timeoutMs>=60000,"the proving run gets its own longer bound");state.starts++;state.result=state.runFails?"exit-code":"success";return{code:state.runFails?3:0,stdout:""};}
    else if(args[1]==="reset-failed"){assert.equal(args.at(-1),`${job.jobId}.service`);state.result="success";}
    else{assert.equal(args.at(-1),`${job.jobId}.timer`);if(args[1]==="enable"){assert.ok(args.includes("--now"));state.enabled=true;state.timerActive=true;}if(args[1]==="disable"){assert.equal(args.includes("--now"),false);state.enabled=false;if(state.race)state.running=true;}if(args[1]==="stop")state.timerActive=false;}
    return{code:0,stdout:""};
  };
  const provider=createNativeClosedBackupProvider({platform,owner,home,run});
  const stage=()=>{mkdirSync(root,{recursive:true,mode:0o700});for(const file of job.files)writeFileSync(path.join(root,file.name),file.text,{mode:0o600});};
  return{home,owner,root,job,state,calls,provider,stage,cleanup:()=>safeWipeSync(home)};
}
for(const platform of ["darwin","linux"]){
  test(`${platform}: exact owned install/readback/remove uses only injected targeted operations`,{skip:POSIX_ONLY},async()=>{
    const f=fixture(platform);try{assert.equal(f.provider.supported,true);assert.equal(await f.provider.read(f.job),null);await f.provider.install(f.job,{expected:null});const current=await f.provider.read(f.job);assert.equal(current.registered,true);assert.deepEqual(current.files,f.job.files);assert.equal(current.running,false);for(const file of f.job.files)assert.equal(readFileSync(path.join(f.root,file.name),"utf8"),file.text);await f.provider.remove(f.job,{expected:current});assert.equal(await f.provider.read(f.job),null);assert.equal(f.calls.some(call=>call.args.includes("--system")||call.args.includes("--global")||call.args.includes("print")||call.args.includes("list")||call.args.includes("kickstart")),false);}finally{f.cleanup();}
  });
  test(`${platform}: running before or after disable never receives a killing removal`,{skip:POSIX_ONLY},async()=>{
    const f=fixture(platform);try{await f.provider.install(f.job,{expected:null});f.state.running=true;let current=await f.provider.read(f.job);const before=f.calls.length;await assert.rejects(f.provider.remove(f.job,{expected:current}));assert.equal(f.calls.slice(before).some(call=>call.args.includes("bootout")||call.args.includes("stop")||call.args.includes("disable")),false);f.state.running=false;current=await f.provider.read(f.job);f.state.race=true;const start=f.calls.length;await assert.rejects(f.provider.remove(f.job,{expected:current}));assert.equal(f.calls.slice(start).some(call=>call.args.includes("bootout")||call.args.includes("stop")),false);assert.ok(f.job.files.every(file=>existsSync(path.join(f.root,file.name))));}finally{f.cleanup();}
  });
  test(`${platform}: foreign, malformed or changed registration refuses mutation`,{skip:POSIX_ONLY},async()=>{
    const f=fixture(platform);try{await f.provider.install(f.job,{expected:null});const current=await f.provider.read(f.job);f.state.foreign=true;await assert.rejects(f.provider.remove(f.job,{expected:current}));f.state.foreign=false;f.state.unknown=true;await assert.rejects(f.provider.read(f.job));f.state.unknown=false;writeFileSync(path.join(f.root,f.job.files[0].name),"foreign definition",{mode:0o600});const before=f.calls.length;await assert.rejects(f.provider.remove(f.job,{expected:current}));assert.equal(f.calls.length,before);assert.equal(readFileSync(path.join(f.root,f.job.files[0].name),"utf8"),"foreign definition");}finally{f.cleanup();}
  });
}
test("Linux drop-ins and stale loaded definitions cannot borrow exact disk-file ownership",{skip:POSIX_ONLY},async()=>{
 const f=fixture("linux");try{await f.provider.install(f.job,{expected:null});f.state.dropin=true;await assert.rejects(f.provider.read(f.job));f.state.dropin=false;f.state.reload=true;await assert.rejects(f.provider.read(f.job));}finally{f.cleanup();}
});
test("Mac explicit unknown PID does not invalidate proven registration but blocks removal conservatively",{skip:POSIX_ONLY},async()=>{
 const f=fixture("darwin");try{await f.provider.install(f.job,{expected:null});f.state.pidMissing=true;const current=await f.provider.read(f.job);assert.equal(current.registered,true);assert.equal(current.activityKnown,false);assert.equal(current.running,true);assert.equal(JSON.stringify(current).includes("foreign-private-label"),false);const before=f.calls.length;await f.provider.install(f.job,{expected:current});await assert.rejects(f.provider.remove(f.job,{expected:current}));assert.equal(f.calls.slice(before).some(call=>["enable","disable","bootout","bootstrap"].includes(call.args[0])),false);}finally{f.cleanup();}
});
test("Mac external disable is not registered; enabling an owned loaded job does not bootstrap another",{skip:POSIX_ONLY},async()=>{
 const f=fixture("darwin");try{await f.provider.install(f.job,{expected:null});f.state.enabled=false;const current=await f.provider.read(f.job);assert.equal(current.registered,false);const before=f.calls.length;await f.provider.install(f.job,{expected:current});assert.equal((await f.provider.read(f.job)).registered,true);assert.equal(f.calls.slice(before).filter(call=>call.args[0]==="enable").length,1);assert.equal(f.calls.slice(before).some(call=>call.args[0]==="bootstrap"),false);f.state.overrideUnknown=true;await assert.rejects(f.provider.read(f.job));}finally{f.cleanup();}
});
test("Mac override parsing retains only the exact label and rejects unknown or ambiguous maps",()=>{
 const label="com.murage.backup."+"a".repeat(64);for(const [value,enabled] of [["true",false],["false",true],["disabled",false],["enabled",true]])assert.equal(selectedMacJobEnabled(`disabled services = {\n "private-other" => disabled\n "${label}" => ${value}\n}\n`,label),enabled);
 assert.equal(selectedMacJobEnabled("disabled services = {\n}\n",label),true);
 for(const text of ["arbitrary output",`disabled services = {\n "${label}" => maybe\n}`,`disabled services = {\n "${label}" => enabled\n "${label}" => disabled\n}`,`disabled services = {\n "private" => enabled\n trailing unknown\n}`,"x".repeat(65537)])assert.throws(()=>selectedMacJobEnabled(text,label));
});
test("unregistered exact files are not installed; expected-state races and failed bootstrap retain them",{skip:POSIX_ONLY},async()=>{
 const f=fixture("darwin");try{f.state.loaded=true;await assert.rejects(f.provider.read(f.job));f.state.loaded=false;f.stage();const current=await f.provider.read(f.job);assert.equal(current.registered,false);await assert.rejects(f.provider.install(f.job,{expected:null}));f.state.fail="bootstrap";await assert.rejects(f.provider.install(f.job,{expected:current}));assert.equal((await f.provider.read(f.job)).registered,false);assert.ok(existsSync(path.join(f.root,f.job.files[0].name)));}finally{f.cleanup();}
});
test("private same-user files, known definitions and supported platform are prerequisites",{skip:POSIX_ONLY},async()=>{
 const f=fixture("linux");try{const unsupported=createNativeClosedBackupProvider({platform:"win32",owner:f.owner,home:f.home,run:async()=>{assert.fail("No OS call on unsupported host");}});assert.equal(unsupported.supported,false);await assert.rejects(unsupported.read(f.job));await assert.rejects(f.provider.read({...f.job,owner:{uid:f.owner.uid+1}}));await assert.rejects(f.provider.read({...f.job,files:[{...f.job.files[0],name:"../../foreign"}]}));assert.equal(f.calls.length,0);f.stage();chmodSync(path.join(f.root,f.job.files[0].name),0o644);await assert.rejects(f.provider.read(f.job));chmodSync(path.join(f.root,f.job.files[0].name),0o600);rmSync(path.join(f.root,f.job.files[0].name));const sentinel=path.join(f.home,"sentinel");writeFileSync(sentinel,"private-canary",{mode:0o600});symlinkSync(sentinel,path.join(f.root,f.job.files[0].name));await assert.rejects(f.provider.read(f.job));assert.equal(readFileSync(sentinel,"utf8"),"private-canary");}finally{f.cleanup();}
});
test("Mac query treats a nil copied Ref as absent and compares only launchd's exposed job view",()=>{
  const spec={Label:"com.murage.backup."+"a".repeat(64),Program:"/Applications/Murage.app/Contents/MacOS/Murage",ProgramArguments:["/Applications/Murage.app/Contents/MacOS/Murage","/private/trigger.mjs","--murage-backup-descriptor","/private/descriptor.json"],LimitLoadToSessionType:"Aqua",OnDemand:true};
  const released=[];
  const query=job=>{
    // Bridge shape observed natively: SMJobCopyDictionary returns a Ref even for a missing job.
    const bridge=new Proxy(function(value){return value;},{get:(_target,name)=>name==="SMJobCopyDictionary"?()=>({ref:job}):name==="CFRelease"?value=>{released.push(value);throw Error("nil release stalls");}:name==="kSMDomainUserLaunchd"?"user":undefined});
    const context=vm.createContext({JSON,Object,Error,Number,$:bridge,ObjC:{import(){},castRefToObject:ref=>({isNil:()=>ref.ref===null,value:ref.ref}),deepUnwrap:object=>structuredClone(object.value)}});
    vm.runInContext(CLOSED_MAC_QUERY,context);return JSON.parse(context.run([spec.Label,JSON.stringify(spec)]));
  };
  assert.deepEqual(query(null),{version:1,status:"absent"});
  // Exact key set of a loaded job observed from launchd (plus the owned values).
  const loaded={...spec,PID:4321,LastExitStatus:0};
  assert.deepEqual(query(loaded),{version:1,status:"found",pid:4321});
  const {PID,...idle}=loaded;assert.equal(PID,4321);assert.deepEqual(query(idle),{version:1,status:"found",pid:0});
  assert.deepEqual(query({...loaded,ProgramArguments:[...spec.ProgramArguments,"--extra"]}),{version:1,status:"foreign"});
  assert.deepEqual(query({...loaded,OnDemand:false}),{version:1,status:"foreign"});
  const {LimitLoadToSessionType,...missing}=loaded;assert.equal(LimitLoadToSessionType,"Aqua");assert.deepEqual(query(missing),{version:1,status:"unavailable"});
  assert.deepEqual(query({...loaded,PID:-1}),{version:1,status:"unavailable"});
  assert.deepEqual(released,[]);
});

test("Linux: a job is kept only after one real run of its command succeeds; a failing one is taken down",{skip:POSIX_ONLY},async()=>{
  const f=fixture("linux");try{
    await f.provider.install(f.job,{expected:null});assert.equal(f.state.starts,1);
    const good=await f.provider.read(f.job);assert.equal(good.registered,true);assert.equal(good.failing,undefined);
    await f.provider.remove(f.job,{expected:good});assert.equal(await f.provider.read(f.job),null);
    // The 0.1.60 AppImage on Ubuntu 24.04: the trigger's command exits 9 every time.
    f.state.runFails=true;
    await assert.rejects(f.provider.install(f.job,{expected:null}),error=>error.code==="CLOSED_NATIVE_JOB_WONT_RUN");
    assert.equal(await f.provider.read(f.job),null,"nothing left registered that cannot run");
    assert.ok(f.job.files.every(file=>!existsSync(path.join(f.root,file.name))));
  }finally{f.cleanup();}
});
test("Linux: a registered job whose last run failed reads as failing, and installing proves it afresh",{skip:POSIX_ONLY},async()=>{
  const f=fixture("linux");try{
    await f.provider.install(f.job,{expected:null});
    f.state.result="exit-code";
    const failing=await f.provider.read(f.job);assert.equal(failing.registered,true);assert.equal(failing.failing,true);
    await f.provider.install(f.job,{expected:failing});assert.equal(f.state.starts,2);
    const again=await f.provider.read(f.job);assert.equal(again.registered,true);assert.equal(again.failing,undefined);
  }finally{f.cleanup();}
});
test("Linux: an older Murage's job (legacy) can be read and removed, never installed",{skip:POSIX_ONLY},async()=>{
  const f=fixture("linux");try{
    const legacy={...f.job,legacy:true,files:f.job.files.map((file,i)=>i===0?{...file,text:file.text.replace("KillMode=process\n","")}:file)};
    assert.notDeepEqual(legacy.files,f.job.files);
    mkdirSync(f.root,{recursive:true,mode:0o700});for(const file of legacy.files)writeFileSync(path.join(f.root,file.name),file.text,{mode:0o600});
    Object.assign(f.state,{loaded:true,enabled:true,timerActive:true});
    const current=await f.provider.read(legacy);assert.equal(current.registered,true);
    // The current code refuses it as a normal job, as before.
    await assert.rejects(f.provider.read(f.job));
    await assert.rejects(f.provider.install(legacy,{expected:current}));
    await f.provider.remove(legacy,{expected:current});assert.equal(await f.provider.read(legacy),null);
    await assert.rejects(f.provider.read({...legacy,files:[{name:"../../foreign",text:"x"},legacy.files[1]]}));
  }finally{f.cleanup();}
});
