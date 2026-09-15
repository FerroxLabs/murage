// Pure, injectable helpers for scripts/mac-installed-backup-qualification.mjs.
// No top-level side effects: synthetic tests exercise these without a runner,
// Keychain, launchd or the packaged app.
import {spawnSync} from "node:child_process";

/** Exact bot keys written by server/testing/backup-fixture.ts:25 at signed
 * source 19947871. Any other key is fixture drift: refused, never overwritten. */
const FIXTURE_BOT_KEYS=["autoApprove","id","name","notifications","resumeCursors","threadId"];
const plainObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
/** The archive fixture is intentionally minimal; the GUI needs a complete bot.
 * Keep its authority canaries, but supply the presentation/model/task fields
 * normally supplied by Store.createBot. No engine is invoked by this helper.
 * Task authority is what Store task adoption derives for this bot
 * (server/store.ts:988); task-level authority is the effective turn authority
 * (store.ts:2046-2048), so seeding false would silently disarm the canary. */
export function guiBackupFixtureBot(bot){
  if(!plainObject(bot)||bot.id!=="bot"||bot.threadId!=="thread"||typeof bot.name!=="string"||JSON.stringify(Object.keys(bot).sort())!==JSON.stringify(FIXTURE_BOT_KEYS)
    ||!plainObject(bot.resumeCursors)||typeof bot.autoApprove!=="boolean"||typeof bot.notifications!=="boolean")throw Error("UNEXPECTED_BACKUP_FIXTURE_BOT");
  const modelSelection={instanceId:"fixture",model:"fixture-model"};
  return{...bot,title:"",description:"",color:"orange",unread:false,createdAt:1,modelSelection,
    tasks:[{threadId:bot.threadId,title:"New task",createdAt:1,resumeCursors:{...bot.resumeCursors},
      modelSelection:{...modelSelection},autoApprove:bot.autoApprove===true,alwaysAllow:[],unread:false}]};
}

/** Idle GUI seed: keep an enabled routine for restore-pause checks without
 * asking ordinary startup to recover a running job or a missed occurrence. */
export function guiBackupFixtureRoutines(now){
  if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(now+86400000))throw Error("INVALID_FIXTURE_TIME");
  return{version:1,routines:[{id:"routine",name:"Fixture routine",prompt:"Synthetic prompt",botId:"bot",enabled:true,
    schedule:{type:"daily",time:"09:00",weekdays:[1]},durationMinutes:5,nextRunAt:now+86400000,createdAt:1,updatedAt:1}],
    runs:[{id:"run",routineId:"routine",routineName:"Fixture routine",botId:"bot",scheduledFor:1,status:"cancelled",manual:false,createdAt:1,startedAt:1,finishedAt:1}]};
}

/** Upper bound of one qualification job (workflow timeout-minutes: 60). */
export const GUI_SEED_WINDOW_MS=60*60*1000;
const RECORD_ID=/^[\w-]{1,160}$/,EMBER_COLORS=["green","blue","red","orange","purple","cyan","pink","yellow","teal","coral"];
const RUN_STATUS=["queued","running","waiting","completed","failed","cancelled","missed"],TERMINAL_RUN=["completed","failed","cancelled","missed"];
const isText=value=>typeof value==="string",isTime=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0,isId=value=>isText(value)&&RECORD_ID.test(value);
const isSelection=value=>plainObject(value)&&isText(value.instanceId)&&value.instanceId!==""&&isText(value.model)&&value.model!=="";
/** Source-cited startup validity of the GUI seed at signed source 19947871.
 * Each finding names the predicate ordinary startup or the first render would
 * hit (Store load/save, RoutineManager construct/tick, restore record schema,
 * renderer dereference). Empty means none of the cited predicates fire; it is
 * not a boot of the app and never replaces the packaged probe. */
export function guiSeedStartupFindings({bots,routines,now,windowMs=GUI_SEED_WINDOW_MS}){
  if(!Number.isSafeInteger(now)||now<0)throw Error("INVALID_FIXTURE_TIME");
  const findings=[],add=(file,code,cite)=>findings.push({file,code,cite});
  if(!Array.isArray(bots)||bots.length!==1)add("bots.json","single-bot","qualification.mjs prepare single-synthetic-fixture-bot");
  for(const bot of Array.isArray(bots)?bots:[]){
    if(!plainObject(bot)){add("bots.json","bot-shape","store.ts:479");continue;}
    for(const key of ["id","threadId"])if(!isId(bot[key]))add("bots.json",`bot-${key}`,"installation-restore-preparation.ts:18");
    for(const key of ["name","title","description"])if(!isText(bot[key]))add("bots.json",`bot-${key}`,"store.ts:479-607");
    for(const key of ["notifications","unread"])if(typeof bot[key]!=="boolean")add("bots.json",`bot-${key}`,"store.ts:479-607");
    if(!isTime(bot.createdAt))add("bots.json","bot-createdAt","store.ts:479-607");
    if(!EMBER_COLORS.includes(bot.color))add("bots.json","bot-color","store.ts:621-632");
    if(!isSelection(bot.modelSelection))add("bots.json","bot-model-selection","src/state/store.tsx:240-245; src/components/ChatHeader.tsx:203");
    if(!plainObject(bot.resumeCursors))add("bots.json","bot-resume-cursors","store.ts:479-607");
    if(bot.busy||(bot.activity!==undefined&&bot.activity!=="idle"))add("bots.json","busy-reset-save","store.ts:822,1011");
    for(const key of ["browserProfile","cloudBackend","autoStartVps","persona","avatarUrl","avatarCrop","chiefScope","chiefOfStaff","individual"])if(Object.hasOwn(bot,key))add("bots.json",`load-normalization-${key}`,"store.ts:825-918,1011");
    if(bot.alwaysAllow!==undefined)add("bots.json","load-normalization-alwaysAllow","store.ts:923-937,1002-1011");
    const tasks=Array.isArray(bot.tasks)?bot.tasks:[];
    if(!tasks.length){add("bots.json","task-adoption-save","store.ts:977,987-990,1011");continue;}
    const active=tasks.filter(task=>plainObject(task)&&task.threadId===bot.threadId),threads=new Set();
    if(active.length!==1)add("bots.json","active-task","store.ts:985");
    for(const task of tasks){
      if(!plainObject(task)||!isId(task.threadId)){add("bots.json","task-shape","store.ts:275-308");continue;}
      if(threads.has(task.threadId))add("bots.json","task-thread-duplicate","installation-restore-preparation.ts:98-103");
      threads.add(task.threadId);
      if(!isText(task.title)||!isTime(task.createdAt)||!plainObject(task.resumeCursors))add("bots.json","task-required","store.ts:275-308");
      if(task.modelSelection===undefined||task.autoApprove===undefined||task.alwaysAllow===undefined||task.unread===undefined)add("bots.json","task-adoption-save","store.ts:987-990,1011");
      if(task.modelSelection!==undefined&&!isSelection(task.modelSelection))add("bots.json","task-model-selection","src/state/store.tsx:793-797; src/components/ChatHeader.tsx:203");
      if(Array.isArray(task.alwaysAllow)&&task.alwaysAllow.length)add("bots.json","load-normalization-alwaysAllow","store.ts:1002-1011");
    }
    if(active.length===1&&active[0].autoApprove!==(bot.autoApprove===true))add("bots.json","task-authority-canary","store.ts:988,2046-2048");
    if(typeof bot.unread==="boolean"&&bot.unread!==tasks.some(task=>task?.unread===true))add("bots.json","unread-projection","store.ts:995");
  }
  if(!plainObject(routines)||routines.version!==1||!Array.isArray(routines.routines)||!Array.isArray(routines.runs)){add("routines.json","routines-shape","installation-record-validation.ts:19");return findings;}
  const routineIds=new Set(),runIds=new Set();let terminalHistory=false;
  if(!routines.routines.some(routine=>plainObject(routine)&&routine.enabled===true))add("routines.json","routine-not-enabled","qualification.mjs restore routineDisabled needs an enabled original");
  for(const routine of routines.routines){
    if(!plainObject(routine)||!isId(routine.id)||!isId(routine.botId)||!isText(routine.name)||!isText(routine.prompt)||typeof routine.enabled!=="boolean"||typeof routine.durationMinutes!=="number"||!Number.isFinite(routine.durationMinutes)
      ||!isTime(routine.createdAt)||!isTime(routine.updatedAt)||!(routine.nextRunAt===null||isTime(routine.nextRunAt))){add("routines.json","routine-record","installation-record-validation.ts:16");continue;}
    if(routineIds.has(routine.id))add("routines.json","duplicate-id","installation-record-validation.ts:19 unique ids");
    routineIds.add(routine.id);
    const schedule=routine.schedule;
    if(!plainObject(schedule)||schedule.type!=="daily"||!isText(schedule.time)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)||!Array.isArray(schedule.weekdays)||schedule.weekdays.length<1||schedule.weekdays.length>7
      ||!schedule.weekdays.every(day=>Number.isInteger(day)&&day>=0&&day<=6))add("routines.json","routine-schedule","routines.ts:410-418; installation-record-validation.ts:12");
    if(routine.watch!==undefined)add("routines.json","routine-watch","routines.ts:548");
    if(routine.enabled===true&&(routine.nextRunAt===null||routine.nextRunAt<=now+windowMs))add("routines.json","routine-due-within-window","routines.ts:1170,1208");
  }
  for(const run of routines.runs){
    if(!plainObject(run)||!isId(run.id)||!isId(run.routineId)||!isText(run.routineName)||!isId(run.botId)||typeof run.scheduledFor!=="number"||!Number.isFinite(run.scheduledFor)||!RUN_STATUS.includes(run.status)
      ||typeof run.manual!=="boolean"||!isTime(run.createdAt)||(run.startedAt!==undefined&&!isTime(run.startedAt))||(run.finishedAt!==undefined&&!isTime(run.finishedAt))){add("routines.json","run-record","installation-record-validation.ts:17");continue;}
    if(runIds.has(run.id))add("routines.json","duplicate-id","installation-record-validation.ts:19 unique ids");
    runIds.add(run.id);
    if(run.status==="running"||run.status==="waiting")add("routines.json","run-startup-recovery","routines.ts:606-625");
    if(run.status==="queued")add("routines.json","run-queued-dispatch","routines.ts:1211-1212");
    if(run.watch!==undefined)add("routines.json","run-watch","routines.ts:574");
    if(!routineIds.has(run.routineId))add("routines.json","run-orphan","history must belong to the seeded routine");
    if(TERMINAL_RUN.includes(run.status)&&isTime(run.finishedAt))terminalHistory=true;
  }
  if(!terminalHistory)add("routines.json","terminal-history-missing","valid terminal history required");
  return findings;
}

export const COMMAND_MAX_BUFFER=16*1024*1024;
const code=error=>typeof error?.code==="string"&&/^[A-Z][A-Z0-9_]{0,60}$/.test(error.code)?error.code:error?"COMMAND_ERROR":null;
/** Bounded, never-throwing command primitive. stdout, stderr and status are kept
 * for success AND failure (codesign/spctl report on stderr when they succeed). */
export function runCommand(command,argv,{input,timeout=120000,env,spawn=spawnSync}={}){
  let result;
  try{result=spawn(command,argv,{input,timeout,env,encoding:"utf8",stdio:["pipe","pipe","pipe"],maxBuffer:COMMAND_MAX_BUFFER});}
  catch(error){return{code:null,signal:null,stdout:"",stderr:"",timedOut:false,error:code(error)};}
  return{code:typeof result.status==="number"?result.status:null,signal:result.signal??null,stdout:String(result.stdout??""),stderr:String(result.stderr??""),timedOut:result.error?.code==="ETIMEDOUT",error:code(result.error)};
}

export const SECURITY="/usr/bin/security";
export const KEYCHAIN_OWNER="murage-installed-qualification";
export const KEYCHAIN_STEPS=["created","unlocked","settings","searchList","default"];
const unquote=line=>line.trim().replace(/^"|"$/g,"");
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function readKeychainState(runner){
  const current=runner(SECURITY,["default-keychain","-d","user"]),list=runner(SECURITY,["list-keychains","-d","user"]);
  if(current.code!==0||list.code!==0)return null;
  return{defaultKeychain:unquote(current.stdout),searchList:list.stdout.split("\n").map(unquote).filter(Boolean)};
}
export const planKeychainIsolation=({keychain})=>({version:1,owner:KEYCHAIN_OWNER,keychain,original:null,preexisting:null,completed:[]});
/** Original default + search list and task path are persisted BEFORE the first
 * mutation; each completed step is persisted after it succeeds. The password is
 * stdin-only (`security -i`) and redacted from any returned diagnostic. */
export function setupKeychain({runner,persist,exists,keychain,password}){
  const state=planKeychainIsolation({keychain}),redact=text=>String(text??"").split(password).join("<redacted>").slice(0,300);
  const original=readKeychainState(runner);if(!original){persist(state);return{ok:false,failed:"read-original",state};}
  state.original=original;state.preexisting=exists(keychain);persist(state);
  if(state.preexisting)return{ok:false,failed:"keychain-preexisting",state};
  const interactive=(step,command)=>()=>{const r=runner(SECURITY,["-i"],{input:`${command} -p "${password}" "${keychain}"\n`});return{...r,ok:r.code===0&&r.stderr.trim()===""&&(step!=="created"||exists(keychain))};};
  const direct=argv=>()=>{const r=runner(SECURITY,argv);return{...r,ok:r.code===0};};
  const steps={created:interactive("created","create-keychain"),unlocked:interactive("unlocked","unlock-keychain"),settings:direct(["set-keychain-settings",keychain]),searchList:direct(["list-keychains","-d","user","-s",keychain]),default:direct(["default-keychain","-d","user","-s",keychain])};
  for(const step of KEYCHAIN_STEPS){
    const r=steps[step]();if(!r.ok)return{ok:false,failed:step,code:r.code,stderr:redact(r.stderr),state};
    state.completed=[...state.completed,step];persist(state);
  }
  return{ok:true,state};
}
/** Attempts every applicable restoration regardless of earlier failures, then
 * re-reads and verifies; ok only when every required postcondition holds. */
export function cleanupKeychain({runner,state,exists}){
  if(!state||state.owner!==KEYCHAIN_OWNER||typeof state.keychain!=="string")return{ok:false,reason:"no-owned-state",results:[],verified:null};
  if(!state.original)return{ok:true,reason:"no-mutation",results:[],verified:null};
  const {original,keychain}=state,results=[];
  const attempt=(step,argv)=>{const r=runner(SECURITY,argv);results.push({step,code:r.code,stderr:String(r.stderr??"").slice(0,300)});};
  attempt("restore-search-list",["list-keychains","-d","user","-s",...original.searchList]);
  attempt("restore-default",["default-keychain","-d","user","-s",original.defaultKeychain]);
  if(!state.preexisting&&exists(keychain))attempt("delete-task-keychain",["delete-keychain",keychain]);
  const after=readKeychainState(runner);
  const verified={stateReadable:Boolean(after),searchListRestored:Boolean(after)&&same(after.searchList,original.searchList),defaultRestored:Boolean(after)&&after.defaultKeychain===original.defaultKeychain,taskKeychainAbsent:state.preexisting?false:!exists(keychain),taskKeychainNotSearched:Boolean(after)&&!after.searchList.includes(keychain)};
  return{ok:Object.values(verified).every(Boolean),results,verified};
}

export const SETTINGS_ENTRY_LABEL="App settings";
/** Admits the Settings entry only when the captured AX snapshot contains exactly
 * one AXButton whose name/title/description is exactly the source label
 * (src/components/Sidebar.tsx:2135-2136,2153). Never guesses. */
export function admitSettingsEntry(snapshot,label=SETTINGS_ENTRY_LABEL){
  if(!Array.isArray(snapshot))return{ok:false,reason:"snapshot-invalid",count:0};
  const named=snapshot.filter(entry=>entry&&Array.isArray(entry.names)&&entry.names.includes(label)),buttons=named.filter(entry=>entry.role==="AXButton");
  if(buttons.length===1)return{ok:true,label,roles:["AXButton"],count:1};
  return{ok:false,reason:buttons.length>1?"duplicate":named.length?"wrong-role":"absent",count:buttons.length,otherRoles:[...new Set(named.map(entry=>entry.role))].filter(role=>role!=="AXButton")};
}
// Only ordinary setup may use this classification. Operation comparisons must
// continue to use the unchanged byte-preservation/SQLite-sidecar rule.
export function classifyQualificationSetup(original, current) {
  const writers = new Set(["folder-trust.json", ...["messages.db", "memory-index.db", "skill-index.db"].flatMap(name => [name, `${name}-wal`, `${name}-shm`])]);
  const directories = new Set(["events/", "native/", "attachments/"]);
  const removed = Object.keys(original).filter(key => !(key in current));
  const changed = Object.keys(original).filter(key => key in current && original[key] !== current[key]);
  const added = Object.keys(current).filter(key => !(key in original));
  const unexpected = [...changed, ...added].filter(key => {
    if (writers.has(key)) return !/^[a-f0-9]{64}$/.test(current[key]);
    return !(added.includes(key) && directories.has(key) && current[key] === "dir");
  });
  return { ok: removed.length === 0 && unexpected.length === 0, changed, added, removed, unexpected };
}

export function freezeQualificationOperation(state, name, current, preconditions) {
  if (!["preScheduled", "preBusy", "preRestore"].includes(name) || Object.hasOwn(state, name)) throw new Error("OPERATION_BASELINE_ALREADY_SET_OR_INVALID");
  if (!preconditions.closed || !preconditions.notStarted) throw new Error("OPERATION_BASELINE_PRECONDITION_FAILED");
  const setup = classifyQualificationSetup(state.original, current);
  if (!setup.ok) throw new Error("UNEXPECTED_SETUP_WRITE");
  state[name] = structuredClone(current);
  return setup;
}
