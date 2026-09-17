import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { APPROVAL_SOUND, approvalOptions, approvalPayload, createApprovalNotifications } from "./approval-notification.mjs";
const payload = { botId: "bot", threadId: "task", requestId: "request", messageId: "card", title: "Approval <needed>", body: "Review & decide" };
function fixture(platform = "darwin", limit = 1024) {
  const notices = [], opened = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    static handleActivation(callback) { this.activation = callback; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() { this.shown = true; }
  }
  return { notices, opened, show: createApprovalNotifications({ Notification: FakeNotification, platform, limit, authorize:async()=>true,revalidate:async value=>value,onOpen: target => opened.push(target) }) };
}
test("fixed native sounds with normal non-looping presentation and escaped Windows content", () => {
  assert.equal(approvalOptions(payload, "darwin").sound, APPROVAL_SOUND);
  const windows = approvalOptions(payload, "win32").toastXml;
  assert.match(windows, /Notification.Reminder/); assert.match(windows, /loop="false"/);
  assert.match(windows, /Approval &lt;needed&gt;/); assert.match(windows, /Review &amp; decide/);
  assert.doesNotMatch(windows, /scenario=|critical|<needed>/);
  assert.equal(approvalOptions(payload, "linux"), null);
});
test("payload allows bounded scalars only, never caller paths, XML or commands", () => {
  assert.deepEqual(approvalPayload(payload), payload);
  for (const bad of [null, [], { ...payload, requestId: "" }, { ...payload, botId: "https://host" }, { ...payload, body: {} }, { ...payload, title: "x".repeat(301) }, { ...payload, sound: "/tmp/custom" }, { ...payload, toastXml: "<toast/>" }]) assert.equal(approvalPayload(bad), null);
});
test("one native cue per request and a click navigates once without approval actions", async () => {
  const f = fixture();
  assert.deepEqual(await f.show(payload), { accepted: true });
  assert.deepEqual(f.show({ ...payload, body: "new text", messageId: "other-card" }), { accepted: false });
  f.notices[0].emit("click"); f.notices[0].emit("click");
  assert.deepEqual(f.opened, [{ botId: "bot", threadId: "task" }]);
  await f.show({ ...payload, threadId: "other-task" });
  await f.show({ ...payload, requestTurnId: "next-turn" });
  assert.equal(f.notices.length, 3);
});
test("native failures stay consumed and old callback retention is bounded", async () => {
  const f = fixture("darwin", 1);
  await f.show(payload); f.notices[0].emit("failed");
  assert.deepEqual(f.show(payload), { accepted: false });
  await f.show({ ...payload, requestId: "second" });
  await f.show({ ...payload, requestId: "third" });
  assert.equal(f.notices[1].listenerCount("click"), 0);
});
test("fixed WAV has valid finite PCM and ships at the native resource lookup root", () => {
  const wave = readFileSync(new URL("./resources/murage-approval.wav", import.meta.url));
  assert.equal(wave.toString("ascii", 0, 4), "RIFF"); assert.equal(wave.toString("ascii", 8, 12), "WAVE");
  assert.equal(wave.readUInt32LE(4), wave.length - 8);
  assert.equal(wave.readUInt16LE(20), 1); assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt16LE(34), 16); assert.equal(wave.readUInt32LE(40), wave.length - 44);
  assert.equal(wave.readUInt32LE(40) / wave.readUInt32LE(28), 0.48);
  assert.ok(wave.subarray(44).some(byte => byte !== 0));
  const build = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(build, /from: electron\/resources\/murage-approval.wav\s+to: murage-approval.wav/);
  assert.equal(APPROVAL_SOUND, "murage-approval.wav");
});

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function authFixture({authorize,revalidate=async p=>p,platform="darwin"}={}){const notices=[];class Native extends EventEmitter{static isSupported(){return true;}static handleActivation(callback){this.activation=callback;}constructor(options){super();this.options=options;notices.push(this);}show(){this.shown=true;}}return{notices,show:createApprovalNotifications({Notification:Native,platform,authorize,revalidate,onOpen(){}})};}
test("first approval waits for native grant and current-card revalidation before one show",async()=>{const grant=deferred();let checks=0;const f=authFixture({authorize:async()=>grant.promise,revalidate:async p=>{checks++;return p}});const result=f.show(payload);assert.deepEqual(f.show(payload),{accepted:false});await new Promise(r=>setImmediate(r));assert.equal(f.notices.length,0);grant.resolve(true);assert.deepEqual(await result,{accepted:true});assert.equal(checks,1);assert.equal(f.notices.length,1);assert.equal(f.notices[0].options.sound,APPROVAL_SOUND);});
test("denial, failed authority and missing authority never construct native notification",async()=>{for(const authorize of [async()=>false,async()=>{throw Error('unavailable')},undefined]){const f=authFixture({authorize});assert.deepEqual(await f.show(payload),{accepted:false});assert.equal(f.notices.length,0);}});
test("resolved or revoked approval during consent is not replayed",async()=>{for(const result of [null,{...payload,requestId:'replacement'}]){const grant=deferred(),f=authFixture({authorize:()=>grant.promise,revalidate:async()=>result});const work=f.show(payload);grant.resolve(true);assert.deepEqual(await work,{accepted:false});assert.equal(f.notices.length,0);assert.deepEqual(f.show(payload),{accepted:false});}});
test("fresh privacy projection replaces stale text and native revocation prevents show",async()=>{const f=authFixture({authorize:async()=>true,revalidate:async p=>({...p,title:'Murage',body:'Your attention is needed.'})});assert.deepEqual(await f.show(payload),{accepted:true});assert.equal(f.notices[0].options.title,'Murage');let checks=0;const g=authFixture({authorize:async()=>++checks===1});assert.deepEqual(await g.show(payload),{accepted:false});assert.equal(g.notices.length,0);});
test("shutdown while authorization or revalidation is pending prevents late delivery",async()=>{for(const stage of ['authorize','revalidate']){const gate=deferred(),f=authFixture({authorize:stage==='authorize'?()=>gate.promise:async()=>true,revalidate:stage==='revalidate'?()=>gate.promise:async p=>p});const work=f.show(payload);await new Promise(r=>setImmediate(r));f.show.dispose();gate.resolve(stage==='authorize'?true:payload);assert.deepEqual(await work,{accepted:false});assert.equal(f.notices.length,0);}});
test("Windows remains synchronous without native authorization and Linux remains unsupported",()=>{const f=authFixture({platform:'win32',authorize:()=>assert.fail('no mac permission')});assert.deepEqual(f.show(payload),{accepted:true});assert.match(f.notices[0].options.toastXml,/Notification.Reminder/);assert.deepEqual(authFixture({platform:'linux'}).show(payload),{accepted:false});});

function windowsFixture(limit=1024){
 const notices=[],opened=[];let callback,registrations=0,throwOnShow=false;
 class Native extends EventEmitter{
  static isSupported(){return true;}
  static handleActivation(handler){callback=handler;registrations++;}
  constructor(options){super();this.options=options;notices.push(this);}
  show(){if(throwOnShow)throw Error("native failure");}
 }
 const create=()=>createApprovalNotifications({Notification:Native,platform:"win32",limit,onOpen:target=>opened.push(target)});
 return {notices,opened,create,show:create(),activate:details=>callback?.(details),registrations:()=>registrations,replace:handler=>Native.handleActivation(handler),failShow:()=>{throwOnShow=true;}};
}
const launchOf=notice=>/ launch="([^"]+)"/.exec(notice.options.toastXml)?.[1];
test("Windows lazily registers public activation and retains exact opaque target after close",()=>{
 const f=windowsFixture();assert.equal(f.registrations(),0);assert.deepEqual(f.show({...payload,botId:"bad/path"}),{accepted:false});assert.equal(f.registrations(),0);
 assert.deepEqual(f.show(payload),{accepted:true});assert.equal(f.registrations(),1);const token=launchOf(f.notices[0]);assert.match(token,/^murage-approval:[a-f0-9]{32}$/);assert(!token.includes(payload.botId));
 f.notices[0].emit("close",{reason:"timedOut"});f.activate({type:"click",arguments:token});assert.deepEqual(f.opened,[{botId:"bot",threadId:"task"}]);f.activate({type:"click",arguments:token});f.notices[0].emit("click");assert.equal(f.opened.length,1);
 f.show({...payload,requestId:"second"});assert.equal(f.registrations(),1);assert.notEqual(launchOf(f.notices[1]),token);
});
test("Windows instance and global callbacks share the same once-open gate in either order",()=>{
 for(const first of ["instance","global"]){const f=windowsFixture();f.show(payload);const n=f.notices[0],token=launchOf(n);if(first==="instance")n.emit("click");else f.activate({type:"click",arguments:token});n.emit("click");f.activate({type:"click",arguments:token});assert.equal(f.opened.length,1);}
});
test("Windows malformed unknown nonclick and failed tokens never navigate",()=>{
 const f=windowsFixture();f.show(payload);const n=f.notices[0],token=launchOf(n);
 for(const details of [null,{}, {type:"reply",arguments:token},{type:"action",arguments:token},{type:"click",arguments:token+" extra"},{type:"click",arguments:"murage-approval:"+"0".repeat(32)},{type:"click",arguments:{botId:"bot"}},{type:"click",arguments:"bot:task"}])f.activate(details);
 assert.equal(f.opened.length,0);n.emit("failed");n.emit("click");f.activate({type:"click",arguments:token});assert.equal(f.opened.length,0);
 const g=windowsFixture();g.failShow();assert.deepEqual(g.show(payload),{accepted:false});g.activate({type:"click",arguments:launchOf(g.notices[0])});g.notices[0].emit("click");assert.equal(g.opened.length,0);
});
test("Windows historical routing stays bounded and evicted tokens fail from both callbacks",()=>{
 const f=windowsFixture(1);f.show(payload);const old=f.notices[0];old.emit("close");f.show({...payload,requestId:"next",threadId:"next-task"});f.activate({type:"click",arguments:launchOf(old)});old.emit("click");assert.equal(f.opened.length,0);f.activate({type:"click",arguments:launchOf(f.notices[1])});assert.deepEqual(f.opened,[{botId:"bot",threadId:"next-task"}]);
 // A late event from an evicted old object cannot invalidate a newly minted token for the same request key.
 f.show(payload);const fresh=f.notices.at(-1);old.emit("close");old.emit("failed");f.activate({type:"click",arguments:launchOf(fresh)});assert.deepEqual(f.opened.at(-1),{botId:"bot",threadId:"task"});
});
test("Windows disposed and previous-controller tokens expire without replacing a later global handler",()=>{
 const f=windowsFixture();f.show(payload);const token=launchOf(f.notices[0]);let external=0;f.replace(()=>external++);const registrations=f.registrations();f.show.dispose();assert.equal(f.registrations(),registrations);f.activate({type:"click",arguments:token});assert.equal(external,1);f.notices[0].emit("click");assert.equal(f.opened.length,0);assert.deepEqual(f.show({...payload,requestId:"late"}),{accepted:false});
 const next=f.create();next({...payload,requestId:"fresh"});f.activate({type:"click",arguments:token});assert.equal(f.opened.length,0);const fresh=f.notices.at(-1);next.dispose();f.activate({type:"click",arguments:launchOf(fresh)});assert.equal(f.opened.length,0);
});
test("Windows launch uses only minted grammar with escaped content and unchanged Reminder XML",()=>{
 const token="murage-approval:"+"a".repeat(32),options=approvalOptions({...payload,title:'<>&"\'',body:'<>&"\''},"win32",token);assert.match(options.toastXml,/launch="murage-approval:a{32}"/);assert(options.toastXml.includes('&lt;&gt;&amp;&quot;&apos;'));assert(options.toastXml.includes('<audio src="ms-winsoundevent:Notification.Reminder" loop="false"/>'));assert.equal(approvalOptions(payload,"win32",'evil" args'),null);assert.deepEqual(approvalOptions(payload,"darwin",token),approvalOptions(payload,"darwin"));
});
