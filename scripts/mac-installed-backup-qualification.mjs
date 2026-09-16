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
import {redactSecretsInLine} from "../electron/diagnostics.mjs";
import {admitSettingsEntry,cleanupKeychain,guiBackupFixtureBot,guiBackupFixtureRoutines,guiSeedStartupFindings,classifyQualificationSetup,freezeQualificationOperation,runCommand,setupKeychain} from "./mac-installed-backup-qualification-lib.mjs";

const CONFIRM="packaged-backup-ephemeral-runner";
// remove precedes restore: a published restored selection changes the selected
// installation bound into the closed descriptor (electron/backup-closed-profile.mjs:74).
const PHASES=["plan","admit","prepare","probe","launch-configure","await-scheduled","no-replay","busy","remove","restore","cleanup-verify"];
const ASSERTIONS={
  admit:"zip sha in SHA256SUMS; ditto extract, no quarantine, no AppTranslocation; codesign strict, spctl exec accepted, stapler valid, TeamIdentifier and Murage/age sha equal final-package-gates; app.asar package.json name; fuse RunAsNode enabled; codesign/spctl evidence read from real stderr; task keychain (original default+search list persisted before first mutation, each step persisted) default+sole search list; '<name> Safe Storage' absent; launchctl managername Aqua",
  prepare:"synthetic installation + authority files, independent pinned-keygen key outside installation, GUI seed (complete fixture bot/task, enabled idle routine, terminal history) with no source-cited startup/render findings before the freeze, digest map, expected label/plist/control dir, manifest frozen (wx) before launch",
  probe:"owned app PID; AXManualAccessibility diagnostic; actual bounded AX tree + screenshot retained; settings entry admitted only as exactly one AXButton named 'App settings' (Sidebar.tsx:2135-2136,2153), never guessed; app quits and bundle processes exit; setup drift vs frozen original recorded after quit (non-gating evidence, never a baseline)",
  "launch-configure":"requires admitted probe label; owned app PID; real UI select→Save references→Prepare→Register→Install backup job→unique unchecked closed-app consent enabled (requires installed/current controller + host registration)→UTC time/consents→Enable; exact label loaded + plist exists; credentials.bin + Safe Storage item exist (metadata only); Cmd+Q; all bundle processes exit; setup drift vs frozen original recorded after quit (non-gating evidence)",
  "await-scheduled":"exact-label launchd runs delta >=1 (durable trigger invocation); coordinator lastClosedResult verified written by packaged main; lastVerified sha/bytes = single archive; immutable pre-operation originals under unchanged sidecar rule; initial setup drift separately gated and retained; closed spawns sampled at 1 s and reported, not required",
  "no-replay":"≥2 further launchd runs; no due spawn; archive count and lastVerified unchanged",
  busy:"app configured then CLOSED; separate owned process holds the real installation lease across the due window: launchd runs delta >=1, no new archive/lastVerified change, holder uninterrupted; after release the retained due occurrence captures exactly once (second verified receipt, sidecar rule)",
  remove:"UI 'Disable all scheduled backups and remove job' → Closed-app job removed; exact label absent; plist absent; staged trigger via packaged exe → unavailable; app exits",
  restore:"Backup mode UI entry → quit recovery and all owned bundle processes → freeze original installation → relaunch same executable in backup mode → Inspect encrypted backup (archive + key panels) → Restore separately → review window; restored paused markers; restore-review barrier; pre-operation originals under unchanged sidecar rule through review exit; archive unchanged",
  "cleanup-verify":"no bundle processes (SIGTERM only exact task-bundle PIDs); registration/plist recorded (manual removal recorded as cleanup, never as pass); every keychain restoration attempted, then default+search list re-read equal to persisted originals and task keychain absent (cleanup fails otherwise); task dirs removed by exact path",
};
// Exact UI names from source. PROBE-REQUIRED entries are not provable from source.
const UI={
  // Supplied only after a recorded probe; never guessed here.
  // Admitted only by the probe phase from the captured AX tree; never supplied by env or guessed.
  settingsEntry:{roles:["AXButton"],label:null,src:"src/components/Sidebar.tsx:2135-2136,2153",probe:"PROBE-REQUIRED: admitted by probe phase only when exactly one AXButton is named 'App settings'"},
  onboarding:{probe:"PROBE-REQUIRED: fresh userData may show the chat-led first-run flow before Settings (evidence screenshot only)"},
  manualAccessibility:{probe:"Attempt AXManualAccessibility and retain its result; admission requires the actual renderer AX tree, not optional setter support"},
  general:{roles:["AXButton"],label:"General",src:"src/components/SettingsModal.tsx:49"},
  chooseRefs:{roles:["AXButton"],label:"Choose destination and recovery key",src:"src/components/BackupSettings.tsx:102"},
  panelOpen:{roles:["AXButton"],label:"Open",probe:"PROBE-REQUIRED: NSOpenPanel default button title (electron/main.mjs:3153-3158, installation-recovery-window.mjs:26,34)"},
  saveRefs:{roles:["AXButton"],label:"Save references",src:"electron/main.mjs:3159"},
  refsNotice:{pattern:"References selected\\. Scheduling has not been enabled\\.",src:"src/components/BackupSettings.tsx:101"},
  prepareJob:{roles:["AXButton"],label:"Prepare closed-app job",src:"src/components/BackupSettings.tsx:110"},
  staged:{pattern:"Job prepared, not registered",src:"src/components/backup-schedule-ui.ts:63"},
  registerJob:{roles:["AXButton"],label:"Register prepared job",src:"src/components/BackupSettings.tsx:111"},
  installJob:{roles:["AXButton"],label:"Install backup job",src:"electron/main.mjs:3127"},
  dailyTime:{roles:["AXTimeField"],label:"Daily time",src:"src/components/BackupSettings.tsx:122",probe:"Native AXTimeField; named hour/minute and optional AM/PM segments require observed ranges/readback"},
  timezone:{roles:["AXTextField"],label:"Timezone",src:"src/components/BackupSettings.tsx:123"},
  catchup:{roles:["AXTextField","AXIncrementor"],label:"Catch-up window (hours)",src:"src/components/BackupSettings.tsx:126",probe:"PROBE-REQUIRED: number input AX role"},
  sizeBudget:{roles:["AXTextField","AXIncrementor"],label:"Maximum backup size (GiB)",src:"src/components/BackupSettings.tsx:128"},
  durationBudget:{roles:["AXTextField","AXIncrementor"],label:"Maximum run duration (minutes)",src:"src/components/BackupSettings.tsx:129"},
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
// Existing Mac closed-native qualification caps (b21-mac-closed-native.mjs:144).
const GUI_SCHEDULE_BUDGETS=Object.freeze({maxBytes:100000000,maxDurationMs:600000});
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
// Evidence only: what ordinary packaged startup wrote into the frozen original
// root after the app fully quit. Never a gate and never a replacement baseline
// (root decides; lane-3 BASELINE-PROPOSAL). s.original and sidecarRule are unchanged.
function recordSetupDrift(s,label){
  try{
    const after=digestTree(s.requestedRoot),rule=sidecarRule(s.original,after),removed=Object.keys(s.original).filter(key=>!(key in after));
    writeAtomic(path.join(E,`setup-drift-${label}.json`),JSON.stringify({gating:false,originalEntries:Object.keys(s.original).length,entries:Object.keys(after).length,changed:rule.changed,added:rule.added,removed,original:s.original,after},null,1)+"\n");
    record({step:`setup-drift-${label}`,gating:false,sidecarRuleOk:rule.ok,changed:rule.changed,added:rule.added,removed,file:`setup-drift-${label}.json`});
  }catch(error){try{record({step:`setup-drift-${label}`,gating:false,error:typeof error?.code==="string"?error.code:"digest-failed"});}catch{/* evidence write failed */}}
}
const listing=()=>must(run("/bin/ps",["-axo","pid=,command="]),"ps").split("\n").map(line=>/^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(([,pid,command])=>({pid:Number(pid),command}));
const bundleProcesses=s=>s.app?listing().filter(p=>p.command.includes(s.app+"/")&&p.pid!==process.pid):[];
function launchdJob(s){const r=run("/bin/launchctl",["print",`gui/${s.uid}/${s.label}`]);if(r.code!==0)return null;const field=name=>new RegExp(`^\\s*${name} = (.*)$`,"m").exec(r.stdout)?.[1]??null;return{state:field("state"),runs:Number(field("runs")),lastExit:field("last exit code"),pid:field("pid")};}
const coordinatorState=s=>{try{return JSON.parse(readFileSync(path.join(s.control,"backup-coordinator.json"),"utf8"));}catch(error){if(error.code==="ENOENT")return null;throw error;}};
const archives=s=>readdirSync(s.destination).filter(name=>name.endsWith(".age"));
async function quietSnapshot(s,label){
  await until(()=>bundleProcesses(s).length===0,60000,`quiet-${label}`,1000);
  return digestTree(s.requestedRoot);
}
async function beforeSetup(s,label){
  const current=await quietSnapshot(s,label);
  if(s.lastQuiescent){const rule=sidecarRule(s.lastQuiescent,current);record({step:`before-setup-${label}`,sidecars:rule});check(rule.ok,"late-operation-write-before-setup");}
}
async function finishSetup(s,label,baseline,notStarted=true){
  const current=await quietSnapshot(s,label);
  const setup=baseline?freezeQualificationOperation(s,baseline,current,{closed:true,notStarted:typeof notStarted==="function"?notStarted():notStarted}):classifyQualificationSetup(s.original,current);
  record({step:`setup-boundary-${label}`,baseline:baseline??null,frozenAt:new Date().toISOString(),setup,original:s.original,current});
  check(setup.ok,"UNEXPECTED_SETUP_WRITE");s.lastQuiescent=current;saveState(s);return current;
}
async function operationEnd(s,baseline,label){
  check(Boolean(s[baseline]),"operation-baseline-required");
  const current=await quietSnapshot(s,label),rule=sidecarRule(s[baseline],current);
  record({step:`operation-boundary-${label}`,baseline,sidecars:rule,initialDrift:sidecarRule(s.original,current),current});
  check(rule.ok,"operation-originals-unchanged");s.lastQuiescent=current;saveState(s);return rule;
}
const keychainItem=s=>run("/usr/bin/security",["find-generic-password","-s",s.keychainService]).code;// 0 present, 44 absent; value never requested

// System Events / JXA. Commands carry labels and task paths only.
const JXA=String.raw`function run(argv){
var cmd=JSON.parse(argv[0]),se=Application('System Events'),ps=se.processes.whose({unixId:cmd.pid});
if(cmd.op==='manualAX'){
 ObjC.import('ApplicationServices');
 // JXA bridges kCFBooleanTrue as a CFNumber; wrap a JS boolean to retain CFBoolean.
 var value=$(true),valueType=String($.CFGetTypeID(value)),booleanType=String($.CFBooleanGetTypeID());
 if(valueType!==booleanType)return JSON.stringify({ok:false,error:'AX-boolean-type',valueType:valueType,booleanType:booleanType});
 var app=$.AXUIElementCreateApplication(cmd.pid),code=$.AXUIElementSetAttributeValue(app,$('AXManualAccessibility'),value);
 return JSON.stringify({ok:code===0,code:code,valueType:valueType,booleanType:booleanType});
}
if(ps.length!==1)return JSON.stringify({ok:false,error:'process',count:ps.length});var p=ps[0];
// System Events cannot resolve Chromium AXTimeField descendants. Use the
// public AX API for this exact control; input still comes from real key events.
if(cmd.op==='time'){
 if(!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(cmd.text))return JSON.stringify({ok:false,error:'time-format'});
 ObjC.import('ApplicationServices');
 ObjC.bindFunction('AXUIElementCreateApplication',['id',['int']]);
 ObjC.bindFunction('AXUIElementCopyAttributeValue',['int',['id','id','id *']]);
 ObjC.bindFunction('AXUIElementSetAttributeValue',['int',['id','id','id']]);
 function read(e,k){var r=Ref();return $.AXUIElementCopyAttributeValue(e,$(k),r)===0?ObjC.deepUnwrap(r[0]):null;}
 var visited=0,overflow=false;
 function walk(e,predicate,out,depth){if(depth>64||++visited>4000){overflow=true;return;}if(predicate(e))out.push(e);var children=read(e,'AXChildren')||[];for(var i=0;i<children.length;i++)walk(children[i],predicate,out,depth+1);}
 var app=$.AXUIElementCreateApplication(cmd.pid),windows=read(app,'AXWindows')||[],fields=[];
 for(var w=0;w<windows.length;w++)walk(windows[w],function(e){return read(e,'AXRole')==='AXTimeField'&&read(e,'AXTitle')===cmd.label;},fields,0);
 if(overflow||fields.length!==1)return JSON.stringify({ok:false,error:'time-field',count:fields.length,overflow:overflow});
 var segments=[];visited=0;walk(fields[0],function(e){return read(e,'AXRole')==='AXIncrementor';},segments,0);
 var observed=segments.map(function(e){return{title:read(e,'AXTitle'),min:read(e,'AXMinValue'),max:read(e,'AXMaxValue')};});
 function named(name){return segments.filter(function(e){return read(e,'AXTitle')===name+' '+cmd.label;});}
 var hour=named('Hours'),minute=named('Minutes'),period=named('AM/PM');
 if(overflow||hour.length!==1||minute.length!==1||period.length>1||segments.length!==2+period.length)return JSON.stringify({ok:false,error:'time-segments',observed:observed});
 var low=read(hour[0],'AXMinValue'),high=read(hour[0],'AXMaxValue'),twelve=period.length===1;
 if((twelve?low!==1||high!==12:low!==0||high!==23)||read(minute[0],'AXMinValue')!==0||read(minute[0],'AXMaxValue')!==59||(twelve&&(read(period[0],'AXMinValue')!==0||read(period[0],'AXMaxValue')!==1)))return JSON.stringify({ok:false,error:'time-ranges',observed:observed});
 var h=Number(cmd.text.slice(0,2)),m=Number(cmd.text.slice(3)),expectedHour=twelve?(h%12||12):h;
 var parts=[{e:hour[0],text:String(expectedHour),value:expectedHour},{e:minute[0],text:String(m),value:m}];if(twelve)parts.push({e:period[0],text:h<12?'A':'P',value:h<12?0:1});
 p.frontmost=true;
 for(var j=0;j<parts.length;j++){var focus=$.AXUIElementSetAttributeValue(parts[j].e,$('AXFocused'),$(true));if(focus!==0)return JSON.stringify({ok:false,error:'time-focus',code:focus,observed:observed});delay(0.2);se.keystroke(parts[j].text);delay(0.2);}
 se.keyCode(48);delay(0.2);
 var values=parts.map(function(part){return{title:read(part.e,'AXTitle'),value:read(part.e,'AXValue'),description:read(part.e,'AXValueDescription'),expected:part.value};});
 var verified=values.every(function(v){return v.value===v.expected&&typeof v.description==='string'&&v.description.length>0;});
 return JSON.stringify({ok:verified,error:verified?null:'time-readback',format:twelve?'12-hour':'24-hour',requested:cmd.text,observed:observed,values:values});
}
// Query the owned PID through public AX APIs. System Events remains keyboard-only.
ObjC.import('ApplicationServices');
ObjC.bindFunction('AXUIElementCreateApplication',['id',['int']]);
ObjC.bindFunction('AXUIElementCreateSystemWide',['id',[]]);
ObjC.bindFunction('AXUIElementCopyAttributeValue',['int',['id','id','id *']]);
ObjC.bindFunction('AXUIElementSetAttributeValue',['int',['id','id','id']]);
ObjC.bindFunction('AXUIElementPerformAction',['int',['id','id']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout',['int',['id','float']]);
var queryStarted=Date.now(),visited=0,queryWindows=0;
function bounded(){if(Date.now()-queryStarted>12000)throw{error:'AX-query-deadline',visited:visited};}
function readAX(e,k,required){bounded();var value=Ref(),code=$.AXUIElementCopyAttributeValue(e,$(k),value);if(code===0)return ObjC.deepUnwrap(value[0]);if(!required&&(code===-25205||code===-25212))return null;throw{error:'AX-read',attribute:k,code:code,visited:visited};}
function names(e){return ['AXTitle','AXDescription'].map(function(k){return readAX(e,k,false);}).filter(function(v){return typeof v==='string'&&v.length;});}
function role(e){return readAX(e,'AXRole',true);}
function all(){
 var out=[],app=$.AXUIElementCreateApplication(cmd.pid),ws=readAX(app,'AXWindows',true)||[];queryWindows=ws.length;
 function walk(e,depth){bounded();if(depth>64||++visited>4000)throw{error:'AX-tree-limit',visited:visited,depth:depth};out.push(e);var children=readAX(e,'AXChildren',false)||[];for(var n=0;n<children.length;n++)walk(children[n],depth+1);}
 for(var i=0;i<ws.length;i++){var roots=cmd.sheet?(readAX(ws[i],'AXSheets',false)||[]):[ws[i]];for(var j=0;j<roots.length;j++)walk(roots[j],0);}return out;
}
function matches(){return all().filter(function(e){return cmd.roles.indexOf(role(e))>=0&&names(e).indexOf(cmd.label)>=0;});}
try{
 var timeoutCode=$.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(),1);
 if(timeoutCode!==0)throw{error:'AX-timeout-setup',code:timeoutCode};
 if(cmd.op==='tree'){var list=all(),out=[],lim=cmd.limit||4000;for(var t=0;t<list.length&&out.length<lim;t++)out.push({role:role(list[t]),names:names(list[t]).map(function(n){return n.slice(0,200);})});return JSON.stringify({ok:true,count:list.length,truncated:list.length>lim,elements:out,backend:'AXUIElement',elapsedMs:Date.now()-queryStarted});}
 if(cmd.op==='count'){var found=matches();return JSON.stringify({ok:true,count:found.length,windows:queryWindows,visited:visited,backend:'AXUIElement',elapsedMs:Date.now()-queryStarted});}
 if(cmd.op==='value'||cmd.op==='state'){var v=matches();if(v.length!==1)return JSON.stringify({ok:false,error:'match',count:v.length,visited:visited});var x=readAX(v[0],'AXValue',false);return JSON.stringify({ok:true,value:x,enabled:cmd.op==='state'?readAX(v[0],'AXEnabled',true):null,backend:'AXUIElement'});}
 if(cmd.op==='press'||cmd.op==='focusType'){var m=matches();if(m.length!==1)return JSON.stringify({ok:false,error:'match',count:m.length,visited:visited});
  if(cmd.op==='press'){var code=$.AXUIElementPerformAction(m[0],$('AXPress'));return JSON.stringify({ok:code===0,code:code,backend:'AXUIElement'});}
  p.frontmost=true;var focused=$.AXUIElementSetAttributeValue(m[0],$('AXFocused'),$(true));if(focused!==0)return JSON.stringify({ok:false,error:'AX-focus',code:focused});delay(0.3);se.keystroke('a',{using:'command down'});se.keystroke(cmd.text);return JSON.stringify({ok:true,backend:'AXUIElement'});
 }
 if(cmd.op==='texts'){var re=new RegExp(cmd.pattern),values=all().map(function(e){var value=readAX(e,'AXValue',false);return [value===null?'':String(value)].concat(names(e)).join(' ');});return JSON.stringify({ok:true,texts:values.filter(function(t){return re.test(t);}).slice(0,10),count:values.length,diagnostics:values.filter(function(t){return /backup|schedul|registration|job|refresh/i.test(t);}).slice(0,30).map(function(t){return t.slice(0,300);}),backend:'AXUIElement',elapsedMs:Date.now()-queryStarted});}
}catch(error){return JSON.stringify({ok:false,error:error.error||'AX-exception',attribute:error.attribute||null,code:error.code===undefined?null:error.code,visited:visited,elapsedMs:Date.now()-queryStarted,backend:'AXUIElement'});}
if(cmd.op==='goto'){p.frontmost=true;delay(0.3);se.keystroke('g',{using:['command down','shift down']});delay(1);se.keystroke(cmd.path);delay(0.3);se.keyCode(36);delay(1);return JSON.stringify({ok:true});}
if(cmd.op==='quit'){p.frontmost=true;delay(0.3);se.keystroke('q',{using:'command down'});return JSON.stringify({ok:true});}
return JSON.stringify({ok:false,error:'op'});}`;
function ax(s,cmd){const file=path.join(s.private,"ax.js");writeAtomic(file,JXA);const r=run("/usr/bin/osascript",["-l","JavaScript",file,JSON.stringify(cmd)],{timeout:90000});try{return JSON.parse(r.stdout.trim());}catch{return{ok:false,error:"osascript",code:r.code,signal:r.signal,timedOut:r.timedOut,commandError:r.error,stderr:redactSecretsInLine(r.stderr).slice(-2000)};}}
async function step(label,fn){
  try{const result=await fn();record({step:label,ok:true,...(result===undefined?{}:{result})});return result;}
  catch(error){const shot=path.join(E,`${phase}-${label}.png`.replace(/[^A-Za-z0-9.-]/g,"_"));run("/usr/sbin/screencapture",["-x",shot]);throw Object.assign(error,{label:error.label??label,screenshot:path.basename(shot)});}
}
async function until(test,ms,label,interval=2000){const end=Date.now()+ms;for(;;){const value=await test();if(value)return value;if(Date.now()>end)check(false,label);await sleep(interval);}}
// settingsEntry label comes only from the probe admission persisted in state.
const selector=(key,s)=>{const entry=key==="settingsEntry"&&s?.settingsEntry?{...UI.settingsEntry,...s.settingsEntry}:UI[key];check(entry.label,`PROBE_REQUIRED_${key}`);return entry;};
const press=(s,pid,key,ms=30000)=>step(`press-${key}`,async()=>{
  const {roles,label,sheet}=selector(key,s);let lastResult=null,queries=0;
  try{await until(()=>{lastResult=ax(s,{op:"count",pid,roles,label,sheet});queries++;return lastResult.ok&&lastResult.count===1;},ms,`present-${key}`);}
  catch(error){record({step:`selector-query-failed-${key}`,pid,roles,label,sheet:Boolean(sheet),queries,result:lastResult});throw error;}
  const result=ax(s,{op:"press",pid,roles,label,sheet});record({step:`press-observation-${key}`,pid,result});check(result.ok,`press-${key}`);
});
// Set-state, not toggle: saved closedApp survives a disabled schedule (BackupSettings.tsx:40,135).
const ensureChecked=(s,pid,key)=>step(`checked-${key}`,async()=>{const {roles,label}=selector(key,s);const before=ax(s,{op:"value",pid,roles,label});check(before.ok,`value-${key}`);if(Number(before.value)!==1)check(ax(s,{op:"press",pid,roles,label}).ok,`press-${key}`);const after=ax(s,{op:"value",pid,roles,label});check(after.ok&&Number(after.value)===1,`checked-${key}`);return{before:before.value};});
const typeInto=(s,pid,key,text)=>step(`type-${key}`,async()=>{const {roles,label}=selector(key,s);const r=ax(s,{op:key==="dailyTime"?"time":"focusType",pid,roles,label,text});record({step:`type-observation-${key}`,result:r});check(r.ok,`type-${key}`);});
async function waitText(s,pid,key,ms=60000){
  let lastResult=null,queries=0;
  return step(`wait-${key}`,async()=>{
    try{return await until(()=>{lastResult=ax(s,{op:"texts",pid,pattern:UI[key].pattern});queries++;return lastResult.ok&&lastResult.texts.length?lastResult.texts[0]:null;},ms,`text-${key}`);}
    catch(error){
      const result=lastResult?{...lastResult,...(lastResult.diagnostics?{diagnostics:lastResult.diagnostics.map(redactSecretsInLine)}:{})}:null;
      record({step:`text-query-failed-${key}`,pid,pattern:UI[key].pattern,queries,result});throw error;
    }
  });
}
// For an unchecked closed-app consent control, enabled means both the current
// controller and host registration are confirmed (BackupSettings.tsx:72,135).
// A checked control remains editable when registration is lost; never admit it.
async function waitInstalled(s,pid){
  const {roles,label}=selector("closedConsent",s);let lastResult=null;
  return step("registration-ui-ready",async()=>{
    try{
      await until(()=>{lastResult=ax(s,{op:"state",pid,roles,label});return lastResult.ok&&[0,"0",false].includes(lastResult.value)&&lastResult.enabled===true;},60000,"registration-ui-ready");
      return{roles,label,result:lastResult};
    }catch(error){record({step:"registration-ui-query-failed",pid,roles,label,result:lastResult});throw error;}
  });
}
const choosePath=async(s,pid,file,name)=>{await step(`panel-${name}`,async()=>{check(ax(s,{op:"goto",pid,path:file}).ok,`goto-${name}`);});await press(s,pid,"panelOpen");};

async function launch(s,label,args=[]){
  const log=openSync(path.join(s.private,`${label}-${Date.now()}.log`),"wx",0o600);
  const child=spawn(s.exe,args,{env:{HOME:process.env.HOME,PATH:"/usr/bin:/bin",TMPDIR:s.tmp,MURAGE_DATA_DIR:s.requestedRoot,MURAGE_USER_DATA:s.userData},stdio:["ignore",log,log],detached:false});
  closeSync(log);const exit=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
  record({step:`launch-${label}`,pid:child.pid});
  await until(()=>ax(s,{op:"count",pid:child.pid,roles:["AXWindow"],label:"__none__"}).windows>0,120000,`window-${label}`);
  // Retain the setter's actual status (-25200 is AX failure, not unsupported).
  // The renderer tree and exact selector remain the admission gate.
  const accessibility=ax(s,{op:"manualAX",pid:child.pid});record({step:"manual-accessibility",result:accessibility});
  return{pid:child.pid,exit};
}
async function quit(s,handle,label){
  check(ax(s,{op:"quit",pid:handle.pid}).ok,`quit-${label}`);
  const result=await Promise.race([handle.exit,sleep(90000).then(()=>null)]);check(result,`exit-${label}`);
  await until(()=>bundleProcesses(s).filter(p=>!p.command.includes("closed-trigger-")).length===0,60000,`bundle-processes-exit-${label}`,1000);
  record({step:`exited-${label}`,pid:handle.pid,...result});
}
async function openBackupSettings(s,pid){await step("launch-state",()=>{const shot=path.join(E,`${phase}-launch-state-${pid}.png`);run("/usr/sbin/screencapture",["-x",shot]);return{screenshot:path.basename(shot)};});await press(s,pid,"settingsEntry",120000);await press(s,pid,"general");}
async function configureDue(s,pid,minutes){
  await typeInto(s,pid,"timezone","UTC");selector("catchup");await typeInto(s,pid,"catchup","1");
  await typeInto(s,pid,"sizeBudget",String(GUI_SCHEDULE_BUDGETS.maxBytes/1024**3));await typeInto(s,pid,"durationBudget",String(GUI_SCHEDULE_BUDGETS.maxDurationMs/60000));
  await ensureChecked(s,pid,"closedConsent");
  // Compute the unchanged lead after slower form entry. Editing time clears idle
  // consent (BackupSettings edit), so that consent must be confirmed afterward.
  const due=new Date(Math.ceil((Date.now()+minutes*60000)/60000)*60000),text=`${String(due.getUTCHours()).padStart(2,"0")}:${String(due.getUTCMinutes()).padStart(2,"0")}`;
  selector("dailyTime");await typeInto(s,pid,"dailyTime",text);
  await ensureChecked(s,pid,"idleConsent");await press(s,pid,"enable");await waitText(s,pid,"enabledNotice");
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
  const botsFile=path.join(requestedRoot,"bots.json"),bots=JSON.parse(readFileSync(botsFile,"utf8"));
  check(Array.isArray(bots)&&bots.length===1,"single-synthetic-fixture-bot");
  writeFileSync(botsFile,JSON.stringify([guiBackupFixtureBot(bots[0])])+"\n");
  // Same authority components as scripts/b20-mac-native.node-test.mjs:38-41.
  mkdirSync(path.join(requestedRoot,"channels","slack"),{recursive:true});
  writeFileSync(path.join(requestedRoot,"channels","slack","connection.json"),JSON.stringify({version:1,chosen:{teamId:"TEAM",appId:"APP",ownerUserId:"OWNER",chiefBotId:"bot"},identity:{teamId:"TEAM",userId:"UBOT",botId:"BOT"},enabled:true,paused:false,binding:{connectionId:"fixture-connection",teamId:"TEAM",appId:"APP",botUserId:"UBOT",botId:"BOT",ownerUserId:"OWNER",dmId:"DOWNER",chiefBotId:"bot"},pairing:null}));
  writeFileSync(path.join(requestedRoot,"startup-background.json"),JSON.stringify({keepRunning:false,startAtLogin:false}));
  writeFileSync(path.join(requestedRoot,"routines.json"),JSON.stringify(guiBackupFixtureRoutines(Date.now())));
  // Source-cited GUI seed validity (19947871 Store/RoutineManager/restore schema/renderer), checked before the original digest is frozen.
  const seedFindings=guiSeedStartupFindings({bots:JSON.parse(readFileSync(botsFile,"utf8")),routines:JSON.parse(readFileSync(path.join(requestedRoot,"routines.json"),"utf8")),now:Date.now()});
  record({step:"gui-seed-validity",findings:seedFindings});check(seedFindings.length===0,"gui-seed-startup-idempotent");
  for(const name of ["userData","archives","keys"])mkdirSync(path.join(parent,name),{mode:0o700});
  const userData=realpathSync.native(path.join(parent,"userData")),destination=realpathSync.native(path.join(parent,"archives")),keyFile=path.join(parent,"keys","independent-recovery-key");
  writeFileSync(keyFile,keys.identity,{flag:"wx",mode:0o600});
  const control=closedControlDirectory(requestedRoot),installationIdentity=closedInstallationIdentity(requestedRoot);
  // Controller's own profile-id recipe (electron/backup-closed-controller.mjs:32).
  const label=`com.murage.backup.${closedProfileId({version:1,platform:"darwin",owner:{uid:s.uid},requestedRoot,userData,installation:requestedRoot,installationIdentity,executable:s.exe,triggerEntry:path.join(control,"unused-trigger.mjs"),triggerSha256:"0".repeat(64)})}`;
  const plist=path.join(process.env.HOME,"Library","LaunchAgents",`${label}.plist`);check(!exists(plist)&&launchdJob({uid:s.uid,label})===null,"label-absent-before-install");
  const original=digestTree(requestedRoot);
  Object.assign(s,{parent,requestedRoot,userData,destination,keyFile,control,label,plist,original,manifest:path.join(E,"manifest.json")});
  writeFileSync(s.manifest,JSON.stringify({frozenAt:new Date().toISOString(),source:process.env.GITHUB_SHA??null,zipSha:s.zipSha,app:s.app,appName:s.appName,team:s.team,keychainService:s.keychainService,label,plist,requestedRoot,userData,destination,control,keyFile:"<independent key file outside installation>",originalEntries:Object.keys(original).length,scheduleBudgets:GUI_SCHEDULE_BUDGETS,phases:PHASES.slice(1),assertions:ASSERTIONS},null,1),{flag:"wx",mode:0o600});
  saveState(s);record({step:"prepared",label,originalEntries:Object.keys(original).length});
}
async function probe(){
  const s=loadState();check(s.manifest&&!s.settingsEntry&&!s.installed,"prepared-not-probed");const app=await launch(s,"probe");let admission,tree;
  try{
    // A native window can precede the server/renderer. Wait for the unchanged
    // exact control admission rather than judging the initial blank shell.
    await until(()=>{
      tree=ax(s,{op:"tree",pid:app.pid,limit:AX_TREE_LIMIT});
      admission=admitSettingsEntry(tree.ok?tree.elements:null);
      return admission.ok;
    },120000,"renderer-settings-ready",1000);
  }finally{
    try{
      run("/usr/sbin/screencapture",["-x",path.join(E,"probe-launch.png")]);
      writeAtomic(path.join(E,"probe-ax-tree.json"),JSON.stringify({pid:app.pid,...tree},null,1));
      record({step:"probe-settings-entry",admission,treeCount:tree?.count,truncated:tree?.truncated,treeFile:"probe-ax-tree.json",screenshot:"probe-launch.png",remainingProbes:Object.entries(UI).filter(([key,value])=>value.probe&&key!=="settingsEntry").map(([key])=>key)});
    }finally{await quit(s,app,"probe");recordSetupDrift(s,"probe");await finishSetup(s,"probe");}
  }
  check(admission?.ok,"settings-entry-admitted");
  s.settingsEntry={label:admission.label,roles:admission.roles,probedAt:new Date().toISOString()};saveState(s);
}
async function launchConfigure(){
  const s=loadState();check(s.manifest&&s.settingsEntry?.label&&!s.installed,"probed-not-installed");await beforeSetup(s,"configure");const app=await launch(s,"configure");
  await openBackupSettings(s,app.pid);await press(s,app.pid,"chooseRefs");
  await choosePath(s,app.pid,s.destination,"destination");await choosePath(s,app.pid,s.keyFile,"key");await press(s,app.pid,"saveRefs");await waitText(s,app.pid,"refsNotice");
  await press(s,app.pid,"prepareJob");await waitText(s,app.pid,"staged");await press(s,app.pid,"registerJob");await press(s,app.pid,"installJob");await waitInstalled(s,app.pid);
  const job=await step("label-loaded",()=>{const value=launchdJob(s);check(value&&exists(s.plist),"exact-label-and-plist");return value;});
  s.dueAt=await configureDue(s,app.pid,5);
  await step("safe-storage-custody",()=>{check(exists(path.join(s.userData,"credentials.bin"))&&keychainItem(s)===0,"credentials-bin-and-keychain-item");return{credentialsBin:true,keychainItem:"present (value not read)"};});
  s.plistSha256=sha(readFileSync(s.plist));await quit(s,app,"configure");recordSetupDrift(s,"configure");
  await finishSetup(s,"configure","preScheduled",()=>Date.now()<s.dueAt-60000&&!coordinatorState(s)?.lastClosedResult&&archives(s).length===0);
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
  const bytes=readFileSync(path.join(s.destination,result.list[0])),rule=await operationEnd(s,"preScheduled","scheduled"),job=launchdJob(s);
  record({step:"scheduled-capture",runsBefore,runsAfter:result.runs,sampledDueSpawns:[...seen],spawnSampling:SPAWN_SAMPLING,job,lastClosedResult:result.state.lastClosedResult,lastVerified:result.state.lastVerified,archiveSha256:sha(bytes),archiveBytes:bytes.length,sidecars:rule});
  check(result.state.lastVerified.sha256===sha(bytes)&&result.state.lastVerified.bytes===bytes.length,"receipt-matches-archive");check(rule.ok,"original-sidecar-rule");
  Object.assign(s,{scheduled:true,archive:path.join(s.destination,result.list[0]),archiveSha256:sha(bytes),lastVerified:result.state.lastVerified,runsAfterCapture:job?.runs});saveState(s);
}
async function noReplay(){
  const s=loadState();check(s.scheduled,"scheduled");const start=launchdJob(s).runs,due=new Set();
  await until(()=>{for(const p of listing())if(p.command.startsWith(s.exe+" --murage-backup-due"))due.add(p.pid);return launchdJob(s).runs>=start+2;},240000,"two-further-runs",1000);
  const state=coordinatorState(s);record({step:"no-replay",spawnSampling:SPAWN_SAMPLING,runsFrom:start,runsTo:launchdJob(s).runs,dueSpawns:[...due],archives:archives(s).length,lastVerified:state.lastVerified});
  check(due.size===0&&archives(s).length===1&&same(state.lastVerified,s.lastVerified),"no-replay");
  await operationEnd(s,"preScheduled","no-replay");
}
async function busy(){
  // Isolated owner case: the app is CLOSED and a separate owned process holds the
  // real installation lease, so the in-app idle restart (backup-schedule-host.mjs:95-113,
  // which configure requires) cannot race the scheduled closed spawn. Packaged
  // main refuses at acquireDesktopDataOwner (main.mjs:3172,3430) without capture;
  // the retained due occurrence must then capture exactly once after release.
  const s=loadState();check(s.scheduled&&!s.busyChecked,"busy-pending");await beforeSetup(s,"busy-configure");const app=await launch(s,"busy-configure");
  await openBackupSettings(s,app.pid);await press(s,app.pid,"disableSchedule");const due=await configureDue(s,app.pid,4);await quit(s,app,"busy-configure");
  check(Date.now()<due-30000,"busy-owner-before-due");
  await finishSetup(s,"busy-configure","preBusy",()=>Date.now()<due-30000&&archives(s).length===1&&same(coordinatorState(s)?.lastVerified,s.lastVerified));
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
  const added=after.list.find(name=>path.join(s.destination,name)!==s.archive),bytes=readFileSync(path.join(s.destination,added)),rule=await operationEnd(s,"preBusy","busy");
  record({step:"busy-released-capture",lastClosedResult:after.state.lastClosedResult,lastVerified:after.state.lastVerified,archiveSha256:sha(bytes),sidecars:rule});
  check(after.state.lastVerified.sha256===sha(bytes)&&after.state.lastVerified.bytes===bytes.length&&rule.ok,"busy-released-receipt");
  Object.assign(s,{busyChecked:true,busyArchive:path.join(s.destination,added),busyLastVerified:after.state.lastVerified});saveState(s);
}
async function remove(){
  const s=loadState();check(s.scheduled&&!s.removed,"remove-pending");await beforeSetup(s,"remove");const app=await launch(s,"remove");
  await openBackupSettings(s,app.pid);await press(s,app.pid,"disableRemove");await waitText(s,app.pid,"removed");
  await step("registration-absent",()=>{check(launchdJob(s)===null&&!exists(s.plist),"label-and-plist-absent");});await quit(s,app,"remove");
  await finishSetup(s,"remove");
  const pointer=JSON.parse(readFileSync(path.join(s.control,"closed-job-pointer.json"),"utf8")),text=readFileSync(path.join(s.control,pointer.directory,`${s.label}.plist`),"utf8");
  const argv=[.../<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(text)[1].matchAll(/<string>(.*?)<\/string>/gs)].map(m=>m[1].replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'").replaceAll("&amp;","&"));
  check(argv[0]===s.exe&&argv.length===4,"staged-program");
  const trigger=run(argv[0],argv.slice(1),{env:{...BASE_ENV,ELECTRON_RUN_AS_NODE:"1"},timeout:120000}),status=/{"type":"murage:closed-backup-trigger","status":"([a-z-]+)"}/.exec(trigger.stdout)?.[1];
  record({step:"trigger-after-removal",exit:trigger.code,status});check(trigger.code===0&&status==="unavailable","trigger-unavailable");
  s.removed=true;saveState(s);
}
async function restore(){
  const s=loadState();check(s.removed&&!s.restored,"restore-pending");const {resolveInstallationSelection}=await import("../electron/installation-selection.mjs");
  await beforeSetup(s,"restore");const first=await launch(s,"restore");await openBackupSettings(s,first.pid);await press(s,first.pid,"backupMode");await press(s,first.pid,"backupModeConfirm");
  await first.exit;// Product relaunches itself (electron/main.mjs:295); track that exact bundle process.
  const entered=await step("backup-mode-process",()=>until(()=>{const p=bundleProcesses(s).find(p=>p.command.startsWith(s.exe)&&p.command.includes("--murage-backup-mode"));return p?{pid:p.pid}:null;},60000,"backup-mode-relaunch"));
  check(ax(s,{op:"quit",pid:entered.pid}).ok,"quit-recovery-before-baseline");
  await finishSetup(s,"restore","preRestore",()=>sha(readFileSync(s.archive))===s.archiveSha256&&!s.restored);
  const recovery=await launch(s,"restore-operation",["--murage-backup-mode"]);
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
  check(Boolean(s.preRestore),"restore-baseline-required");
  const rule=sidecarRule(s.preRestore,digestTree(s.requestedRoot)),archiveUnchanged=sha(readFileSync(s.archive))===s.archiveSha256;
  // Evidence only (not a marker): task-level authority is the effective turn authority (store.ts:2046-2048) and restore keeps it (installation-restore-preparation.ts:103).
  const taskAuthority=(Array.isArray(bot.tasks)?bot.tasks:[]).map(task=>({threadId:task?.threadId??null,autoApprove:task?.autoApprove??null,alwaysAllowCount:Array.isArray(task?.alwaysAllow)?task.alwaysAllow.length:null,resumeCursorsCleared:same(task?.resumeCursors,{})}));
  record({step:"restored",target,markers,sidecars:rule,archiveUnchanged,taskAuthority,limitations:["Idle GUI seed: running-to-cancelled conversion is not exercised here; retain its separate qualification requirement.",
    "The seeded run is already terminal (cancelled) before capture; routineDisabled's runs[0] status is pass-through (installation-restore-preparation.ts:21,125), never evidence of running/waiting-to-cancelled conversion.",
    "Task-level autoApprove/alwaysAllow after restore are recorded in taskAuthority, not gated; seeded from store.ts:988 (tasks[0].autoApprove true). Gating is a root decision."]});check(Object.values(markers).every(Boolean)&&rule.ok&&archiveUnchanged,"restored-paused-originals-unchanged");
  check(ax(s,{op:"quit",pid:review.pid}).ok,"quit-review");await until(()=>bundleProcesses(s).length===0,120000,"review-exit",1000);
  await operationEnd(s,"preRestore","restore-after-exit");
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
  // Bounded tails of the app's own logs, copied before task paths are removed:
  // launch() stdout/stderr (main console, [renderer] load-failure/crash lines,
  // electron/main.mjs:2311-2328) and the isolated logs dir (setAppLogsPath at
  // electron/main.mjs:139; server.log/desktop-crashes.log at 691-692,741).
  // server.log holds raw server child output (main.mjs:1380-1381) whose env carries
  // tokens, and the evidence artifact is readable on a public repository, so bytes
  // are kept only through the product redactor as the bug-report bundle uses it
  // (electron/diagnostics.mjs readSafeLogTail:115, redactSecretsInLine:76, as in
  // buildDiagnosticsReport:316,323). No redactor, no bytes; nothing here throws.
  const appLogs=[];
  try{
    let safe=null;try{const d=await import("../electron/diagnostics.mjs");if(typeof d.readSafeLogTail==="function"&&typeof d.redactSecretsInLine==="function")safe=d;}catch{}
    const keepLog=(file,name)=>{try{if(!safe){appLogs.push({name,error:"redaction-unavailable"});return;}const tail=safe.readSafeLogTail(file);if(!tail){appLogs.push({name,error:"unsafe-or-unreadable"});return;}let text;try{text=safe.redactSecretsInLine(tail.tail);}catch{appLogs.push({name,error:"redaction-unavailable"});return;}writeAtomic(path.join(E,name),text);appLogs.push({name,tailBytes:tail.bytes,redacted:true});}catch(error){appLogs.push({name,error:error?.code??"write-failed"});}};
    const list=(dir,label)=>{try{return exists(dir)?readdirSync(dir):[];}catch(error){appLogs.push({name:label,error:error?.code??"enumerate-failed"});return[];}};
    if(s.private)for(const name of list(s.private,"private-dir").filter(name=>name.endsWith(".log")).sort())keepLog(path.join(s.private,name),`app-${name}`);
    if(s.userData){const logs=path.join(s.userData,"logs"),present=list(logs,"userdata-logs-dir");for(const name of ["server.log","desktop-crashes.log"])if(present.includes(name))keepLog(path.join(logs,name),`app-userdata-${name}`);}
  }catch(error){appLogs.push({name:"app-logs",error:error?.code??"capture-failed"});}
  // Exact recorded task paths under ROOT only; the evidence directory is retained for upload.
  if(!left.length)for(const dir of [s.parent,s.appDir,s.tmp,s.private].filter(Boolean))if(dir.startsWith(ROOT+"/")&&dir!==E&&exists(dir))rmSync(dir,{recursive:true,force:true});
  record({step:"cleanup",terminated:remaining.map(p=>p.pid),left,registrationBeforeCleanup:job,plistPresent,manualRemovalNotAPass:manual,keychainItemBeforeDelete:item,keychainCompleted:s.keychainIsolation?.completed??null,keychainCleanup:keychain,appLogs,productRemovalPassed:Boolean(s.removed)});
  check(left.length===0,"no-owned-processes-left");check(keychain.ok,"keychain-restored-task-keychain-absent");
}
const phases={admit,prepare,probe,"launch-configure":launchConfigure,"await-scheduled":awaitScheduled,"no-replay":noReplay,busy,remove,restore,"cleanup-verify":cleanupVerify};
try{await phases[phase]();record({step:"phase-complete"});}
catch(error){try{record({step:"phase-failed",label:typeof error?.label==="string"?error.label:null,code:typeof error?.code==="string"?error.code:null,screenshot:error?.screenshot??null});}catch{/* evidence write failed */}process.exitCode=1;}
process.exit(process.exitCode??0);
