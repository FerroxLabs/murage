// B21 macOS closed-app scheduler qualification recipe. Operator-run, one phase
// per invocation: stage-install, observe, closed-due, remove, post-remove.
// DEVELOPMENT RUNTIME ONLY: the descriptor executable is this Node, and a
// file-backed document substitutes for Electron safeStorage. The production
// controller, native launchd provider, staged trigger bundle, coordinator,
// schedule host, installation lease and built private worker are real. This is
// not signed/installed-app proof: packaged main closed startup is not exercised.
// While registered, launchd runs the staged trigger every 60s. A due wake from a
// development Node launches `node --murage-backup-due ...`, which exits on the
// unknown option (trigger result needs-review, no state write) instead of
// opening an Electron default-app window.
import {execFile,execFileSync,spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {chmodSync,copyFileSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync} from "node:fs";
import {userInfo} from "node:os";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {Worker} from "node:worker_threads";
import {BackupCoordinator} from "../server/backup-coordinator.ts";
import {backupFixture,testAgeKeys} from "../server/testing/backup-fixture.ts";
import {verifiedBackupTool} from "../electron/backup-mode.mjs";
import {acquireDataDirLease} from "../electron/data-dir-lease.mjs";
import {resolveInstallationSelection} from "../electron/installation-selection.mjs";
import {BACKUP_SCHEDULE_BINDINGS_KEY,createBackupScheduleHost} from "../electron/backup-schedule-host.mjs";
import {closedControlDirectory,createClosedBackupController} from "../electron/backup-closed-controller.mjs";
import {createNativeClosedBackupProvider} from "../electron/backup-closed-native.mjs";
import {closedInstallationIdentity,readClosedBackupDescriptor} from "../electron/backup-closed-profile.mjs";
import {readClosedBackupStage} from "../electron/backup-closed-jobs.mjs";

const PHASES=["stage-install","observe","closed-due","remove","post-remove"];
const refuse=reason=>{process.stderr.write(`b21-mac-closed-native refused: ${reason}\n`);process.exit(2);};
const phase=process.argv[2];
if(process.argv.length!==3||!PHASES.includes(phase))refuse(`expected one phase: ${PHASES.join("|")}`);
if(process.platform!=="darwin"||process.arch!=="arm64")refuse("darwin-arm64 only");
if(process.env.MURAGE_B21_MAC_QUAL_CONFIRM!=="register-one-temporary-launch-agent")refuse("MURAGE_B21_MAC_QUAL_CONFIRM");
const evidenceDir=process.env.MURAGE_QUAL_EVIDENCE_DIR;
try{const s=lstatSync(evidenceDir);if(!path.isAbsolute(evidenceDir)||!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||realpathSync.native(evidenceDir)!==evidenceDir)throw Error();}catch{refuse("MURAGE_QUAL_EVIDENCE_DIR must be an existing canonical private owned directory");}
if(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)refuse("MURAGE_BACKUP_TEST_AGE_DIR");
const W=fileURLToPath(new URL("../",import.meta.url));
const stateFile=path.join(evidenceDir,"b21-state.json"),evidenceFile=path.join(evidenceDir,"b21-mac-closed-native.json");
const absent=file=>{try{lstatSync(file);return false;}catch(error){if(error.code==="ENOENT")return true;throw error;}};
if(phase==="stage-install"?!absent(stateFile):absent(stateFile))refuse(phase==="stage-install"?"state already exists; remove prior run first":"no b21-state.json; run stage-install first");

const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const writePrivate=(file,text)=>{const temp=`${file}.${process.pid}.tmp`;writeFileSync(temp,text,{flag:"wx",mode:0o600});renameSync(temp,file);};
const record=entry=>{const all=absent(evidenceFile)?[]:JSON.parse(readFileSync(evidenceFile,"utf8"));all.push({phase,at:new Date().toISOString(),...entry});writePrivate(evidenceFile,JSON.stringify(all,null,1)+"\n");};
const code=value=>typeof value==="string"&&/^[A-Z][A-Z0-9_]{0,100}$/.test(value)?value:null;
const safeError=error=>({code:code(error?.code),message:code(error?.message),name:typeof error?.name==="string"?error.name.slice(0,60):null});
const check=(condition,label)=>{if(!condition)throw Object.assign(Error("QUALIFICATION_ASSERTION_FAILED"),{code:"QUALIFICATION_ASSERTION_FAILED",label});};
const archives=s=>readdirSync(s.destination).filter(name=>name.endsWith(".age"));

/** Digest every original file, including existing SQLite sidecars. */
function treeDigests(root){
  const files={},sidecars=[];
  const walk=relative=>{for(const name of readdirSync(path.join(root,relative)).sort()){const rel=relative?`${relative}/${name}`:name,s=lstatSync(path.join(root,rel));if(s.isDirectory())walk(rel);else{if(/-(wal|shm)$/.test(name))sidecars.push(rel);files[rel]=s.isFile()?sha(readFileSync(path.join(root,rel))):"non-regular";}}};
  walk("");return{files,sidecars};
}

/** Built private worker, same parentPort shim as the accepted host test. The
 * identity travels only by recovery-input message. */
function runWorker(args,identity,env){
  check(!JSON.stringify(args).includes("AGE-SECRET")&&!JSON.stringify(env).includes("AGE-SECRET"),"no-secret-in-argv-or-env");
  const entry=pathToFileURL(path.join(W,"dist-server","installation-recovery-worker.js")).href;
  const source=`import {parentPort} from 'node:worker_threads';const listeners=new Map();process.parentPort={on(name,fn){const wrap=data=>fn({data});listeners.set(fn,wrap);parentPort.on(name,wrap);},removeListener(name,fn){parentPort.removeListener(name,listeners.get(fn));},postMessage:value=>parentPort.postMessage(value)};process.argv=[process.execPath,'worker',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`;
  return new Promise((resolve,reject)=>{
    const child=new Worker(new URL("data:text/javascript,"+encodeURIComponent(source)),{stdout:true,stderr:true,env});let result,inputs=0,logs="";
    child.stdout.on("data",chunk=>{logs+=chunk;});child.stderr.on("data",chunk=>{logs+=chunk;});
    child.on("message",message=>{if(message.type==="murage:recovery-input-ready"){inputs++;child.postMessage({type:"murage:recovery-input",nonce:message.nonce,identity});}if(message.type==="murage:recovery-result"){result=message.result;child.postMessage({type:"murage:recovery-result-ack",nonce:message.nonce});}});
    const timer=setTimeout(()=>{void child.terminate().then(()=>reject(Object.assign(Error("WORKER_TIMEOUT"),{code:"WORKER_TIMEOUT"})));},11*60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("exit",exit=>{clearTimeout(timer);resolve({exit,inputs,result,privateLogDetected:logs.includes("AGE-SECRET")||logs.includes("FAKE-CREDENTIAL-CANARY")});});
  });
}
const workerSummary=run=>({exit:run.exit,inputs:run.inputs,ok:run.result?.ok??null,error:code(run.result?.error),privateLogDetected:run.privateLogDetected});

function context(s){
  const provider=createNativeClosedBackupProvider(),resources=path.join(s.parent,"Resources");
  const supported=()=>verifiedBackupTool(resources)===s.tool;
  // Harness substitute for Electron safeStorage: bindings JSON only, never key material.
  const protectedFile=path.join(s.userData,"qual-protected.json"),load=()=>absent(protectedFile)?{}:JSON.parse(readFileSync(protectedFile,"utf8"));
  const coordinator=()=>new BackupCoordinator({stateDirectory:closedControlDirectory(s.installation)});
  const captures=[];let owner=null,host;
  const controller=createClosedBackupController({
    profile:()=>({version:1,platform:"darwin",owner:{uid:process.getuid()},requestedRoot:s.requestedRoot,userData:s.userData,installation:s.installation,installationIdentity:closedInstallationIdentity(s.installation),executable:s.executable}),
    triggerSource:s.triggerSource,backupSupported:supported,provider,backup:()=>host,confirmInstall:async()=>true,
  });
  const forbidden=name=>async()=>{throw Object.assign(Error(`CLOSED_PATH_CALLED_${name}`),{code:`CLOSED_PATH_CALLED_${name}`});};
  host=createBackupScheduleHost({
    coordinator:coordinator(),installation:()=>s.installation,supported,
    verifyEncrypted:async()=>{if(!supported())throw Error("AGE_TOOL_UNVERIFIED");},
    readProtected:async key=>{if(key!==BACKUP_SCHEDULE_BINDINGS_KEY)throw Error("BACKUP_BINDINGS_UNAVAILABLE");return load()[key];},
    writeProtected:async(key,value)=>{if(key!==BACKUP_SCHEDULE_BINDINGS_KEY)throw Error("BACKUP_BINDINGS_UNAVAILABLE");writePrivate(protectedFile,JSON.stringify({...load(),[key]:value}));},
    chooseDestination:async()=>s.destination,chooseKey:async()=>s.keyFile,confirmReferences:async()=>true,
    assertClosedAllowed:()=>controller.assertInstalled(),
    // Mirrors electron/main.mjs closed admission for a development process: the
    // real installation lease first, exact profile, then exact OS registration.
    assertClosedStartup:async()=>{
      if(owner)throw Object.assign(Error("BACKUP_CLOSED_OWNER_UNAVAILABLE"),{code:"BACKUP_CLOSED_OWNER_UNAVAILABLE"});
      try{owner=acquireDataDirLease(s.installation);}catch(error){if(error?.name==="DataDirLeaseError")throw Object.assign(Error("BACKUP_CLOSED_BUSY"),{code:"BACKUP_CLOSED_BUSY"});throw error;}
      const descriptor=readClosedBackupDescriptor(s.descriptorPath);
      if(descriptor.installation!==s.installation||descriptor.requestedRoot!==s.requestedRoot||descriptor.userData!==s.userData)throw Error("BACKUP_CLOSED_PROFILE_CHANGED");
      await controller.assertInvocation(descriptor,s.descriptorPath);
    },
    prepare:forbidden("PREPARE"),cleanupIdle:forbidden("CLEANUP_IDLE"),relaunch:forbidden("RELAUNCH"),
    capture:async request=>{
      check(owner!==null,"capture-holds-owner");
      let foreign=true;try{acquireDataDirLease(s.installation).release();foreign=false;}catch{/* expected exclusive owner */}
      check(foreign,"capture-exclusive-owner");
      const identity=await request.readIdentity();
      const args=["backup-encrypted","--data-dir",s.installation,"--output",request.output,"--age-tool",s.tool,"--recipient",request.recipient,"--credential-policy","preserve-in-encrypted-fidelity","--max-bytes",String(request.maxBytes),"--max-duration-ms",String(request.maxDurationMs)];
      const run=await runWorker(args,identity,{PATH:path.dirname(process.execPath),HOME:s.parent,USERPROFILE:s.parent,...owner.utilityServerLeaseEnvironment()});
      captures.push(workerSummary(run));
      check(!run.privateLogDetected,"worker-no-private-log");check(run.exit===0&&run.inputs===1&&run.result?.ok===true,"worker-capture-result");
      return run.result;
    },
  });
  // Concurrent calls share one owner; release only after the host is idle.
  const runClosed=async()=>{try{return await host.runClosedDue();}finally{if(owner&&!host.isPreparing()){owner.release();owner=null;}}};
  return{provider,controller,host,coordinator,captures,runClosed,supported};
}

/** Program and arguments exactly as staged in the owned plist text. */
function stagedProgram(s){
  const text=readClosedBackupStage(s.stageDirectory).files[0].text;
  const array=/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(text)?.[1];check(array,"plist-program-arguments");
  const values=[...array.matchAll(/<string>(.*?)<\/string>/gs)].map(match=>match[1].replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'").replaceAll("&amp;","&"));
  check(values.length===4&&values[0]===s.executable,"plist-program-shape");return values;
}
function directTrigger(s){
  const [executable,...args]=stagedProgram(s);
  return new Promise(resolve=>{execFile(executable,args,{env:{HOME:userInfo().homedir,PATH:"/usr/bin:/bin",ELECTRON_RUN_AS_NODE:"1"},encoding:"utf8",timeout:120000,maxBuffer:65536},(error,stdout)=>{
    const lines=String(stdout).trim().split(/\r?\n/).filter(line=>line.startsWith('{"type":"murage:closed-backup-trigger"'));let status=null;
    try{if(lines.length===1)status=JSON.parse(lines[0]).status;}catch{status=null;}
    resolve({exitCode:error?(typeof error.code==="number"?error.code:null):0,timedOut:Boolean(error?.killed),status});
  });});
}
async function enable(c,at,catchupMs){
  let refs=(await c.host.status()).refs;
  if(!refs){await c.host.selectReferences();refs=(await c.host.status()).refs;}
  check(refs,"references-selected");
  const time=new Date(at).toISOString().slice(11,16),internal=c.host.internalStatus();
  await c.host.configure(internal.revision,{enabled:true,timezone:"UTC",time,catchupMs,maxBytes:100000000,maxDurationMs:600000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},preUpgrade:false,closedApp:true,installationRef:refs.installationRef,destinationRef:refs.destinationRef,recoveryRef:refs.recoveryRef,allowIdleRestart:true,allowClosedApp:true});
  c.host.stopPolling();for(let attempt=0;attempt<600&&c.host.isPreparing();attempt++)await sleep(50);
  check(!c.host.isPreparing(),"configure-initial-tick-settled");return time;
}

async function stageInstall(){
  const keys=testAgeKeys(),f=backupFixture();f.db.close();
  const parent=realpathSync.native(f.parent),requestedRoot=realpathSync.native(f.data);
  for(const name of ["userData","archives"])mkdirSync(path.join(parent,name),{mode:0o700});
  const userData=realpathSync.native(path.join(parent,"userData")),destination=realpathSync.native(path.join(parent,"archives")),keyFile=path.join(parent,"independent-key.txt");
  writeFileSync(keyFile,keys.identity,{flag:"wx",mode:0o600});
  const resources=path.join(parent,"Resources"),tool=path.join(resources,"backup-tools","arm64","age");
  mkdirSync(path.dirname(tool),{recursive:true});copyFileSync(keys.ageExecutable,tool);chmodSync(tool,0o755);
  check(verifiedBackupTool(resources)===tool,"fixed-resource-age-verified");
  const installation=resolveInstallationSelection(userData,requestedRoot).dataDirectory;check(installation===requestedRoot,"default-installation-selection");
  const triggerSource=path.join(W,"dist-server","backup-schedule-trigger.js");check(!absent(triggerSource),"built-trigger-present");
  const s={version:1,runtime:"development-node",nodeVersion:process.version,parent,requestedRoot,userData,installation,destination,keyFile,tool,
    executable:realpathSync.native(process.execPath),triggerSource,triggerSourceSha256:sha(readFileSync(triggerSource)),control:closedControlDirectory(installation),original:treeDigests(installation)};
  writePrivate(stateFile,JSON.stringify(s));
  const c=context(s),staged=await c.controller.stage();check(staged.state==="staged","stage-state");
  const pointer=JSON.parse(readFileSync(path.join(s.control,"closed-job-pointer.json"),"utf8")),stage=readClosedBackupStage(path.join(s.control,pointer.directory));
  Object.assign(s,{stageDirectory:stage.directory,descriptorPath:stage.descriptorPath,label:stage.jobId,plistPath:path.join(userInfo().homedir,"Library","LaunchAgents",`${stage.jobId}.plist`),definitionDigest:stage.definitionDigest,triggerEntry:stage.descriptor.triggerEntry,triggerSha256:stage.descriptor.triggerSha256});
  writePrivate(stateFile,JSON.stringify(s));
  check(/^com\.murage\.backup\.[a-f0-9]{64}$/.test(s.label),"label-shape");check(s.triggerSha256===s.triggerSourceSha256,"staged-trigger-digest");
  check(absent(s.plistPath),"plist-absent-before-install");check(await c.provider.read(stage)===null,"registration-absent-before-install");
  record({step:"pre-install",label:s.label,plistPath:s.plistPath,descriptorPath:s.descriptorPath,definitionDigest:s.definitionDigest,triggerSha256:s.triggerSha256,runtime:s.runtime,nodeVersion:s.nodeVersion,originalFiles:Object.keys(s.original.files).length});
  const installed=await c.controller.install();check(installed.state==="installed","install-state");
  const plistSha256=sha(readFileSync(s.plistPath));check(plistSha256===sha(Buffer.from(stage.files[0].text)),"plist-exact-bytes");
  const again=await c.controller.install();check(again.state==="installed"&&sha(readFileSync(s.plistPath))===plistSha256,"install-idempotent");
  const current=await c.provider.read(stage);check(current?.registered===true&&same(current.files,stage.files),"registered-readback");
  record({step:"installed",label:s.label,plistSha256,installState:installed.state,secondInstallState:again.state,registered:current.registered,running:current.running,activityKnown:current.activityKnown});
}
async function observe(s){
  const c=context(s),stage=readClosedBackupStage(s.stageDirectory),registration=await c.provider.read(stage);
  check(registration?.registered===true&&same(registration.files,stage.files)&&registration.jobId===s.label,"registered-exact-files");
  // "disabled" (not "unavailable") also proves the trigger validated the real registration.
  const disabled=await directTrigger(s);record({step:"trigger-while-disabled",...disabled,running:registration.running,activityKnown:registration.activityKnown});
  check(disabled.exitCode===0&&disabled.status==="disabled","trigger-disabled-status");
  const time=await enable(c,Date.now()+30*60000,60000);
  const notDue=await directTrigger(s);record({step:"trigger-enabled-not-due",time,...notDue,lastClosedResult:c.coordinator().status().lastClosedResult??null});
  check(notDue.exitCode===0&&notDue.status==="not-due","trigger-not-due-status");
}
async function closedDue(s){
  const c=context(s),next=Math.ceil((Date.now()+5000)/60000)*60000,time=await enable(c,next,3600000);
  while(Date.now()<next+2000)await sleep(500);
  check(c.coordinator().closedEligibility().status==="due","eligibility-due");
  // B1: a separate process holds the real installation lease.
  const leaseUrl=pathToFileURL(path.join(W,"electron","data-dir-lease.mjs")).href;
  const holder=spawn(process.execPath,["--input-type=module","-e",`import {acquireDataDirLease} from ${JSON.stringify(leaseUrl)};const lease=acquireDataDirLease(${JSON.stringify(s.installation)});process.stdout.write("held\\n");process.stdin.resume();process.stdin.on("end",()=>{lease.release();process.exit(0);});`],{stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin",HOME:s.parent}});
  const holderExit=new Promise(resolve=>holder.once("exit",exit=>resolve(exit)));
  await new Promise((resolve,reject)=>{let text="";const timer=setTimeout(()=>reject(Object.assign(Error("HOLDER_TIMEOUT"),{code:"HOLDER_TIMEOUT"})),30000);holder.stdout.on("data",chunk=>{text+=chunk;if(text.includes("held\n")){clearTimeout(timer);resolve();}});holderExit.then(()=>{clearTimeout(timer);reject(Object.assign(Error("HOLDER_EXITED"),{code:"HOLDER_EXITED"}));});});
  let busy;try{busy=await c.runClosed();}finally{holder.stdin.end();}
  const busyExit=await holderExit,afterBusy=c.coordinator().status();
  record({step:"busy-foreign-installation-lease",time,result:busy,holderExit:busyExit,archives:archives(s).length,captures:c.captures.length,lastClosedResult:afterBusy.lastClosedResult??null,eligibility:c.coordinator().closedEligibility().status});
  check(busy.status==="busy"&&afterBusy.lastClosedResult?.status==="busy","busy-result-durable");
  check(archives(s).length===0&&c.captures.length===0,"busy-no-capture");check(busyExit===0,"holder-exit");
  check(c.coordinator().closedEligibility().status==="due","due-retained-after-busy");
  // B3: overlapping invocations on one host; exactly one capture.
  const [first,second]=await Promise.all([c.runClosed(),c.runClosed()]);
  const list=archives(s),status=c.coordinator().status();
  const bytes=list.length===1?readFileSync(path.join(s.destination,list[0])):null;
  record({step:"overlapping-closed-due",first,second,archives:list.length,phase:status.phase,lastVerified:status.lastVerified??null,lastClosedResult:status.lastClosedResult??null,archiveSha256:bytes&&sha(bytes),archiveBytes:bytes?.length??null,captures:c.captures});
  check(second.status==="busy"&&first.status==="verified","overlap-statuses");
  check(bytes&&c.captures.length===1,"exactly-one-archive-and-capture");
  check(status.phase==="returned"&&status.lastVerified?.sha256===sha(bytes)&&status.lastVerified.bytes===bytes.length&&status.lastClosedResult?.status==="verified","durable-verified-receipt");
  const now=treeDigests(s.installation),added=Object.keys(now.files).filter(key=>!(key in s.original.files));
  const originalsUnchanged=Object.entries(s.original.files).every(([key,value])=>now.files[key]===value);
  const bookkeepingOnly=added.every(key=>(key==="messages.db-wal"||key==="messages.db-shm")&&now.files[key]!=="non-regular")&&(!added.includes("messages.db-wal")||lstatSync(path.join(s.installation,"messages.db-wal")).size===0);
  record({step:"original-preservation",unchanged:originalsUnchanged,bookkeepingOnly,added,sidecarsBefore:s.original.sidecars,sidecarsAfter:now.sidecars});
  check(originalsUnchanged&&bookkeepingOnly,"original-installation-unchanged");
  const archive=path.join(s.destination,list[0]);
  const inspected=await runWorker(["inspect-encrypted","--archive",archive,"--age-tool",s.tool],readFileSync(s.keyFile,"utf8"),{PATH:path.dirname(process.execPath),HOME:s.parent,USERPROFILE:s.parent});
  record({step:"inspect-scheduled-archive",...workerSummary(inspected),sha256:inspected.result?.sha256??null,activationAvailable:inspected.result?.activationAvailable??null,coverage:inspected.result?.coverage??null});
  check(!inspected.privateLogDetected&&inspected.exit===0&&inspected.inputs===1&&inspected.result?.ok===true&&inspected.result.sha256===sha(bytes)&&inspected.result.activationAvailable===false,"inspect-scheduled-archive");
  // B4: consumed occurrence is not replayed.
  const replay=await c.runClosed(),trigger=await directTrigger(s);
  record({step:"no-replay",result:replay,archives:archives(s).length,captures:c.captures.length,trigger});
  check(replay.status==="not-due"&&archives(s).length===1&&c.captures.length===1,"closed-no-replay");
  check(trigger.exitCode===0&&trigger.status==="not-due","trigger-after-capture-not-due");
  writePrivate(stateFile,JSON.stringify({...s,closedDueVerified:true,archive,archiveSha256:sha(bytes)}));
}
async function remove(s){
  const c=context(s),stage=s.stageDirectory?readClosedBackupStage(s.stageDirectory):null;
  const result=await c.controller.disable();record({step:"disable",state:result.state});
  if(result.state!=="disabled"){process.exitCode=1;return;}// Exact bootout/unlink is left to the operator.
  const registration=stage?await c.provider.read(stage):null,status=c.coordinator().status();
  record({step:"removed",registration,plistAbsent:s.plistPath?absent(s.plistPath):null,enabled:status.enabled,lastVerified:status.lastVerified??null,archives:archives(s).length});
  check(registration===null&&(!s.plistPath||absent(s.plistPath))&&status.enabled===false,"registration-removed-schedule-disabled");
  if(s.closedDueVerified)check(status.lastVerified?.sha256===s.archiveSha256&&sha(readFileSync(s.archive))===s.archiveSha256,"receipt-and-archive-retained");
}
async function postRemove(s){
  const trigger=s.stageDirectory&&!absent(s.stageDirectory)?await directTrigger(s):null;
  const registration=s.stageDirectory?await createNativeClosedBackupProvider().read(readClosedBackupStage(s.stageDirectory)):null;
  const processes=execFileSync("/bin/ps",["-axo","pid=,command="],{encoding:"utf8",maxBuffer:16*1024*1024}).split("\n").filter(line=>line.includes(s.parent)).map(line=>Number(line.trim().split(/\s+/)[0])).filter(pid=>pid!==process.pid);
  record({step:"post-remove",trigger,registration,plistAbsent:s.plistPath?absent(s.plistPath):null,fixtureProcessPids:processes,fixtureParent:s.parent});
  check(!trigger||trigger.status==="unavailable","trigger-unavailable-after-removal");check(registration===null,"registration-absent");check(processes.length===0,"no-fixture-processes");
  process.stdout.write(`fixture parent retained for operator cleanup: ${s.parent}\n`);
}

const phases={"stage-install":stageInstall,observe,"closed-due":closedDue,remove,"post-remove":postRemove};
try{
  const s=phase==="stage-install"?undefined:JSON.parse(readFileSync(stateFile,"utf8"));
  await phases[phase](s);if(!process.exitCode)record({step:"phase-complete"});
}catch(error){
  try{record({step:"phase-failed",error:safeError(error),label:typeof error?.label==="string"?error.label:null});}catch{/* evidence write failed; exit code remains */}
  process.exitCode=1;
}
process.exit(process.exitCode??0);
