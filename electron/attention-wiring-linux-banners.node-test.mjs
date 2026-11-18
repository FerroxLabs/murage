// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// S4c through the S3R native seam: createAttentionMain -> createBannerApprovals -> createLinuxBanners -> a fake session bus.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createAttentionMain } from "./attention-main.mjs";
import { createLinuxBanners } from "./linux-notify.mjs";
import { createBannerApprovals, bannerActionsOn } from "./native-banner-approvals.mjs";
import { pickNativeBanner } from "./native-banner-pick.mjs";
import { createNotifySurfaces, NOTIFY_SURFACES_FILE } from "./notify-surfaces.mjs";
import { normalizeNotifySurfaces, notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const ticks = async () => { for (let i = 0; i < 8; i++) await tick(); };

function rig({ capabilities = ["actions", "body"], actionsOn = true, previews = true, outsideOk = true, notify = true, choice = null, store = null } = {}) {
  const posted = [], closed = [], plain = [], minted = [], opened = [], sends = [];
  let connections = 0, disconnects = 0;
  const iface = new EventEmitter();
  iface.GetCapabilities = async () => capabilities;
  iface.GetServerInformation = async () => ["gnome-shell", "GNOME", "46.0", "1.2"];
  iface.Notify = async (...args) => { posted.push(args); return posted.length; };
  iface.CloseNotification = async id => { closed.push(id); };
  const identities = [];
  const transport = { current: () => { identities.push("id"); return "port|pid"; },
    readCard: async () => ({ open: true, requestId: "r1", digest: "d".repeat(64), approvalId: "ap-1", requestRef: "ref-1", actionHash: "c".repeat(64), ...(outsideOk ? { outsideOk: { "banner-linux": true } } : {}),
      display: { botName: "Ada", title: "Run a command", willRun: "node --check example.mjs" } }) };
  const linux = createLinuxBanners({
    platform: "linux", loadBus: () => {
      connections += 1;
      const bus = new EventEmitter();
      const names = new EventEmitter();
      names.GetNameOwner = async () => ":1.42";
      bus.getProxyObject = async name => ({ getInterface: () => name === "org.freedesktop.DBus" ? names : iface });
      bus.disconnect = () => { disconnects += 1; };
      return bus;
    },
    mint: spec => { minted.push(spec); return "a".repeat(32); },
    act: async () => ({ ok: true }), open: (route, home) => opened.push({ route, home }),
  });
  const nativeApprovals = createBannerApprovals({ banner: pickNativeBanner({ platform: "linux", mac: null, linux }),
    createNotice: options => { const notice = { options, show() { plain.push(options); }, close() {}, on() {}, removeAllListeners() {} }; return notice; },
    transportFor: () => transport, mint: spec => { minted.push(spec); return "b".repeat(32); }, actionsOn: () => store ? bannerActionsOn(store.get()) : choice ? bannerActionsOn(state) : actionsOn });
  // `store` is main's own owner of notify-surfaces.json: both reads below are the ones electron/main.mjs makes (prefs and actionsOn).
  // `choice` is the owner's saved notify-surfaces state: main's own gate (bannerActionsOn) then decides the buttons, as in electron/main.mjs.
  const state = choice ?? notifySurfaceDefaults("new", "linux");
  state.nudgeMinutes = 0;
  if (!choice) state.surfaces.notify = notify;
  const sessions = new Map();
  const owner = home => {
    if (!sessions.has(home)) sessions.set(home, { home, session: `session${sessions.size}`.padEnd(25, "x"), webContentsId: sessions.size + 1, alive: true, ledger: new Set() });
    return sessions.get(home);
  };
  const main = createAttentionMain({ prefs: () => store ? store.get() : state, presence: { rev: 0, refresh: async () => ({ rev: 0, locked: false }), markConservative() {} },
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
  assert.deepEqual([spec.entry.frame.approvalId, spec.entry.frame.requestRef, spec.entry.frame.actionHash], ["ap-1", "ref-1", "c".repeat(64)],
    "the token is bound to the card the server named in its read, not to anything the window sent");
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

test("owner's choice: with the native notification surface switched off, nothing reaches the session bus", async () => {
  const r = rig({ notify: false });
  const result = await r.offer("local");
  assert.notEqual(result.decision, "notify", "the notification rung is not chosen for an owner who turned it off");
  assert.deepEqual(r.posted, [], "no banner");
  assert.deepEqual(r.plain, [], "and no plain notice either");
  assert.equal(r.minted.length, 0, "no answer token exists for a surface the owner switched off");
  assert.equal(r.connections(), 0, "the bus is never opened");
});

test("owner's choice: answering from notifications switched off keeps the notice but never the buttons", async () => {
  const r = rig({ actionsOn: false });
  await r.offer("local");
  assert.deepEqual(r.posted, []);
  assert.equal(r.plain.length, 1);
  assert.equal(r.connections(), 0, "an Open-only notice needs no session bus connection");
});

// Reviewer High (owner's choice), Linux side: what the owner chose and saved decides the banner, read through main's own gate.
const saved = (origin, change = () => {}) => {
  const state = notifySurfaceDefaults(origin, "linux");
  change(state);
  // through the settings file's own shape: written as JSON, read back and normalised
  return normalizeNotifySurfaces(JSON.parse(JSON.stringify(state)), "linux");
};

test("owner's choice: a new Linux install answers from the notification by default; an upgrade keeps yesterday's plain notice", async () => {
  const fresh = rig({ choice: saved("new") });
  await fresh.offer("local");
  assert.equal(fresh.posted.length, 1, "new install: native notification on, answering on");
  assert.ok(fresh.posted[0][5].includes("allow") && fresh.posted[0][5].includes("deny") && fresh.posted[0][5].includes("open"));
  assert.deepEqual(fresh.plain, []);
  const upgraded = rig({ choice: saved("upgrade") });
  await upgraded.offer("local");
  assert.deepEqual(upgraded.posted, [], "an upgrade never gains buttons the owner did not choose");
  assert.equal(upgraded.plain.length, 1);
  assert.equal(upgraded.connections(), 0);
});

test("owner's choice: the saved switches decide, in every combination, and survive the settings round trip", async () => {
  for (const [notify, answers, banner, notice] of [[true, true, 1, 0], [true, false, 0, 1], [false, true, 0, 0], [false, false, 0, 0]]) {
    const r = rig({ choice: saved("new", state => { state.surfaces.notify = notify; state.notifyActions = answers; }) });
    await r.offer("local");
    const label = `notify=${notify} answers=${answers}`;
    assert.equal(r.posted.length, banner, `banner ${label}`);
    assert.equal(r.plain.length, notice, `plain notice ${label}`);
    assert.equal(r.minted.length, banner, `answer token ${label}`);
    assert.equal(r.connections(), banner, `session bus ${label}`);
  }
  // An upgraded owner who then switches answering on in Settings gets the buttons.
  const optedIn = rig({ choice: saved("upgrade", state => { state.notifyActions = true; }) });
  await optedIn.offer("local");
  assert.equal(optedIn.posted.length, 1);
});

test("owner's choice: a state that is not a clear yes never shows buttons", async () => {
  for (const damage of [state => { state.notifyActions = "true"; }, state => { state.notifyActions = 1; }, state => { delete state.notifyActions; }]) {
    const state = notifySurfaceDefaults("new", "linux");
    damage(state);
    const r = rig({ choice: state });
    await r.offer("local");
    assert.deepEqual(r.posted, []);
    assert.equal(r.plain.length, 1, "the card is still delivered, Open only");
    assert.equal(r.minted.length, 0);
  }
});

// Reviewer High H3, the Linux part (MAIN 2026-11-17T13:01Z): each owner switch, as it is saved in the Settings file on disk, decides
// the Linux banner. The file is written by the same set() the Settings page calls and read back by a fresh owner, as after a restart.
// First-run choice, the Settings page itself and the other surfaces: fix/1019-nfy-chooser (owner o1019-nfy-chooser).
function profile(t, origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (origin === "upgrade") fs.writeFileSync(path.join(dir, "messages.db"), ""); // a profile that was used before this release
  const settings = createNotifySurfaces({ profileDir: dir, platform: "linux" });
  assert.equal(settings.get().origin, origin);
  settings.set("nudgeMinutes", 0);
  // Both origins start these witnesses with both switches on, so each one shows exactly one switch going off.
  settings.set("surfaces.notify", true); settings.set("notifyActions", true);
  return { dir, settings, onDisk: () => JSON.parse(fs.readFileSync(path.join(dir, NOTIFY_SURFACES_FILE), "utf8")),
    restarted: () => createNotifySurfaces({ profileDir: dir, platform: "linux" }) };
}
const buttons = r => r.posted.map(args => args[5].filter((_, index) => index % 2 === 0));

for (const origin of ["new", "upgrade"]) {
  test(`Settings file (${origin} install): with both switches saved on, the Linux banner carries Allow and Deny`, async t => {
    const p = profile(t, origin);
    assert.deepEqual([p.onDisk().surfaces.notify, p.onDisk().notifyActions], [true, true]);
    const r = rig({ store: p.restarted() });
    await r.offer("local");
    assert.deepEqual(buttons(r), [["default", "allow", "deny", "open"]]);
    assert.deepEqual(r.plain, []);
    assert.equal(r.minted.length, 1);
  });

  test(`Settings file (${origin} install): native notifications saved off, answering still on: no banner, no buttons, no token, no bus`, async t => {
    const p = profile(t, origin);
    p.settings.set("surfaces.notify", false);
    assert.deepEqual([p.onDisk().surfaces.notify, p.onDisk().notifyActions], [false, true], "the file on disk holds the owner's switch");
    const restarted = p.restarted();
    // Two independent refusals, each read from the file: main's gate for the buttons, and the router for the notice itself.
    assert.equal(bannerActionsOn(restarted.get()), false, "main's gate refuses the buttons on its own, whatever the router decides");
    const r = rig({ store: restarted });
    const result = await r.offer("local");
    assert.notEqual(result.decision, "notify", "the router does not choose the notification for an owner who switched it off");
    assert.deepEqual(r.posted, [], "nothing is posted to the notification daemon");
    assert.deepEqual(r.plain, [], "and no plain notice takes its place");
    assert.equal(r.minted.length, 0, "no answer token exists");
    assert.equal(r.connections(), 0, "the session bus is never opened");
  });

  test(`Settings file (${origin} install): answering saved off: the notice stays, Open only, and the session bus is never opened`, async t => {
    const p = profile(t, origin);
    p.settings.set("notifyActions", false);
    assert.deepEqual([p.onDisk().surfaces.notify, p.onDisk().notifyActions], [true, false], "the file on disk holds the owner's switch");
    const restarted = p.restarted();
    assert.equal(bannerActionsOn(restarted.get()), false);
    const r = rig({ store: restarted });
    assert.equal((await r.offer("local")).decision, "notify", "the notice itself is still wanted");
    assert.deepEqual(r.posted, [], "no banner with buttons");
    assert.equal(r.plain.length, 1, "the plain notice, which can only open the app");
    assert.equal(r.minted.length, 0);
    assert.equal(r.connections(), 0);
  });
}

test("Settings file: Notifications OFF (every surface saved off, the first-run 'keep everything inside') posts nothing at all on Linux", async t => {
  const p = profile(t, "new");
  for (const id of ["notify", "receipt", "tray", "badge", "bubble", "dock"]) p.settings.set(`surfaces.${id}`, false);
  p.settings.set("chooser", "kept-inside");
  const file = p.onDisk();
  assert.equal(Object.values(file.surfaces).some(value => value !== false), false, "the file on disk has every surface off");
  assert.equal(file.notifyActions, true, "answering was never touched: the surface switch alone must decide");
  const restarted = p.restarted();
  assert.equal(bannerActionsOn(restarted.get()), false, "main's gate refuses the buttons on its own");
  const r = rig({ store: restarted });
  const result = await r.offer("local");
  assert.notEqual(result.decision, "notify");
  assert.deepEqual(r.posted, []);
  assert.deepEqual(r.plain, [], "not even a plain notice");
  assert.equal(r.minted.length, 0);
  assert.equal(r.connections(), 0);
});

test("Settings file: a switch flipped while the app runs decides the very next card, and switching back on restores the banner", async t => {
  const p = profile(t, "new");
  const r = rig({ store: p.settings });
  await r.offer("local");
  assert.equal(r.posted.length, 1, "both on: a banner");
  p.settings.set("notifyActions", false);
  await r.offer("cloud-one");
  assert.equal(r.posted.length, 1, "answering off: no second banner");
  assert.equal(r.plain.length, 1, "a plain notice instead");
  p.settings.set("surfaces.notify", false);
  await r.offer("cloud-two");
  assert.deepEqual([r.posted.length, r.plain.length, r.minted.length], [1, 1, 1], "native notifications off: nothing new of any kind");
  p.settings.set("surfaces.notify", true); p.settings.set("notifyActions", true);
  assert.deepEqual([p.onDisk().surfaces.notify, p.onDisk().notifyActions], [true, true]);
  await r.offer("cloud-three");
  assert.equal(r.posted.length, 2, "both back on: the banner returns");
  assert.equal(r.minted.length, 2);
});
