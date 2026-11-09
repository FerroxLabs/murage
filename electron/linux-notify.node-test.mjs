// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createLinuxBanners, SURFACE } from "./linux-notify.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const card = () => ({ display: { botName: "Ada", title: "Run a command", willRun: "private command <detail>" }, outsideOk: { [SURFACE]: true }, digest: "d".repeat(64) });
const target = { botId: "b1", threadId: "t1", messageId: "m1" };

function rig(options = {}) {
  const buses = [], posted = [], closed = [], minted = [], acted = [], opened = [], muted = [], logs = [];
  let attempts = 0;
  const loadBus = () => {
    attempts += 1;
    if (options.loadError) throw new Error(card().display.willRun);
    const bus = new EventEmitter(), iface = new EventEmitter();
    bus.iface = iface;
    bus.capabilityCalls = 0;
    bus.disconnections = 0;
    bus.disconnect = () => { bus.disconnections += 1; };
    bus.getProxyObject = async (name, path) => {
      assert.equal(name, "org.freedesktop.Notifications");
      assert.equal(path, "/org/freedesktop/Notifications");
      if (options.proxyError) throw new Error(card().display.willRun);
      return { getInterface: name => { assert.equal(name, "org.freedesktop.Notifications"); return iface; } };
    };
    iface.GetCapabilities = async () => {
      bus.capabilityCalls += 1;
      if (options.capabilityError) throw new Error(card().display.willRun);
      if (options.capabilityWait) await options.capabilityWait.promise;
      return options.capabilities ?? ["actions", "inline-reply"];
    };
    iface.Notify = async (...args) => {
      posted.push(args);
      if (options.postError) throw new Error(card().display.willRun);
      const id = posted.length;
      if (options.postWait) await options.postWait.promise;
      return id;
    };
    iface.CloseNotification = async id => {
      closed.push(id);
      if (options.closeWait) await options.closeWait.promise;
      if (options.closeError) throw new Error(card().display.willRun);
    };
    buses.push(bus);
    return bus;
  };
  const banners = createLinuxBanners({
    platform: options.platform ?? "linux", loadBus: options.noLoader ? undefined : loadBus,
    language: () => options.language ?? "en",
    mint: spec => { minted.push(spec); if (options.mintError) throw new Error(card().display.willRun); return options.noToken ? null : "a".repeat(32); },
    act: async (...args) => { acted.push(args); if (options.actWait) await options.actWait.promise; if (options.actError) throw new Error(card().display.willRun); return options.actResult ?? { ok: true }; },
    open: route => opened.push(route), mute: route => muted.push(route), log: line => logs.push(line),
  });
  const entry = { home: "local", epoch: "e0", key: "k1", frame: { kind: "approval", ...target, requestId: "r1" } };
  return { banners, buses, posted, closed, minted, acted, opened, muted, logs, attempts: () => attempts,
    show: over => banners.show({ entry, record: card(), actionsOn: true, plain: { title: "Murage", body: "Attention" }, ...over }),
    signal: (name, ...args) => buses.at(-1).iface.emit(name, ...args) };
}

test("availability probes and Open-only fallback never connect or post", async () => {
  const r = rig();
  assert.equal(r.banners.available(), true);
  assert.equal(r.banners.available(), true);
  assert.equal(r.attempts(), 0);
  for (const over of [
    { actionsOn: false }, { actionsOn: 1 }, { record: null },
    { record: { ...card(), outsideOk: undefined } }, { record: { ...card(), outsideOk: { [SURFACE]: false } } },
    { record: { ...card(), outsideOk: { [SURFACE]: "true" } } },
    { record: { ...card(), digest: undefined } }, { record: { ...card(), digest: "" } },
    { record: { ...card(), display: undefined } }, { record: { ...card(), display: {} } },
  ]) assert.equal(await r.show(over), null);
  assert.equal(r.attempts(), 0);
  assert.deepEqual(r.posted, []);
  assert.deepEqual(r.minted, []);
  for (const options of [{ platform: "darwin" }, { platform: "win32" }, { noLoader: true }]) {
    const other = rig(options);
    assert.equal(other.banners.available(), false);
    assert.equal(await other.show(), null);
    assert.equal(other.attempts(), 0);
  }
});

test("capabilities gate posting and inline Reply, once per connection", async () => {
  for (const capabilities of [[], ["inline-reply"], null, "actions"]) {
    const r = rig({ capabilities: capabilities === null ? {} : capabilities });
    assert.equal(await r.show(), null);
    assert.equal(r.posted.length, 0);
    assert.equal(r.minted.length, 0);
    assert.equal(r.buses[0].disconnections, 1);
  }
  const r = rig({ capabilities: ["actions"] });
  await r.show(); await r.show();
  assert.deepEqual(r.posted[0][5], ["allow", "Allow", "deny", "Deny"]);
  assert.equal(r.buses[0].capabilityCalls, 1);
  r.signal("NotificationReplied", 1, "cannot reply here");
  await tick();
  assert.deepEqual(r.acted, []);
  assert.deepEqual(r.opened, [target]);
  r.banners.dispose(); await tick();
});

test("Notify uses the full display, the protocol fields, and a token for its mb id", async () => {
  const r = rig();
  const ids = await r.show({ silent: true });
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^mb:[a-f0-9]{16}$/);
  assert.deepEqual(r.posted[0], ["Murage", 0, "", "Ada: Run a command", card().display.willRun,
    ["allow", "Allow", "deny", "Deny", "reply", "Reply"], { "suppress-sound": { signature: "b", value: true } }, -1]);
  assert.equal(r.minted[0].surface, "banner-linux");
  assert.equal(r.minted[0].surfaceId, ids[0]);
  assert.equal(r.minted[0].digest, card().digest);
  assert.equal(r.minted[0].entry.home, "local");
  await r.show();
  assert.deepEqual(r.posted[1][6], {});
  r.banners.dispose(); await tick();
});

test("one bus serves concurrent posts, closes after the last route, then reopens", async () => {
  const capabilityWait = deferred();
  const r = rig({ capabilityWait });
  const first = r.show(), second = r.show();
  assert.equal(r.attempts(), 1);
  capabilityWait.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(r.buses[0].capabilityCalls, 1);
  assert.equal(r.banners.size(), 2);
  r.banners.close(a); await tick();
  assert.equal(r.buses[0].disconnections, 0);
  r.banners.close(b); await tick();
  assert.equal(r.buses[0].disconnections, 1);
  assert.equal(r.buses[0].iface.listenerCount("ActionInvoked"), 0);
  assert.equal(r.banners.size(), 0);
  await r.show();
  assert.equal(r.attempts(), 2);
  assert.equal(r.buses[1].capabilityCalls, 1);
  r.banners.dispose(); await tick();
});

test("translated button labels leave the protocol action keys unchanged", async () => {
  const r = rig({ language: "de-DE" });
  await r.show();
  assert.deepEqual(r.posted[0][5], ["allow", "Erlauben", "deny", "Ablehnen", "reply", "Antworten"]);
  r.signal("ActionInvoked", 1, "allow"); await tick();
  assert.equal(r.acted[0][1], "allow");
});

test("close on settle withdraws each server id once, waiting before disconnect", async () => {
  const closeWait = deferred();
  const r = rig({ closeWait });
  const a = await r.show(), b = await r.show();
  r.banners.close([...a, ...b, ...a, "mb:unknown"]);
  r.banners.close(a);
  assert.deepEqual(r.closed, [1, 2]);
  assert.equal(r.banners.size(), 0);
  assert.equal(r.buses[0].disconnections, 0);
  r.signal("ActionInvoked", 1, "allow");
  assert.deepEqual(r.acted, []);
  closeWait.resolve(); await tick();
  assert.equal(r.buses[0].disconnections, 1);
});

test("unknown ids are ignored and repeated answers call act only once", async () => {
  const actWait = deferred();
  const r = rig({ actWait });
  const ids = await r.show();
  r.signal("ActionInvoked", 999, "allow");
  r.signal("NotificationReplied", 999, "words");
  assert.deepEqual(r.acted, []);
  r.signal("ActionInvoked", 1, "allow");
  r.signal("ActionInvoked", 1, "deny");
  assert.deepEqual(r.acted, [["a".repeat(32), "allow", undefined]]);
  assert.equal(r.banners.size(), 0);
  assert.equal(r.buses[0].disconnections, 0);
  actWait.resolve(); await tick();
  assert.deepEqual(r.closed, [1]);
  assert.deepEqual(r.opened, []);
  assert.equal(r.buses[0].disconnections, 1);
  r.banners.close(ids);
  assert.deepEqual(r.closed, [1]);
});

test("Deny and inline reply route with the minted token; reply activation waits for text", async () => {
  const r = rig();
  await r.show(); await r.show();
  r.signal("ActionInvoked", 1, "deny");
  r.signal("ActionInvoked", 2, "reply");
  assert.equal(r.acted.length, 1);
  r.signal("NotificationReplied", 2, "later please");
  r.signal("NotificationReplied", 2, "twice");
  await tick();
  assert.deepEqual(r.acted, [["a".repeat(32), "deny", undefined], ["a".repeat(32), "reply", "later please"]]);
  assert.deepEqual(r.closed, [1, 2]);
  assert.equal(r.buses[0].disconnections, 1);
});

test("a refused or throwing act opens the card and withdraws the banner", async () => {
  for (const options of [{ actResult: { ok: false } }, { actError: true }]) {
    const r = rig(options);
    await r.show();
    r.signal("ActionInvoked", 1, "allow"); await tick();
    assert.deepEqual(r.opened, [target]);
    assert.deepEqual(r.closed, [1]);
    assert.equal(r.banners.size(), 0);
    assert.equal(r.buses[0].disconnections, 1);
    assert.ok(!r.logs.join(" ").includes(card().display.willRun));
  }
});

test("default, open and unknown actions open the card; mute uses its callback", async () => {
  for (const action of ["default", "open", "unknown", "mute"]) {
    const r = rig(); await r.show();
    r.signal("ActionInvoked", 1, action); await tick();
    assert.deepEqual(r.acted, []);
    assert.deepEqual(r.opened, action === "mute" ? [] : [target]);
    assert.deepEqual(r.muted, action === "mute" ? [target] : []);
    assert.deepEqual(r.closed, [1]);
    assert.equal(r.buses[0].disconnections, 1);
  }
});

test("NotificationClosed forgets only that route and does not close it again", async () => {
  const r = rig(); const a = await r.show(), b = await r.show();
  r.signal("NotificationClosed", 999, 2);
  assert.equal(r.banners.size(), 2);
  r.signal("NotificationClosed", 1, 2);
  assert.equal(r.banners.size(), 1);
  assert.equal(r.buses[0].disconnections, 0);
  r.signal("ActionInvoked", 1, "allow");
  r.signal("NotificationClosed", 2, 1);
  assert.equal(r.banners.size(), 0);
  assert.equal(r.buses[0].disconnections, 1);
  r.banners.close([...a, ...b]);
  assert.deepEqual(r.closed, []);
  assert.deepEqual(r.acted, []);
});

test("setup, post, mint and close errors are contained without logging display text", async () => {
  for (const option of ["loadError", "proxyError", "capabilityError", "postError", "mintError", "noToken", "closeError"]) {
    const r = rig({ [option]: true });
    const ids = await r.show();
    if (option === "closeError") r.banners.close(ids);
    else assert.equal(ids, null, option);
    await tick();
    assert.equal(r.banners.size(), 0, option);
    if (r.buses[0]) assert.equal(r.buses[0].disconnections, 1, option);
    const output = r.logs.join(" ");
    assert.ok(!output.includes(card().display.willRun), option);
    assert.ok(!output.includes(card().display.title), option);
  }
});

test("bus loss drops routes and the next post can reconnect", async () => {
  const r = rig(); await r.show();
  const old = r.buses[0];
  old.emit("error", new Error(card().display.willRun));
  assert.equal(r.banners.size(), 0);
  old.iface.emit("ActionInvoked", 1, "allow");
  assert.deepEqual(r.acted, []);
  assert.equal(old.disconnections, 1);
  assert.ok(!r.logs.join(" ").includes(card().display.willRun));
  await r.show();
  assert.equal(r.attempts(), 2);
  r.banners.dispose(); await tick();
});

test("dispose withdraws routes once and a pending Notify cannot leave a banner behind", async () => {
  const r = rig(); await r.show(); await r.show();
  r.banners.dispose(); r.banners.dispose(); await tick();
  assert.deepEqual(r.closed, [1, 2]);
  assert.equal(r.buses[0].disconnections, 1);
  assert.equal(r.banners.available(), false);
  assert.equal(await r.show(), null);
  const postWait = deferred();
  const pending = rig({ postWait });
  const show = pending.show(); await tick();
  pending.banners.dispose();
  assert.equal(pending.buses[0].disconnections, 0);
  postWait.resolve();
  assert.equal(await show, null); await tick();
  assert.deepEqual(pending.closed, [1]);
  assert.equal(pending.banners.size(), 0);
  assert.equal(pending.buses[0].disconnections, 1);
});
