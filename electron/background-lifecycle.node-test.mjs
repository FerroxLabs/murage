import test from "node:test";
import assert from "node:assert/strict";
import { backgroundPreferences,createBackgroundLifecycle,elapsedLabel,linuxTrayHostAvailable,trayMenu,trayPresentation,traySummaryValue } from "./background-lifecycle.mjs";

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
  f.menu().find(item=>item.label==="See all in Inbox").click();assert.equal(f.visible(),true);assert.ok(f.events.includes("inbox"));
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

// ── menu bar / tray menu ─────────────────────────────────────────────
const approval=(n,extra={})=>({botId:"b1",botName:"Ember",summary:`Read the weekly report draft number ${n} for the team`,threadId:"t1",messageId:`m${n}`,requestId:`r${n}`,quick:true,...extra});
const summaryOf=(items,extra={})=>({needsYou:items.length,items:items.slice(0,5),working:[],bots:[],moreBots:false,...extra});
function menuOf(summary,extra={}){
  const calls=[];
  const items=trayMenu({summary,automationsPaused:false,now:10_000,open:()=>calls.push("open"),openInbox:()=>calls.push("inbox"),
    openTarget:target=>calls.push(target),decide:(item,behavior)=>()=>calls.push([behavior,item.messageId]),togglePause:()=>{},checkForUpdates:null,quit:()=>{},...extra});
  return {items,calls,labels:items.map(item=>item.type==="separator"?"---":item.label)};
}
test("menu with nothing waiting shows no Needs you section and ends with the app items",()=>{
  const {labels}=menuOf(summaryOf([]));
  assert.deepEqual(labels,["See all in Inbox","---","Open Murage","---","Pause automations","---","Quit Murage"]);
  assert.deepEqual(menuOf(null).labels,labels);
});
test("one approval: header with the count, a Bot · summary item with Open, Allow once, Deny",()=>{
  const {items,labels,calls}=menuOf(summaryOf([approval(1)]));
  assert.equal(labels[0],"Needs you  1");assert.equal(items[0].enabled,false);
  assert.ok(items[1].label.startsWith("Ember · Read the weekly"));assert.ok(items[1].label.length<=44);assert.ok(items[1].label.endsWith("…"));
  assert.doesNotMatch(labels.join("\n"),/\u2014/);
  const sub=items[1].submenu.filter(item=>item.type!=="separator");
  assert.deepEqual(sub.slice(1).map(item=>item.label),["Open","Allow once","Deny"]);
  assert.equal(sub[0].enabled,false);assert.match(sub[0].label,/number 1 for the team/);
  sub[1].click();sub[2].click();sub[3].click();
  assert.deepEqual(calls,[{kind:"approval",botId:"b1",threadId:"t1",messageId:"m1"},["allow","m1"],["deny","m1"]]);
  assert.equal(labels[2],"See all in Inbox");
});
test("seven waiting: count says 7, five items listed, then See all in Inbox",()=>{
  const all=[1,2,3,4,5,6,7].map(n=>approval(n));
  const {labels}=menuOf({...summaryOf(all),needsYou:7});
  assert.equal(labels[0],"Needs you  7");assert.equal(labels.slice(1,6).length,5);assert.equal(labels[6],"See all in Inbox");
});
test("stop-line, keys and secrets and other full-card items only open; never Allow from the menu",()=>{
  const {items,calls}=menuOf(summaryOf([approval(1,{quick:false})]));
  assert.equal(items[1].submenu,undefined);assert.ok(!JSON.stringify(items).includes("Allow"));
  items[1].click();assert.deepEqual(calls,[{kind:"approval",botId:"b1",threadId:"t1",messageId:"m1"}]);
  // quick without a request id is never answerable
  assert.equal(traySummaryValue({needsYou:1,items:[{...approval(1),requestId:undefined}]}).items[0].quick,false);
  assert.equal(traySummaryValue({needsYou:"3",items:[]}),null);
});
test("count, macOS title and tooltip; dotted icon elsewhere; zero is plain",()=>{
  assert.deepEqual(trayPresentation(3,"darwin"),{attention:true,title:" 3",tooltip:"Murage: 3 need you"});
  assert.deepEqual(trayPresentation(1,"win32"),{attention:true,title:"",tooltip:"Murage: 1 needs you"});
  assert.deepEqual(trayPresentation(0,"linux"),{attention:false,title:"",tooltip:"Murage"});
  assert.deepEqual(trayPresentation(undefined,"darwin"),{attention:false,title:"",tooltip:"Murage"});
  assert.equal(trayPresentation(250,"darwin").title," 99+");
});
test("working now is hidden when nothing runs and lists Bot · doing · elapsed otherwise",()=>{
  assert.ok(!menuOf(summaryOf([])).labels.includes("Working now"));
  const {items,labels,calls}=menuOf(summaryOf([],{working:[{botId:"b2",botName:"Zed",threadId:"t2",doing:"reading a file",startedAt:10_000-125_000}]}));
  const index=labels.indexOf("Working now");assert.ok(index>0);
  assert.equal(items[index+1].label,"Zed · reading a file · 2 min");items[index+1].click();
  assert.deepEqual(calls,[{kind:"conversation",botId:"b2",threadId:"t2"}]);
  assert.equal(elapsedLabel(0,3_900_000),"1 h 5 min");
});
test("New message to lists the Chief first and caps with More in Murage",()=>{
  const {items,calls}=menuOf(summaryOf([],{bots:[{id:"c",name:"Sable",chief:true},{id:"a",name:"Amy",chief:false}],moreBots:true}));
  const compose=items.find(item=>item.label==="New message to…");
  assert.deepEqual(compose.submenu.map(item=>item.type==="separator"?"---":item.label),["Sable","---","Amy","---","More in Murage"]);
  compose.submenu[0].click();assert.deepEqual(calls,[{kind:"compose",botId:"c"}]);
  assert.ok(menuOf(summaryOf([]),{checkForUpdates:()=>{}}).labels.includes("Check for updates"));
});
test("Allow re-reads the card, answers through the app's respond route, then refreshes the menu",async()=>{
  const f=fixture("darwin");const requests=[];let waiting=[approval(1)],presented=[];
  f.options.harness={get:async route=>{requests.push(["GET",route]);return summaryOf(waiting);},post:async(route,body)=>{requests.push(["POST",route,body]);waiting=[];return {ok:true,outcome:"allowed-once"};}};
  f.options.presentTray=(_tray,view)=>presented.push(view);
  await f.lifecycle.start();
  assert.equal(presented.at(-1).title," 1");
  const item=f.menu().find(entry=>entry.label?.startsWith("Ember"));
  item.submenu.find(entry=>entry.label==="Allow once").click();
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests.filter(([method])=>method==="POST"),[["POST","/api/threads/t1/respond",{requestId:"r1",behavior:"allow"}]]);
  assert.equal(presented.at(-1).title,"");assert.ok(!f.menu().some(entry=>entry.label?.startsWith("Needs you")));
  f.lifecycle.dispose();
});
test("Allow on a card that stopped being quick answers nothing and opens the card instead",async()=>{
  const f=fixture();const posts=[];let quick=true;const opened=[];
  f.options.harness={get:async()=>summaryOf([approval(1,{quick})]),post:async(...args)=>{posts.push(args);return {ok:true};}};
  f.options.openTarget=target=>opened.push(target);
  await f.lifecycle.start();quick=false;
  f.menu()[1].submenu.find(entry=>entry.label==="Allow once").click();
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(posts.length,0);assert.deepEqual(opened,[{kind:"approval",botId:"b1",threadId:"t1",messageId:"m1"}]);
  assert.ok(f.events.some(event=>/changed/.test(event)));f.lifecycle.dispose();
});
