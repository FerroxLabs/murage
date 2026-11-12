// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
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
    close() { this.closed = true; }
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
  assert.deepEqual(f.opened, [{ botId: "bot", threadId: "task", messageId: "card" }]);
  await f.show({ ...payload, threadId: "other-task" });
  await f.show({ ...payload, requestTurnId: "next-turn" });
  assert.equal(f.notices.length, 3);
});
test("native failures stay consumed and old callback retention is bounded", async () => {
  const f = fixture("darwin", 1);
  await f.show(payload); f.notices[0].emit("failed");
  assert.deepEqual(f.show(payload), { accepted: false });
  await f.show({ ...payload, requestId: "second" });
  // S3R R4: an active cap below 1024 would evict before main's global cap.
  for (let i = 0; i < 1024; i++) await f.show({ ...payload, requestId: `third-${i}` });
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
  close(){this.closed=true;}
 }
 const create=()=>createApprovalNotifications({Notification:Native,platform:"win32",limit,onOpen:target=>opened.push(target)});
 return {notices,opened,create,show:create(),activate:details=>callback?.(details),registrations:()=>registrations,replace:handler=>Native.handleActivation(handler),failShow:()=>{throwOnShow=true;}};
}
const launchOf=notice=>/ launch="([^"]+)"/.exec(notice.options.toastXml)?.[1];
test("Windows lazily registers public activation and retains exact opaque target after close",()=>{
 const f=windowsFixture();assert.equal(f.registrations(),0);assert.deepEqual(f.show({...payload,botId:"bad/path"}),{accepted:false});assert.equal(f.registrations(),0);
 assert.deepEqual(f.show(payload),{accepted:true});assert.equal(f.registrations(),1);const token=launchOf(f.notices[0]);assert.match(token,/^murage-approval:[a-f0-9]{32}$/);assert(!token.includes(payload.botId));
 f.notices[0].emit("close",{reason:"timedOut"});f.activate({type:"click",arguments:token});assert.deepEqual(f.opened,[{botId:"bot",threadId:"task",messageId:"card"}]);f.activate({type:"click",arguments:token});f.notices[0].emit("click");assert.equal(f.opened.length,1);
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
 // Flag-off callers keep their consumed identity after a native show throw.
 assert.deepEqual(g.show(payload),{accepted:false});assert.equal(g.notices.length,1);
});
test("Windows historical routing stays bounded and evicted tokens fail from both callbacks",()=>{
 // S3R R4 retains at least 1024 active routes, including OS-dismissed notices.
 const f=windowsFixture(1);f.show(payload);const old=f.notices[0];old.emit("close");
 for(let i=0;i<1024;i++)f.show({...payload,requestId:`next-${i}`,threadId:"next-task"});
 f.activate({type:"click",arguments:launchOf(old)});old.emit("click");assert.equal(f.opened.length,0);f.activate({type:"click",arguments:launchOf(f.notices.at(-1))});assert.deepEqual(f.opened,[{botId:"bot",threadId:"next-task",messageId:"card"}]);
 // A late event from an evicted old object cannot invalidate a newly minted token for the same request key.
 f.show(payload);const fresh=f.notices.at(-1);old.emit("close");old.emit("failed");f.activate({type:"click",arguments:launchOf(fresh)});assert.deepEqual(f.opened.at(-1),{botId:"bot",threadId:"task",messageId:"card"});
});
test("Windows disposed and previous-controller tokens expire without replacing a later global handler",()=>{
 const f=windowsFixture();f.show(payload);const token=launchOf(f.notices[0]);let external=0;f.replace(()=>external++);const registrations=f.registrations();f.show.dispose();assert.equal(f.registrations(),registrations);f.activate({type:"click",arguments:token});assert.equal(external,1);f.notices[0].emit("click");assert.equal(f.opened.length,0);assert.deepEqual(f.show({...payload,requestId:"late"}),{accepted:false});
 const next=f.create();next({...payload,requestId:"fresh"});f.activate({type:"click",arguments:token});assert.equal(f.opened.length,0);const fresh=f.notices.at(-1);next.dispose();f.activate({type:"click",arguments:launchOf(fresh)});assert.equal(f.opened.length,0);
});
test("Windows launch uses only minted grammar with escaped content and unchanged Reminder XML",()=>{
 const token="murage-approval:"+"a".repeat(32),options=approvalOptions({...payload,title:'<>&"\'',body:'<>&"\''},"win32",token);assert.match(options.toastXml,/launch="murage-approval:a{32}"/);assert(options.toastXml.includes('&lt;&gt;&amp;&quot;&apos;'));assert(options.toastXml.includes('<audio src="ms-winsoundevent:Notification.Reminder" loop="false"/>'));assert.equal(approvalOptions(payload,"win32",'evil" args'),null);assert.deepEqual(approvalOptions(payload,"darwin",token),approvalOptions(payload,"darwin"));
});

// The legacy adapter exercises cc2f's closest operations instead of failing on
// missing methods. That implementation presents during prepare, cannot cancel
// or close a key, and drops callbacks without withdrawing notices.
function deliveryApi(show) {
  if (show.prepare) return show;
  return {
    prepare(input, { onSlot } = {}) {
      onSlot?.({ cancel() {} });
      return Promise.resolve(show(input)).then(result => ({ ok: result.accepted, prepared: { result, words: { title: input.title, body: input.body } } }));
    },
    present: prepared => prepared.result,
    close: () => false,
    setOnEvict() {},
    dispose: () => show.dispose(),
  };
}
function deliveryFixture({ platform = "win32", authorize = async () => true, revalidate = async p => p, limit = 1024 } = {}) {
  const notices = [], opened = [], events = [];
  let activation, fault, closeEvents = false;
  class Native extends EventEmitter {
    static isSupported() { return true; }
    static handleActivation(fn) { activation = fn; }
    constructor(options) {
      super();
      if (fault === "constructor") throw Error("constructor refused");
      this.options = options; this.index = notices.length; this.closes = 0;
      notices.push(this);
    }
    show() { events.push([this.index, "show"]); if (fault === "show") throw Error("show refused"); }
    close() {
      this.closes++; events.push([this.index, "close"]);
      if (closeEvents) { this.emit("close"); this.emit("failed"); }
    }
    removeAllListeners() { events.push([this.index, "remove"]); return super.removeAllListeners(); }
  }
  const show = createApprovalNotifications({ Notification: Native, platform, authorize, revalidate, limit, onOpen: target => opened.push(target) });
  return { api: deliveryApi(show), show, notices, opened, events, activate: token => activation?.({ type: "click", arguments: token }), fault: value => { fault = value; }, emitOnClose: () => { closeEvents = true; } };
}
const nativeKey = (session = "session-a", gen = "g1", ref = "ref") => `home|${session}|${ref}|${gen}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function deliver(f, key = nativeKey(), input = payload, onFailed = () => {}) {
  const result = await f.api.prepare(input, { key });
  assert.equal(result.ok, true);
  return f.api.present(result.prepared, { key, onFailed });
}

test("N1 keyed close withdraws once and forgets both activation routes", async () => {
  const f = deliveryFixture(), key = nativeKey();
  const result = await deliver(f, key), notice = f.notices[0], token = launchOf(notice);
  f.api.close(key);
  assert.equal(notice.closes, 1);
  assert.deepEqual(result, { accepted: true, handle: `n:${key}` });
  f.activate(token); notice.emit("click");
  assert.equal(f.opened.length, 0);
  assert.equal(f.api.close(key), false);
  assert.deepEqual(f.events.slice(-2), [[0, "close"], [0, "remove"]]);
});

for (const stage of ["authorize", "revalidate", "reauthorize"]) {
  test(`N2 close cancels a pending Mac ${stage} and late completion creates no notice`, async () => {
    const gate = deferred(); let calls = 0;
    const f = deliveryFixture({ platform: "darwin",
      authorize: () => { calls++; return (stage === "authorize" && calls === 1) || (stage === "reauthorize" && calls === 2) ? gate.promise : true; },
      revalidate: value => stage === "revalidate" ? gate.promise : value,
    });
    const key = nativeKey(), work = f.api.prepare(payload, { key });
    await tick(); f.api.close(key);
    gate.resolve(stage === "revalidate" ? payload : true);
    await work; await tick();
    assert.equal(f.notices.length, 0);
    assert.deepEqual(await work, { ok: false });
  });
}

test("cancel resolves before authorization and releases the same card for a new generation", async () => {
  const gates = [deferred(), deferred()]; let calls = 0, slot;
  const f = deliveryFixture({ platform: "darwin", authorize: () => ++calls <= 2 ? gates[calls - 1].promise : true });
  const old = f.api.prepare(payload, { key: nativeKey(), onSlot: value => { slot = value; } });
  assert.ok(slot);
  await tick(); slot.cancel();
  let outcome; void old.then(value => { outcome = value; });
  await tick(); assert.deepEqual(outcome, { ok: false });
  const replacement = f.api.prepare(payload, { key: nativeKey("session-a", "g2") });
  await tick(); gates[0].resolve(true); await tick();
  assert.equal(f.notices.length, 0);
  // The old continuation must not delete the replacement's reservation.
  assert.deepEqual(await f.api.prepare(payload, { key: nativeKey("session-a", "g3") }), { ok: false });
  gates[1].resolve(true);
  const ready = await replacement;
  assert.equal(ready.ok, true);
  assert.equal(f.api.present(ready.prepared, { key: nativeKey("session-a", "g2") }).accepted, true);
  assert.equal(f.notices.length, 1);
});

test("a cancelled generation resolving after its replacement commits cannot touch it", async () => {
  const gate = deferred(); let calls = 0, slot;
  const f = deliveryFixture({ platform: "darwin", authorize: () => ++calls === 1 ? gate.promise : true });
  const old = f.api.prepare(payload, { key: nativeKey(), onSlot: value => { slot = value; } });
  await tick(); slot.cancel();
  const key = nativeKey("session-a", "g2");
  assert.equal((await deliver(f, key)).accepted, true);
  gate.resolve(true); await old; await tick();
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].closes, 0);
  f.notices[0].emit("click"); assert.equal(f.opened.length, 1);
  assert.equal(f.api.close(nativeKey()), false);
  assert.equal(f.api.close(key), true);
  assert.equal(f.notices[0].closes, 1);
});

test("N3 capacity keeps 1024 notices then closes before listener removal and reports the key", async () => {
  const f = deliveryFixture({ limit: 1 }), evicted = [];
  f.api.setOnEvict(key => evicted.push(key));
  for (let i = 0; i < 1024; i++) await deliver(f, nativeKey("session-a", "g1", `ref-${i}`), { ...payload, requestId: `request-${i}` });
  assert.equal(f.notices[0].closes, 0);
  await deliver(f, nativeKey("session-a", "g1", "ref-1024"), { ...payload, requestId: "request-1024" });
  assert.equal(f.notices[0].closes, 1);
  assert.deepEqual(f.events.filter(([index, event]) => index === 0 && event !== "show"), [[0, "close"], [0, "remove"]]);
  assert.deepEqual(evicted, [nativeKey("session-a", "g1", "ref-0")]);
  f.activate(launchOf(f.notices[0])); assert.equal(f.opened.length, 0);
});

test("N4 dispose withdraws all active notices and cancels all pending slots", async () => {
  const gate = deferred(); let calls = 0;
  const f = deliveryFixture({ platform: "darwin", authorize: () => ++calls > 4 ? gate.promise : true });
  await deliver(f);
  await deliver(f, nativeKey("session-b"), { ...payload, requestId: "second" });
  const pending = f.api.prepare({ ...payload, requestId: "third" }, { key: nativeKey("session-c") });
  await tick(); f.api.dispose(); f.api.dispose();
  assert.deepEqual(f.notices.map(n => n.closes), [1, 1]);
  gate.resolve(true); assert.deepEqual(await pending, { ok: false });
  assert.equal(f.notices.length, 2);
  for (const notice of f.notices) notice.emit("click");
  assert.equal(f.opened.length, 0);
  assert.deepEqual(await f.api.prepare(payload, { key: nativeKey() }), { ok: false });
});

test("N6 equal refs in different sessions retain independent close and click routes", async () => {
  const f = deliveryFixture(), a = nativeKey(), b = nativeKey("session-b");
  await deliver(f, a); await deliver(f, b, { ...payload, requestId: "second", threadId: "second-task" });
  f.api.close(a);
  assert.deepEqual(f.notices.map(n => n.closes), [1, 0]);
  f.activate(launchOf(f.notices[0])); f.activate(launchOf(f.notices[1]));
  assert.deepEqual(f.opened, [{ botId: "bot", threadId: "second-task", messageId: "card" }]);
});

test("N7 notifier retains OS-closed notices until keyed close and ignores reentrant failure", async () => {
  const f = deliveryFixture(), failed = [], key = nativeKey();
  await deliver(f, key, payload, value => failed.push(value));
  const notice = f.notices[0]; notice.emit("close");
  assert.equal(notice.closes, 0); assert.deepEqual(failed, []);
  f.emitOnClose(); f.api.close(key);
  assert.equal(notice.closes, 1); assert.deepEqual(failed, []);
});

test("OS failed reports its key once and drops active and activation routes", async () => {
  const f = deliveryFixture(), failed = [], key = nativeKey();
  await deliver(f, key, payload, value => failed.push(value));
  const notice = f.notices[0], token = launchOf(notice);
  notice.emit("failed"); notice.emit("failed");
  assert.deepEqual(failed, [key]);
  assert.equal(f.api.close(key), false);
  f.activate(token); notice.emit("click"); assert.equal(f.opened.length, 0);
});

for (const fault of ["constructor", "show"]) {
  test(`a ${fault} throw releases the identity for an orphan retry`, async () => {
    const f = deliveryFixture(); f.fault(fault);
    const first = await f.api.prepare(payload, { key: nativeKey() });
    const result = first.ok ? f.api.present(first.prepared, { key: nativeKey() }) : { accepted: false };
    assert.equal(result.accepted, false);
    f.fault(undefined);
    const retry = await f.api.prepare(payload, { key: nativeKey("session-a", "g2") });
    assert.equal(retry.ok, true);
    assert.equal(f.api.present(retry.prepared, { key: nativeKey("session-a", "g2") }).accepted, true);
    if (fault === "show") assert.equal(f.notices[0].closes, 1);
  });
}

test("prepare has no OS surface and present consumes only its matching key once", async () => {
  const f = deliveryFixture(), key = nativeKey();
  const ready = await f.api.prepare(payload, { key });
  assert.equal(f.notices.length, 0);
  assert.deepEqual(ready.prepared.words, { title: payload.title, body: payload.body });
  assert.deepEqual(f.api.present(ready.prepared, { key: nativeKey("session-b") }), { accepted: false });
  assert.deepEqual(f.api.present({}, { key }), { accepted: false });
  assert.deepEqual(f.api.present(ready.prepared, { key }), { accepted: true, handle: `n:${key}` });
  assert.deepEqual(f.api.present(ready.prepared, { key }), { accepted: false });
  assert.equal(f.notices.length, 1);
  assert.equal(f.api.close("unknown"), false);
  assert.equal(f.notices[0].closes, 0);
});

test("Mac prepare exposes exact re-read words before presentation and retains local mute", async () => {
  const calls = [], checked = [];
  const f = deliveryFixture({ platform: "darwin", authorize: prompt => { calls.push(prompt); return true; }, revalidate: input => { checked.push(input); return { ...payload, title: "Current approval", body: "Current details" }; } });
  const key = nativeKey(), ready = await f.api.prepare({ ...payload, silent: true }, { key });
  assert.equal(f.notices.length, 0);
  assert.deepEqual(calls, [undefined, false]);
  assert.deepEqual(checked, [{ ...payload, silent: true }]);
  assert.deepEqual(ready.prepared.words, { title: "Current approval", body: "Current details" });
  f.api.present(ready.prepared, { key });
  assert.deepEqual(f.notices[0].options, { ...ready.prepared.words, silent: true });
});

for (const failure of ["authorize", "revalidate", "identity", "reauthorize", "throw"]) {
  test(`router preparation releases its identity after ${failure} rejection`, async () => {
    let rejecting = true, grants = 0, reads = 0;
    const f = deliveryFixture({ platform: "darwin",
      authorize: prompt => { grants++; return !(rejecting && (failure === "authorize" || (failure === "reauthorize" && prompt === false))); },
      revalidate: input => {
        reads++;
        if (rejecting && failure === "throw") throw new Error("read unavailable");
        if (rejecting && failure === "revalidate") return null;
        return rejecting && failure === "identity" ? { ...input, requestId: "another" } : input;
      },
    });
    assert.deepEqual(await f.api.prepare(payload, { key: nativeKey() }), { ok: false });
    assert.equal(f.notices.length, 0);
    const before = grants; rejecting = false;
    const key = nativeKey("session-a", "g2"), retry = await f.api.prepare(payload, { key });
    assert.equal(retry.ok, true); assert.equal(grants, before + 2); assert.ok(reads >= 1);
    assert.equal(f.api.present(retry.prepared, { key }).accepted, true); assert.equal(f.notices.length, 1);
  });
}

test("Windows keyed preparation revalidates its own ids, refuses replacements and can retry", async () => {
  for (const replacement of [null, { ...payload, requestId: "other" }, { ...payload, threadId: "other" }]) {
    const checked = []; let result = replacement;
    const f = deliveryFixture({ revalidate: input => { checked.push(input); return result; }, authorize: () => assert.fail("Windows does not request Mac permission") });
    const key = nativeKey();
    assert.deepEqual(await f.api.prepare(payload, { key }), { ok: false }); assert.equal(f.notices.length, 0);
    result = { ...payload, title: "Read title", body: "Read details" };
    const retry = await f.api.prepare(payload, { key }); assert.equal(retry.ok, true);
    assert.deepEqual(checked, [payload, payload]);
    assert.deepEqual(retry.prepared.words, { title: result.title, body: result.body });
    assert.equal(f.api.present(retry.prepared, { key }).accepted, true);
    assert.match(f.notices[0].options.toastXml, /Read title/);
  }
});

test("GUARD (also green on cc2f, regression guard, not a red-first test): Windows keyed preparation without a revalidator keeps caller words", async () => {
  const f = deliveryFixture({ revalidate: null }), key = nativeKey();
  const ready = await f.api.prepare(payload, { key });
  assert.deepEqual(ready.prepared.words, { title: payload.title, body: payload.body });
  assert.equal(f.api.present(ready.prepared, { key }).accepted, true);
});

test("Windows revalidation cancellation releases the card before a late read resolves", async () => {
  const gate = deferred(); let calls = 0;
  const f = deliveryFixture({ revalidate: input => ++calls === 1 ? gate.promise : input });
  const key = nativeKey(), pending = f.api.prepare(payload, { key });
  await tick(); f.api.close(key); assert.deepEqual(await pending, { ok: false });
  await deliver(f, nativeKey("session-a", "g2")); gate.resolve(payload); await tick();
  assert.equal(f.notices.length, 1);
});

test("record click callback replaces legacy navigation for native and Windows activation", async () => {
  for (const platform of ["darwin", "win32"]) for (const globalFirst of [false, true]) {
    const f = deliveryFixture({ platform }), key = nativeKey(); let clicks = 0;
    const ready = await f.api.prepare(payload, { key });
    f.api.present(ready.prepared, { key, onClick: () => { clicks++; } });
    const notice = f.notices[0];
    if (globalFirst && platform === "win32") f.activate(launchOf(notice));
    notice.emit("click"); notice.emit("click"); f.activate(launchOf(notice));
    assert.equal(clicks, 1); assert.deepEqual(f.opened, []);
  }
});
