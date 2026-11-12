// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import * as notifications from "./approval-notification.mjs";
import { createAttentionActions } from "./attention-actions.mjs";
import { createBannerApprovals } from "./native-banner-approvals.mjs";
import { pickNativeBanner } from "./native-banner-pick.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const payload = { botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1", title: "Title", body: "Body" };
const entry = { home: "cloud-a", epoch: "e1", frame: payload };
const launch = n => /launch="([^"]+)"/.exec(n.options.toastXml)[1];
const action = (n, letter) => launch(n).replace(/:o$/, `:${letter}`);

// Exercise the pre-S4a Open-only notifier on the base, so RED is observable
// behavior (missing buttons/answers/withdrawal), not a missing-module failure.
function baselineWindows({ Notification, open }) {
  const active = new Set(); let sequence = 0;
  const show = notifications.createApprovalNotifications({ Notification, platform: "win32", onOpen: open });
  return {
    available: () => true,
    async show(input) {
      const key = `baseline-${++sequence}`;
      const ready = await show.prepare({ ...input.entry.frame, ...input.plain }, { key });
      if (!ready.ok || !show.present(ready.prepared, { key, onFailed: input.onFailed }).accepted) return null;
      active.add(key); return [key];
    },
    close(ids) { for (const id of ids) { show.close(id); active.delete(id); } },
    size: () => active.size,
    dispose() { show.dispose(); active.clear(); },
  };
}

function rig() {
  const notices = [], posts = [], opened = [], minted = [], failed = [];
  let callback, registrations = 0, locked = false, identity = "cloud-a|session-1", failure;
  class Native extends EventEmitter {
    static isSupported() { return true; }
    static handleActivation(fn) { callback = fn; registrations++; }
    constructor(options) { super(); this.options = options; this.closes = 0; notices.push(this); }
    show() { if (failure === "throw") throw Error("native failure"); if (failure === "event") this.emit("failed"); }
    close() { this.closes++; this.emit("close"); }
  }
  const record = { open: true, requestId: "r1", digest: "d".repeat(64), outsideOk: { "banner-win": true },
    display: { botName: "Ada", title: "Run a command", willRun: "node --check example.mjs" } };
  const transport = { current: () => identity, readCard: async (_e, guard) => { guard(); return record; },
    post: async (body, guard) => { guard(); posts.push(body); return { ok: true }; } };
  const actions = createAttentionActions({ lock: { locked: () => locked } });
  const banner = (notifications.createWindowsBanners ?? baselineWindows)({ platform: "win32", Notification: Native,
    mint: spec => { minted.push(spec); return actions.mint({ ...spec, ...spec.entry.frame, home: spec.entry.home, epoch: spec.entry.epoch }); },
    act: (...args) => actions.act(...args), invalidate: id => actions.invalidateSurface(id),
    open: (route, home) => opened.push({ route, home }), locked: () => locked });
  const input = { entry, record, actionsOn: true, transport, identity, plain: { title: "Private", body: "Private" }, onFailed: () => failed.push(true) };
  const show = options => banner.show({ ...input, ...options });
  return { banner, show, input, Native, notices, posts, opened, minted, failed, record, transport, actions,
    activate: (n, letter, extras = {}) => callback({ type: "click", arguments: action(n, letter), ...extras }),
    raw: details => callback?.(details), registrations: () => registrations, lock: () => { locked = true; },
    replaceIdentity: () => { identity = "cloud-a|session-2"; }, fail: value => { failure = value; } };
}

test("Windows adapter is selected through the existing native seam", () => {
  const windows = {};
  assert.equal(pickNativeBanner({ platform: "win32", windows }), windows);
});

test("Windows full-detail XML has escaped fields, foreground actions, input, opaque arguments and local sound choice", async () => {
  const r = rig();
  r.record.display = { botName: 'A<&"', title: "Run 'this'", willRun: "echo <a> & b" };
  await r.show({ silent: true });
  const xml = r.notices[0].options.toastXml;
  assert.match(xml, /<text>A&lt;&amp;&quot;<\/text><text>Run &apos;this&apos;<\/text><text>echo &lt;a&gt; &amp; b<\/text>/);
  assert.match(xml, /<input id="reply" type="text"/);
  assert.equal((xml.match(/activationType="foreground"/g) ?? []).length, 3);
  for (const letter of ["a", "d", "r"]) assert.ok(xml.includes(`arguments="${action(r.notices[0], letter)}"`));
  assert.match(xml, /hint-inputId="reply"/);
  assert.match(launch(r.notices[0]), /^murage-act:[a-f0-9]{32}:o$/);
  assert.match(xml, /<audio silent="true"\/>/);
  assert.doesNotMatch(xml, /cloud-a|t1|r1|Notification.Reminder/);
  assert.equal(r.minted[0].transport, r.transport);
  assert.equal(r.minted[0].identity, r.input.identity);
});

for (const [letter, behavior] of [["a", "allow"], ["d", "deny"], ["r", "deny"]]) {
  test(`Windows ${letter} posts once through the captured action transport`, async () => {
    const r = rig(); await r.show(); const n = r.notices[0];
    r.activate(n, letter, { userInputs: { reply: "  Try\u0000 again\nplease  " } });
    r.activate(n, letter); n.emit("click"); await tick();
    assert.deepEqual(r.posts, [{ requestId: "r1", behavior, ...(letter === "r" ? { message: "Try again\nplease" } : {}),
      outside: { digest: r.record.digest, surface: "banner-win" } }]);
    assert.equal(r.opened.length, 0); assert.equal(n.closes, 1);
    assert.equal(r.banner.size(), 0); assert.equal(r.actions.size, 0);
  });
}

test("Reply accepts only the named native input and refuses missing, empty, oversized or non-string words", async () => {
  for (const extra of [{ reply: "not the named input" }, { userInputs: { reply: " " } }, { userInputs: { reply: "x".repeat(2001) } },
    { userInputs: { reply: 3 } }, { userInputs: { other: "no" } }]) {
    const r = rig(); await r.show(); r.activate(r.notices[0], "r", extra); await tick();
    assert.equal(r.posts.length, 0); assert.equal(r.opened.length, 1); assert.equal(r.notices[0].closes, 1);
  }
});

test("unknown, malformed and cold-start arguments never navigate or answer", async () => {
  const r = rig(); await r.show();
  for (const details of [null, {}, { type: "click", arguments: "murage-act:" + "0".repeat(32) + ":a" },
    { type: "click", arguments: action(r.notices[0], "a") + " extra" }, { type: "other", arguments: action(r.notices[0], "a") },
    { type: "action", actionIndex: 0 }, { type: "reply", reply: "yes" }]) r.raw(details);
  await tick(); assert.equal(r.posts.length, 0); assert.equal(r.opened.length, 0);
});

test("disabled actions, hidden previews, ineligible or missing detail, cancellation and lock mint and show nothing", async () => {
  for (const change of [r => ({ actionsOn: false }), r => ({ record: null }), r => ({ record: { ...r.record, outsideOk: {} } }),
    r => ({ record: { ...r.record, display: null } }), r => ({ record: { ...r.record, open: false } }),
    r => ({ record: { ...r.record, requestId: "other" } }), r => ({ cancelled: () => true }),
    r => { r.lock(); return {}; }]) {
    const r = rig(); assert.equal(await r.show(change(r)), null);
    assert.equal(r.notices.length, 0); assert.equal(r.minted.length, 0);
  }
});

test("settled, changed, private, locked and replaced-Cloud cards refuse at answer time", async () => {
  for (const change of [r => { r.record.open = false; }, r => { r.record.digest = "b".repeat(64); },
    r => { r.record.outsideOk["banner-win"] = false; }, r => r.lock(), r => r.replaceIdentity(),
    r => r.actions.invalidateAll("previews")]) {
    const r = rig(); await r.show(); change(r); r.activate(r.notices[0], "a"); await tick();
    assert.equal(r.posts.length, 0); assert.equal(r.opened.length, 1); assert.equal(r.notices[0].closes, 1);
    assert.equal(r.opened[0].home, "cloud-a");
  }
});

test("withdrawal and disposal retire native routes AND tokens; Action Centre timeout keeps them until withdrawal", async () => {
  for (const dispose of [false, true]) {
    const r = rig(); const ids = await r.show(); const n = r.notices[0];
    n.emit("close", { reason: "timedOut" });
    assert.equal(r.banner.size(), 1);
    if (dispose) r.banner.dispose(); else r.banner.close(ids);
    r.banner.close(ids); r.activate(n, "a"); await tick();
    assert.equal(n.closes, 1); assert.equal(r.posts.length, 0); assert.equal(r.actions.size, 0);
  }
});

test("native show failures and late failures release tokens and notify the owning seam", async () => {
  for (const failure of ["throw", "event", "late"]) {
    const r = rig(); r.fail(failure); const ids = await r.show();
    if (failure === "late") { assert.ok(ids); r.notices[0].emit("failed"); assert.equal(r.failed.length, 1); }
    else assert.equal(ids, null);
    assert.equal(r.banner.size(), 0); assert.equal(r.actions.size, 0);
    r.activate(r.notices[0], "a"); await tick(); assert.equal(r.posts.length, 0);
  }
});

test("Windows action and local/Cloud Open-only controllers share one global activation callback", async () => {
  const r = rig(); await r.show();
  const opened = [];
  const make = home => notifications.createApprovalNotifications({ Notification: r.Native, platform: "win32", onOpen: () => opened.push(home) });
  const local = make("local"), cloud = make("cloud-b");
  local(payload); cloud(payload);
  r.activate(r.notices[0], "d");
  for (const n of r.notices.slice(1)) r.raw({ type: "click", arguments: launch(n) });
  await tick(); assert.deepEqual(opened, ["local", "cloud-b"]); assert.equal(r.posts.length, 1);
  assert.equal(r.registrations(), 1);
  local.dispose(); cloud.dispose(); r.banner.dispose();
});

test("native seam snapshots Cloud identity, honors privacy, propagates failures and withdraws on settlement", async () => {
  const r = rig(); const failed = [];
  const seam = createBannerApprovals({ banner: r.banner, transportFor: () => r.transport });
  const key = "cloud-a|session|ref|1";
  const prepared = await seam.prepare(payload, { key, epoch: "e1" });
  seam.present(prepared.prepared, { key, previews: true, onFailed: key => failed.push(key) });
  await tick(); assert.equal(r.notices.length, 1);
  assert.equal(r.minted[0].transport, r.transport); assert.equal(r.minted[0].entry.home, "cloud-a");
  r.notices[0].emit("failed"); assert.deepEqual(failed, [key]); assert.equal(seam.size(), 0);
  const next = await seam.prepare(payload, { key, epoch: "e1" });
  seam.present(next.prepared, { key, previews: true }); await tick();
  seam.close(key); assert.equal(r.notices[1].closes, 1); assert.equal(r.actions.size, 0);
});

test("late native failure releases the fallback reservation so the same card can be offered again", async () => {
  const r = rig();
  const base = notifications.createApprovalNotifications({ Notification: r.Native, platform: "win32", revalidate: async p => p, onOpen() {} });
  const seam = createBannerApprovals({ banner: r.banner, base, transportFor: () => r.transport });
  const key = "cloud-a|session|ref|1";
  const first = await seam.prepare(payload, { key, epoch: "e1" });
  seam.present(first.prepared, { key, previews: true }); await tick();
  r.notices[0].emit("failed");
  const next = await seam.prepare(payload, { key: key + "next", epoch: "e1" });
  assert.equal(next.ok, true, "failed native attempt must release the prepared base slot");
  seam.close(key + "next"); seam.dispose(); base.dispose();
});

test("settlement during an action read invalidates the flight and cannot open a stale card", async () => {
  const r = rig(); const ids = await r.show(); let release;
  r.transport.readCard = async (_entry, guard) => { await new Promise(resolve => { release = resolve; }); guard(); return r.record; };
  r.activate(r.notices[0], "a");
  r.banner.close(ids); release(); await tick();
  assert.equal(r.posts.length, 0); assert.equal(r.opened.length, 0);
  assert.equal(r.notices[0].closes, 1); assert.equal(r.actions.size, 0);
});

test("1024 native routes bound retention; a full adapter mints nothing and dispose withdraws every owned toast", async () => {
  const r = rig();
  for (let i = 0; i < 1024; i++) assert.ok(await r.show());
  assert.equal(await r.show(), null);
  assert.equal(r.minted.length, 1024); assert.equal(r.banner.size(), 1024);
  r.banner.dispose();
  assert.equal(r.actions.size, 0); assert.equal(r.banner.size(), 0);
  assert.ok(r.notices.every(n => n.closes === 1));
  r.activate(r.notices[0], "d"); await tick(); assert.equal(r.posts.length, 0);
});

test("a queued failure from a withdrawn banner cannot cancel its replacement reservation", async () => {
  const r = rig(), failures = [], retired = [];
  const base = notifications.createApprovalNotifications({ Notification: r.Native, platform: "win32", revalidate: async p => p, onOpen() {} });
  const banner = { available: () => true, show: async ({ onFailed }) => { failures.push(onFailed); return [`id-${failures.length}`]; }, close() {} };
  const seam = createBannerApprovals({ banner, base, transportFor: () => r.transport });
  const key = "cloud-a|session|ref|1";
  const first = await seam.prepare(payload, { key }); seam.present(first.prepared, { key, previews: true, onFailed: () => retired.push("old") });
  await tick(); seam.close(key);
  const second = await seam.prepare(payload, { key }); seam.present(second.prepared, { key, previews: true, onFailed: () => retired.push("new") });
  await tick(); failures[0]();
  assert.deepEqual(retired, [], "a retired generation cannot retire a current main record");
  assert.equal((await base.prepare(payload, { key: key + "duplicate" })).ok, false, "replacement still owns its reservation");
  seam.close(key); seam.dispose(); base.dispose();
});
