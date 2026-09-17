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
function authFixture({authorize,revalidate=async p=>p,platform="darwin"}={}){const notices=[];class Native extends EventEmitter{static isSupported(){return true;}constructor(options){super();this.options=options;notices.push(this);}show(){this.shown=true;}}return{notices,show:createApprovalNotifications({Notification:Native,platform,authorize,revalidate,onOpen(){}})};}
test("first approval waits for native grant and current-card revalidation before one show",async()=>{const grant=deferred();let checks=0;const f=authFixture({authorize:async()=>grant.promise,revalidate:async p=>{checks++;return p}});const result=f.show(payload);assert.deepEqual(f.show(payload),{accepted:false});await new Promise(r=>setImmediate(r));assert.equal(f.notices.length,0);grant.resolve(true);assert.deepEqual(await result,{accepted:true});assert.equal(checks,1);assert.equal(f.notices.length,1);assert.equal(f.notices[0].options.sound,APPROVAL_SOUND);});
test("denial, failed authority and missing authority never construct native notification",async()=>{for(const authorize of [async()=>false,async()=>{throw Error('unavailable')},undefined]){const f=authFixture({authorize});assert.deepEqual(await f.show(payload),{accepted:false});assert.equal(f.notices.length,0);}});
test("resolved or revoked approval during consent is not replayed",async()=>{for(const result of [null,{...payload,requestId:'replacement'}]){const grant=deferred(),f=authFixture({authorize:()=>grant.promise,revalidate:async()=>result});const work=f.show(payload);grant.resolve(true);assert.deepEqual(await work,{accepted:false});assert.equal(f.notices.length,0);assert.deepEqual(f.show(payload),{accepted:false});}});
test("fresh privacy projection replaces stale text and native revocation prevents show",async()=>{const f=authFixture({authorize:async()=>true,revalidate:async p=>({...p,title:'Murage',body:'Your attention is needed.'})});assert.deepEqual(await f.show(payload),{accepted:true});assert.equal(f.notices[0].options.title,'Murage');let checks=0;const g=authFixture({authorize:async()=>++checks===1});assert.deepEqual(await g.show(payload),{accepted:false});assert.equal(g.notices.length,0);});
test("shutdown while authorization or revalidation is pending prevents late delivery",async()=>{for(const stage of ['authorize','revalidate']){const gate=deferred(),f=authFixture({authorize:stage==='authorize'?()=>gate.promise:async()=>true,revalidate:stage==='revalidate'?()=>gate.promise:async p=>p});const work=f.show(payload);await new Promise(r=>setImmediate(r));f.show.dispose();gate.resolve(stage==='authorize'?true:payload);assert.deepEqual(await work,{accepted:false});assert.equal(f.notices.length,0);}});
test("Windows remains synchronous without native authorization and Linux remains unsupported",()=>{const f=authFixture({platform:'win32',authorize:()=>assert.fail('no mac permission')});assert.deepEqual(f.show(payload),{accepted:true});assert.match(f.notices[0].options.toastXml,/Notification.Reminder/);assert.deepEqual(authFixture({platform:'linux'}).show(payload),{accepted:false});});
