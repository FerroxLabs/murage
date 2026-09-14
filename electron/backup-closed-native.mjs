import {execFile} from "node:child_process";
import {userInfo} from "node:os";
import {lstatSync,mkdirSync,realpathSync,unlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {buildClosedBackupJob} from "./backup-closed-jobs.mjs";
import {closedInvocation,readClosedPrivateFile} from "./backup-closed-profile.mjs";

const fail=(code="CLOSED_NATIVE_REVIEW_REQUIRED")=>{throw Object.assign(new Error("Closed backup registration requires review."),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const LIMIT=65536;
/** No launchctl print/list parsing. Query exactly one user-domain label and
 * compare inside the helper so foreign arguments/environment never leave it.
 * SMJobCopyDictionary is deprecated and its shape is not stable: missing facts
 * are unavailable, never a guessed idle/registered result. Native macOS 26.3:
 * a missing job still bridges as a non-null Ref (only its cast object is nil),
 * and CFRelease of that nil Ref stalls osascript. The one copied dictionary is
 * left to this short-lived helper's exit. */
export const CLOSED_MAC_QUERY=String.raw`ObjC.import('Foundation');ObjC.import('ServiceManagement');
function run(argv){try{if(argv.length!==2)throw Error();var expected=JSON.parse(argv[1]);var raw=$.SMJobCopyDictionary($.kSMDomainUserLaunchd,$(argv[0]));
if(raw===null||raw===undefined)return JSON.stringify({version:1,status:'absent'});var job=ObjC.castRefToObject(raw);
if(job.isNil())return JSON.stringify({version:1,status:'absent'});var d=ObjC.deepUnwrap(job);
if(!d||typeof d!=='object')throw Error();var keys=Object.keys(expected);for(var i=0;i<keys.length;i++){var key=keys[i];if(!Object.prototype.hasOwnProperty.call(d,key))throw Error();if(JSON.stringify(d[key])!==JSON.stringify(expected[key]))return JSON.stringify({version:1,status:'foreign'});}
var pid=0;if(Object.prototype.hasOwnProperty.call(d,'PID')){if(typeof d.PID!=='number'||!Number.isSafeInteger(d.PID)||d.PID<0)throw Error();pid=d.PID;}return JSON.stringify({version:1,status:'found',pid:pid});
}catch(_){return JSON.stringify({version:1,status:'unavailable'});}}`;

/** One bounded current-user override map is necessary: the public command has
 * no single-label form. Retain no other label or value. The finite grammars
 * vary by OS release; an unknown format is unavailable, never "enabled". */
export function selectedMacJobEnabled(stdout,label){
  if(typeof stdout!=="string"||Buffer.byteLength(stdout)>LIMIT||!/^com\.murage\.backup\.[a-f0-9]{64}$/.test(label))fail("CLOSED_NATIVE_UNAVAILABLE");
  const lines=stdout.trim().split(/\r?\n/);if(lines.shift()?.trim()!=="disabled services = {"||lines.pop()?.trim()!=="}")fail("CLOSED_NATIVE_UNAVAILABLE");
  const seen=new Set();let disabled=false;
  for(const line of lines){const match=/^\s*("(?:[^"\\]|\\.)*")\s*=>\s*(true|false|enabled|disabled)\s*$/.exec(line);if(!match)fail("CLOSED_NATIVE_UNAVAILABLE");let key;try{key=JSON.parse(match[1]);}catch{fail("CLOSED_NATIVE_UNAVAILABLE");}if(typeof key!=="string"||key.length>1024||/[\x00-\x1f\x7f]/.test(key)||seen.has(key))fail("CLOSED_NATIVE_UNAVAILABLE");seen.add(key);if(key===label)disabled=match[2]==="true"||match[2]==="disabled";}
  // C2's exact installed definition has no Disabled=true default. Only after
  // validating the complete override map may an absent override use it.
  return !disabled;
}

function defaultRun({executable,args,input}){
  return new Promise((resolve,reject)=>{
    const env={HOME:userInfo().homedir,PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"};for(const key of ["XDG_RUNTIME_DIR","DBUS_SESSION_BUS_ADDRESS"])if(typeof process.env[key]==="string")env[key]=process.env[key];
    const child=execFile(executable,args,{env,encoding:"utf8",timeout:10000,maxBuffer:LIMIT,windowsHide:true},(error,stdout)=>{
      if(error&&(error.killed||typeof error.code!=="number")){reject(Object.assign(new Error("Closed backup native command unavailable."),{code:"CLOSED_NATIVE_UNAVAILABLE"}));return;}
      resolve({code:error?.code??0,stdout});
    });
    child.stdin?.on("error",()=>{});child.stdin?.end(input??"");
  });
}
const PROPERTIES=["Id","LoadState","ActiveState","SubState","UnitFileState","FragmentPath","DropInPaths","NeedDaemonReload","MainPID"];
function properties(stdout,requested){
  if(typeof stdout!=="string"||Buffer.byteLength(stdout)>LIMIT)fail("CLOSED_NATIVE_UNAVAILABLE");const out={};
  for(const line of stdout.trimEnd().split("\n")){const at=line.indexOf("=");if(at<1)fail("CLOSED_NATIVE_UNAVAILABLE");const key=line.slice(0,at);if(!requested.includes(key)||Object.hasOwn(out,key))fail("CLOSED_NATIVE_UNAVAILABLE");out[key]=line.slice(at+1);}
  if(requested.some(key=>!Object.hasOwn(out,key)))fail("CLOSED_NATIVE_UNAVAILABLE");return out;
}

/** All OS operations are deferred until callbacks are explicitly invoked.
 * Tests inject run and a private fake home; no global/system registration. */
export function createNativeClosedBackupProvider({platform=process.platform,owner,home,run=defaultRun}={}){
  const account=userInfo();owner??={uid:account.uid};home??=account.homedir;
  const supported=["darwin","linux"].includes(platform)&&Number.isSafeInteger(owner.uid)&&owner.uid>0&&owner.uid===account.uid;
  const root=path.join(home,...(platform==="darwin"?["Library","LaunchAgents"]:[".config","systemd","user"]));
  let operation=false;
  function directory(create=false){
    if(!supported||typeof home!=="string"||!path.isAbsolute(home))fail("CLOSED_NATIVE_UNAVAILABLE");
    const inspect=file=>{const s=lstatSync(file);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==owner.uid||(s.mode&0o022)||realpathSync.native(file)!==file)fail();};
    inspect(home);let current=home;
    for(const part of path.relative(home,root).split(path.sep)){current=path.join(current,part);try{inspect(current);}catch(error){if(error.code!=="ENOENT")throw error;if(!create)return false;mkdirSync(current,{mode:0o700});inspect(current);}}
    return true;
  }
  function validate(job){
    if(!supported||job?.owner?.uid!==owner.uid||Object.keys(job.owner).length!==1||job?.descriptor?.platform!==platform)fail("CLOSED_NATIVE_UNAVAILABLE");
    const expected=buildClosedBackupJob(job.descriptor,job.descriptorPath,{backupSupported:true});
    if(!expected.supported||!same(expected.owner,owner)||expected.jobId!==job.jobId||!same(expected.files,job.files)||!/^com\.murage\.backup\.[a-f0-9]{64}$/.test(job.jobId))fail();return expected;
  }
  function disk(job){
    if(!directory())return null;const files=[];
    for(const file of job.files){try{files.push({name:file.name,text:readClosedPrivateFile(path.join(root,file.name),{uid:owner.uid,maxBytes:LIMIT})});}catch(error){if(error.code!=="ENOENT")throw error;}}
    if(!files.length)return null;if(!same(files,job.files))fail();return files;
  }
  async function command(executable,args){
    let result;try{result=await run({executable,args});}catch{fail("CLOSED_NATIVE_UNAVAILABLE");}
    if(!result||!Number.isInteger(result.code)||typeof result.stdout!=="string"||Buffer.byteLength(result.stdout)>LIMIT)fail("CLOSED_NATIVE_UNAVAILABLE");return result;
  }
  async function mutate(executable,args){if((await command(executable,args)).code!==0)fail("CLOSED_NATIVE_UNAVAILABLE");}
  // launchd's legacy job view exposes only Label, Program, ProgramArguments,
  // LimitLoadToSessionType, OnDemand (KeepAlive false), PID and LastExitStatus.
  // Environment, interval, RunAtLoad and ProcessType are bound by the exact
  // owned plist bytes that read() requires beside this loaded-job comparison.
  // After those identity checks, an omitted PID is launchd's idle-job shape.
  // Explicit null/malformed helper output still cannot establish idle state.
  function macSpec(job){const invoke=closedInvocation(job.descriptor,job.descriptorPath,{mode:"trigger"});return{Label:job.jobId,Program:invoke.executable,ProgramArguments:[invoke.executable,...invoke.args],LimitLoadToSessionType:"Aqua",OnDemand:true};}
  async function native(job){
    if(platform==="darwin"){
      const result=await command("/usr/bin/osascript",["-l","JavaScript","-e",CLOSED_MAC_QUERY,"--",job.jobId,JSON.stringify(macSpec(job))]);if(result.code!==0)fail("CLOSED_NATIVE_UNAVAILABLE");
      let value;try{value=JSON.parse(result.stdout);}catch{fail("CLOSED_NATIVE_UNAVAILABLE");}
      if(value?.version!==1)fail("CLOSED_NATIVE_UNAVAILABLE");
      if(value.status==="absent"&&same(Object.keys(value).sort(),["status","version"]))return{absent:true,registered:false,running:false,activityKnown:true};
      if(value.status!=="found"||!same(Object.keys(value).sort(),["pid","status","version"])||(value.pid!==null&&(!Number.isSafeInteger(value.pid)||value.pid<0)))fail(value?.status==="foreign"?undefined:"CLOSED_NATIVE_UNAVAILABLE");
      const overrides=await command("/bin/launchctl",["print-disabled",`gui/${owner.uid}`]);if(overrides.code!==0)fail("CLOSED_NATIVE_UNAVAILABLE");const enabled=selectedMacJobEnabled(overrides.stdout,job.jobId);
      return{absent:false,registered:enabled,enabled,running:value.pid===null||value.pid>0,activityKnown:value.pid!==null};
    }
    const values={};
    for(const kind of ["service","timer"]){const requested=kind==="service"?PROPERTIES:[...PROPERTIES.filter(key=>key!=="MainPID"),"Triggers"];const name=`${job.jobId}.${kind}`,result=await command("/usr/bin/systemctl",["--user","show","--all","--no-pager",`--property=${requested.join(",")}`,name]);if(result.code!==0)fail("CLOSED_NATIVE_UNAVAILABLE");const value=properties(result.stdout,requested);if(value.Id!==name)fail();
      if(value.LoadState!=="not-found"){
        if(value.LoadState!=="loaded"||value.FragmentPath!==path.join(root,name)||value.DropInPaths!==""||value.NeedDaemonReload!=="no")fail();
        if(kind==="timer"&&value.Triggers!==`${job.jobId}.service`)fail();
      }else if(value.FragmentPath!==""||value.DropInPaths!==""||!["inactive","failed"].includes(value.ActiveState))fail();
      if(kind==="service"&&(!/^(0|[1-9][0-9]*)$/.test(value.MainPID)||!Number.isSafeInteger(Number(value.MainPID))))fail("CLOSED_NATIVE_UNAVAILABLE");values[kind]=value;
    }
    const {service,timer}=values;const running=Number(service.MainPID)>0||!["inactive","failed"].includes(service.ActiveState);
    return{absent:service.LoadState==="not-found"&&timer.LoadState==="not-found",registered:service.LoadState==="loaded"&&timer.LoadState==="loaded"&&timer.UnitFileState==="enabled"&&timer.ActiveState==="active",running,activityKnown:true};
  }
  async function read(job){validate(job);const files=disk(job),state=await native(job);if(!files){if(!state.absent)fail();return null;}return{jobId:job.jobId,owner:{uid:owner.uid},files,registered:state.registered,running:state.running,activityKnown:state.activityKnown};}
  async function compare(job,expected){const current=await read(job);if(!same(current,expected)||current?.running)fail();return current;}
  async function exclusive(fn){if(operation)fail();operation=true;try{return await fn();}finally{operation=false;}}
  async function install(job,{expected}={}){return exclusive(async()=>{
    validate(job);const prior=await read(job);if(!same(prior,expected))fail();if(prior?.registered)return;if(prior?.running)fail();directory(true);
    for(const file of job.files){try{const current=readClosedPrivateFile(path.join(root,file.name),{uid:owner.uid,maxBytes:LIMIT});if(current!==file.text)fail();}catch(error){if(error.code!=="ENOENT")throw error;writeFileSync(path.join(root,file.name),file.text,{flag:"wx",mode:0o600,flush:true});}}
    if(platform==="darwin"){
      const state=await read(job);if(state?.running)fail();if(!state?.registered){await mutate("/bin/launchctl",["enable",`gui/${owner.uid}/${job.jobId}`]);const again=await read(job);if(!again)fail();if(!again.registered){const latest=await native(job);if(!latest.absent||latest.running||!same(disk(job),job.files))fail();await mutate("/bin/launchctl",["bootstrap",`gui/${owner.uid}`,path.join(root,job.files[0].name)]);}}
    }else{
      // Read exact bytes again immediately before manager mutation.
      if(!same(disk(job),job.files))fail();await mutate("/usr/bin/systemctl",["--user","daemon-reload"]);const current=await read(job);if(current?.running)fail();await mutate("/usr/bin/systemctl",["--user","enable","--now",`${job.jobId}.timer`]);
    }
    const current=await read(job);if(!current?.registered)fail("CLOSED_NATIVE_UNAVAILABLE");
  });}
  async function remove(job,{expected}={}){return exclusive(async()=>{
    validate(job);const current=await compare(job,expected);if(!current)return;
    if(platform==="darwin"){
      await mutate("/bin/launchctl",["disable",`gui/${owner.uid}/${job.jobId}`]);const fresh=await read(job);if(!fresh||fresh.running||!same(fresh.files,job.files))fail();
      const latest=await native(job);if(latest.running||latest.enabled)fail();if(!latest.absent){await mutate("/bin/launchctl",["bootout",`gui/${owner.uid}/${job.jobId}`]);if(!(await native(job)).absent)fail("CLOSED_NATIVE_UNAVAILABLE");}
    }else{
      await mutate("/usr/bin/systemctl",["--user","disable",`${job.jobId}.timer`]);const fresh=await read(job);if(!fresh||fresh.running||!same(fresh.files,job.files))fail();
      await mutate("/usr/bin/systemctl",["--user","stop",`${job.jobId}.timer`]);if((await read(job))?.running)fail();
    }
    if(!same(disk(job),job.files))fail();for(const file of job.files)unlinkSync(path.join(root,file.name));
    if(platform==="linux")await mutate("/usr/bin/systemctl",["--user","daemon-reload"]);
  });}
  return{supported,read,install,remove};
}
