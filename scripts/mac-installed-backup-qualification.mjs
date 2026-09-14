// Packaged macOS arm64 backup/scheduler qualification. Operator/CI-run, one phase
// per invocation, ONLY inside an ephemeral GitHub-hosted macos-14 runner that
// consumes the signed artifact. Drives the real signed Murage main, its native
// dialogs, safeStorage (task keychain), launchd and the recovery window. No Node
// mirror, host injection or harness endpoint. Not proof of sleep/wake,
// boot-login, locked-Keychain prompts or macOS 26 behaviour.
import {spawn} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {closeSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {userInfo} from "node:os";
import path from "node:path";
import {admitSettingsEntry,cleanupKeychain,runCommand,setupKeychain} from "./mac-installed-backup-qualification-lib.mjs";

const CONFIRM="packaged-backup-ephemeral-runner";
// remove precedes restore: a published restored selection changes the selected
// installation bound into the closed descriptor (electron/backup-closed-profile.mjs:74).
const PHASES=["plan","admit","prepare","probe","launch-configure","await-scheduled","no-replay","busy","remove","restore","cleanup-verify"];
const ASSERTIONS={
  admit:"zip sha in SHA256SUMS; ditto extract, no quarantine, no AppTranslocation; codesign strict, spctl exec accepted, stapler valid, TeamIdentifier and Murage/age sha equal final-package-gates; app.asar package.json name; fuse RunAsNode enabled; codesign/spctl evidence read from real stderr; task keychain (original default+search list persisted before first mutation, each step persisted) default+sole search list; '<name> Safe Storage' absent; launchctl managername Aqua",
  prepare:"synthetic installation + authority files, independent pinned-keygen key outside installation, digest map, expected label/plist/control dir, manifest frozen (wx) before launch",
  probe:"owned app PID; AXManualAccessibility; bounded AX tree + screenshot retained; settings entry admitted only as exactly one AXButton named 'App settings' (Sidebar.tsx:2135-2136,2153), never guessed; app quits and bundle processes exit",
  "launch-configure":"requires admitted probe label; owned app PID; real UI select→Save references→Prepare→Register→Install backup job→UTC time/consents→Enable; exact label loaded + plist exists; credentials.bin + Safe Storage item exist (metadata only); Cmd+Q; all bundle processes exit",
  "await-scheduled":"exact-label launchd runs delta >=1 (durable trigger invocation); coordinator lastClosedResult verified written by packaged main; lastVerified sha/bytes = single archive; originals under sidecar rule; closed spawns sampled at 1 s and reported, not required",
  "no-replay":"≥2 further launchd runs; no due spawn; archive count and lastVerified unchanged",
  busy:"app configured then CLOSED; separate owned process holds the real installation lease across the due window: launchd runs delta >=1, no new archive/lastVerified change, holder uninterrupted; after release the retained due occurrence captures exactly once (second verified receipt, sidecar rule)",
  remove:"UI 'Disable all scheduled backups and remove job' → Closed-app job removed; exact label absent; plist absent; staged trigger via packaged exe → unavailable; app exits",
  restore:"Backup mode → Inspect encrypted backup (archive + key panels) → Restore separately → review window; restored paused markers; restore-review barrier; originals under sidecar rule; archive unchanged; exits",
  "cleanup-verify":"no bundle processes (SIGTERM only exact task-bundle PIDs); registration/plist recorded (manual removal recorded as cleanup, never as pass); every keychain restoration attempted, then default+search list re-read equal to persisted originals and task keychain absent (cleanup fails otherwise); task dirs removed by exact path",
};
// Exact UI names from source. PROBE-REQUIRED entries are not provable from source.
const UI={
  // Supplied only after a recorded probe; never guessed here.
  // Admitted only by the probe phase from the captured AX tree; never supplied by env or guessed.
  settingsEntry:{roles:["AXButton"],label:null,src:"src/components/Sidebar.tsx:2135-2136,2153",probe:"PROBE-REQUIRED: admitted by probe phase only when exactly one AXButton is named 'App settings'"},
  onboarding:{probe:"PROBE-REQUIRED: fresh userData may show the chat-led first-run flow before Settings (evidence screenshot only)"},
  manualAccessibility:{probe:"PROBE-REQUIRED: Chromium renderer AX tree needs AXManualAccessibility set by the assistive client"},
  general:{roles:["AXButton"],label:"General",src:"src/components/SettingsModal.tsx:49"},
  chooseRefs:{roles:["AXButton"],label:"Choose destination and recovery key",src:"src/components/BackupSettings.tsx:102"},
  panelOpen:{roles:["AXButton"],label:"Open",probe:"PROBE-REQUIRED: NSOpenPanel default button title (electron/main.mjs:3153-3158, installation-recovery-window.mjs:26,34)"},
  saveRefs:{roles:["AXButton"],label:"Save references",src:"electron/main.mjs:3159"},
  refsNotice:{pattern:"References selected\\. Scheduling has not been enabled\\.",src:"src/components/BackupSettings.tsx:101"},
  prepareJob:{roles:["AXButton"],label:"Prepare closed-app job",src:"src/components/BackupSettings.tsx:110"},
  staged:{pattern:"Job prepared, not registered",src:"src/components/backup-schedule-ui.ts:63"},
  registerJob:{roles:["AXButton"],label:"Register prepared job",src:"src/components/BackupSettings.tsx:111"},
  installJob:{roles:["AXButton"],label:"Install backup job",src:"electron/main.mjs:3127"},
  installed:{pattern:"Job registration confirmed",src:"src/components/backup-schedule-ui.ts:63"},
  dailyTime:{roles:["AXTextField","AXDateTimeArea","AXGroup"],label:"Daily time",src:"src/components/BackupSettings.tsx:122",probe:"PROBE-REQUIRED: type=time AX role and 12h segment keystrokes"},
  timezone:{roles:["AXTextField"],label:"Timezone",src:"src/components/BackupSettings.tsx:123"},
  catchup:{roles:["AXTextField","AXIncrementor"],label:"Catch-up window (hours)",src:"src/components/BackupSettings.tsx:126",probe:"PROBE-REQUIRED: number input AX role"},
  closedConsent:{roles:["AXCheckBox"],label:"Allow scheduled backups while Murage is closed, while I am signed in.",src:"src/components/BackupSettings.tsx:136"},
  idleConsent:{roles:["AXCheckBox"],label:"Allow Murage to close an idle workspace for this backup and reopen it afterward.",src:"src/components/BackupSettings.tsx:141"},
  enable:{roles:["AXButton"],label:"Enable scheduled backups",src:"src/components/BackupSettings.tsx:149"},
  enabledNotice:{pattern:"Scheduled backups enabled, including closed-app checks while you are signed in\\.",src:"src/components/BackupSettings.tsx:148"},
  disableSchedule:{roles:["AXButton"],label:"Disable schedule",src:"src/components/BackupSettings.tsx:153"},
  disableRemove:{roles:["AXButton"],label:"Disable all scheduled backups and remove job",src:"src/components/BackupSettings.tsx:112"},
  removed:{pattern:"Closed-app job removed",src:"src/components/backup-schedule-ui.ts:63"},
  backupMode:{roles:["AXButton"],label:"Restart into Backup mode",src:"src/components/BackupSettings.tsx:11"},
  backupModeConfirm:{roles:["AXButton"],label:"Restart into Backup mode",sheet:true,src:"electron/main.mjs:288",probe:"PROBE-REQUIRED: parented message box exposed as AXSheet"},
  inspectEncrypted:{roles:["AXButton"],label:"Inspect encrypted backup",src:"electron/recovery/index.html:23"},
  inspected:{pattern:"Backup inspected\\. No installation data has been changed\\.",src:"electron/recovery/renderer.js:75"},
  restoreEncrypted:{roles:["AXButton"],label:"Restore encrypted backup separately for review",src:"electron/recovery/index.html:56"},
  restoreConfirm:{roles:["AXButton"],label:"Restore separately and restart for review",src:"electron/installation-recovery-window.mjs:52"},
  reviewReason:{pattern:"This restored installation is paused for recovery review\\.",src:"electron/main.mjs:2025"},
};

const refuse=(gate,code=2)=>{process.stderr.write(`mac-installed-backup-qualification refused: ${gate}\n`);process.exit(code);};
const phase=process.argv[2],args=process.argv.slice(3);
if(!PHASES.includes(phase))refuse(`phase must be one of ${PHASES.join("|")}`);
if(phase==="admit"?args.length!==3||!args.every(value=>path.isAbsolute(value)):args.length!==0)refuse("arguments: admit <artifact-zip> <final-package-gates.json> <SHA256SUMS>; other phases take none");
const privateDir=dir=>{const s=lstatSync(dir);return path.isAbsolute(dir)&&s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077)&&realpathSync.native(dir)===dir;};
// Ordered: environment-only gates precede any account or filesystem query.
function failedGate(){
  for(const [name,test] of [
    ["darwin-arm64",()=>process.platform==="darwin"&&process.arch==="arm64"],
    ["github-hosted-runner",()=>process.env.GITHUB_ACTIONS==="true"&&process.env.RUNNER_ENVIRONMENT==="github-hosted"&&typeof process.env.RUNNER_TEMP==="string"&&path.isAbsolute(process.env.RUNNER_TEMP)],
    ["confirm",()=>process.env.MURAGE_MAC_INSTALLED_CONFIRM===CONFIRM],
    ["runner-account",()=>process.env.HOME==="/Users/runner"&&userInfo().username==="runner"],
    ["evidence-dir",()=>privateDir(process.env.MURAGE_QUAL_EVIDENCE_DIR)],
  ]){let ok=false;try{ok=test();}catch{ok=false;}if(!ok)return name;}
  return null;
}
if(phase==="plan"){
  process.stdout.write(JSON.stringify({phases:PHASES.slice(1),assertions:ASSERTIONS,probeRequired:Object.entries(UI).filter(([,v])=>v.probe).map(([k,v])=>`${k}: ${v.probe}`)},null,1)+"\n");
  const gate=failedGate();if(gate)refuse(`gate failed: ${gate}`);process.exit(0);
}
{const gate=failedGate();if(gate)refuse(`gate failed: ${gate}`);}

const E=process.env.MURAGE_QUAL_EVIDENCE_DIR,ROOT=path.join(process.env.RUNNER_TEMP,"murage-installed-qual");
const stateFile=path.join(E,"state.json"),evidenceFile=path.join(E,"qualification.json");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exists=file=>{try{lstatSync(file);return true;}catch(error){if(error.code==="ENOENT")return false;throw error;}};
const writeAtomic=(file,text)=>{const temp=`${file}.${process.pid}.tmp`;writeFileSync(temp,text,{flag:"wx",mode:0o600});renameSync(temp,file);};
const record=entry=>{const all=exists(evidenceFile)?JSON.parse(readFileSync(evidenceFile,"utf8")):[];all.push({phase,at:new Date().toISOString(),...entry});writeAtomic(evidenceFile,JSON.stringify(all,null,1)+"\n");};
const check=(condition,label)=>{if(!condition)throw Object.assign(Error("QUALIFICATION_ASSERTION_FAILED"),{code:"QUALIFICATION_ASSERTION_FAILED",label});};
const loadState=()=>JSON.parse(readFileSync(stateFile,"utf8"));
const saveState=s=>writeAtomic(stateFile,JSON.stringify(s,null,1));
const BASE_ENV={HOME:process.env.HOME,PATH:"/usr/bin:/bin:/usr/sbin:/sbin",LANG:"en_US.UTF-8"};
const AX_TREE_LIMIT=4000;
const SPAWN_SAMPLING="closed-main spawns are sampled from ps every 1000 ms and can miss short-lived processes; durable evidence is the exact-label launchd runs delta plus coordinator receipts";
/** Bounded non-throwing runner keeping stdout, stderr and status. Secrets travel only on stdin. */
const run=(command,argv,options={})=>runCommand(command,argv,{timeout:120000,env:BASE_ENV,...options});
const must=(result,label)=>{check(result.code===0,label);return result.stdout;};

function asarFile(asar,name){
  const fd=openSync(asar,"r");
  try{
    const head=Buffer.alloc(16);readSync(fd,head,0,16,0);const headerSize=head.readUInt32LE(4),length=head.readUInt32LE(12);
    check(head.readUInt32LE(0)===4&&length>0&&length+8<=headerSize,"asar-header-shape");
    const json=Buffer.alloc(length);readSync(fd,json,0,length,16);const entry=JSON.parse(json.toString("utf8")).files?.[name];
    check(entry&&!entry.unpacked&&Number.isSafeInteger(entry.size)&&/^\d+$/.test(entry.offset),"asar-entry");
    const bytes=Buffer.alloc(entry.size);readSync(fd,bytes,0,entry.size,8+headerSize+Number(entry.offset));return bytes;
  }finally{closeSync(fd);}
}
const FUSES=["RunAsNode","EnableCookieEncryption","EnableNodeOptionsEnvironmentVariable","EnableNodeCliInspectArguments","EnableEmbeddedAsarIntegrityValidation","OnlyLoadAppFromAsar","LoadBrowserProcessSpecificV8Snapshot","GrantFileProtocolExtraPrivileges"];
function fuseWire(framework){
  const bytes=readFileSync(framework),marker=Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),at=bytes.indexOf(marker);
  check(at>=0&&bytes.indexOf(marker,at+1)<0,"fuse-sentinel-unique");const base=at+marker.length,count=bytes[base+1],wire={};
  for(let i=0;i<count;i++)wire[FUSES[i]??`fuse${i}`]={48:"disabled",49:"enabled",114:"removed"}[bytes[base+2+i]]??"unknown";
  return{version:bytes[base],count,wire};
}
function digestTree(root){
  const out={};const walk=dir=>{for(const name of readdirSync(dir).sort()){const file=path.join(dir,name),rel=path.relative(root,file),s=lstatSync(file);if(s.isSymbolicLink())out[rel]="symlink";else if(s.isDirectory()){out[rel+"/"]="dir";walk(file);}else out[rel]=sha(readFileSync(file));}};
  walk(root);return out;
}
// Inherited rule: every pre-existing entry (including pre-existing sidecars) is
// identical; only newly added SQLite -shm or empty -wal bookkeeping is allowed.
function sidecarRule(before,after){
  const changed=Object.keys(before).filter(key=>before[key]!==after[key]);
  const added=Object.keys(after).filter(key=>!(key in before));
  const allowed=added.every(key=>key.endsWith(".db-shm")||(key.endsWith(".db-wal")&&after[key]===sha(Buffer.alloc(0))));
  return{ok:changed.length===0&&allowed,changed,added};
}
const listing=()=>must(run("/bin/ps",["-axo","pid=,command="]),"ps").split("\n").map(line=>/^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(([,pid,command])=>({pid:Number(pid),command}));
const bundleProcesses=s=>s.app?listing().filter(p=>p.command.includes(s.app+"/")&&p.pid!==process.pid):[];
function launchdJob(s){const r=run("/bin/launchctl",["print",`gui/${s.uid}/${s.label}`]);if(r.code!==0)return null;const field=name=>new RegExp(`^\\s*${name} = (.*)$`,"m").exec(r.stdout)?.[1]??null;return{state:field("state"),runs:Number(field("runs")),lastExit:field("last exit code"),pid:field("pid")};}
const coordinatorState=s=>{try{return JSON.parse(readFileSync(path.join(s.control,"backup-coordinator.json"),"utf8"));}catch(error){if(error.code==="ENOENT")return null;throw error;}};
const archives=s=>readdirSync(s.destination).filter(name=>name.endsWith(".age"));
const keychainItem=s=>run("/usr/bin/security",["find-generic-password","-s",s.keychainService]).code;// 0 present, 44 absent; value never requested

// System Events / JXA. Commands carry labels and task paths only.
const JXA=String.raw`function run(argv){
var cmd=JSON.parse(argv[0]),se=Application('System Events'),ps=se.processes.whose({unixId:cmd.pid});
if(cmd.op==='manualAX'){ObjC.import('ApplicationServices');var app=$.AXUIElementCreateApplication(cmd.pid);return JSON.stringify({ok:true,code:$.AXUIElementSetAttributeValue(app,$('AXManualAccessibility'),$.kCFBooleanTrue)});}
if(ps.length!==1)return JSON.stringify({ok:false,error:'process',count:ps.length});var p=ps[0];
function names(e){var v=[];['name','title','description'].forEach(function(k){try{var x=e[k]();if(typeof x==='string'&&x)v.push(x);}catch(_){}});return v;}
function role(e){try{return e.role();}catch(_){return '';}}
function all(){var out=[],ws=p.windows();for(var i=0;i<ws.length;i++){var roots=cmd.sheet?ws[i].sheets():[ws[i]];for(var r=0;r<roots.length;r++){out.push(roots[r]);var c=roots[r].entireContents();for(var j=0;j<c.length;j++)out.push(c[j]);}}return out;}
function matches(){return all().filter(function(e){return cmd.roles.indexOf(role(e))>=0&&names(e).indexOf(cmd.label)>=0;});}
if(cmd.op==='tree'){var list=all(),out=[],lim=cmd.limit||4000;for(var t=0;t<list.length&&out.length<lim;t++)out.push({role:role(list[t]),names:names(list[t]).map(function(n){return n.slice(0,200);})});return JSON.stringify({ok:true,count:list.length,truncated:list.length>lim,elements:out});}
if(cmd.op==='count')return JSON.stringify({ok:true,count:matches().length,windows:p.windows().length});
if(cmd.op==='value'){var v=matches();if(v.length!==1)return JSON.stringify({ok:false,error:'match',count:v.length});var x=null;try{x=v[0].value();}catch(_){}return JSON.stringify({ok:true,value:x});}
if(cmd.op==='press'||cmd.op==='focusType'){var m=matches();if(m.length!==1)return JSON.stringify({ok:false,error:'match',count:m.length});
 if(cmd.op==='press'){m[0].actions.byName('AXPress').perform();return JSON.stringify({ok:true});}
 p.frontmost=true;m[0].focused=true;delay(0.3);se.keystroke('a',{using:'command down'});se.keystroke(cmd.text);return JSON.stringify({ok:true});}
if(cmd.op==='texts'){var re=new RegExp(cmd.pattern);return JSON.stringify({ok:true,texts:all().map(function(e){var v='';try{v=String(e.value());}catch(_){}return [v].concat(names(e)).join(' ');}).filter(function(t){return re.test(t);}).slice(0,10)});}
if(cmd.op==='goto'){p.frontmost=true;delay(0.3);se.keystroke('g',{using:['command down','shift down']});delay(1);se.keystroke(cmd.path);delay(0.3);se.keyCode(36);delay(1);return JSON.stringify({ok:true});}
if(cmd.op==='quit'){p.frontmost=true;delay(0.3);se.keystroke('q',{using:'command down'});return JSON.stringify({ok:true});}
return JSON.stringify({ok:false,error:'op'});}`;
function ax(s,cmd){const file=path.join(s.private,"ax.js");writeAtomic(file,JXA);const r=run("/usr/bin/osascript",["-l","JavaScript",file,JSON.stringify(cmd)],{timeout:90000});try{return JSON.parse(r.stdout.trim());}catch{return{ok:false,error:"osascript",code:r.code,signal:r.signal};}}
async function step(label,fn){
  try{const result=await fn();record({step:label,ok:true,...(result===undefined?{}:{result})});return result;}
  catch(error){const shot=path.join(E,`${phase}-${label}.png`.replace(/[^A-Za-z0-9.-]/g,"_"));run("/usr/sbin/screencapture",["-x",shot]);throw Object.assign(error,{label:error.label??label,screenshot:path.basename(shot)});}
}
async function until(test,ms,label,interval=2000){const end=Date.now()+ms;for(;;){const value=await test();if(value)return value;if(Date.now()>end)check(false,label);await sleep(interval);}}
// settingsEntry label comes only from the probe admission persisted in state.
const selector=(key,s)=>{const entry=key==="settingsEntry"&&s?.settingsEntry?{...UI.settingsEntry,...s.settingsEntry}:UI[key];check(entry.label,`PROBE_REQUIRED_${key}`);return entry;};
const press=(s,pid,key,ms=30000)=>step(`press-${key}`,async()=>{const {roles,label,sheet}=selector(key,s);await until(()=>ax(s,{op:"count",pid,roles,label,sheet}).count===1,ms,`present-${key}`);const r=ax(s,{op:"press",pid,roles,label,sheet});check(r.ok,`press-${key}`);});
// Set-state, not toggle: saved closedApp survives a disabled schedule (BackupSettings.tsx:40,135).
const ensureChecked=(s,pid,key)=>step(`checked-${key}`,async()=>{const {roles,label}=selector(key,s);const before=ax(s,{op:"value",pid,roles,label});check(before.ok,`value-${key}`);if(Number(before.value)!==1)check(ax(s,{op:"press",pid,roles,label}).ok,`press-${key}`);const after=ax(s,{op:"value",pid,roles,label});check(after.ok&&Number(after.value)===1,`checked-${key}`);return{before:before.value};});
const typeInto=(s,pid,key,text)=>step(`type-${key}`,async()=>{const {roles,label}=selector(key,s);const r=ax(s,{op:"focusType",pid,roles,label,text});check(r.ok,`type-${key}`);});
const waitText=(s,pid,key,ms=60000)=>step(`wait-${key}`,()=>until(()=>{const r=ax(s,{op:"texts",pid,pattern:UI[key].pattern});return r.ok&&r.texts.length?r.texts[0]:null;},ms,`text-${key}`));
const choosePath=async(s,pid,file,name)=>{await step(`panel-${name}`,async()=>{check(ax(s,{op:"goto",pid,path:file}).ok,`goto-${name}`);});await press(s,pid,"panelOpen");};

async function launch(s,label){
  const log=openSync(path.join(s.private,`${label}-${Date.now()}.log`),"wx",0o600);
  const child=spawn(s.exe,[],{env:{HOME:process.env.HOME,PATH:"/usr/bin:/bin",TMPDIR:s.tmp,MURAGE_DATA_DIR:s.requestedRoot,MURAGE_USER_DATA:s.userData},stdio:["ignore",log,log],detached:false});
  closeSync(log);const exit=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
  record({step:`launch-${label}`,pid:child.pid});
  await until(()=>ax(s,{op:"count",pid:child.pid,roles:["AXWindow"],label:"__none__"}).windows>0,120000,`window-${label}`);
  const accessibility=ax(s,{op:"manualAX",pid:child.pid});record({step:"manual-accessibility",result:accessibility});check(accessibility.ok&&accessibility.code===0,"manual-accessibility");
  return{pid:child.pid,exit};
}
async function quit(s,handle,label){
  check(ax(s,{op:"quit",pid:handle.pid}).ok,`quit-${label}`);
  const result=await Promise.race([handle.exit,sleep(90000).then(()=>null)]);check(result,`exit-${label}`);
  await until(()=>bundleProcesses(s).filter(p=>!p.command.includes("closed-trigger-")).length===0,60000,`bundle-processes-exit-${label}`,1000);
  record({step:`exited-${label}`,pid:handle.pid,...result});
}
async function openBackupSettings(s,pid){await step("launch-state",()=>{const shot=path.join(E,`${phase}-launch-state-${pid}.png`);run("/usr/sbin/screencapture",["-x",shot]);return{screenshot:path.basename(shot)};});await press(s,pid,"settingsEntry");await press(s,pid,"general");}
async function configureDue(s,pid,minutes){
  const due=new Date(Math.ceil((Date.now()+minutes*60000)/60000)*60000),hours=due.getUTCHours(),text=`${String(hours%12||12).padStart(2,"0")}${String(due.getUTCMinutes()).padStart(2,"0")}${hours<12?"A":"P"}`;
  selector("dailyTime");await typeInto(s,pid,"dailyTime",text);await typeInto(s,pid,"timezone","UTC");selector("catchup");await typeInto(s,pid,"catchup","1");
  await ensureChecked(s,pid,"closedConsent");await ensureChecked(s,pid,"idleConsent");await press(s,pid,"enable");await waitText(s,pid,"enabledNotice");
  return due.getTime();
}

async function admit(){
  const [zip,gatesFile,sums]=args;check(!exists(stateFile),"state-absent");
  check(privateDir(ROOT),"root-private");const priv=path.join(ROOT,"private"),appDir=path.join(ROOT,"app"),tmp=path.join(ROOT,"tmp");
  for(const dir of [priv,appDir,tmp])mkdirSync(dir,{mode:0o700});
  // Task-path ownership is persisted before extraction or any OS mutation.
  const s={version:1,root:ROOT,private:priv,appDir,tmp,uid:process.getuid()};saveState(s);
  const zipSha=sha(readFileSync(zip)),listed=readFileSync(sums,"utf8").split("\n").map(line=>line.trim().split(/\s+/)).find(([,name])=>name&&path.basename(name)===path.basename(zip));
  check(listed?.[0]===zipSha,"zip-sha256-listed");const gates=JSON.parse(readFileSync(gatesFile,"utf8"));
  must(run("/usr/bin/ditto",["-x","-k",zip,appDir]),"ditto-extract");const app=realpathSync.native(path.join(appDir,"Murage.app")),exe=path.join(app,"Contents","MacOS","Murage");Object.assign(s,{app,exe});saveState(s);
  check(!/AppTranslocation|\.mount_/.test(app),"not-translocated");check(run("/usr/bin/xattr",["-p","com.apple.quarantine",app]).code!==0,"no-quarantine");
  must(run("/usr/bin/codesign",["--verify","--deep","--strict",app]),"codesign-strict");
  const spctl=run("/usr/sbin/spctl",["-a","-vv","-t","exec",app]);check(spctl.code===0&&/accepted/.test(spctl.stderr+spctl.stdout),"spctl-accepted");
  must(run("/usr/bin/xcrun",["stapler","validate",app]),"stapler-validate");
  const signature=run("/usr/bin/codesign",["-dv","--verbose=4",app]),team=/^TeamIdentifier=(.+)$/m.exec(signature.stderr)?.[1];check(signature.code===0&&team&&team===gates.appTeam,"team-matches-gates");
  const inventory=Object.fromEntries(gates.inventory.map(entry=>[entry.path,entry.sha256]));
  for(const relative of ["Contents/MacOS/Murage","Contents/Resources/backup-tools/arm64/age"])check(sha(readFileSync(path.join(app,relative)))===inventory[relative],`sha-${relative}`);
  const packaged=JSON.parse(asarFile(path.join(app,"Contents","Resources","app.asar"),"package.json").toString("utf8")),appName=packaged.productName||packaged.name;check(typeof appName==="string"&&appName,"packaged-app-name");
  const fuses=fuseWire(path.join(app,"Contents","Frameworks","Electron Framework.framework","Versions","A","Electron Framework"));check(fuses.wire.RunAsNode==="enabled","fuse-run-as-node");
  Object.assign(s,{appName,keychainService:`${appName} Safe Storage`,zipSha,team,fuses});saveState(s);
  // Synthetic VM-only password held in memory; stdin-only (`security -i`), never argv, disk or evidence.
  const setup=setupKeychain({runner:run,exists,persist:keychainState=>{s.keychainIsolation=keychainState;saveState(s);},keychain:path.join(priv,"murage-qualification.keychain-db"),password:randomBytes(32).toString("hex")});
  record({step:"keychain-isolation",ok:setup.ok,failed:setup.failed??null,code:setup.code??null,completed:setup.state.completed,originalSearchListCount:setup.state.original?.searchList.length??null});
  check(setup.ok,"task-keychain-isolation");
  check(keychainItem(s)===44,"safe-storage-item-absent-before-launch");
  const manager=run("/bin/launchctl",["managername"]);check(manager.code===0&&manager.stdout.trim()==="Aqua","launchctl-aqua-session");
  record({step:"admitted",zipSha,team,appName,keychainService:s.keychainService,fuses,manager:manager.stdout.trim(),uid:s.uid,appShaMurage:inventory["Contents/MacOS/Murage"],spctl:(spctl.stderr+spctl.stdout).trim().slice(0,500)});
  s.admitted=true;saveState(s);
}
async function prepare(){
  const s=loadState();check(s.admitted&&!s.manifest,"admitted-not-prepared");process.env.TMPDIR=s.tmp;
  const {backupFixture,testAgeKeys}=await import("../server/testing/backup-fixture.ts");
  const {closedControlDirectory}=await import("../electron/backup-closed-controller.mjs");
  const {closedInstallationIdentity,closedProfileId}=await import("../electron/backup-closed-profile.mjs");
  const keys=testAgeKeys(),f=backupFixture();f.db.close();const parent=realpathSync.native(f.parent),requestedRoot=realpathSync.native(f.data);
  // Same authority components as scripts/b20-mac-native.node-test.mjs:38-41.
  mkdirSync(path.join(requestedRoot,"channels","slack"),{recursive:true});
  writeFileSync(path.join(requestedRoot,"channels","slack","connection.json"),JSON.stringify({version:1,chosen:{teamId:"TEAM",appId:"APP",ownerUserId:"OWNER",chiefBotId:"bot"},identity:{teamId:"TEAM",userId:"UBOT",botId:"BOT"},enabled:true,paused:false,binding:{connectionId:"fixture-connection",teamId:"TEAM",appId:"APP",botUserId:"UBOT",botId:"BOT",ownerUserId:"OWNER",dmId:"DOWNER",chiefBotId:"bot"},pairing:null}));
  writeFileSync(path.join(requestedRoot,"startup-background.json"),JSON.stringify({keepRunning:false,startAtLogin:false}));
  writeFileSync(path.join(requestedRoot,"routines.json"),JSON.stringify({version:1,routines:[{id:"routine",name:"Fixture routine",prompt:"Synthetic prompt",botId:"bot",enabled:true,schedule:{type:"daily",time:"09:00",weekdays:[1]},durationMinutes:5,nextRunAt:1,createdAt:1,updatedAt:1}],runs:[{id:"run",routineId:"routine",routineName:"Fixture routine",botId:"bot",scheduledFor:1,status:"running",manual:false,createdAt:1,startedAt:1}]}));
  for(const name of ["userData","archives","keys"])mkdirSync(path.join(parent,name),{mode:0o700});
  const userData=realpathSync.native(path.join(parent,"userData")),destination=realpathSync.native(path.join(parent,"archives")),keyFile=path.join(parent,"keys","independent-recovery-key");
  writeFileSync(keyFile,keys.identity,{flag:"wx",mode:0o600});
  const control=closedControlDirectory(requestedRoot),installationIdentity=closedInstallationIdentity(requestedRoot);
  // Controller's own profile-id recipe (electron/backup-closed-controller.mjs:32).
  const label=`com.murage.backup.${closedProfileId({version:1,platform:"darwin",owner:{uid:s.uid},requestedRoot,userData,installation:requestedRoot,installationIdentity,executable:s.exe,triggerEntry:path.join(control,"unused-trigger.mjs"),triggerSha256:"0".repeat(64)})}`;
  const plist=path.join(process.env.HOME,"Library","LaunchAgents",`${label}.plist`);check(!exists(plist)&&launchdJob({uid:s.uid,label})===null,"label-absent-before-install");
  const original=digestTree(requestedRoot);
  Object.assign(s,{parent,requestedRoot,userData,destination,keyFile,control,label,plist,original,manifest:path.join(E,"manifest.json")});
  writeFileSync(s.manifest,JSON.stringify({frozenAt:new Date().toISOString(),source:process.env.GITHUB_SHA??null,zipSha:s.zipSha,app:s.app,appName:s.appName,team:s.team,keychainService:s.keychainService,label,plist,requestedRoot,userData,destination,control,keyFile:"<independent key file outside installation>",originalEntries:Object.keys(original).length,phases:PHASES.slice(1),assertions:ASSERTIONS},null,1),{flag:"wx",mode:0o600});
  saveState(s);record({step:"prepared",label,originalEntries:Object.keys(original).length});
}
async function probe(){
  const s=loadState();check(s.manifest&&!s.settingsEntry&&!s.installed,"prepared-not-probed");const app=await launch(s,"probe");let admission;
  try{
    run("/usr/sbin/screencapture",["-x",path.join(E,"probe-launch.png")]);
    const tree=ax(s,{op:"tree",pid:app.pid,limit:AX_TREE_LIMIT});check(tree.ok&&Array.isArray(tree.elements),"ax-tree");
    writeAtomic(path.join(E,"probe-ax-tree.json"),JSON.stringify({pid:app.pid,count:tree.count,truncated:tree.truncated,elements:tree.elements},null,1));
    admission=admitSettingsEntry(tree.elements);
    record({step:"probe-settings-entry",admission,treeCount:tree.count,truncated:tree.truncated,treeFile:"probe-ax-tree.json",screenshot:"probe-launch.png",remainingProbes:Object.entries(UI).filter(([key,value])=>value.probe&&key!=="settingsEntry").map(([key])=>key)});
  }finally{await quit(s,app,"probe");}
  check(admission?.ok,"settings-entry-admitted");
  s.settingsEntry={label:admission.label,roles:admission.roles,probedAt:new Date().toISOString()};saveState(s);
}
async function launchConfigure(){
  const s=loadState();check(s.manifest&&s.settingsEntry?.label&&!s.installed,"probed-not-installed");const app=await launch(s,"configure");
  await openBackupSettings(s,app.pid);await press(s,app.pid,"chooseRefs");
  await choosePath(s,app.pid,s.destination,"destination");await choosePath(s,app.pid,s.keyFile,"key");await press(s,app.pid,"saveRefs");await waitText(s,app.pid,"refsNotice");
  await press(s,app.pid,"prepareJob");await waitText(s,app.pid,"staged");await press(s,app.pid,"registerJob");await press(s,app.pid,"installJob");await waitText(s,app.pid,"installed");
  const job=await step("label-loaded",()=>{const value=launchdJob(s);check(value&&exists(s.plist),"exact-label-and-plist");return value;});
  s.dueAt=await configureDue(s,app.pid,5);
  await step("safe-storage-custody",()=>{check(exists(path.join(s.userData,"credentials.bin"))&&keychainItem(s)===0,"credentials-bin-and-keychain-item");return{credentialsBin:true,keychainItem:"present (value not read)"};});
  s.plistSha256=sha(readFileSync(s.plist));await quit(s,app,"configure");
  s.installed=true;saveState(s);record({step:"configured",label:s.label,plistSha256:s.plistSha256,dueAt:new Date(s.dueAt).toISOString(),job});
}
async function awaitScheduled(){
  const s=loadState();check(s.installed&&!s.scheduled,"installed-not-scheduled");const seen=new Set(),runsBefore=launchdJob(s)?.runs;check(Number.isSafeInteger(runsBefore),"launchd-runs-before");
  const result=await until(()=>{
    const processes=listing();for(const p of processes)if(p.command.startsWith(s.exe+" --murage-backup-due"))seen.add(p.pid);
    const alive=new Set(processes.map(p=>p.pid)),state=coordinatorState(s),list=archives(s),runs=launchdJob(s)?.runs;
    const done=state?.lastClosedResult?.status==="verified"&&state.lastVerified&&list.length===1&&runs>=runsBefore+1&&[...seen].every(pid=>!alive.has(pid));
    return done?{state,list,runs}:null;
  },s.dueAt-Date.now()+8*60000,"scheduled-verified",1000);
  const bytes=readFileSync(path.join(s.destination,result.list[0])),rule=sidecarRule(s.original,digestTree(s.requestedRoot)),job=launchdJob(s);
  record({step:"scheduled-capture",runsBefore,runsAfter:result.runs,sampledDueSpawns:[...seen],spawnSampling:SPAWN_SAMPLING,job,lastClosedResult:result.state.lastClosedResult,lastVerified:result.state.lastVerified,archiveSha256:sha(bytes),archiveBytes:bytes.length,sidecars:rule});
  check(result.state.lastVerified.sha256===sha(bytes)&&result.state.lastVerified.bytes===bytes.length,"receipt-matches-archive");check(rule.ok,"original-sidecar-rule");
  Object.assign(s,{scheduled:true,archive:path.join(s.destination,result.list[0]),archiveSha256:sha(bytes),lastVerified:result.state.lastVerified,runsAfterCapture:job?.runs});saveState(s);
}
async function noReplay(){
  const s=loadState();check(s.scheduled,"scheduled");const start=launchdJob(s).runs,due=new Set();
  await until(()=>{for(const p of listing())if(p.command.startsWith(s.exe+" --murage-backup-due"))due.add(p.pid);return launchdJob(s).runs>=start+2;},240000,"two-further-runs",1000);
  const state=coordinatorState(s);record({step:"no-replay",spawnSampling:SPAWN_SAMPLING,runsFrom:start,runsTo:launchdJob(s).runs,dueSpawns:[...due],archives:archives(s).length,lastVerified:state.lastVerified});
  check(due.size===0&&archives(s).length===1&&same(state.lastVerified,s.lastVerified),"no-replay");
}
async function busy(){
  // Isolated owner case: the app is CLOSED and a separate owned process holds the
  // real installation lease, so the in-app idle restart (backup-schedule-host.mjs:95-113,
  // which configure requires) cannot race the scheduled closed spawn. Packaged
  // main refuses at acquireDesktopDataOwner (main.mjs:3172,3430) without capture;
  // the retained due occurrence must then capture exactly once after release.
  const s=loadState();check(s.scheduled&&!s.busyChecked,"busy-pending");const app=await launch(s,"busy-configure");
  await openBackupSettings(s,app.pid);await press(s,app.pid,"disableSchedule");const due=await configureDue(s,app.pid,4);await quit(s,app,"busy-configure");
  check(Date.now()<due-30000,"busy-owner-before-due");
  const lease=new URL("../electron/data-dir-lease.mjs",import.meta.url).href;
  const holder=spawn(process.execPath,["--input-type=module","-e",`import {acquireDataDirLease} from ${JSON.stringify(lease)};const owned=acquireDataDirLease(${JSON.stringify(s.requestedRoot)});process.stdout.write("held\\n");process.stdin.resume();process.stdin.on("end",()=>{owned.release();process.exit(0);});`],{stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin",HOME:process.env.HOME}});
  const holderExit=new Promise(resolve=>holder.once("exit",code=>resolve(code)));let text="";holder.stdout.on("data",chunk=>{text+=chunk;});
  const seen=new Set();
  try{
    await until(()=>text.includes("held\n")||holder.exitCode!==null,30000,"busy-owner-held",500);check(holder.exitCode===null,"busy-owner-held");
    const runsBefore=launchdJob(s)?.runs;check(Number.isSafeInteger(runsBefore),"busy-launchd-runs-before");record({step:"busy-owner",holderPid:holder.pid,due,runsBefore});
    await until(()=>{for(const p of listing())if(p.command.startsWith(s.exe+" --murage-backup-due"))seen.add(p.pid);return Date.now()>due+150000;},due-Date.now()+170000,"busy-window",1000);
    const alive=new Set(listing().map(p=>p.pid)),state=coordinatorState(s),runsAfter=launchdJob(s)?.runs;
    const refused={holderAlive:holder.exitCode===null,runsBefore,runsAfter,sampledDueSpawns:[...seen],spawnSampling:SPAWN_SAMPLING,spawnsExited:[...seen].every(pid=>!alive.has(pid)),archives:archives(s).length,lastClosedResult:state.lastClosedResult,lastVerified:state.lastVerified};
    record({step:"busy-refused",...refused});
    check(refused.holderAlive&&runsAfter>=runsBefore+1&&refused.spawnsExited&&refused.archives===1&&same(state.lastVerified,s.lastVerified),"busy-no-capture-owner-uninterrupted");
  }finally{holder.stdin.end();}
  check(await Promise.race([holderExit,sleep(30000).then(()=>null)])===0,"busy-owner-released");
  const after=await until(()=>{const state=coordinatorState(s),list=archives(s);return state?.lastClosedResult?.status==="verified"&&list.length===2&&state.lastVerified?.sha256!==s.lastVerified.sha256?{state,list}:null;},5*60000,"busy-retained-due-captured",5000);
  const added=after.list.find(name=>path.join(s.destination,name)!==s.archive),bytes=readFileSync(path.join(s.destination,added)),rule=sidecarRule(s.original,digestTree(s.requestedRoot));
  record({step:"busy-released-capture",lastClosedResult:after.state.lastClosedResult,lastVerified:after.state.lastVerified,archiveSha256:sha(bytes),sidecars:rule});
  check(after.state.lastVerified.sha256===sha(bytes)&&after.state.lastVerified.bytes===bytes.length&&rule.ok,"busy-released-receipt");
  Object.assign(s,{busyChecked:true,busyArchive:path.join(s.destination,added),busyLastVerified:after.state.lastVerified});saveState(s);
}
async function remove(){
  const s=loadState();check(s.scheduled&&!s.removed,"remove-pending");const app=await launch(s,"remove");
  await openBackupSettings(s,app.pid);await press(s,app.pid,"disableRemove");await waitText(s,app.pid,"removed");
  await step("registration-absent",()=>{check(launchdJob(s)===null&&!exists(s.plist),"label-and-plist-absent");});await quit(s,app,"remove");
  const pointer=JSON.parse(readFileSync(path.join(s.control,"closed-job-pointer.json"),"utf8")),text=readFileSync(path.join(s.control,pointer.directory,`${s.label}.plist`),"utf8");
  const argv=[.../<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(text)[1].matchAll(/<string>(.*?)<\/string>/gs)].map(m=>m[1].replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'").replaceAll("&amp;","&"));
  check(argv[0]===s.exe&&argv.length===4,"staged-program");
  const trigger=run(argv[0],argv.slice(1),{env:{...BASE_ENV,ELECTRON_RUN_AS_NODE:"1"},timeout:120000}),status=/{"type":"murage:closed-backup-trigger","status":"([a-z-]+)"}/.exec(trigger.stdout)?.[1];
  record({step:"trigger-after-removal",exit:trigger.code,status});check(trigger.code===0&&status==="unavailable","trigger-unavailable");
  s.removed=true;saveState(s);
}
async function restore(){
  const s=loadState();check(s.removed&&!s.restored,"restore-pending");const {resolveInstallationSelection}=await import("../electron/installation-selection.mjs");
  const first=await launch(s,"restore");await openBackupSettings(s,first.pid);await press(s,first.pid,"backupMode");await press(s,first.pid,"backupModeConfirm");
  await first.exit;// Product relaunches itself (electron/main.mjs:295); track that exact bundle process.
  const recovery=await step("backup-mode-process",()=>until(()=>{const p=bundleProcesses(s).find(p=>p.command.startsWith(s.exe)&&p.command.includes("--murage-backup-mode"));return p?{pid:p.pid,exit:new Promise(()=>{})}:null;},60000,"backup-mode-relaunch"));
  await press(s,recovery.pid,"inspectEncrypted",120000);await choosePath(s,recovery.pid,s.archive,"archive");await choosePath(s,recovery.pid,s.keyFile,"recovery-key");await waitText(s,recovery.pid,"inspected",120000);
  await press(s,recovery.pid,"restoreEncrypted");await press(s,recovery.pid,"restoreConfirm");
  const review=await step("review-process",()=>until(()=>{const p=bundleProcesses(s).find(p=>p.command.startsWith(s.exe)&&p.pid!==recovery.pid&&!p.command.includes("--murage-backup-mode"));return p?{pid:p.pid}:null;},300000,"review-relaunch",3000));
  await waitText(s,review.pid,"reviewReason",120000);
  const selected=resolveInstallationSelection(s.userData,s.requestedRoot),target=selected.dataDirectory,j=file=>JSON.parse(readFileSync(path.join(target,file),"utf8"));
  const config=j("config.json"),bot=j("bots.json")[0],routines=j("routines.json"),connections=j("restored-connections.json"),reviewFile=j("restore-review.json");
  const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(path.join(target,"messages.db"),{readOnly:true});let memory;try{memory=db.prepare("SELECT mode FROM memory_meta").get().mode;}finally{db.close();}
  // Markers asserted by scripts/b20-mac-native.node-test.mjs (installation-restore-preparation.ts:64-201).
  const markers={selected:selected.selected===true&&target!==s.requestedRoot,engineDiscovery:config.engineDiscovery==="explicit",instancesDisabled:Object.values(config.instances??{}).every(value=>value.enabled===false),credentialCanaryAbsent:!JSON.stringify(config).includes("FAKE-CREDENTIAL-CANARY"),
    botAuthority:bot.autoApprove===false&&bot.computer==="off"&&bot.browser===false&&bot.composio===false&&bot.autoStartVps===false&&same(bot.resumeCursors,{}),routineDisabled:routines.routines[0].enabled===false&&routines.runs[0].status==="cancelled",
    channelsAbsent:!exists(path.join(target,"channels")),startupAbsent:!exists(path.join(target,"startup-background.json")),connectionsFresh:same(Object.keys(connections).sort(),["id","version"]),companionAbsent:!exists(path.join(target,"companion")),review:reviewFile.status==="review-required",memoryPaused:memory==="paused"};
  const rule=sidecarRule(s.original,digestTree(s.requestedRoot)),archiveUnchanged=sha(readFileSync(s.archive))===s.archiveSha256;
  record({step:"restored",target,markers,sidecars:rule,archiveUnchanged});check(Object.values(markers).every(Boolean)&&rule.ok&&archiveUnchanged,"restored-paused-originals-unchanged");
  check(ax(s,{op:"quit",pid:review.pid}).ok,"quit-review");await until(()=>bundleProcesses(s).length===0,120000,"review-exit",1000);
  s.restored=true;saveState(s);
}
async function cleanupVerify(){
  const s=exists(stateFile)?loadState():null;if(!s){record({step:"cleanup",state:"no-state"});return;}
  const remaining=bundleProcesses(s);for(const p of remaining)if(p.command.startsWith(s.app+"/"))process.kill(p.pid,"SIGTERM");
  if(remaining.length)await until(()=>bundleProcesses(s).length===0,60000,"owned-processes-exit",1000).catch(()=>null);
  const job=s.label?launchdJob(s):null,plistPresent=Boolean(s.plist&&exists(s.plist));let manual=null;
  if(job||plistPresent){manual={bootout:job?run("/bin/launchctl",["bootout",`gui/${s.uid}/${s.label}`]).code:null,unlinked:false};if(plistPresent&&s.plistSha256&&sha(readFileSync(s.plist))===s.plistSha256){rmSync(s.plist);manual.unlinked=true;}}
  const item=s.keychainService&&s.keychainIsolation?.completed?.includes("default")?keychainItem(s):null;
  // Every restoration is attempted, then verified by re-reading (lib cleanupKeychain).
  const keychain=s.keychainIsolation?cleanupKeychain({runner:run,state:s.keychainIsolation,exists}):{ok:true,reason:"not-started",results:[],verified:null};
  const left=bundleProcesses(s).map(p=>p.pid);
  // Exact recorded task paths under ROOT only; the evidence directory is retained for upload.
  if(!left.length)for(const dir of [s.parent,s.appDir,s.tmp,s.private].filter(Boolean))if(dir.startsWith(ROOT+"/")&&dir!==E&&exists(dir))rmSync(dir,{recursive:true,force:true});
  record({step:"cleanup",terminated:remaining.map(p=>p.pid),left,registrationBeforeCleanup:job,plistPresent,manualRemovalNotAPass:manual,keychainItemBeforeDelete:item,keychainCompleted:s.keychainIsolation?.completed??null,keychainCleanup:keychain,productRemovalPassed:Boolean(s.removed)});
  check(left.length===0,"no-owned-processes-left");check(keychain.ok,"keychain-restored-task-keychain-absent");
}
const phases={admit,prepare,probe,"launch-configure":launchConfigure,"await-scheduled":awaitScheduled,"no-replay":noReplay,busy,remove,restore,"cleanup-verify":cleanupVerify};
try{await phases[phase]();record({step:"phase-complete"});}
catch(error){try{record({step:"phase-failed",label:typeof error?.label==="string"?error.label:null,code:typeof error?.code==="string"?error.code:null,screenshot:error?.screenshot??null});}catch{/* evidence write failed */}process.exitCode=1;}
process.exit(process.exitCode??0);
