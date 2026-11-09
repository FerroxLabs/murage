// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createFloatWindows, createFloatSurface, WAYLAND_REASON } from "./float-windows.mjs";
import { createAttentionWindowHost } from "./attention-window-host.mjs";
import { createAttentionActions } from "./attention-actions.mjs";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture({ platform = "linux", session = "x11", on = true, protect = true, loading } = {}) {
  const windows = [], registrations = new Map(), unregistered = [], timers = new Map();
  let time = 0, timerId = 0, displaysRead = 0;
  let p = { surfaces: { bubble: on, dock: on }, pinnedBotId: "alpha" };
  let quiet = { fullscreen: false, sharing: false, locked: false };
  let rows = [{ botId: "alpha", name: "Alpha", state: "idle" }, { botId: "beta", name: "Beta", state: "idle" }];
  let displays = [1, 2].map(id => ({ id, workArea: { x: (id - 2) * 800, y: 20, width: 800, height: 600 } }));
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.messages = []; this.visible = false; this.boundsCalls = 0;
      this.webContents = new EventEmitter(); this.webContents.id = windows.length + 1;
      this.webContents.send = (...args) => this.messages.push({ time, args });
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    setContentProtection(value) { this.protected = value; if (!protect) throw Error("protection"); }
    setAlwaysOnTop(...args) { this.top = args; }
    setVisibleOnAllWorkspaces(...args) { this.spaces = args; }
    setBounds(bounds) { this.bounds = bounds; this.boundsCalls++; }
    setFocusable(value) { this.focusable = value; }
    focus() { this.focused = true; }
    loadURL(url) { this.url = url; return loading ?? Promise.resolve(); }
    showInactive() { this.visible = true; }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
  }
  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => displays[0];
  screen.getAllDisplays = () => { displaysRead++; return displays; };
  const manager = createFloatWindows({ BrowserWindow: Window, screen, platform,
    capabilities: () => ({ session }), prefs: () => p, presence: () => quiet, botStates: () => rows,
    attentionIpc: { register: (id, kind) => registrations.set(id, kind), unregister: id => { registrations.delete(id); unregistered.push(id); } },
    loadUrlFor: kind => `file:///fixture/${kind}.html`, now: () => time,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id) });
  const advance = async ms => {
    const end = time + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
    }
    time = end; await settle();
  };
  return { manager, windows, registrations, timers, unregistered, screen, advance,
    active: kind => windows.filter(w => !w.destroyed && (!kind || registrations.get(w.webContents.id) === kind)),
    prefs: patch => { p = { ...p, ...patch }; }, quiet: value => { quiet = value; },
    displays: value => { displays = value; }, rows: value => { rows = value; }, reads: () => displaysRead };
}

test("off constructs nothing, registers nothing, and leaves no timers even on state or display events", async () => {
  const f = fixture({ on: false }); await f.manager.sync(); f.manager.setBotState("alpha", "working");
  f.screen.emit("display-added"); await f.advance(5000);
  assert.equal(f.windows.length, 0); assert.equal(f.registrations.size, 0); assert.equal(f.timers.size, 0);
  f.manager.destroy();
});
for (const platform of ["linux", "darwin", "win32"]) test(`${platform}: one bubble, one dock per display, protected nonactivating exact-file windows`, async () => {
  const f = fixture({ platform }); await f.manager.sync(); await f.manager.sync();
  assert.equal(f.windows.length, 3); assert.equal(f.active("bubble").length, 1); assert.equal(f.active("dock").length, 2);
  assert.equal(f.timers.size, 0);
  for (const w of f.windows) {
    assert.equal(w.options.focusable, false); assert.equal(w.options.frame, false); assert.equal(w.options.transparent, true);
    assert.equal(w.options.alwaysOnTop, true); assert.equal(w.options.skipTaskbar, true); assert.equal(w.options.show, false);
    assert.equal(w.protected, true); assert.equal(w.visible, true); assert.equal(w.focused, undefined);
    assert.deepEqual(w.top, [true, "status"]); assert.equal(w.boundsCalls, 1);
    assert.equal(w.options.webPreferences.contextIsolation, true); assert.equal(w.options.webPreferences.sandbox, true);
    assert.equal(w.options.webPreferences.nodeIntegration, false); assert.equal(w.options.webPreferences.webviewTag, false);
    assert.match(w.options.webPreferences.preload, /attention-window-preload\.cjs$/);
    assert.match(w.url, /^file:\/\/\/fixture\/(bubble|dock)\.html$/);
    if (platform === "darwin") assert.deepEqual(w.spaces, [true, { visibleOnFullScreen: false }]);
    let denied = 0; for (const event of ["will-navigate", "will-frame-navigate", "will-attach-webview"]) w.webContents.emit(event, { preventDefault: () => denied++ });
    assert.equal(denied, 3); assert.deepEqual(w.openHandler(), { action: "deny" });
  }
  f.prefs({ surfaces: { bubble: false, dock: false } }); await f.manager.sync();
  assert.equal(f.active().length, 0); assert.equal(f.registrations.size, 0); assert.equal(f.unregistered.length, 3);
  f.manager.destroy();
});
test("Wayland reports the exact reason and unknown Linux sessions create nothing", async () => {
  for (const session of ["wayland", null, "unknown"]) {
    const f = fixture({ session }); await f.manager.sync();
    assert.equal(f.windows.length, 0); assert.equal(f.manager.status().available.bubble, false);
    if (session === "wayland") assert.equal(f.manager.status().reason, "Needs an X11 session: Wayland cannot keep it on top.");
    f.manager.destroy();
  }
  assert.equal(WAYLAND_REASON.includes("X11"), true);
});
for (const platform of ["linux", "darwin", "win32"]) test(`${platform}: bubble and dock bounds stay separate with one bot and expanded cards`, async () => {
  const f = fixture({ platform });
  f.rows([{ botId: "alpha", name: "Alpha", state: "idle" }]);
  await f.manager.sync();
  const bubble = f.active("bubble")[0], dock = f.active("dock")[0];
  const info = (kind, win) => ({ kind, windowId: win.webContents.id });
  const check = area => {
    const a = bubble.bounds, b = dock.bounds;
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      "bubble and dock must not intersect");
    for (const bounds of [a, b]) {
      assert.ok(bounds.width > 0 && bounds.height > 0);
      assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
      assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
    }
  };
  for (const area of [{ x: -800, y: 20, width: 800, height: 600 }, { x: -640, y: -480, width: 640, height: 480 }]) {
    f.displays([{ id: 1, workArea: area }]); await f.manager.sync();
    for (const [bubbleExpanded, dockExpanded] of [[false, false], [true, false], [true, true], [false, true], [false, false]]) {
      f.manager.setExpanded(info("bubble", bubble), bubbleExpanded);
      f.manager.setExpanded(info("dock", dock), dockExpanded);
      check(area);
    }
  }
  f.manager.destroy();
});
test("only transitions push; identical states send nothing; bursts coalesce to 500ms trailing pushes per window", async () => {
  const f = fixture(); await f.manager.sync();
  const bubble = f.active("bubble")[0], docks = f.active("dock");
  assert.equal(f.manager.setBotState("alpha", "idle"), false);
  assert.equal(f.manager.setBotState("unknown", "working"), false);
  assert.equal(f.manager.setBotState("alpha", "unknown"), false);
  assert.equal(f.timers.size, 0); assert.equal(bubble.messages.length, 0);
  f.manager.setBotState("alpha", "working");
  assert.equal(bubble.messages.length, 1);
  f.manager.setBotState("alpha", "working"); assert.equal(f.timers.size, 0);
  await f.advance(100); f.manager.setBotState("alpha", "needs-you");
  await f.advance(100); f.manager.setBotState("alpha", "idle"); f.manager.setBotState("beta", "working");
  assert.equal(f.timers.size, 3); await f.advance(299); assert.equal(bubble.messages.length, 1);
  await f.advance(1); assert.equal(f.timers.size, 0);
  for (const w of [bubble, ...docks]) assert.deepEqual(w.messages, [0, 500].map(time => ({ time, args: ["attention-window:changed"] })));
  assert.equal(f.manager.readState({ kind: "bubble", windowId: bubble.webContents.id }).bots[0].state, "idle");
  await f.advance(500); f.manager.setBotState("beta", "needs-you");
  assert.equal(bubble.messages.length, 2); assert.equal(docks[0].messages.length, 3);
  await f.advance(5000); assert.equal(f.timers.size, 0); f.manager.destroy();
});
for (const flag of ["fullscreen", "sharing", "locked"]) test(`${flag}: no initial window; existing windows and queued paints disappear; sync restores`, async () => {
  const f = fixture(), quiet = { fullscreen: false, sharing: false, locked: false, [flag]: true };
  f.quiet(quiet); await f.manager.sync(); assert.equal(f.windows.length, 0);
  f.quiet({ fullscreen: false, sharing: false, locked: false }); await f.manager.sync();
  f.manager.setBotState("alpha", "working"); f.manager.setBotState("alpha", "needs-you");
  f.quiet(quiet); await f.manager.sync();
  assert.equal(f.active().length, 0); assert.equal(f.registrations.size, 0); assert.equal(f.timers.size, 0);
  await f.advance(500); assert.ok(f.windows.every(w => w.messages.length === 1));
  f.quiet({ fullscreen: false, sharing: false, locked: false }); await f.manager.sync(); assert.equal(f.active().length, 3);
  f.manager.destroy();
});
test("unknown presence and failed content protection never show outside", async () => {
  const f = fixture(); f.quiet({}); await f.manager.sync(); assert.equal(f.windows.length, 0); f.manager.destroy();
  const g = fixture({ protect: false }); await g.manager.sync(); assert.equal(g.active().length, 0); assert.equal(g.registrations.size, 0); g.manager.destroy();
});
test("hide for an hour affects only its kind, uses one timer, restores once, and preferences cancel the hold", async () => {
  const f = fixture(); await f.manager.sync();
  f.manager.hideForAnHour("dock"); assert.equal(f.active("dock").length, 0); assert.equal(f.active("bubble").length, 1); assert.equal(f.timers.size, 1);
  f.manager.hideForAnHour("dock"); assert.equal(f.timers.size, 1);
  await f.advance(3599999); assert.equal(f.active("dock").length, 0);
  await f.advance(1); assert.equal(f.active("dock").length, 2); assert.equal(f.timers.size, 0);
  f.manager.hideForAnHour("bubble"); const stale = [...f.timers.values()][0];
  f.prefs({ pinnedBotId: "beta" }); await f.manager.sync(); assert.equal(f.timers.size, 0); assert.equal(f.active("bubble").length, 1);
  stale.callback(); await settle(); assert.equal(f.active("bubble").length, 1);
  f.manager.hideForAnHour("dock"); f.prefs({ surfaces: { bubble: false, dock: false } }); await f.manager.sync();
  assert.equal(f.timers.size, 0); await f.advance(3600000); assert.equal(f.active().length, 0); f.manager.destroy();
});
test("display bursts reconcile once, keep surviving windows and destroy removed displays without duplicates", async () => {
  const f = fixture(); await f.manager.sync(); const before = f.reads();
  const surviving = f.active("dock")[0], removed = f.active("dock")[1];
  f.displays([1, 3, 3].map(id => ({ id, workArea: { x: -800, y: 0, width: 640, height: 480 } })));
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) f.screen.emit(event);
  assert.equal(f.timers.size, 1); await f.advance(0); assert.equal(f.reads(), before + 1);
  assert.equal(removed.destroyed, true); assert.ok(f.active("dock").includes(surviving)); assert.equal(f.active("dock").length, 2);
  assert.equal(f.windows.length, 4); f.screen.emit("display-added"); f.manager.destroy();
  assert.equal(f.screen.listenerCount("display-added"), 0); assert.equal(f.timers.size, 0);
});
test("pending loads cannot show after privacy, off, hour hide or destroy", async () => {
  for (const stop of [f => f.quiet({ locked: true }), f => f.prefs({ surfaces: { bubble: false, dock: false } }), f => f.manager.hideForAnHour("bubble"), f => f.manager.destroy()]) {
    let release; const loading = new Promise(resolve => { release = resolve; });
    const f = fixture({ loading }); const pending = f.manager.sync(); await settle(); stop(f); release(); await pending;
    assert.equal(f.active("bubble").length, 0); assert.ok(f.windows.filter(w => w.url?.endsWith("bubble.html")).every(w => !w.visible));
    f.manager.destroy();
  }
});
test("only a current registered kind can expand, and hidden bots or an absent pin are not exposed", async () => {
  const f = fixture(); await f.manager.sync(); const w = f.active("bubble")[0], info = { kind: "bubble", windowId: w.webContents.id };
  assert.deepEqual(f.manager.setExpanded(info, true), { ok: true }); assert.equal(w.focusable, true); assert.equal(w.bounds.width, 380);
  f.manager.setExpanded(info, false); assert.equal(w.focusable, false); assert.equal(w.bounds.width, 72);
  assert.equal(f.manager.setExpanded({ ...info, kind: "dock" }, true).ok, false);
  f.rows([{ botId: "alpha", state: "idle", hidden: true }, { botId: "beta", state: "idle", visible: false }]); await f.manager.sync();
  assert.equal(f.active("bubble").length, 0); assert.equal(f.manager.readState(info), null);
  assert.equal(f.manager.setExpanded(info, true).ok, false); f.manager.destroy();
});
test("router adapter refuses mismatched pins and unavailable windows; close invalidates without creating windows", async () => {
  const f = fixture(); const invalidated = [], surface = createFloatSurface({ floatWindows: f.manager, host: { invalidateWindow: id => invalidated.push(id) } });
  assert.equal(await surface.show({ frame: { botId: "beta" } }), null);
  const id = await surface.show({ frame: { botId: "alpha" } }); assert.match(id, /^float:bubble:\d+$/);
  surface.close(); assert.equal(invalidated.length, 1);
  f.manager.hideForAnHour("bubble"); assert.equal(await surface.show({ frame: { botId: "alpha" } }), null);
  f.manager.destroy();
});
test("external retirement refreshes the next pending bubble card even while the bot still needs attention", async () => {
  const f = fixture(), posts = [], opened = [];
  f.rows([{ botId: "alpha", name: "Alpha", state: "needs-you" }]);
  const card = requestId => ({ botId: "alpha", home: "local", epoch: "e", threadId: "t", messageId: requestId, requestId,
    digest: "a".repeat(64), outsideOk: { bubble: true }, display: { botName: "Alpha", title: requestId, willRun: "cat notes.txt" } });
  let pending = [card("A"), card("B")];
  const actions = createAttentionActions({ lock: { locked: () => false } });
  const host = createAttentionWindowHost({ actions, floatWindows: f.manager, surfaceFor: kind => kind,
    readItems: async () => ({ previews: true, items: pending }), openTarget: target => opened.push(target),
    transportFor: () => ({ current: () => "identity", readCard: async entry => ({ ...pending.find(row => row.requestId === entry.requestId), open: true }),
      post: async body => { posts.push(body); return { ok: true }; } }) });
  const surface = createFloatSurface({ floatWindows: f.manager, host });
  await surface.show({ frame: { botId: "alpha" } });
  const bubble = f.active("bubble")[0], info = { kind: "bubble", windowId: bubble.webContents.id };
  f.manager.setExpanded(info, true);
  let view = await host.items(info), refreshes = 0;
  const old = view.bots[0].item, botKey = view.bots[0].key;
  assert.equal(old.display.title, "A");
  const send = bubble.webContents.send;
  bubble.webContents.send = (...args) => {
    send(...args);
    assert.deepEqual(args, ["attention-window:changed"]);
    refreshes++;
    void host.items(info).then(value => { view = value; });
  };
  pending = pending.slice(1); // Request A settles outside this window.
  surface.close();
  assert.equal(f.manager.setBotState("alpha", "needs-you"), false);
  await f.advance(500);
  assert.equal(refreshes, 1);
  assert.equal(view.bots[0].key, botKey);
  assert.equal(view.bots[0].state, "needs-you");
  assert.equal(view.bots[0].item.display.title, "B");
  assert.equal((await host.act(info, old.actionToken, "allow")).ok, false);
  assert.equal((await host.open(info, old.openToken)).ok, false);
  assert.equal(posts.length, 0); assert.equal(opened.length, 0);
  assert.equal((await host.open(info, view.bots[0].item.openToken)).ok, true);
  assert.equal(opened[0].messageId, "B");
  assert.equal((await host.act(info, view.bots[0].item.actionToken, "allow")).ok, true);
  assert.equal(posts.length, 1); assert.equal(posts[0].requestId, "B");
  assert.equal(f.windows.length, 3);
  f.manager.hideForAnHour("bubble"); surface.close(); await f.advance(500);
  assert.equal(refreshes, 1); assert.equal(f.windows.length, 3);
  f.manager.destroy();
});
test("roster changes remove hidden bots, retain display windows and publish once without repainting unchanged syncs", async () => {
  const f = fixture(); await f.manager.sync(); const docks = f.active("dock"), bubble = f.active("bubble")[0];
  f.rows([{ botId: "alpha", name: "Alpha", state: "idle" }, { botId: "beta", name: "Beta", state: "idle", hidden: true }]);
  await f.manager.sync(); await f.manager.sync();
  assert.equal(f.windows.length, 3); assert.equal(bubble.messages.length, 0);
  for (const dock of docks) {
    assert.equal(dock.messages.length, 1);
    assert.equal(f.manager.readState({ kind: "dock", windowId: dock.webContents.id }).bots.length, 1);
  }
  assert.equal(f.timers.size, 0); f.manager.destroy();
});
