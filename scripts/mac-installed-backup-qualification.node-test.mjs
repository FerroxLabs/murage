import test from "node:test";
import assert from "node:assert/strict";
import {runCommand,setupKeychain,cleanupKeychain,admitSettingsEntry,KEYCHAIN_OWNER,KEYCHAIN_STEPS,SECURITY} from "./mac-installed-backup-qualification-lib.mjs";

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
