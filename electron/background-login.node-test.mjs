import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,readFileSync,readdirSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { applyLoginProfileArguments,createBackgroundLogin,desktopExecArgument } from "./background-login.mjs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createBackgroundLifecycle } from "./background-lifecycle.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const WINDOWS_EXE=String.raw`C:\Program Files\Murage\Murage.exe`;
const WINDOWS_PROFILE=String.raw`C:\Users\Fixture User\Murage Profiles\one`;
const WINDOWS_USER_DATA=String.raw`C:\Users\Fixture User\Murage User Data`;
const PROFILE_NAME=`Murage-${createHash("sha256").update(WINDOWS_PROFILE).digest("hex").slice(0,16)}`;
const PROFILE_ARGS=["--murage-login","--murage-data-dir",WINDOWS_PROFILE,"--murage-user-data",WINDOWS_USER_DATA];
const launchItem=(patch={})=>({name:PROFILE_NAME,path:WINDOWS_EXE,args:[...PROFILE_ARGS],scope:"user",enabled:true,...patch});
// Model the native distinction: legacy openAtLogin remains false for a custom
// name, the executable flag aggregates entries, and GetArgs drops switches
// unless registration places the standard terminator before our raw vector.
function windowsFixture({items=[],failWrite=false,rawResponse}={}){
  let current=structuredClone(items);const writes=[],reads=[];
  const app={getLoginItemSettings(options){
    reads.push(structuredClone(options));if(rawResponse!==undefined)return structuredClone(rawResponse);
    const parsed=/^"([^"]+)"$/.exec(options.path)?.[1]??options.path.split(/\s/)[0];
    return {openAtLogin:false,executableWillLaunchAtLogin:current.some(item=>item?.enabled===true),launchItems:parsed.toLowerCase()===WINDOWS_EXE.toLowerCase()?structuredClone(current):[],wasOpenedAtLogin:true};
  },setLoginItemSettings(options){
    writes.push(structuredClone(options));if(failWrite)return;
    current=current.filter(item=>!(item.name===options.name&&item.scope==="user"));
    if(options.openAtLogin){const separator=options.args.indexOf("--"),args=separator>=0?options.args.slice(separator+1):options.args.filter(arg=>!arg.startsWith("--"));current.push({name:options.name,path:options.path,args,scope:"user",enabled:options.enabled});}
  }};
  const provider=createBackgroundLogin({platform:"win32",installed:true,primaryProfile:false,profileDir:WINDOWS_PROFILE,userDataDir:WINDOWS_USER_DATA,executable:WINDOWS_EXE,app});
  return {provider,writes,reads,items:()=>structuredClone(current)};
}
test("Windows confirms the exact enabled named user entry even when legacy openAtLogin is false",async()=>{
  const f=windowsFixture();assert.equal(f.provider.read().openAtLogin,false);assert.equal(f.writes.length,0);
  await f.provider.write(true);assert.equal(f.provider.read().openAtLogin,true);assert.equal(f.provider.read().wasOpenedAtLogin,true);
  assert.deepEqual(f.writes[0],{openAtLogin:true,path:WINDOWS_EXE,args:["--",...PROFILE_ARGS],name:PROFILE_NAME,enabled:true});
  assert.deepEqual(f.reads.at(-1),{path:`"${WINDOWS_EXE}"`,args:["--",...PROFILE_ARGS]});assert.deepEqual(f.items()[0].args,PROFILE_ARGS);
  assert.equal(windowsFixture({items:[launchItem({path:WINDOWS_EXE.toLowerCase()})]}).provider.read().openAtLogin,true);
});
test("Windows never substitutes aggregate/legacy flags or accepts a different named command",()=>{
  const unrelated=launchItem({name:"Other-profile"});
  const invalid=[[],[unrelated],[unrelated,launchItem({enabled:false})],[launchItem({scope:"machine"})],[launchItem({name:PROFILE_NAME+"-other"})],
    [launchItem({path:String.raw`C:\Other\Murage.exe`})],[launchItem({args:[...PROFILE_ARGS].reverse()})],
    [launchItem({args:[...PROFILE_ARGS,"--extra"]})],[launchItem({args:PROFILE_ARGS.slice(1)})],
    [launchItem({args:["--murage-login","--murage-data-dir",WINDOWS_PROFILE+"-other","--murage-user-data",WINDOWS_USER_DATA]})],
    [launchItem(),launchItem()],[launchItem(),launchItem({scope:"machine"})],
    [launchItem({enabled:"true"})],[launchItem({args:PROFILE_ARGS.join(" ")})],[launchItem({args:[...PROFILE_ARGS,undefined]})],
    [null],[{}],[launchItem(),null]];
  for(const items of invalid){const f=windowsFixture({rawResponse:{openAtLogin:true,executableWillLaunchAtLogin:true,launchItems:items,status:"requires-approval"}});assert.equal(f.provider.read().openAtLogin,false,JSON.stringify(items));assert.equal(f.provider.read().requiresApproval,false);assert.equal(f.writes.length,0);}
  for(const launchItems of [undefined,null,{},"malformed"])assert.equal(windowsFixture({rawResponse:{openAtLogin:true,executableWillLaunchAtLogin:true,launchItems}}).provider.read().openAtLogin,false);
});
test("Windows rejects old switch-stripped entries and only explicit enable canonicalizes that same name",async()=>{
  const old=launchItem({args:[WINDOWS_PROFILE,WINDOWS_USER_DATA]}),other=launchItem({name:"Different-profile"});const f=windowsFixture({items:[old,other]});
  assert.equal(f.provider.read().openAtLogin,false);await f.provider.write(true);assert.equal(f.provider.read().openAtLogin,true);assert.equal(f.writes[0].name,PROFILE_NAME);
  await f.provider.write(false);assert.equal(f.provider.read().openAtLogin,false);assert.equal(f.writes[1].name,PROFILE_NAME);assert.equal(f.writes[1].enabled,false);assert.deepEqual(f.writes[1].args,["--",...PROFILE_ARGS]);assert.deepEqual(f.items(),[other]);
});
test("Windows native write failures still fail the unchanged lifecycle readback",async()=>{
  for(const enabled of [true,false]){const f=windowsFixture({items:enabled?[launchItem({name:"Other-profile"})]:[launchItem()],failWrite:true});
    const lifecycle=createBackgroundLifecycle({platform:"win32",loadPreferences:()=>({}),window:()=>null,login:f.provider});
    await assert.rejects(lifecycle.update({startAtLogin:enabled}),/operating system did not confirm/);assert.equal(f.writes.length,1);assert.equal(f.writes[0].name,PROFILE_NAME);lifecycle.dispose();
  }
});
test("Windows standard terminator preserves profile flags and platform path/duplicate guards",()=>{
  const parse=runInNewContext(`(${applyLoginProfileArguments.toString()})`,{LOGIN_FLAG:"--murage-login",isAbsolute:win32.isAbsolute});
  const env={};parse([WINDOWS_EXE,"--",...PROFILE_ARGS],env);assert.equal(env.MURAGE_DATA_DIR,WINDOWS_PROFILE);assert.equal(env.MURAGE_USER_DATA,WINDOWS_USER_DATA);
  const existing={MURAGE_DATA_DIR:String.raw`C:\Chosen`};parse(["--",...PROFILE_ARGS],existing);assert.equal(existing.MURAGE_DATA_DIR,String.raw`C:\Chosen`);
  for(const bad of [["--",...PROFILE_ARGS,"--murage-data-dir",WINDOWS_PROFILE],["--",...PROFILE_ARGS,"--murage-user-data",WINDOWS_USER_DATA],["--","--murage-login","--murage-data-dir","relative"],["--","--murage-login","--murage-user-data","relative"]])assert.throws(()=>parse(bad,{}),/Invalid Murage sign-in profile/);
  const unchanged={};parse(["--","--murage-data-dir",WINDOWS_PROFILE],unchanged);assert.deepEqual(unchanged,{});
});
test("Mac primary login settings retain their native approval behavior and no Windows arguments",async()=>{
  const reads=[],writes=[];let enabled=false;
  const provider=createBackgroundLogin({platform:"darwin",installed:true,primaryProfile:true,profileDir:"/fixture/profile",userDataDir:"/fixture/user",executable:"/fixture/app",app:{getLoginItemSettings:options=>{reads.push(options);return {openAtLogin:enabled,status:"requires-approval"};},setLoginItemSettings:value=>{writes.push(value);enabled=value.openAtLogin;}}});
  assert.equal(provider.read().requiresApproval,true);await provider.write(true);assert.equal(provider.read().openAtLogin,true);assert.deepEqual(writes,[{openAtLogin:true}]);assert(reads.every(value=>value===undefined));
});
test("Mac custom profiles refuse registration rather than launching the wrong profile",async()=>{
  const provider=createBackgroundLogin({platform:"darwin",installed:true,primaryProfile:false,profileDir:"/fixture/custom",userDataDir:"/fixture/user",executable:"/fixture/app",app:{setLoginItemSettings(){throw Error("must not call native API");}}});
  assert.equal(provider.read().supported,false);await assert.rejects(provider.write(true),/primary Murage profile/);
});
test("Linux writes and removes only its scratch profile entry and safely quotes argv",async()=>{
  const root=mkdtempSync(join(tmpdir(),"murage-login-"));
  try{
    const provider=createBackgroundLogin({platform:"linux",installed:true,profileDir:join(root,"profile $name"),userDataDir:join(root,"user"),executable:"/opt/Murage AppImage",autostartDir:root});
    assert.equal(provider.read().openAtLogin,false);await provider.write(true);
    const file=join(root,readdirSync(root)[0]);const content=readFileSync(file,"utf8");
    assert.match(content,/Exec="\/opt\/Murage AppImage"/);assert.ok(content.includes(desktopExecArgument(join(root,"profile $name"))));assert.equal(provider.read().openAtLogin,true);
    await provider.write(false);assert.deepEqual(readdirSync(root),[]);
    await provider.write(true);writeFileSync(file,"[Desktop Entry]\nName=Other application\n");await assert.rejects(provider.write(false),/different sign-in entry/);assert.match(readFileSync(file,"utf8"),/Other application/);
  }finally{safeWipeSync(root);}
});
test("sign-in profile arguments are explicit and cannot replace an existing override",()=>{
  const env={MURAGE_DATA_DIR:"/chosen"};applyLoginProfileArguments(["--murage-login","--murage-data-dir","/scheduled","--murage-user-data","/user"],env);
  assert.equal(env.MURAGE_DATA_DIR,"/chosen");assert.equal(env.MURAGE_USER_DATA,"/user");assert.throws(()=>applyLoginProfileArguments(["--murage-login","--murage-data-dir","relative"],{}),/Invalid/);
  assert.equal(desktopExecArgument("100% done"),'"100%% done"');assert.throws(()=>desktopExecArgument("bad\npath"),/Unsupported/);
});
