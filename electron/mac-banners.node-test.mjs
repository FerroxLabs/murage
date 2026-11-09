// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY, SURFACE, createMacBanners } from "./mac-banners.mjs";

function rig({ platform = "darwin", addon, record, actionsOn = true, actResult = { ok: true }, mintFails = false } = {}) {
  const posted = [], removed = [], opened = [], acted = [], muted = [], minted = [];
  let respond = null, registrations = 0, unsubscribed = 0;
  const fake = addon === null ? null : addon ?? {
    registerCategories: () => { registrations += 1; },
    post: async payload => { posted.push(payload); return true; },
    remove: id => removed.push(id),
    onResponse: cb => { respond = cb; return () => { unsubscribed += 1; }; },
  };
  const banners = createMacBanners({
    platform, loadAddon: () => { if (!fake) throw new Error("no addon"); return fake; },
    mint: spec => { if (mintFails) throw new Error("mint"); minted.push(spec); return "a".repeat(32); },
    act: async (token, action, text) => { acted.push([token, action, text]); return actResult; },
    open: route => opened.push(route), mute: route => muted.push(route),
  });
  const entry = { home: "local", key: "k1", frame: { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1" } };
  const card = record === undefined ? { display: { botName: "Ada", title: "Run a command", willRun: "npm test" }, outsideOk: { [SURFACE]: true }, digest: "d".repeat(64) } : record;
  const plain = { title: "Murage", body: "Your attention is needed." };
  const show = (over = {}) => banners.show({ entry, record: card, actionsOn, plain, ...over });
  return { banners, show, posted, removed, opened, acted, muted, minted, respond: (...args) => respond(...args), registrations: () => registrations, unsubscribed: () => unsubscribed, entry };
}

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
