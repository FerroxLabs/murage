// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createAttentionMain } from "./attention-main.mjs";
import { createLinuxBanners } from "./linux-notify.mjs";
import { pickNativeBanner } from "./native-banner-pick.mjs";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));

function rig({ capabilities = ["actions"], actionsOn = true } = {}) {
  const posted = [], closed = [], fallback = [], rendererClosed = [], minted = [], opened = [];
  let connections = 0, disconnects = 0;
  const iface = new EventEmitter();
  iface.GetCapabilities = async () => capabilities;
  iface.Notify = async (...args) => { posted.push(args); return posted.length; };
  iface.CloseNotification = async id => { closed.push(id); };
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
  const prefs = notifySurfaceDefaults("new", "linux");
  prefs.notifyActions = actionsOn;
  prefs.nudgeMinutes = 0;
  const main = createAttentionMain({
    prefs: () => prefs, presence: () => ({ locked: false }),
    nativeBanner: pickNativeBanner({ platform: "linux", mac: null, linux }),
    sendShow: (home, ref) => { fallback.push([home, ref]); return true; },
    sendClose: (home, ref) => rendererClosed.push([home, ref]),
    transportFor: () => ({ readCard: async () => ({ open: true, requestId: "r1", digest: "d".repeat(64), outsideOk: { "banner-linux": true },
      display: { botName: "Ada", title: "Run a command", willRun: "node --check example.mjs" } }) }),
    pillAvailable: () => false, now: () => 1000, setTimer: () => { assert.fail("no timer for this fixture"); }, clearTimer() {},
  });
  const offer = home => main.offer(home, { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1", ref: "ref1" });
  return { main, linux, iface, offer, posted, closed, fallback, rendererClosed, minted, opened,
    connections: () => connections, disconnects: () => disconnects };
}

test("the existing attention seam posts through Linux and settles its mb id through CloseNotification", async () => {
  const r = rig();
  assert.equal((await r.offer("local")).decision, "notify");
  assert.equal(r.posted.length, 1);
  assert.deepEqual(r.fallback, []);
  assert.equal(r.minted[0].entry.home, "local");
  assert.match(r.minted[0].surfaceId, /^mb:[0-9a-f]{16}$/);
  r.main.settled("local", "t1", "r1");
  r.main.settled("local", "t1", "r1");
  await tick();
  assert.deepEqual(r.closed, [1]);
  assert.deepEqual(r.rendererClosed, []);
  assert.equal(r.disconnects(), 1);
});

test("Open-only returns to the existing renderer path without creating another banner", async () => {
  for (const options of [{ actionsOn: false }, { capabilities: [] }]) {
    const r = rig(options);
    assert.equal((await r.offer("local")).decision, "notify");
    assert.deepEqual(r.fallback, [["local", "ref1"]]);
    assert.deepEqual(r.posted, []);
    assert.equal(r.connections(), options.actionsOn === false ? 0 : 1);
    r.main.settled("local", "t1", "r1");
    assert.deepEqual(r.rendererClosed, [["local", "ref1"]]);
    assert.deepEqual(r.closed, []);
  }
});

test("Open callbacks retain the offering home even when routing ids match", async () => {
  const r = rig();
  await r.offer("local"); await r.offer("cloud-one");
  r.iface.emit("ActionInvoked", 2, "default");
  r.iface.emit("ActionInvoked", 1, "open");
  await tick();
  assert.deepEqual(r.opened, ["cloud-one", "local"].map(home => ({ home, route: { botId: "b1", threadId: "t1", messageId: "m1" } })));
  assert.deepEqual(r.closed, [2, 1]);
  assert.equal(r.connections(), 1);
  assert.equal(r.disconnects(), 1);
});
