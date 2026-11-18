// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAttentionSurfaces, surfaceForKind } from "./attention-surfaces.mjs";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

const URL_FOR = { popover: "file:///app/ui/src/tray-panel/index.html", flyout: "file:///app/ui/src/tray-panel/index.html", popup: "file:///app/ui/src/tray-panel/index.html",
  bubble: "file:///app/ui/src/float/bubble.html", dock: "file:///app/ui/src/float/dock.html" };

function rig({ previews = true, hold = null } = {}) {
  const handlers = new Map(), minted = [], invalidated = [], opened = [], sent = [], targets = [], watches = [], created = [];
  const transport = { current: () => "port|pid", readCard: async () => ({ open: true }), post: async () => ({ ok: true }) };
  const attention = { epoch: "E1", open: [{ threadId: "t1", messageId: "m1", requestId: "r1", botId: "b1", display: { botName: "Ada", title: "Run a command", willRun: "ls" }, outsideOk: { flyout: true }, digest: "d".repeat(64) }] };
  const tray = { needsYou: 1, items: [], working: [{ botId: "b2", botName: "Bo", doing: "x" }], bots: [{ id: "b1", name: "Ada", chief: true }, { id: "b2", name: "Bo", chief: false }] };
  const prefs = notifySurfaceDefaults("new", "linux");
  const surfaces = createAttentionSurfaces({
    electron: { BrowserWindow: class { constructor() { created.push(1); throw new Error("no window expected"); } static getAllWindows() { return []; } }, screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 800, height: 600 } }), on() {}, removeListener() {} } },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, platform: "linux", tray: { getBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }) },
    actions: { mint: entry => { minted.push(entry); return "t".repeat(32); }, invalidateSurface: id => invalidated.push(id), act: async () => ({ ok: true }) },
    prefs: () => prefs, capabilities: () => ({ session: "x11", surfaces: {} }), presence: () => ({}), presenceWatch: () => { watches.push(1); return () => watches.push(-1); },
    transportFor: home => (home === "local" ? transport : null),
    readLocal: async route => { if (hold) await hold.promise; return JSON.parse(JSON.stringify(route === "/api/desktop/attention" ? attention : tray)); },
    readPreviews: async () => previews, openApp: async () => { opened.push("app"); }, openTarget: target => targets.push(target),
    sendToBot: async (who, text) => { sent.push([who, text]); return { ok: true }; }, pauseAutomations: async () => ({ ok: true }),
    loadUrlFor: kind => URL_FOR[kind] ?? null, log: () => {} });
  const invoke = (channel, id, kind, ...args) => handlers.get(channel)({ sender: { id }, senderFrame: { url: URL_FOR[kind], parent: null } }, ...args);
  return { surfaces, handlers, minted, invalidated, opened, sent, targets, invoke, watches, created, transport, prefs };
}

test("S6: the window gate serves a registered panel its cards with an action token bound to the transport it read, and refuses anyone else", async () => {
  const r = rig();
  r.surfaces.gate.register(7, "popover");
  const result = await r.invoke("attention-window:items", 7, "popover");
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].actionToken, /^t+$/);
  assert.equal(r.minted[0].surface, "flyout", "the panel kinds all answer on the flyout surface");
  assert.equal(r.minted[0].transport, r.transport);
  assert.equal(r.minted[0].identity, "port|pid");
  assert.deepEqual(await r.invoke("attention-window:items", 8, "popover"), { ok: false, reason: "refused" }, "an unregistered window");
  assert.deepEqual(await r.invoke("attention-window:items", 7, "bubble"), { ok: false, reason: "refused" }, "a page that is not the one main loaded");
  assert.equal(surfaceForKind("popup"), "flyout");
  assert.equal(surfaceForKind("dock"), "dock");
});

test("S6: closing a window spends the tokens it was shown, and previews off shows no card content or action", async () => {
  const r = rig();
  r.surfaces.gate.register(7, "flyout");
  await r.invoke("attention-window:items", 7, "flyout");
  r.surfaces.gate.unregister(7);
  assert.ok(r.invalidated.length >= 1, "the host forgot the window's surface");
  assert.deepEqual(await r.invoke("attention-window:items", 7, "flyout"), { ok: false, reason: "refused" });
  const off = rig({ previews: false });
  off.surfaces.gate.register(9, "popup");
  const read = await off.invoke("attention-window:items", 9, "popup");
  assert.equal(read.items[0].display, null);
  assert.equal(read.items[0].actionToken, undefined);
  assert.equal(off.minted.length, 0);
});

test("S6: the panel's Open and Tell-the-chief effects reach main by the gated path only", async () => {
  const r = rig();
  r.surfaces.gate.register(7, "popover");
  const items = await r.invoke("attention-window:items", 7, "popover");
  const open = await r.invoke("attention-window:open", 7, "popover", items.items[0].openToken);
  assert.deepEqual(open, { ok: true });
  assert.deepEqual(r.opened, ["app"]);
  assert.deepEqual(r.targets, [{ kind: "approval", threadId: "t1", messageId: "m1", botId: "b1" }]);
  assert.deepEqual(await r.invoke("attention-window:send-to-chief", 7, "popover", "hello"), { ok: true });
  assert.deepEqual(r.sent, [["chief", "hello"]]);
  assert.deepEqual(await r.invoke("attention-window:open", 7, "popover", items.items[0].openToken), { ok: false, reason: "unknown" }, "an open capability is single use");
});

test("S9: with no floating surface on, sync reads the roster, creates no window and holds no presence watch; teardown is quiet", async () => {
  const r = rig();
  await r.surfaces.sync();
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.watches, []);
  r.surfaces.botFrame({ botId: "b1", state: "working" });
  r.surfaces.botFrame(null);
  r.surfaces.invalidateAll();
  r.surfaces.dispose();
  await r.surfaces.sync();
  assert.deepEqual(r.created, [], "a disposed set builds nothing");
});

test("Astra r1 FIX: presence stays watched while a float is wanted, even when none is visible, and is released only when none is wanted", async () => {
  const r = rig();
  await r.surfaces.sync();
  assert.deepEqual(r.watches, [], "nothing wanted: no watch");
  r.prefs.surfaces.bubble = true;
  await r.surfaces.sync();
  await r.surfaces.sync();
  assert.deepEqual(r.watches, [1], "a wanted float holds exactly one watch although nothing is visible (a hidden float must see fullscreen or sharing end)");
  r.prefs.surfaces.bubble = false;
  await r.surfaces.sync();
  assert.deepEqual(r.watches, [1, -1], "the watch is released once nothing floating is wanted or exists");
  r.surfaces.dispose();
});

test("Astra r2 FIX: a sync that was reading when floats were switched off does not take the presence watch back", async () => {
  let release; const hold = { promise: new Promise(resolve => { release = resolve; }) };
  const r = rig({ hold });
  r.prefs.surfaces.bubble = true;
  const slow = r.surfaces.sync(); // captured "wanted" before its reads
  r.prefs.surfaces.bubble = false;
  release();
  await slow;
  assert.deepEqual(r.watches, [], "the preference is read again after the awaits: nothing wanted, nothing watched");
  r.surfaces.dispose();
});

test("Astra r1 FIX: a watcher frame with no valid state leaves the roster's dot alone", async () => {
  const set = [];
  const r = rig();
  r.surfaces.floatWindows.setBotState = (id, state) => set.push([id, state]);
  r.surfaces.botFrame({ botId: "b1" });
  r.surfaces.botFrame({ botId: "b1", state: "bogus" });
  r.surfaces.botFrame({ botId: "b1", state: "working" });
  r.surfaces.botFrame({ botId: "b1", state: "needs-you" });
  r.surfaces.botFrame({ botId: "b1", state: "idle" });
  assert.deepEqual(set, [["b1", "working"], ["b1", "needs-you"], ["b1", "idle"]], "only a frame that carries a state moves a dot");
});

test("S9: the bubble rung is the float surface the router is given", () => {
  const r = rig();
  assert.equal(typeof r.surfaces.floatSurface.show, "function");
  assert.equal(typeof r.surfaces.floatSurface.close, "function");
});
