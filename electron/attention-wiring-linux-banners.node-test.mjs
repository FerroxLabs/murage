// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// S4c through the S3R native seam: createAttentionMain -> createBannerApprovals -> createLinuxBanners -> a fake session bus.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createAttentionMain } from "./attention-main.mjs";
import { createLinuxBanners } from "./linux-notify.mjs";
import { createBannerApprovals } from "./native-banner-approvals.mjs";
import { pickNativeBanner } from "./native-banner-pick.mjs";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const ticks = async () => { for (let i = 0; i < 8; i++) await tick(); };

function rig({ capabilities = ["actions"], actionsOn = true, previews = true, outsideOk = true } = {}) {
  const posted = [], closed = [], plain = [], minted = [], opened = [], sends = [];
  let connections = 0, disconnects = 0;
  const iface = new EventEmitter();
  iface.GetCapabilities = async () => capabilities;
  iface.Notify = async (...args) => { posted.push(args); return posted.length; };
  iface.CloseNotification = async id => { closed.push(id); };
  const identities = [];
  const transport = { current: () => { identities.push("id"); return "port|pid"; },
    readCard: async () => ({ open: true, requestId: "r1", digest: "d".repeat(64), ...(outsideOk ? { outsideOk: { "banner-linux": true } } : {}),
      display: { botName: "Ada", title: "Run a command", willRun: "node --check example.mjs" } }) };
  const linux = createLinuxBanners({
    platform: "linux", loadBus: () => {
      connections += 1;
      const bus = new EventEmitter();
      bus.getProxyObject = async () => ({ getInterface: () => iface });
      bus.disconnect = () => { disconnects += 1; };
      return bus;
    },
    mint: spec => { minted.push(spec); return "a".repeat(32); },
    act: async () => ({ ok: true }), open: (route, home) => opened.push({ route, home }),
  });
  const nativeApprovals = createBannerApprovals({ banner: pickNativeBanner({ platform: "linux", mac: null, linux }),
    createNotice: options => { const notice = { options, show() { plain.push(options); }, close() {}, on() {}, removeAllListeners() {} }; return notice; },
    transportFor: () => transport, mint: spec => { minted.push(spec); return "b".repeat(32); }, actionsOn: () => actionsOn });
  const state = notifySurfaceDefaults("new", "linux");
  state.nudgeMinutes = 0;
  const sessions = new Map();
  const owner = home => {
    if (!sessions.has(home)) sessions.set(home, { home, session: `session${sessions.size}`.padEnd(25, "x"), webContentsId: sessions.size + 1, alive: true, ledger: new Set() });
    return sessions.get(home);
  };
  const main = createAttentionMain({ prefs: () => state, presence: { rev: 0, refresh: async () => ({ rev: 0, locked: false }), markConservative() {} },
    nativeApprovals, sendToSession: (home, session, message) => { sends.push([home, message.type, message.ref]); return true; },
    createNotice: options => { const notice = { options, show() { plain.push(options); }, close() {}, on() {}, removeAllListeners() {} }; return notice; },
    transportFor: () => transport, readPreviews: async () => previews, pillAvailable: () => false, now: () => 1000, setTimer: () => ({}), clearTimer() {} });
  const offer = async home => {
    const s = owner(home);
    await main.previewsCheck(home);
    const result = await main.offer(s, { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1", ref: "ref1", session: s.session });
    const record = [...main.records.values()].find(r => r.owner === s && r.ref === "ref1");
    if (record?.state === "SENT") await main.present(s, { session: s.session, ref: record.ref, gen: record.gen, title: "Title", body: "Body", privatePreview: false, silent: false });
    await ticks();
    return result;
  };
  return { main, linux, iface, offer, posted, closed, plain, minted, opened, sends, transport, identities, nativeApprovals,
    connections: () => connections, disconnects: () => disconnects };
}

test("S4c: a Linux approval posts one actionable banner whose action token carries the captured transport and identity", async () => {
  const r = rig();
  assert.equal((await r.offer("local")).decision, "notify");
  assert.equal(r.posted.length, 1, "one banner");
  assert.deepEqual(r.plain, [], "no second plain notice");
  const spec = r.minted.find(row => row.surface === "banner-linux");
  assert.ok(spec, "the banner minted its action token");
  assert.equal(spec.transport, r.transport, "the transport read for the card is the one the token is bound to (the real blocker)");
  assert.equal(spec.identity, "port|pid");
  assert.equal(spec.entry.home, "local");
  assert.match(spec.entry.epoch, /^e\d+$/);
  assert.equal(spec.entry.frame.requestId, "r1");
  assert.match(spec.surfaceId, /^mb:[0-9a-f]{16}$/);
});

test("S4c: a settle withdraws the banner through CloseNotification, once", async () => {
  const r = rig();
  await r.offer("local");
  r.main.settled("local", "t1", "r1");
  r.main.settled("local", "t1", "r1");
  await ticks();
  assert.deepEqual(r.closed, [1]);
  assert.equal(r.disconnects(), 1);
});

test("S4c: with answering off, no actions capability, or previews off the card is a plain main notice, never a banner", async () => {
  for (const options of [{ actionsOn: false }, { capabilities: [] }, { previews: false }, { outsideOk: false }]) {
    const r = rig(options);
    assert.equal((await r.offer("local")).decision, "notify", JSON.stringify(options));
    assert.deepEqual(r.posted, [], JSON.stringify(options));
    assert.equal(r.plain.length, 1, `plain notice ${JSON.stringify(options)}`);
    assert.equal(r.minted.length, 0, "nothing was minted for a plain card");
  }
});

test("S4c: Open callbacks keep the offering home even when routing ids match", async () => {
  const r = rig();
  await r.offer("local"); await r.offer("cloud-one");
  r.iface.emit("ActionInvoked", 2, "default");
  r.iface.emit("ActionInvoked", 1, "open");
  await tick();
  assert.deepEqual(r.opened, ["cloud-one", "local"].map(home => ({ home, route: { botId: "b1", threadId: "t1", messageId: "m1" } })));
  assert.deepEqual(r.closed, [2, 1]);
});

test("S4c: no banner service at all falls back to the plain notice without losing the card", async () => {
  const r = rig();
  r.linux.dispose();
  assert.equal(r.nativeApprovals.handles(), false, "a disposed or absent banner service is not claimed; the S3R plain path runs");
  const result = await r.offer("local");
  assert.equal(result.decision, "notify", "the card is still routed to a notice");
  assert.deepEqual(r.posted, [], "nothing goes to the bus");
  assert.equal(r.minted.length, 0, "no token for a plain notice");
  assert.equal(r.plain.length, 1, "the card is delivered as the plain main notice, not dropped");
  const records = [...r.main.records.values()];
  assert.equal(records.length, 1, "and it is still tracked");
  assert.equal(records[0].state, "SHOWN");
});
