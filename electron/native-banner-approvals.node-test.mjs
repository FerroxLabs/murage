// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createBannerApprovals, MAX_ENTRIES } from "./native-banner-approvals.mjs";
import { createMacBanners } from "./mac-banners.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const input = { title: "Murage", body: "Your attention is needed.", silent: false, botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1" };
const card = { open: true, requestId: "r1", digest: "d".repeat(64), outsideOk: { "banner-mac": true }, display: { botName: "Ada", title: "Run", willRun: "ls" } };

function macRig({ post = async () => true, card: cardResult = card, base = true } = {}) {
  const posts = [], removed = [], minted = [], baseShown = [], failed = [], baseClosed = [];
  const transport = { current: () => "id1", readCard: async () => cardResult };
  const addon = { registerCategories() {}, post: async spec => { posts.push(spec); return post(spec); }, remove: id => removed.push(id), onResponse: () => () => {} };
  const mac = createMacBanners({ platform: "darwin", loadAddon: () => addon, mint: spec => { minted.push(spec); return "t".repeat(32); }, act: async () => ({ ok: true }), open: () => {} });
  const baseApprovals = base ? {
    async prepare(inp, options) { options.onSlot?.({ cancel() {} }); return { ok: true, prepared: { words: { title: "Server", body: "Review" } } }; },
    present(prepared, options) { baseShown.push([prepared.words, options.key]); return { accepted: true, handle: `n:${options.key}` }; },
    close(key) { baseClosed.push(key); return true; }, setOnEvict() {},
  } : null;
  const native = createBannerApprovals({ banner: mac, base: baseApprovals, transportFor: () => transport, mint: spec => { minted.push(spec); return "m".repeat(32); }, actionsOn: () => true });
  return { native, posts, removed, minted, baseShown, failed, baseClosed, transport };
}
const options = (r, extra = {}) => ({ key: "local|s|ref1|1", epoch: "e0", previews: true, onFailed: key => r.failed.push(key), onClick() {}, canShow: async () => true, ...extra });

test("Astra r1 #1: a transport identity that changes during the card read voids the card; the read itself is guarded", async () => {
  let identity = "id1", guardThrew = false;
  const r = macRig();
  r.transport.current = () => identity;
  r.transport.readCard = async (_entry, guard) => { identity = "id2"; try { guard(); } catch { guardThrew = true; throw new Error("stopped"); } return card; };
  const prepared = (await r.native.prepare(input, options(r))).prepared;
  assert.equal(guardThrew, true, "the guard handed to readCard compares the live identity with the captured one");
  assert.equal(prepared.card, null);
  r.native.present(prepared, options(r));
  await tick();
  assert.equal(r.posts[0].category, null, "no buttons on a card read under another identity");
  assert.equal(r.minted.length, 0);
  const swapped = macRig();
  swapped.transport.readCard = async () => { identity = "id3"; return card; }; // an unguarded read that still returns after the identity moved
  identity = "id1"; swapped.transport.current = () => identity;
  const p2 = (await swapped.native.prepare(input, options(swapped))).prepared;
  assert.equal(p2.card, null, "a card returned after the identity moved is discarded even when the read did not notice");
  const noIdentity = macRig();
  noIdentity.transport.current = () => { throw new Error("gone"); };
  assert.equal((await noIdentity.native.prepare(input, options(noIdentity))).prepared.card, null, "a transport that cannot name its identity binds nothing");
});

test("Astra r1 #2: the banner service is told when the card is settled, so it can stop before it mints or posts", async () => {
  let probe = null, release;
  const gated = createBannerApprovals({ banner: { available: () => true, show: spec => { probe = spec.cancelled; return new Promise(resolve => { release = resolve; }); }, close() {} }, createNotice: null, transportFor: () => null, mint: () => null });
  const prepared = (await gated.prepare(input, { key: "local|s|ref3|1", onSlot() {} })).prepared;
  gated.present(prepared, { key: "local|s|ref3|1", onFailed() {}, canShow: async () => true });
  await tick();
  assert.equal(typeof probe, "function", "show receives a cancelled() probe");
  assert.equal(probe(), false, "false while the card is live");
  assert.equal(gated.close("local|s|ref3|1"), true);
  assert.equal(probe(), true, "true once the card settled, even though the post is still pending");
  release(null);
  await tick();
  assert.equal(gated.size(), 0);
});

test("Astra r1 #3: after an asynchronous refusal the fallback notice needs a fresh clear presence read, else the card goes to the counts", async () => {
  const quiet = macRig({ post: async () => false });
  const p1 = (await quiet.native.prepare(input, options(quiet))).prepared;
  quiet.native.present(p1, options(quiet, { canShow: async () => false }));
  await tick();
  assert.equal(quiet.baseShown.length, 0, "sharing, a lock or Focus began since the commit: nothing is shown");
  assert.deepEqual(quiet.failed, ["local|s|ref1|1"], "the card is retired to the counts, once");
  assert.equal(quiet.native.size(), 0);
  const throwing = macRig({ post: async () => false });
  const p2 = (await throwing.native.prepare(input, options(throwing))).prepared;
  throwing.native.present(p2, options(throwing, { canShow: async () => { throw new Error("read failed"); } }));
  await tick();
  assert.equal(throwing.baseShown.length, 0, "a failed presence read is never a yes");
  assert.deepEqual(throwing.failed, ["local|s|ref1|1"]);
  const missing = macRig({ post: async () => false });
  const p3 = (await missing.native.prepare(input, options(missing))).prepared;
  const noProbe = options(missing); delete noProbe.canShow;
  missing.native.present(p3, noProbe);
  await tick();
  assert.equal(missing.baseShown.length, 0, "without a presence probe the fallback fails closed");
  const moved = macRig({ post: async () => false });
  const p5 = (await moved.native.prepare(input, options(moved))).prepared;
  moved.native.present(p5, options(moved, { stillClear: () => false }));
  await tick();
  assert.equal(moved.baseShown.length, 0, "evidence that landed between the read and the show stops it");
  assert.deepEqual(moved.failed, ["local|s|ref1|1"]);
  const clear = macRig({ post: async () => false });
  const p4 = (await clear.native.prepare(input, options(clear))).prepared;
  clear.native.present(p4, options(clear));
  await tick();
  assert.equal(clear.baseShown.length, 1, "a clear read shows the fallback");
});

test("Astra r1 #4: every failure path frees its entry, the map is bounded, and onFailed fires once", async () => {
  // the notice reports failed after it was shown
  const listeners = [];
  const shown = { show() {}, close() {}, on(name, fn) { listeners.push([name, fn]); }, removeAllListeners() {} };
  const failed = [];
  // the Mac notifier path whose present is refused synchronously
  const refusing = createBannerApprovals({ banner: null, base: { prepare: async () => ({ ok: true, prepared: { words: { title: "t", body: "b" } } }), present: () => ({ accepted: false }), close: () => false }, transportFor: () => null, mint: () => null });
  const pr = (await refusing.prepare(input, { key: "local|s|a|1", onSlot() {} })).prepared;
  refusing.present(pr, { key: "local|s|a|1", onFailed: key => failed.push(key) });
  assert.equal(refusing.size(), 0, "a synchronously refused base notice leaves no entry");
  assert.deepEqual(failed, ["local|s|a|1"]);
  // createNotice throws
  const throwingNotice = createBannerApprovals({ banner: { available: () => true, show: async () => null, close() {} }, createNotice: () => { throw new Error("no notice"); }, transportFor: () => null, mint: () => null });
  const pt = (await throwingNotice.prepare(input, { key: "local|s|b|1", onSlot() {} })).prepared;
  throwingNotice.present(pt, { key: "local|s|b|1", onFailed: key => failed.push(key), canShow: async () => true });
  await tick();
  assert.equal(throwingNotice.size(), 0, "a notice that cannot be built leaves no entry");
  assert.deepEqual(failed, ["local|s|a|1", "local|s|b|1"]);
  // the shown notice fails later: once only
  const late = createBannerApprovals({ banner: null, base: null, createNotice: () => shown, transportFor: () => null, mint: () => null });
  const pl = (await late.prepare(input, { key: "local|s|c|1", onSlot() {} })).prepared;
  late.present(pl, { key: "local|s|c|1", onFailed: key => failed.push(key) });
  const onFailedEvent = listeners.filter(([name]) => name === "failed").at(-1)[1];
  onFailedEvent(); onFailedEvent();
  assert.equal(late.size(), 0);
  assert.deepEqual(failed.slice(2), ["local|s|c|1"], "the card is handed back once");
  // the bound
  const bounded = createBannerApprovals({ banner: null, base: null, createNotice: () => ({ show() {}, close() {}, on() {}, removeAllListeners() {} }), transportFor: () => null, mint: () => null });
  let accepted = 0;
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    const key = `local|s|n${i}|1`;
    const prepared = (await bounded.prepare(input, { key, onSlot() {} })).prepared;
    if (bounded.present(prepared, { key, onFailed() {} }).accepted) accepted += 1;
  }
  assert.equal(accepted, MAX_ENTRIES);
  assert.equal(bounded.size(), MAX_ENTRIES, "banner entries never outgrow the router's tracked-card bound");
});

test("Mac: the banner carries buttons, and the minted token is bound to the transport and identity read with the card", async () => {
  const r = macRig();
  const prepared = (await r.native.prepare(input, options(r))).prepared;
  const result = r.native.present(prepared, options(r));
  assert.deepEqual(result, { accepted: true, handle: "n:local|s|ref1|1" }, "present is synchronous and accepted at the commit point");
  await tick();
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].category, "murage.approval");
  assert.equal(r.minted[0].transport, r.transport);
  assert.equal(r.minted[0].identity, "id1");
  assert.equal(r.minted[0].entry.epoch, "e0");
  assert.deepEqual(r.baseShown, [], "the Electron notice is not also shown");
});

test("Mac: previews off means no card content and no buttons; the banner is Open-only with the plain words", async () => {
  const r = macRig();
  const prepared = (await r.native.prepare(input, options(r, { previews: false }))).prepared;
  r.native.present(prepared, options(r, { previews: false }));
  await tick();
  assert.equal(r.posts[0].category, null);
  assert.equal(r.posts[0].title, "Server");
  assert.equal(r.minted.length, 0);
});

test("Mac: an OS refusal falls back to the existing notice, and a close racing the post withdraws the late banner", async () => {
  const refused = macRig({ post: async () => false });
  const p1 = (await refused.native.prepare(input, options(refused))).prepared;
  refused.native.present(p1, options(refused));
  await tick();
  assert.equal(refused.baseShown.length, 1, "the existing notifier shows it instead");
  assert.deepEqual(refused.failed, []);

  let release;
  const slow = macRig({ post: () => new Promise(resolve => { release = resolve; }) });
  const p2 = (await slow.native.prepare(input, options(slow))).prepared;
  slow.native.present(p2, options(slow));
  await tick();
  assert.equal(slow.native.close("local|s|ref1|1"), true);
  release(true);
  await tick();
  assert.equal(slow.removed.length, 1, "the banner that arrived after the settle is withdrawn at once");
  assert.equal(slow.baseShown.length, 0);
});

test("Mac: a card that is not the named one carries no buttons (mismatched request id)", async () => {
  const r = macRig({ card: { ...card, requestId: "other" } });
  const prepared = (await r.native.prepare(input, options(r))).prepared;
  r.native.present(prepared, options(r));
  await tick();
  assert.equal(r.posts[0].category, null);
  assert.equal(r.minted.length, 0);
});

test("without a banner service and without a base the seam declines the home; a refused post with nothing to fall back to retires the card", async () => {
  const none = createBannerApprovals({ banner: null, base: null, transportFor: () => null, mint: () => null });
  assert.equal(none.handles("local"), false);
  const failed = [];
  const native = createBannerApprovals({ banner: { available: () => true, show: async () => null, close() {} }, createNotice: null, transportFor: () => null, mint: () => null });
  const prepared = (await native.prepare(input, { key: "local|s|ref2|1", onSlot() {} })).prepared;
  native.present(prepared, { key: "local|s|ref2|1", onFailed: key => failed.push(key) });
  await tick();
  assert.deepEqual(failed, ["local|s|ref2|1"]);
});
