// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY, SURFACE, createMacBanners, macActionReadiness } from "./mac-banners.mjs";

const READY = { authorization: 2, alert: 2, previews: 0, category: true, failed: false };
const BOUND = { approvalId: "ap-1", requestRef: "ref-1", actionHash: "h".repeat(64) };
function rig({ platform = "darwin", addon, record, actionsOn = true, actResult = { ok: true }, mintFails = false, readiness = async () => READY, readinessTimeoutMs } = {}) {
  const posted = [], removed = [], opened = [], acted = [], muted = [], minted = [], logged = [];
  let respond = null, registrations = 0, unsubscribed = 0;
  const fake = addon === null ? null : addon ?? {
    ...(readiness ? { readiness } : {}),
    registerCategories: () => { registrations += 1; },
    post: async payload => { posted.push(payload); return true; },
    remove: id => removed.push(id),
    onResponse: cb => { respond = cb; return () => { unsubscribed += 1; }; },
  };
  const banners = createMacBanners({
    platform, loadAddon: () => { if (!fake) throw new Error("no addon"); return fake; },
    mint: spec => { if (mintFails) throw new Error("mint"); minted.push(spec); return "a".repeat(32); },
    act: async (token, action, text) => { acted.push([token, action, text]); return actResult; },
    open: route => opened.push(route), mute: route => muted.push(route), log: line => logged.push(line), ...(readinessTimeoutMs !== undefined ? { readinessTimeoutMs } : {}),
  });
  const entry = { home: "local", key: "k1", frame: { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1" } };
  const card = record === undefined ? { display: { botName: "Ada", title: "Run a command", willRun: "npm test" }, outsideOk: { [SURFACE]: true }, digest: "d".repeat(64), ...BOUND } : record;
  const plain = { title: "Murage", body: "Your attention is needed." };
  const show = (over = {}) => banners.show({ entry, record: card, actionsOn, plain, ...over });
  return { banners, show, posted, removed, opened, acted, muted, minted, logged, respond: (...args) => respond(...args), registrations: () => registrations, unsubscribed: () => unsubscribed, entry };
}

test("Astra r1 #2: a card that settled before the banner began mints and posts nothing", async () => {
  const r = rig();
  assert.equal(await r.show({ cancelled: () => true }), null);
  assert.deepEqual(r.minted, []);
  assert.deepEqual(r.posted, []);
  assert.equal(r.registrations(), 0, "the notification service is not even touched");
});

test("no addon, or not a Mac: nothing is shown here and the caller keeps today's path", async () => {
  const none = rig({ addon: null });
  assert.equal(none.banners.available(), false);
  assert.equal(await none.show(), null);
  const linux = rig({ platform: "linux" });
  assert.equal(linux.banners.available(), false);
  assert.equal(await linux.show(), null);
  assert.deepEqual(linux.posted, []);
  const partial = rig({ addon: { post: async () => true, remove() {}, onResponse: () => () => {} } });
  assert.equal(partial.banners.available(), false, "all four functions are required");
});

test("categories register once, and a banner with full detail carries the category and one minted token", async () => {
  const r = rig();
  const ids = await r.show();
  await r.show();
  assert.equal(r.registrations(), 1);
  assert.equal(ids.length, 1);
  assert.equal(r.posted[0].category, CATEGORY);
  assert.equal(r.posted[0].title, "Ada: Run a command");
  assert.equal(r.posted[0].body, "npm test", "the full executable detail, never a one-line summary");
  assert.equal(r.minted.length, 2, "one token per banner");
  assert.deepEqual({ surface: r.minted[0].surface, digest: r.minted[0].digest, surfaceId: ids[0] === r.minted[0].surfaceId ? ids[0] : null }, { surface: SURFACE, digest: "d".repeat(64), surfaceId: ids[0] });
});

test("Open only when buttons are off, previews hide the detail, the card is not outsideOk, or the token cannot be minted", async () => {
  for (const [label, over] of [["buttons off", { actionsOn: false }], ["not outsideOk", { record: { display: { botName: "Ada", title: "T", willRun: "x" }, outsideOk: { [SURFACE]: false }, digest: "d".repeat(64) } }],
    ["no digest", { record: { display: { botName: "Ada", title: "T", willRun: "x" }, outsideOk: { [SURFACE]: true } } }], ["previews off", { record: { outsideOk: { [SURFACE]: false } } }], ["mint fails", { mintFails: true }]]) {
    const r = rig(over.mintFails ? { mintFails: true } : { record: over.record, actionsOn: over.actionsOn });
    await r.show();
    assert.equal(r.posted[0].category, null, label);
    assert.ok(!r.posted[0].body.includes("npm test"), `${label}: the command is not on an Open-only banner`);
  }
  const hidden = rig({ record: { outsideOk: {} } });
  await hidden.show();
  assert.deepEqual([hidden.posted[0].title, hidden.posted[0].body], ["Murage", "Your attention is needed."], "the allowlisted words");
  const nothing = rig({ record: null });
  await nothing.show();
  assert.equal(nothing.posted[0].category, null);
});

test("responses route to act with the minted token; a failed answer opens the card and withdraws the banner", async () => {
  const r = rig();
  const [id] = await r.show();
  r.respond(id, "allow");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(r.acted, [["a".repeat(32), "allow", undefined]]);
  r.respond(id, "deny");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.acted.length, 1, "a banner answers once: the route is spent");
  const reply = rig();
  const [rid] = await reply.show();
  reply.respond(rid, "reply", "do it later");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reply.acted, [["a".repeat(32), "reply", "do it later"]]);
  const refused = rig({ actResult: { ok: false, reason: "locked" } });
  const [fid] = await refused.show();
  refused.respond(fid, "allow");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refused.opened, [{ botId: "b1", threadId: "t1", messageId: "m1" }]);
  assert.deepEqual(refused.removed, [fid]);
});

test("open, default click and mute route correctly; an unknown banner or action does nothing harmful", async () => {
  const r = rig();
  const [id] = await r.show();
  r.respond("mb:unknown", "allow");
  r.respond(id, "mute");
  assert.deepEqual(r.muted, [{ botId: "b1", threadId: "t1", messageId: "m1" }]);
  r.respond(id, "weird");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.acted.length, 0, "an unknown action is an open, never an answer");
  assert.equal(r.opened.length, 1);
  const [id2] = await r.show();
  r.respond(id2, "open");
  assert.equal(r.opened.length, 2);
  const openOnly = rig({ actionsOn: false });
  const [oid] = await openOnly.show();
  openOnly.respond(oid, "allow");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(openOnly.acted, [], "an action on an Open-only banner is an open, never an answer");
  assert.equal(openOnly.opened.length, 1);
});

test("close withdraws every banner and forgets routes; the OS refusing a post shows nothing; routes are bounded", async () => {
  const r = rig();
  const [a] = await r.show(), [b] = await r.show();
  r.banners.close([a, b]);
  assert.deepEqual(r.removed, [a, b]);
  assert.equal(r.banners.size(), 0);
  r.respond(a, "allow");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(r.acted, [], "a withdrawn banner answers nothing");
  const refused = rig({ addon: { registerCategories() {}, post: async () => false, remove() {}, onResponse: () => () => {} } });
  assert.equal(await refused.show(), null);
  assert.equal(refused.banners.size(), 0);
  const throwing = rig({ addon: { registerCategories() {}, post: async () => { throw new Error("os"); }, remove() {}, onResponse: () => () => {} } });
  assert.equal(await throwing.show(), null);
  const many = rig();
  for (let i = 0; i < 1030; i += 1) await many.show();
  assert.equal(many.banners.size(), 1024);
  many.banners.dispose();
  assert.equal(many.banners.size(), 0);
  assert.equal(many.unsubscribed(), 1);
});

// Banner-actions design, section 5 (Mac): fail closed to Open only.
const openOnly = (r, label) => {
  assert.equal(r.posted.length, 1, `${label}: the banner is still shown`);
  assert.equal(r.posted[0].category, null, `${label}: no buttons`);
  assert.ok(!r.posted[0].body.includes("npm test"), `${label}: the command is not on an Open-only banner`);
  assert.deepEqual(r.minted, [], `${label}: no action token exists`);
};

test("fail closed: notifications not authorised, previews set to never, or the action category missing give an Open-only banner", async () => {
  for (const [label, state, reason] of [
    ["denied", { ...READY, authorization: 1 }, "unauthorised"], ["not determined", { ...READY, authorization: 0 }, "unauthorised"],
    ["provisional", { ...READY, authorization: 3 }, "unauthorised"], ["alerts off", { ...READY, alert: 1 }, "unauthorised"],
    ["previews never", { ...READY, previews: 2 }, "previews"], ["previews unknown", { ...READY, previews: 3 }, "previews"], ["previews missing", { ...READY, previews: undefined }, "previews"],
    ["category missing", { ...READY, category: false }, "category"], ["category not a boolean", { ...READY, category: 1 }, "category"],
    ["read failed", { ...READY, failed: true }, "unavailable"], ["failed missing", { ...READY, failed: undefined }, "unavailable"], ["null", null, "unavailable"], ["a string", "ready", "unavailable"],
  ]) {
    assert.deepEqual(macActionReadiness(state), { ok: false, reason }, label);
    const r = rig({ readiness: async () => state });
    await r.show();
    openOnly(r, label);
    assert.deepEqual(r.logged, [`mac-banners: open only (${reason})`], `${label}: the reason is logged, never the card`);
  }
  assert.deepEqual(macActionReadiness(READY), { ok: true });
  assert.deepEqual(macActionReadiness({ ...READY, previews: 1 }), { ok: true }, "previews when unlocked still show the detail to an unlocked owner");
});

test("fail closed: an addon with no readiness read, one that throws, rejects or never answers gives an Open-only banner", async () => {
  const absent = rig({ readiness: null });
  assert.equal(absent.banners.available(), true, "the banner service itself still works");
  await absent.show();
  openOnly(absent, "no readiness export");
  const throws = rig({ readiness: () => { throw new Error("boom"); } });
  await throws.show();
  openOnly(throws, "throws");
  const rejects = rig({ readiness: async () => { throw new Error("boom"); } });
  await rejects.show();
  openOnly(rejects, "rejects");
  const hangs = rig({ readiness: () => new Promise(() => {}), readinessTimeoutMs: 20 });
  await hangs.show();
  openOnly(hangs, "never answers");
});

test("the readiness read is made per banner, only for a card that could carry buttons, and a card that settles during it shows nothing", async () => {
  let reads = 0, state = READY;
  const r = rig({ readiness: async () => { reads += 1; return state; } });
  await r.show();
  assert.equal(r.posted[0].category, CATEGORY);
  state = { ...READY, previews: 2 };
  await r.show();
  assert.equal(r.posted[1].category, null, "a change in System Settings applies to the next banner");
  assert.equal(reads, 2);
  await r.show({ actionsOn: false });
  assert.equal(reads, 2, "an Open-only banner needs no read");
  let settled = false;
  const racing = rig({ readiness: async () => { settled = true; return READY; } });
  assert.equal(await racing.show({ cancelled: () => settled }), null);
  assert.deepEqual([racing.minted, racing.posted], [[], []]);
});

test("fail closed: a card record that does not name its registered approval carries no buttons", async () => {
  const base = { display: { botName: "Ada", title: "Run a command", willRun: "npm test" }, outsideOk: { [SURFACE]: true }, digest: "d".repeat(64) };
  for (const field of ["approvalId", "requestRef", "actionHash"]) {
    for (const bad of [undefined, "", 7]) {
      const r = rig({ record: { ...base, ...BOUND, [field]: bad } });
      await r.show();
      openOnly(r, `${field}=${String(bad)}`);
    }
  }
});

test("an answer re-reads the OS first: a banner posted while ready answers nothing once previews, authorization or the category changed", async () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 40));
  const changes = [
    ["previews never", { ...READY, previews: 2 }], ["notifications off", { ...READY, authorization: 1 }], ["alerts off", { ...READY, alert: 1 }],
    ["category gone", { ...READY, category: false }], ["read failed", { authorization: -1, alert: -1, previews: -1, category: false, failed: true }],
  ];
  for (const [what, later] of changes) {
    for (const action of ["allow", "deny", "reply"]) {
      let state = READY, reads = 0;
      const r = rig({ readiness: async () => { reads += 1; return state; } });
      const [id] = await r.show();
      assert.equal(r.posted[0].category, CATEGORY, `${what}: posted with buttons while ready`);
      state = later;
      r.respond(id, action, action === "reply" ? "later" : undefined);
      await settle();
      assert.equal(reads, 2, `${what} ${action}: the click reads the OS again`);
      assert.deepEqual(r.acted, [], `${what} ${action}: nothing is answered`);
      assert.deepEqual(r.opened, [{ botId: "b1", threadId: "t1", messageId: "m1" }], `${what} ${action}: the card opens instead`);
      assert.deepEqual(r.removed, [id], `${what} ${action}: the banner is withdrawn`);
      r.respond(id, action);
      await settle();
      assert.deepEqual([r.acted.length, r.opened.length], [0, 1], `${what} ${action}: the route is spent`);
    }
  }
  for (const [what, readiness] of [["throws", () => { throw new Error("boom"); }], ["never answers", () => new Promise(() => {})]]) {
    let first = true;
    const r = rig({ readiness: () => { if (first) { first = false; return READY; } return readiness(); }, readinessTimeoutMs: 20 });
    const [id] = await r.show();
    r.respond(id, "allow");
    await settle();
    assert.deepEqual([r.acted, r.removed], [[], [id]], `${what} at the click: nothing is answered`);
  }
  const still = rig();
  const [sid] = await still.show();
  still.respond(sid, "allow");
  await settle();
  assert.deepEqual(still.acted, [["a".repeat(32), "allow", undefined]], "still ready: the answer goes through");
});
