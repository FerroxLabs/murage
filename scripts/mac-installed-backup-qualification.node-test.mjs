import test from "node:test";
import {spawnSync} from "node:child_process";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {runInNewContext} from "node:vm";
import {classifyQualificationSetup,freezeQualificationOperation} from "./mac-installed-backup-qualification-lib.mjs";

test("setup classification permits exact startup writers but no arbitrary descendants or removals",()=>{
  const original={"messages.db":"a".repeat(64),"bots.json":"b".repeat(64)};
  const current={...original,"messages.db":"c".repeat(64),"attachments/":"dir","skill-index.db":"d".repeat(64)};
  assert.equal(classifyQualificationSetup(original,current).ok,true);
  assert.equal(classifyQualificationSetup(original,{...current,"attachments/unexpected.txt":"e".repeat(64)}).ok,false);
  assert.equal(classifyQualificationSetup(original,{...current,"bots.json":"e".repeat(64)}).ok,false);
  assert.equal(classifyQualificationSetup(original,{"messages.db":"c".repeat(64)}).ok,false);
});

test("operation baseline is one-time, requires stopped pre-operation state and retains original bytes",()=>{
  const original={"messages.db":"a".repeat(64)},state={original},current={"messages.db":"b".repeat(64)};
  assert.throws(()=>freezeQualificationOperation(state,"preScheduled",current,{closed:false,notStarted:true}),/PRECONDITION/);
  assert.throws(()=>freezeQualificationOperation(state,"preScheduled",current,{closed:true,notStarted:false}),/PRECONDITION/);
  freezeQualificationOperation(state,"preScheduled",current,{closed:true,notStarted:true});
  assert.deepEqual(state.original,original);
  current["messages.db"]="c".repeat(64);
  assert.equal(state.preScheduled["messages.db"],"b".repeat(64));
  assert.throws(()=>freezeQualificationOperation(state,"preScheduled",current,{closed:true,notStarted:true}),/ALREADY_SET/);
});

test("operation checks reject a startup-writer mutation after the baseline freezes",()=>{
  const source=readFileSync(new URL("./mac-installed-backup-qualification.mjs",import.meta.url),"utf8");
  const functionText=/function sidecarRule\(before,after\)\{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(functionText,"exercise the actual unchanged operation comparator");
  const compare=runInNewContext(`(${functionText})`,{Buffer,sha:bytes=>createHash("sha256").update(bytes).digest("hex")});
  const initial={"messages.db":"a".repeat(64)},prepared={"messages.db":"b".repeat(64)},state={original:initial};
  freezeQualificationOperation(state,"preScheduled",prepared,{closed:true,notStarted:true});
  assert.equal(compare(state.preScheduled,prepared).ok,true);
  assert.equal(compare(state.preScheduled,{"messages.db":"c".repeat(64)}).ok,false);
  assert.equal(compare(state.preScheduled,{}).ok,false);
  assert.equal(compare(state.preScheduled,{...prepared,"attachments/unexpected":"d".repeat(64)}).ok,false);
});
import {runCommand,setupKeychain,cleanupKeychain,admitSettingsEntry,guiBackupFixtureBot,guiBackupFixtureRoutines,guiSeedStartupFindings,GUI_SEED_WINDOW_MS,KEYCHAIN_OWNER,KEYCHAIN_STEPS,SECURITY} from "./mac-installed-backup-qualification-lib.mjs";

test("GUI routine seed stays enabled but idle beyond the bounded qualification window",()=>{
  const now=1800000000000,seed=guiBackupFixtureRoutines(now);
  assert.equal(seed.routines[0].enabled,true);
  assert.ok(seed.routines[0].nextRunAt>now+60*60*1000);
  assert.equal(seed.runs[0].status,"cancelled");assert.equal(seed.runs[0].finishedAt,1);
  assert.throws(()=>guiBackupFixtureRoutines(NaN),/INVALID_FIXTURE_TIME/);
});

test("GUI backup seed supplies required bot/task fields without losing authority canaries",()=>{
  const input={id:"bot",threadId:"thread",name:"Fixture",resumeCursors:{fixture:"native-cursor"},autoApprove:true,notifications:true};
  const before=structuredClone(input),bot=guiBackupFixtureBot(input);
  assert.deepEqual(input,before);
  assert.equal(bot.modelSelection.instanceId,"fixture");assert.equal(bot.modelSelection.model,"fixture-model");
  assert.equal(bot.title,"");assert.equal(bot.description,"");assert.equal(bot.color,"orange");
  assert.equal(bot.unread,false);assert.equal(bot.createdAt,1);assert.equal(bot.autoApprove,true);
  assert.deepEqual(bot.resumeCursors,input.resumeCursors);assert.equal(bot.tasks.length,1);
  assert.equal(bot.tasks[0].threadId,bot.threadId);assert.deepEqual(bot.tasks[0].modelSelection,bot.modelSelection);
  assert.deepEqual(bot.tasks[0].resumeCursors,input.resumeCursors);
  assert.throws(()=>guiBackupFixtureBot({...input,id:"other"}),/UNEXPECTED_BACKUP_FIXTURE_BOT/);
});

// GUI seed validity against signed source 19947871: cited predicates only, no
// app, server, engine or filesystem. Bot literal: server/testing/backup-fixture.ts:25.
const SIGNED_FIXTURE_BOT={id:"bot",threadId:"thread",name:"Fixture",resumeCursors:{fixture:"native-cursor"},autoApprove:true,notifications:true};
const GUI_NOW=1800000000000;
const fixtureBot=()=>structuredClone(SIGNED_FIXTURE_BOT);
const seededBot=()=>guiBackupFixtureBot(fixtureBot());
const seedCodes=(bots,routines=guiBackupFixtureRoutines(GUI_NOW),now=GUI_NOW)=>guiSeedStartupFindings({bots,routines,now}).map(finding=>finding.code);

test("GUI seed: bot helper supplies every required BotRecord/TaskRecord field and keeps the signed fixture bot as an exact subset",()=>{
  const input=fixtureBot(),bot=guiBackupFixtureBot(input);
  assert.deepEqual(input,SIGNED_FIXTURE_BOT);
  for(const [key,value] of Object.entries(SIGNED_FIXTURE_BOT))assert.deepEqual(bot[key],value,key);
  // store.ts:479-607 required BotRecord keys; store.ts:275-308 TaskRecord plus the adoption fields of store.ts:987-990.
  for(const key of ["id","threadId","name","title","description","notifications","color","unread","modelSelection","resumeCursors","createdAt"])assert.ok(Object.hasOwn(bot,key),key);
  assert.equal(bot.tasks.length,1);
  for(const key of ["threadId","title","createdAt","resumeCursors","modelSelection","autoApprove","alwaysAllow","unread"])assert.ok(Object.hasOwn(bot.tasks[0],key),key);
  // instances.fixture is configured by server/testing/backup-fixture.ts:24; no synthetic instance is invented.
  assert.deepEqual(bot.modelSelection,{instanceId:"fixture",model:"fixture-model"});
  assert.notEqual(bot.tasks[0].modelSelection,bot.modelSelection);assert.notEqual(bot.tasks[0].resumeCursors,bot.resumeCursors);
  assert.deepEqual(JSON.parse(JSON.stringify([bot])),[bot]);
  assert.deepEqual(guiSeedStartupFindings({bots:[bot],routines:guiBackupFixtureRoutines(GUI_NOW),now:GUI_NOW}),[]);
});

test("GUI seed: task authority equals Store task adoption so the effective autoApprove canary stays armed",()=>{
  const bot=seededBot();
  assert.equal(bot.autoApprove,true);assert.equal(bot.tasks[0].autoApprove,true);assert.deepEqual(bot.tasks[0].alwaysAllow,[]);
  assert.equal(guiBackupFixtureBot({...fixtureBot(),autoApprove:false}).tasks[0].autoApprove,false);
  const disarmed=structuredClone(bot);disarmed.tasks[0].autoApprove=false;
  assert.deepEqual(seedCodes([disarmed]),["task-authority-canary"]);
});

test("GUI seed: validator flags the original fixture bot and each cited load migration or render dereference",()=>{
  const original=seedCodes([fixtureBot()]);
  for(const code of ["bot-title","bot-description","bot-unread","bot-createdAt","bot-color","bot-model-selection","task-adoption-save"])assert.ok(original.includes(code),code);
  for(const [mutate,code] of [
    [bot=>{delete bot.tasks[0].modelSelection;},"task-adoption-save"],
    [bot=>{delete bot.tasks[0].autoApprove;},"task-adoption-save"],
    [bot=>{delete bot.tasks[0].alwaysAllow;},"task-adoption-save"],
    [bot=>{delete bot.tasks[0].unread;},"task-adoption-save"],
    [bot=>{bot.busy=true;},"busy-reset-save"],
    [bot=>{bot.activity="working";},"busy-reset-save"],
    [bot=>{bot.persona="  ";},"load-normalization-persona"],
    [bot=>{bot.autoStartVps="yes";},"load-normalization-autoStartVps"],
    [bot=>{bot.alwaysAllow=["ask_bot:@Fixture"];},"load-normalization-alwaysAllow"],
    [bot=>{bot.tasks[0].threadId="other";},"active-task"],
    [bot=>{bot.tasks.push(structuredClone(bot.tasks[0]));},"task-thread-duplicate"],
    [bot=>{bot.color="magenta";},"bot-color"],
    [bot=>{bot.modelSelection={instanceId:"",model:"fixture-model"};},"bot-model-selection"],
    [bot=>{bot.tasks[0].modelSelection={model:"fixture-model"};},"task-model-selection"],
    [bot=>{bot.unread=true;},"unread-projection"],
  ]){const bot=seededBot();mutate(bot);assert.ok(seedCodes([bot]).includes(code),code);}
  assert.ok(seedCodes([seededBot(),seededBot()]).includes("single-bot"));assert.ok(seedCodes(null).includes("single-bot"));
});

test("GUI seed: routine seed is enabled, beyond the job window and terminal-only so RoutineManager neither recovers nor ticks it",()=>{
  const seed=guiBackupFixtureRoutines(GUI_NOW);
  assert.deepEqual(guiSeedStartupFindings({bots:[seededBot()],routines:seed,now:GUI_NOW}),[]);
  assert.equal(seed.routines[0].nextRunAt,GUI_NOW+86400000);assert.ok(seed.routines[0].nextRunAt>GUI_NOW+GUI_SEED_WINDOW_MS);
  assert.ok(seed.runs.every(run=>["completed","failed","cancelled","missed"].includes(run.status)&&Number.isFinite(run.finishedAt)&&run.watch===undefined));
  assert.equal(seed.routines[0].watch,undefined);assert.deepEqual(JSON.parse(JSON.stringify(seed)),seed);
  // The committed HEAD seed: recovered to failed at construction (routines.ts:606-625) and ticked as missed (routines.ts:1170-1208).
  const head={version:1,routines:[{...seed.routines[0],nextRunAt:1}],runs:[{id:"run",routineId:"routine",routineName:"Fixture routine",botId:"bot",scheduledFor:1,status:"running",manual:false,createdAt:1,startedAt:1}]};
  const headCodes=seedCodes([seededBot()],head);
  for(const code of ["run-startup-recovery","routine-due-within-window","terminal-history-missing"])assert.ok(headCodes.includes(code),code);
  for(const [mutate,code] of [
    [value=>{value.runs[0].status="waiting";},"run-startup-recovery"],
    [value=>{value.runs[0].status="queued";},"run-queued-dispatch"],
    [value=>{value.routines[0].nextRunAt=GUI_NOW+30*60*1000;},"routine-due-within-window"],
    [value=>{value.routines[0].nextRunAt=null;},"routine-due-within-window"],
    [value=>{value.routines[0].enabled=false;},"routine-not-enabled"],
    [value=>{value.routines[0].watch={};},"routine-watch"],
    [value=>{value.runs[0].watch={};},"run-watch"],
    [value=>{value.routines[0].schedule.time="9:00";},"routine-schedule"],
    [value=>{value.routines[0].schedule.weekdays=[];},"routine-schedule"],
    [value=>{value.runs=[];},"terminal-history-missing"],
    [value=>{value.runs[0].status="done";},"run-record"],
    [value=>{value.runs.push(structuredClone(value.runs[0]));},"duplicate-id"],
    [value=>{value.runs[0].routineId="other";},"run-orphan"],
    [value=>{value.version=2;},"routines-shape"],
  ]){const value=structuredClone(seed);mutate(value);assert.ok(seedCodes([seededBot()],value).includes(code),code);}
  // Wall-clock bound only: a job still running at nextRunAt would queue and save.
  assert.ok(seedCodes([seededBot()],seed,seed.routines[0].nextRunAt).includes("routine-due-within-window"));
});

test("GUI seed: helpers refuse fixture drift and unsafe time instead of overwriting canaries",()=>{
  const missing=fixtureBot();delete missing.notifications;
  for(const bad of [null,[],"bot",missing,{...fixtureBot(),id:"other"},{...fixtureBot(),threadId:"other"},{...fixtureBot(),name:1},
    {...fixtureBot(),modelSelection:{instanceId:"x",model:"y"}},{...fixtureBot(),tasks:[]},{...fixtureBot(),title:"kept"},{...fixtureBot(),busy:true},
    {...fixtureBot(),resumeCursors:null},{...fixtureBot(),resumeCursors:[]},{...fixtureBot(),autoApprove:"true"},{...fixtureBot(),notifications:undefined}])
    assert.throws(()=>guiBackupFixtureBot(bad),/UNEXPECTED_BACKUP_FIXTURE_BOT/);
  for(const bad of [NaN,-1,1.5,Infinity,"1800000000000",Number.MAX_SAFE_INTEGER])assert.throws(()=>guiBackupFixtureRoutines(bad),/INVALID_FIXTURE_TIME/);
  assert.throws(()=>guiSeedStartupFindings({bots:[seededBot()],routines:guiBackupFixtureRoutines(GUI_NOW),now:NaN}),/INVALID_FIXTURE_TIME/);
});

// Synthetic only: no runner, Keychain, launchd or packaged app. Every security
// invocation goes to the injected fake below.
const PASSWORD="synthetic-password-0123456789abcdef";
const LOGIN="/Users/runner/Library/Keychains/login.keychain-db",UNRELATED="/Users/runner/Library/Keychains/unrelated-ci.keychain-db",TASK="/private/tmp/qual/private/murage-qualification.keychain-db";

function fakeSecurity({failAt,cleanupFail=[],wrongDefault=false,keepKeychain=false,unreadable=false}={}){
  const os={default:LOGIN,list:[LOGIN,UNRELATED],files:new Set([LOGIN,UNRELATED])},calls=[],persisted=[];
  const ok=(stdout="")=>({code:0,stdout,stderr:""}),fail=text=>({code:1,stdout:"",stderr:`security: ${text}`});
  const runner=(command,argv,options={})=>{
    assert.equal(command,SECURITY);assert.equal(argv.some(value=>value.includes(PASSWORD)),false);calls.push({argv,input:options.input});
    if(argv[0]==="-i"){
      const [name]=options.input.split(" "),step=name==="create-keychain"?"created":"unlocked";assert.ok(options.input.includes(PASSWORD));
      if(failAt===step)return{code:0,stdout:"",stderr:`${name} -p "${PASSWORD}" failed`};
      if(step==="created")os.files.add(TASK);return ok();
    }
    const [op,,,flag,...values]=argv;
    if(op==="set-keychain-settings")return failAt==="settings"?fail("settings"):ok();
    if(op==="list-keychains"&&flag===undefined)return unreadable&&calls.some(call=>call.argv[0]==="delete-keychain"||call.argv.includes("-s"))?fail("read"):ok(os.list.map(value=>`    "${value}"`).join("\n")+"\n");
    if(op==="default-keychain"&&flag===undefined)return ok(`    "${os.default}"\n`);
    if(op==="list-keychains"){const restoring=values.length!==1||values[0]!==TASK;if(restoring?cleanupFail.includes("restore-search-list"):failAt==="searchList")return fail("list");os.list=[...values];return ok();}
    if(op==="default-keychain"){const restoring=values[0]!==TASK;if(restoring?cleanupFail.includes("restore-default"):failAt==="default")return fail("default");os.default=restoring&&wrongDefault?UNRELATED:values[0];return ok();}
    if(op==="delete-keychain"){if(cleanupFail.includes("delete"))return fail("delete");if(!keepKeychain)os.files.delete(argv[1]);os.list=os.list.filter(value=>value!==argv[1]);if(os.default===argv[1])os.default="";return ok();}
    assert.fail(`unexpected security ${argv.join(" ")}`);
  };
  const mutations=()=>calls.filter(call=>call.argv[0]==="-i"||call.argv[0]==="set-keychain-settings"||call.argv.includes("-s")||call.argv[0]==="delete-keychain").length;
  return{os,calls,persisted,runner,exists:file=>os.files.has(file),persist:state=>persisted.push({mutations:mutations(),state:structuredClone(state)})};
}
const setup=fake=>setupKeychain({runner:fake.runner,persist:fake.persist,exists:fake.exists,keychain:TASK,password:PASSWORD});

test("command primitive keeps stdout, stderr and status for success, failure, stdin and timeout",()=>{
  const ok=runCommand("/bin/sh",["-c","printf out; printf err >&2"]);
  assert.deepEqual([ok.code,ok.stdout,ok.stderr,ok.timedOut,ok.error],[0,"out","err",false,null]);
  const failed=runCommand("/bin/sh",["-c","printf partial; printf 'TeamIdentifier=ABCDE12345' >&2; exit 3"]);
  assert.deepEqual([failed.code,failed.stdout,failed.stderr,failed.timedOut],[3,"partial","TeamIdentifier=ABCDE12345",false]);
  assert.equal(runCommand("/bin/sh",["-c","cat"],{input:"stdin-only"}).stdout,"stdin-only");
  const slow=runCommand("/bin/sh",["-c","sleep 5"],{timeout:200});assert.deepEqual([slow.code,slow.timedOut,slow.error],[null,true,"ETIMEDOUT"]);
  const missing=runCommand("/nonexistent/qualification-binary",[]);assert.deepEqual([missing.code,missing.error],[null,"ENOENT"]);
});

test("keychain setup persists original state before any mutation and every completed step",()=>{
  const fake=fakeSecurity(),result=setup(fake);
  assert.equal(result.ok,true);assert.deepEqual(result.state.completed,KEYCHAIN_STEPS);
  assert.equal(fake.persisted[0].mutations,0);assert.deepEqual(fake.persisted[0].state.original,{defaultKeychain:LOGIN,searchList:[LOGIN,UNRELATED]});
  assert.equal(fake.persisted[0].state.owner,KEYCHAIN_OWNER);assert.deepEqual(fake.persisted.map(entry=>entry.state.completed.length),[0,1,2,3,4,5]);
  assert.equal(JSON.stringify(fake.persisted).includes(PASSWORD),false);
  const cleanup=cleanupKeychain({runner:fake.runner,state:result.state,exists:fake.exists});
  assert.equal(cleanup.ok,true);assert.deepEqual(fake.os.list,[LOGIN,UNRELATED]);assert.equal(fake.os.default,LOGIN);assert.equal(fake.exists(TASK),false);
});

test("failure after each mutation step leaves persisted state that cleanup restores and verifies",()=>{
  for(const [index,step] of KEYCHAIN_STEPS.entries()){
    const fake=fakeSecurity({failAt:step}),result=setup(fake),last=fake.persisted.at(-1).state;
    assert.equal(result.ok,false,step);assert.equal(result.failed,step);assert.deepEqual(last.completed,KEYCHAIN_STEPS.slice(0,index));
    assert.deepEqual(last.original,{defaultKeychain:LOGIN,searchList:[LOGIN,UNRELATED]});assert.equal(String(result.stderr??"").includes(PASSWORD),false);
    const cleanup=cleanupKeychain({runner:fake.runner,state:last,exists:fake.exists});
    assert.equal(cleanup.ok,true,step);assert.deepEqual(fake.os.list,[LOGIN,UNRELATED]);assert.equal(fake.os.default,LOGIN);assert.equal(fake.exists(TASK),false);
    assert.equal(cleanup.results.some(entry=>entry.step==="delete-task-keychain"),step!=="created");
  }
});

test("cleanup attempts every step and fails when any restoration or deletion postcondition is unmet",()=>{
  for(const [options,unmet] of [[{cleanupFail:["restore-search-list"]},"searchListRestored"],[{wrongDefault:true},"defaultRestored"],[{cleanupFail:["delete"]},"taskKeychainAbsent"],[{keepKeychain:true},"taskKeychainAbsent"],[{unreadable:true},"stateReadable"]]){
    const fake=fakeSecurity(options),result=setup(fake);assert.equal(result.ok,true);
    const cleanup=cleanupKeychain({runner:fake.runner,state:result.state,exists:fake.exists});
    assert.equal(cleanup.ok,false,unmet);assert.equal(cleanup.verified[unmet],false,unmet);
    assert.deepEqual(cleanup.results.map(entry=>entry.step),["restore-search-list","restore-default","delete-task-keychain"]);
  }
  assert.equal(cleanupKeychain({runner:()=>assert.fail("no command without owned state"),state:null,exists:()=>false}).ok,false);
  assert.equal(cleanupKeychain({runner:()=>assert.fail("no command before mutation"),state:{owner:KEYCHAIN_OWNER,keychain:TASK,original:null,completed:[]},exists:()=>false}).reason,"no-mutation");
  const collision=fakeSecurity();collision.os.files.add(TASK);const refused=setup(collision);
  assert.deepEqual([refused.ok,refused.failed,refused.state.preexisting],[false,"keychain-preexisting",true]);
  const kept=cleanupKeychain({runner:collision.runner,state:refused.state,exists:collision.exists});
  assert.equal(kept.results.some(entry=>entry.step==="delete-task-keychain"),false);assert.equal(collision.exists(TASK),true);assert.equal(kept.ok,false);
});

test("settings entry is admitted only for exactly one AXButton with the exact source label",()=>{
  const button={role:"AXButton",names:["App settings"]},text={role:"AXStaticText",names:["App settings"]},other={role:"AXButton",names:["New task"]};
  assert.deepEqual(admitSettingsEntry([other,button,text]),{ok:true,label:"App settings",roles:["AXButton"],count:1});
  assert.equal(admitSettingsEntry([other]).reason,"absent");
  assert.equal(admitSettingsEntry([button,{...button}]).reason,"duplicate");
  assert.deepEqual([admitSettingsEntry([{role:"AXGroup",names:["App settings"]}]).reason,admitSettingsEntry([{role:"AXGroup",names:["App settings"]}]).otherRoles],["wrong-role",["AXGroup"]]);
  assert.equal(admitSettingsEntry([{role:"AXButton",names:["app settings"]},{role:"AXButton",names:["App settings…"]}]).ok,false);
  assert.equal(admitSettingsEntry(null).reason,"snapshot-invalid");
});

// Real JXA/CoreFoundation marshalling only. No AX target, Application(), UI,
// permission request, user data or keychain access. Extract the actual helper
// argument so reverting to the imported CF constant fails this regression.
test("manual AX argument retains CFBoolean through the actual JXA bridge",{skip:process.platform!=="darwin"},()=>{
  const source=readFileSync(new URL("./mac-installed-backup-qualification.mjs",import.meta.url),"utf8");
  const body=/if\(cmd.op==='manualAX'\)\{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.ok(body);
  const expression=/var value=([^,;]+),valueType=/.exec(body)?.[1];
  assert.ok(expression,"exercise the exact value passed to the AX setter");
  assert.match(body,/AXUIElementSetAttributeValue\(app,\$\('AXManualAccessibility'\),value\)/);
  const script=`ObjC.import('ApplicationServices');var value=${expression};JSON.stringify({actual:String($.CFGetTypeID(value)),expected:String($.CFBooleanGetTypeID()),value:ObjC.unwrap(value)})`;
  const result=spawnSync("/usr/bin/osascript",["-l","JavaScript","-e",script],{encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  const observed=JSON.parse(result.stdout.trim());
  assert.equal(observed.actual,observed.expected);
  assert.equal(observed.value,true);
});

// Actual embedded JXA with System Events mocked: no OS/app/UI call.
test("status query retains bounded nonmatching backup states without admitting them",()=>{
  const source=readFileSync(new URL("./mac-installed-backup-qualification.mjs",import.meta.url),"utf8");
  const jxa=/const JXA=String.raw`([\s\S]*?)`;/.exec(source)?.[1];assert.ok(jxa);
  const element=text=>({name:()=>text,title:()=>"",description:()=>"",value:()=>text});
  const window={...element("Settings"),entireContents:()=>[element("Registration is not confirmed. Refresh status before enabling closed-app backups."),element("Closed-app scheduling unavailable"),element("Unrelated profile text")]};
  const se={processes:{whose:()=>[{windows:()=>[window]}]}};
  const run=runInNewContext(jxa+";run",{Application:()=>se});
  const result=JSON.parse(run([JSON.stringify({op:"texts",pid:123,pattern:"Job registration confirmed"})]));
  assert.equal(result.ok,true);assert.deepEqual(result.texts,[]);assert.equal(result.count,4);
  assert.equal(result.diagnostics.length,2);assert.match(result.diagnostics[0],/Registration is not confirmed/);
  window.entireContents=()=>[element("Job registration confirmed"),...Array.from({length:40},()=>element("backup "+"x".repeat(500)))];
  const success=JSON.parse(run([JSON.stringify({op:"texts",pid:123,pattern:"Job registration confirmed"})]));
  assert.equal(success.texts.length,1);assert.equal(success.diagnostics.length,30);assert.ok(success.diagnostics.every(value=>value.length<=300));
});

test("status wait preserves query failure versus readable missing status and rethrows the original gate",async()=>{
  const source=readFileSync(new URL("./mac-installed-backup-qualification.mjs",import.meta.url),"utf8");
  const fn=/async function waitText\(s,pid,key,ms=60000\)\{[\s\S]*?\n\}/.exec(source)?.[0];assert.ok(fn);
  for(const observation of [{ok:false,error:"osascript",code:null,signal:"SIGTERM",timedOut:true,stderr:"execution error"},{ok:true,texts:[],count:400,diagnostics:["Closed-app scheduling unavailable"]}]){
    const records=[],failure=new Error("original text-installed gate");
    const wait=runInNewContext(`(${fn})`,{UI:{installed:{pattern:"Job registration confirmed"}},step:(_label,callback)=>callback(),ax:()=>observation,until:async callback=>{assert.equal(callback(),null);throw failure;},record:value=>records.push(value),redactSecretsInLine:value=>value});
    await assert.rejects(wait({},123,"installed"),error=>error===failure);
    assert.equal(records.length,1);assert.equal(records[0].queries,1);assert.equal(records[0].result.ok,observation.ok);
    assert.equal(records[0].result.timedOut,observation.timedOut);assert.equal(records[0].pid,123);
    assert.equal(records[0].step,"text-query-failed-installed");
  }
});
