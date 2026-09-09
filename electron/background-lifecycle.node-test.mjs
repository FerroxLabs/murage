import test from "node:test";
import assert from "node:assert/strict";
import { backgroundPreferences,createBackgroundLifecycle,linuxTrayHostAvailable } from "./background-lifecycle.mjs";

function fixture(platform="win32",stored={}){
  let visible=true,trayReady=true,destroyed=false,quitting=false,login=false,paused=false,menu=[];
  const events=[];
  const win={isDestroyed:()=>false,isVisible:()=>visible,hide:()=>{visible=false;events.push("hide");}};
  const tray={isDestroyed:()=>destroyed,destroy:()=>{destroyed=true;}};
  const options={platform,loadPreferences:()=>stored,savePreferences:value=>{stored=value;events.push("save");},window:()=>win,
    login:{read:()=>({supported:true,openAtLogin:login}),write:value=>{login=value;events.push("login");}},
    createTray:()=>tray,setTrayMenu:(_tray,items)=>{menu=items;},probeTray:()=>trayReady,dockAvailable:()=>false,
    openWindow:()=>{visible=true;events.push("open");},openInbox:()=>events.push("inbox"),quit:()=>{quitting=true;events.push("quit");},isQuitting:()=>quitting,
    explainClose:async()=>{events.push("explain");return "keep";},automationStatus:async()=>({paused}),setAutomationsPaused:async value=>{paused=value;return {paused};},
    setInterval:()=>({unref(){}}),clearInterval:()=>{},onError:error=>events.push(error.message)};
  const lifecycle=createBackgroundLifecycle(options);
  return {lifecycle,events,options,menu:()=>menu,stored:()=>stored,loseTray:()=>{trayReady=false;},visible:()=>visible};
}
test("preserves unset Mac residency and defaults other platforms off; explicit off wins",()=>{
  assert.equal(backgroundPreferences({},"darwin").keepRunning,true);
  for(const platform of ["win32","linux"])assert.equal(backgroundPreferences({},platform).keepRunning,false);
  assert.equal(backgroundPreferences({keepRunning:false},"darwin").keepRunning,false);
});
test("close explanation happens once and retained window can reopen through Inbox",async()=>{
  const f=fixture();await f.lifecycle.start();await f.lifecycle.update({keepRunning:true});
  let prevented=0;const close={preventDefault(){prevented++;}};
  assert.equal(f.lifecycle.handleClose(close),true);await f.lifecycle.settledClose();assert.equal(f.visible(),false);
  f.menu().find(item=>item.label==="Inbox").click();assert.equal(f.visible(),true);assert.ok(f.events.includes("inbox"));
  f.lifecycle.handleClose(close);await f.lifecycle.settledClose();assert.equal(f.events.filter(event=>event==="explain").length,1);assert.equal(prevented,2);
  assert.equal(f.stored().closeExplained,true);f.lifecycle.dispose();
});
test("explicit quit and OS/update shutdown never hide or explain",async()=>{
  const f=fixture("darwin");await f.lifecycle.start();f.lifecycle.beginQuit();
  assert.equal(f.lifecycle.handleClose({preventDefault(){throw Error("must not prevent quit");}}),false);
  assert.equal(f.lifecycle.keepAliveWithoutWindows(),false);assert.ok(!f.events.includes("hide"));
  f.lifecycle.dispose();
});
test("lost tray restores a hidden Linux window; quiet startup needs a live tray",async()=>{
  const f=fixture("linux",{keepRunning:true,closeExplained:true});await f.lifecycle.start();
  assert.equal(f.lifecycle.shouldStartQuietly(),true);f.lifecycle.handleClose({preventDefault(){}});await f.lifecycle.settledClose();
  f.loseTray();await f.lifecycle.refresh();assert.equal(f.visible(),true);assert.equal(f.lifecycle.shouldStartQuietly(),false);assert.equal(f.lifecycle.keepAliveWithoutWindows(),false);
  assert.equal(f.lifecycle.handleClose({preventDefault(){throw Error("no unreachable hidden window");}}),false);f.lifecycle.dispose();
});
test("off shows a hidden window and login changes only after an explicit request",async()=>{
  const f=fixture("darwin",{closeExplained:true});await f.lifecycle.start();assert.ok(!f.events.includes("login"));
  f.lifecycle.handleClose({preventDefault(){}});await f.lifecycle.settledClose();await f.lifecycle.update({keepRunning:false});assert.equal(f.visible(),true);
  assert.equal(f.lifecycle.keepAliveWithoutWindows(),false);await f.lifecycle.update({startAtLogin:true});assert.equal(f.lifecycle.status().login.openAtLogin,true);f.lifecycle.dispose();
});
test("pause menu changes admission only and suspend status never claims continued work",async()=>{
  const f=fixture();await f.lifecycle.start();f.menu().find(item=>item.label==="Pause automations").click();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.lifecycle.status().automationsPaused,true);assert.ok(!f.events.includes("quit"));
  f.lifecycle.setSuspended(true);assert.equal(f.lifecycle.status().suspended,true);f.lifecycle.dispose();
});
test("probe exceptions degrade to visibility and invalid patches have no effects",async()=>{
  const f=fixture("linux");f.options.probeTray=()=>{throw Error("host missing");};await f.lifecycle.start();
  assert.equal(f.lifecycle.status().trayAvailable,false);await assert.rejects(f.lifecycle.update({keepRunning:true}),/No working tray/);
  await assert.rejects(f.lifecycle.update({startAtLogin:"yes"}),/one startup/);assert.ok(!f.events.includes("login"));f.lifecycle.dispose();
});
test("Linux host probe requires an actual successful D-Bus response",async()=>{
  assert.equal(await linuxTrayHostAvailable((_bin,_args,_opts,cb)=>cb(null,"(<true>,)")),true);
  assert.equal(await linuxTrayHostAvailable((_bin,_args,_opts,cb)=>cb(null,"(<false>,)")),false);
  assert.equal(await linuxTrayHostAvailable((_bin,_args,_opts,cb)=>cb(Error("missing executable"),"true")),false);
});
test("disposing while native tray discovery is pending cannot start a late monitor",async()=>{
  const f=fixture();let finish,started,monitors=0;
  const entered=new Promise(resolve=>{started=resolve;});
  f.options.probeTray=()=>new Promise(resolve=>{finish=resolve;started();});
  f.options.setInterval=()=>{monitors++;return {unref(){}};};
  const pending=f.lifecycle.start();await entered;f.lifecycle.dispose();finish(true);await pending;
  assert.equal(monitors,0);assert.equal(f.lifecycle.status().trayAvailable,false);
});
