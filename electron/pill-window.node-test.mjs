// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPillWindow, createPillSurface } from "./pill-window.mjs";
import { createAttentionWindowHost } from "./attention-window-host.mjs";
import { createAttentionActions } from "./attention-actions.mjs";
import { createAttentionIpc } from "./attention-ipc.mjs";
import { createAttentionRouter } from "./attention-router.mjs";

const quiet = { locked: false, sharing: false, fullscreen: false };
const item = (itemId, extra = {}) => ({ itemId, kind: "approval", previews: true, createdAt: 10,
  home: "local", epoch: "epoch", threadId: `thread-${itemId}`, messageId: `message-${itemId}`, requestId: `request-${itemId}`,
  digest: "a".repeat(64), outsideOk: { pill: true },
  display: { botName: "Chief", title: "Read notes", willRun: "cat notes.txt\ncat details.txt" }, ...extra });
function fixture(options = {}) {
  const windows = [], timers = new Map(), registered = [], unregistered = [], invalidated = [], posts = [], opened = [];
  let time = 0, nextTimer = 0, currentPresence = { ...quiet }, releaseLoad;
  const load = options.pending ? new Promise(resolve => { releaseLoad = resolve; }) : Promise.resolve();
  class Window extends EventEmitter {
    constructor(config) {
      super(); this.config = config; this.boundsCalls = []; this.focusCalls = 0; this.inactiveCalls = 0; this.focusable = false;
      this.webContents = new EventEmitter(); this.webContents.id = windows.length + 1;
      this.webContents.send = (...args) => { this.lastMessage = args; };
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    setBounds(bounds) { this.boundsCalls.push(bounds); this.bounds = bounds; }
    setContentProtection(value) { if (options.protection === false) throw Error("unavailable"); this.protected = value; }
    setAlwaysOnTop(...args) { this.top = args; }
    setVisibleOnAllWorkspaces(...args) { this.workspaces = args; }
    setFocusable(value) { this.focusable = value; }
    showInactive() { this.inactiveCalls++; this.visible = true; }
    focus() { this.focusCalls++; }
    show() { throw Error("must use showInactive"); }
    hide() { this.visible = false; }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    loadURL(url) { this.url = url; return load; }
  }
  const internal = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 24, width: 1600, height: 976 },
    auxiliaryTopLeftArea: { x: 0, y: 0, width: 700, height: 32 }, auxiliaryTopRightArea: { x: 820, y: 0, width: 780, height: 32 } };
  const external = { id: 2, internal: false, bounds: { x: -1200, y: -300, width: 1200, height: 900 }, workArea: { x: -1200, y: -276, width: 1200, height: 876 } };
  const screen = new EventEmitter(), powerMonitor = new EventEmitter(); let display = internal;
  screen.getCursorScreenPoint = () => ({ x: display.bounds.x + 100, y: display.bounds.y + 100 });
  screen.getDisplayNearestPoint = point => { assert.deepEqual(point, screen.getCursorScreenPoint()); return display; };
  const urlFor = kind => `file:///fixture/${kind}.html`;
  const ipc = createAttentionIpc({ urlFor });
  const pill = createPillWindow({ BrowserWindow: Window, screen, powerMonitor, platform: options.platform ?? "darwin", loadUrlFor: urlFor,
    attentionIpc: { register(id, kind) { registered.push([id, kind]); ipc.register(id, kind); }, unregister(id) { unregistered.push(id); ipc.unregister(id); } },
    now: () => time, setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: time + delay, delay }); return id; },
    clearTimer: id => timers.delete(id), presence: () => currentPresence, getSafeAreaTop: id => id === 1 ? 32 : 0,
    replyTyping: options.replyTyping ?? false });
  const actions = createAttentionActions({ lock: { locked: () => currentPresence?.locked !== false } });
  const host = createAttentionWindowHost({ actions, readItems: () => pill.readItems(), surfaceFor: () => "pill",
    replyTyping: options.replyTyping ?? false, pillFocus: pill.pillFocus, pillExpand: pill.pillExpand,
    transportFor: row => ({ current: () => "identity", readCard: async () => ({ ...row, open: true }), post: async body => { posts.push(body); return { ok: true }; } }),
    openTarget: target => opened.push(target) });
  if (!options.isolated) pill.onChange(id => { invalidated.push(id); host.invalidateWindow(id); });
  const tick = ms => {
    const end = time + ms;
    while (true) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at; timers.delete(due[0]); due[1].callback();
    }
    time = end;
  };
  return { pill, host, actions, ipc, info: { kind: "pill", windowId: 1 }, windows, timers, registered, unregistered, invalidated, posts, opened,
    internal, external, screen, powerMonitor, tick, releaseLoad: () => releaseLoad(), setPresence: value => { currentPresence = value; },
    pointTo: value => { display = value; } };
}

test("five states, oldest-first order including Chief questions, and duplicate items", async () => {
  const f = fixture(); assert.equal(f.windows.length, 0); assert.equal(f.pill.readItems().pill.state, "hidden"); assert.equal(f.timers.size, 0);
  assert.deepEqual(await f.pill.show(item("new", { createdAt: 30 })), { shown: true });
  assert.equal(f.pill.readItems().pill.state, "collapsed");
  assert.equal(f.pill.pillExpand(1, true), true); assert.equal(f.pill.readItems().pill.state, "expanded");
  await f.pill.show(item("old", { kind: "question", createdAt: 5 }));
  await f.pill.show(item("new", { createdAt: 99 }));
  assert.equal(f.pill.count(), 2); assert.equal(f.windows.length, 1);
  assert.equal(f.pill.readItems().pill.state, "stacked");
  const data = await f.host.items(f.info);
  assert.equal(data.items[0].actionToken, undefined); assert.ok(data.items[1].actionToken);
  assert.deepEqual(f.pill.readItems().items.map(row => row.itemId), ["old", "new"]);
  await f.host.open(f.info, data.items[0].openToken); assert.equal(f.opened[0].threadId, "thread-old"); assert.equal(f.posts.length, 0);
  f.pill.settle("old"); f.pill.settle("new"); assert.equal(f.pill.count(), 0); assert.equal(f.windows[0].visible, false);
  await f.pill.receipt({ itemId: "done", previews: true, receiptText: "Chief finished" });
  assert.equal(f.pill.readItems().pill.state, "finished"); assert.equal(f.pill.readItems().receipts[0].text, "Chief finished");
  f.tick(5999); assert.equal(f.pill.count(), 1); f.tick(1); assert.equal(f.pill.count(), 0);
  assert.equal(f.pill.readItems().pill.state, "hidden"); f.pill.destroy();
});
test("idle teardown is exactly two minutes, re-show cancels it, and stale callbacks cannot destroy the panel", async () => {
  const f = fixture(); await f.pill.show(item("a")); f.pill.settle("a");
  const stale = [...f.timers.values()][0]; assert.equal(stale.delay, 120000);
  f.tick(119999); assert.equal(f.windows[0].isDestroyed(), false);
  await f.pill.show(item("b")); stale.callback(); assert.equal(f.windows[0].isDestroyed(), false); assert.equal(f.timers.size, 0);
  f.pill.hideAll(); f.tick(120000); assert.equal(f.windows[0].isDestroyed(), true); assert.deepEqual(f.unregistered, [1]);
  assert.equal(f.ipc.size(), 0); await f.pill.show(item("c")); assert.equal(f.windows.length, 2);
  f.pill.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.screen.listenerCount("display-added"), 0);
});
for (const key of ["fullscreen", "sharing", "locked"]) test(`${key} refuses show and receipts without creating a window`, async () => {
  const f = fixture(); f.setPresence({ ...quiet, [key]: true });
  assert.deepEqual(await f.pill.show(item("a")), { shown: false, reason: key });
  assert.deepEqual(await f.pill.receipt({ itemId: "done" }), { shown: false, reason: key });
  assert.equal(f.windows.length, 0); assert.equal(f.pill.count(), 0); assert.equal(f.timers.size, 0); f.pill.destroy();
});
test("unknown presence, non-Mac and protection failure show nothing", async () => {
  for (const p of [null, {}, { ...quiet, sharing: "unknown" }]) {
    const f = fixture(); f.setPresence(p); assert.equal((await f.pill.show(item("a"))).shown, false); assert.equal(f.windows.length, 0); f.pill.destroy();
  }
  const linux = fixture({ platform: "linux" }); assert.equal((await linux.pill.show(item("a"))).reason, "platform"); assert.equal(linux.windows.length, 0); linux.pill.destroy();
  const f = fixture({ protection: false }); assert.equal((await f.pill.show(item("a"))).shown, false);
  assert.equal(f.windows[0].inactiveCalls, 0); assert.equal(f.windows[0].isDestroyed(), true); assert.equal(f.pill.count(), 0); f.pill.destroy();
});
test("show, Allow and Deny never focus; panel privacy, workspace, IPC and navigation settings hold", async () => {
  const f = fixture(); await f.pill.show(item("a")); const w = f.windows[0];
  assert.equal(w.config.type, "panel"); assert.equal(w.config.frame, false); assert.equal(w.config.transparent, true);
  assert.equal(w.config.focusable, false); assert.equal(w.protected, true); assert.deepEqual(w.top, [true, "status"]);
  assert.deepEqual(w.workspaces, [true, { visibleOnFullScreen: false }]); assert.equal(w.url, "file:///fixture/pill.html");
  assert.deepEqual(f.registered, [[1, "pill"]]);
  assert.deepEqual({ ...w.config.webPreferences, preload: "preload" }, { preload: "preload", contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
  assert.match(w.config.webPreferences.preload, /attention-window-preload.cjs$/);
  let prevented = 0;
  for (const event of ["will-navigate", "will-frame-navigate", "will-attach-webview"]) w.webContents.emit(event, { preventDefault() { prevented++; } });
  assert.equal(prevented, 3); assert.deepEqual(w.openHandler(), { action: "deny" });
  for (const action of ["allow", "deny"]) {
    const data = await f.host.items(f.info); assert.equal((await f.host.act(f.info, data.items[0].actionToken, action)).ok, true);
    assert.equal(w.focusable, false); assert.equal(w.focusCalls, 0);
  }
  assert.equal(f.posts.length, 2); assert.equal(w.inactiveCalls, 1); f.pill.destroy();
});
test("notch geometry uses auxiliary areas; Top pill follows the pointer across negative display coordinates", async () => {
  const f = fixture(); assert.deepEqual(f.pill.geometryFor(f.internal), { x: 620, y: 32, width: 280, height: 72 });
  assert.deepEqual(f.pill.geometryFor({ ...f.internal, id: 3 }), { x: 660, y: 24, width: 280, height: 72 });
  assert.deepEqual(f.pill.geometryFor(f.external), { x: -740, y: -276, width: 280, height: 72 });
  await f.pill.show(item("a")); f.pointTo(f.external); await f.pill.show(item("b"));
  assert.deepEqual(f.windows[0].bounds, f.pill.geometryFor(f.external)); assert.equal(f.windows.length, 1);
  f.pill.pillExpand(1, true); assert.equal(f.windows[0].bounds.width, 380); assert.equal(f.windows[0].bounds.height, 560); f.pill.destroy();
});
test("display bursts and wake coalesce once, never create idle windows or revive hidden content", async () => {
  const f = fixture(); f.screen.emit("display-added"); f.powerMonitor.emit("resume"); assert.equal(f.timers.size, 0);
  await f.pill.show(item("a")); const before = f.windows[0].boundsCalls.length; f.pointTo(f.external);
  for (const event of ["display-metrics-changed", "display-added", "display-removed", "display-sleep", "display-wake"]) f.screen.emit(event);
  f.powerMonitor.emit("resume"); assert.equal(f.timers.size, 1); f.tick(0);
  assert.equal(f.windows[0].boundsCalls.length, before + 1); assert.equal(f.windows.length, 1);
  f.powerMonitor.emit("suspend"); assert.equal(f.pill.count(), 0); assert.equal(f.windows[0].visible, false);
  f.powerMonitor.emit("resume"); f.tick(0); assert.equal(f.windows[0].visible, false); f.pill.destroy();
});
test("late loads cannot show after withdrawal, destruction or changed presence", async () => {
  for (const withdrawal of [f => f.pill.hideAll(), f => f.pill.destroy(), f => f.setPresence({ ...quiet, locked: true })]) {
    const f = fixture({ pending: true }); const pending = f.pill.show(item("a")); withdrawal(f); f.releaseLoad();
    assert.equal((await pending).shown, false); assert.equal(f.windows[0].inactiveCalls, 0); assert.equal(f.pill.count(), 0); f.pill.destroy();
  }
});
test("receipt expiry cannot remove a replacement; hiding cancels receipt timers and immediately invalidates tokens", async () => {
  const f = fixture(); await f.pill.receipt(item("a")); const stale = [...f.timers.values()][0];
  await f.pill.show(item("a")); stale.callback(); assert.equal(f.pill.count(), 1);
  const data = await f.host.items(f.info); f.pill.hideAll();
  assert.equal((await f.host.act(f.info, data.items[0].actionToken, "allow")).ok, false); assert.equal(f.posts.length, 0);
  assert.equal((await f.host.open(f.info, data.items[0].openToken)).ok, false); assert.equal(f.opened.length, 0); f.pill.destroy();
});
test("previews and unknown kinds cannot carry answer authority or private display", async () => {
  const f = fixture(); await f.pill.show(item("private", { previews: false })); await f.pill.show(item("unknown", { kind: "other" }));
  const data = await f.host.items(f.info); assert.equal(data.items[0].display, null); assert.equal(data.items[0].actionToken, undefined);
  assert.equal(data.items[1].actionToken, undefined); assert.doesNotMatch(JSON.stringify(data), /thread-|message-|request-|digest/); f.pill.destroy();
});
test("Reply focus defaults off; opt-in focus and expansion use bound one-use Open tokens, no new IPC channel", async () => {
  const off = fixture(); await off.pill.show(item("a")); assert.equal((await off.host.items(off.info)).items[0].replyFocusToken, undefined);
  assert.equal(off.pill.pillFocus(1), false); off.pill.destroy();
  const f = fixture({ replyTyping: true }); await f.pill.show(item("a"));
  let data = await f.host.items(f.info);
  assert.equal((await f.host.open(f.info, data.pill.toggleToken)).ok, true); assert.equal(f.pill.readItems().pill.state, "expanded");
  assert.equal((await f.host.open(f.info, data.pill.toggleToken)).ok, false);
  data = await f.host.items(f.info);
  assert.equal((await f.host.open({ ...f.info, windowId: 2 }, data.items[0].replyFocusToken)).ok, false); assert.equal(f.windows[0].focusable, false);
  data = await f.host.items(f.info);
  assert.equal((await f.host.open(f.info, data.items[0].replyFocusToken)).ok, true); assert.equal(f.windows[0].focusable, true);
  assert.equal((await f.host.open(f.info, data.items[0].replyFocusToken)).ok, false); assert.equal(f.posts.length, 0); assert.equal(f.opened.length, 0);
  assert.equal((await f.host.act(f.info, data.items[0].actionToken, "reply", "Please wait")).ok, true);
  assert.equal(f.windows[0].focusable, false); assert.equal(f.posts[0].message, "Please wait");
  const event = { sender: { id: 1 }, senderFrame: { url: "file:///fixture/pill.html", parent: null } };
  assert.equal(f.ipc.authorize(event, "attention-window:focus-reply").ok, false); assert.equal(f.windows[0].focusCalls, 0); f.pill.destroy();
});
test("router seam maps captured entry, returns ids or null, closes only its own ids and supports receipts", async () => {
  const f = fixture(), calls = [];
  const surface = createPillSurface({ pillWindow: f.pill, host: f.host, mapItem: async entry => { calls.push(entry); return item("mapped"); } });
  const entry = { key: "local|epoch|thread|request", home: "local", epoch: "epoch", frame: { kind: "question", threadId: "thread", messageId: "message" } };
  assert.equal(await surface.show("notify", entry), null); assert.equal(calls.length, 0);
  const ids = await surface.show("pill", entry); assert.equal(calls[0], entry); assert.equal(ids.length, 1); assert.match(ids[0], /^pill:/);
  assert.equal((await f.host.items(f.info)).items[0].actionToken, undefined);
  surface.close(ids, { ...entry }); assert.equal(f.pill.count(), 1); surface.close(["other", ...ids], entry); assert.equal(f.pill.count(), 0);
  const receiptIds = await surface.show("receipt-pill", entry); assert.equal(receiptIds.length, 1); f.tick(6000); assert.equal(f.pill.count(), 0);
  f.setPresence({ ...quiet, sharing: true }); assert.equal(await surface.show("pill", entry), null);
  surface.dispose(); f.pill.destroy();
});
test("the last approval settling folds an expanded stack to a compact receipt", async () => {
  const f = fixture(); await f.pill.show(item("a")); await f.pill.receipt({ itemId: "done" });
  f.pill.pillExpand(1, true); assert.equal(f.windows[0].bounds.height, 560);
  f.pill.settle("a"); assert.equal(f.pill.readItems().pill.state, "finished"); assert.equal(f.windows[0].bounds.height, 72);
  f.tick(6000); assert.equal(f.pill.count(), 0); f.pill.destroy();
});
test("pending mapping is refused after router settlement, preview changes or surface disposal", async () => {
  for (const change of ["settled", "previews", "disposed"]) {
    const f = fixture(); let release;
    const entry = { frame: { kind: "approval" }, generation: 1 };
    const surface = createPillSurface({ pillWindow: f.pill, host: f.host, mapItem: () => new Promise(resolve => { release = resolve; }) });
    const pending = surface.show("pill", entry);
    if (change === "disposed") surface.dispose();
    else if (change === "settled") entry.dead = true;
    else { entry.generation++; f.pill.hideAll(); }
    release(item("a")); assert.equal(await pending, null); assert.equal(f.windows.length, 0);
    surface.dispose(); f.pill.destroy();
  }
});
test("router preview changes prevent presentation during mapping and window loading for cards and receipts", async () => {
  for (const phase of ["mapping", "loading"]) for (const kind of ["approval", "done"]) {
    const f = fixture({ pending: phase === "loading" });
    let releaseMap;
    const mapped = item("a", { receiptText: "Finished reading" });
    const surface = createPillSurface({ pillWindow: f.pill, host: f.host,
      mapItem: () => phase === "mapping" ? new Promise(resolve => { releaseMap = resolve; }) : mapped });
    const router = createAttentionRouter({ now: () => 0, setTimer: () => { throw Error("unexpected router timer"); }, clearTimer: () => {},
      prefs: () => ({ pill: true, receipt: true }), available: () => ({ pill: true }), quiet: () => quiet,
      surfaces: { show: surface.show, close: surface.close, counts: () => {} }, readCard: async () => ({ open: true }) });
    const pending = router.offer({ kind, botId: "b", threadId: "t", messageId: "m", requestId: "r", deliveryId: "d" });
    await new Promise(resolve => setImmediate(resolve));
    router.previewsChanged();
    // Mapping must not recreate a hidden panel; loading must honor the router's
    // cancellation even when no surface id has yet been returned to close.
    if (phase === "mapping") { f.pill.hideAll(); releaseMap(mapped); }
    else f.releaseLoad();
    await pending;
    assert.equal(f.windows.length, phase === "mapping" ? 0 : 1);
    assert.ok(f.windows.every(win => win.inactiveCalls === 0));
    assert.equal(f.pill.count(), 0);
    const data = await f.host.items(f.info);
    assert.deepEqual(data.items, []); assert.deepEqual(data.receipts, []);
    assert.equal([...f.timers.values()].some(timer => timer.delay === 6000), false);
    surface.dispose(); f.pill.destroy();
  }
});
test("host retains four pill receipts until each six-second expiry", async () => {
  const f = fixture();
  const receipts = Array.from({ length: 4 }, (_, i) => ({ text: `Finished ${i + 1}` }));
  for (let i = 0; i < receipts.length; i++) {
    if (i) f.tick(1000);
    await f.pill.receipt({ itemId: `done-${i}`, previews: true, receiptText: receipts[i].text });
  }
  const check = async expected => {
    const data = await f.host.items(f.info);
    assert.deepEqual(data.receipts, expected);
    assert.equal(data.pill.count, expected.length);
    assert.equal(f.pill.count(), expected.length);
  };
  await check(receipts);
  f.tick(2999); await check(receipts);
  for (let i = 0; i < receipts.length; i++) {
    f.tick(1); await check(receipts.slice(i + 1));
    if (i < receipts.length - 1) { f.tick(999); await check(receipts.slice(i + 1)); }
  }
  assert.equal(f.windows[0].visible, false); f.pill.destroy();
});

test("PW1 the real pill surface retains cards on a stack change and discards on hideAll, closed and dispose", async () => {
  const mk = async () => {
    const f = fixture({ isolated: true }), calls = [], spy = { invalidateWindow: (...args) => { calls.push(args); } };
    const surface = createPillSurface({ pillWindow: f.pill, host: spy, mapItem: async () => item("mapped") });
    await f.pill.show(item("a")); await f.pill.show(item("b")); calls.length = 0;
    return { f, calls, surface };
  };
  { const { f, calls } = await mk(); f.pill.settle("b");
    assert.ok(calls.length > 0); for (const call of calls) assert.deepEqual(call, [1, { retainCards: true }], "stack change retains"); f.pill.destroy(); }
  { const { f, calls } = await mk(); f.pill.hideAll();
    assert.ok(calls.length > 0); for (const call of calls) assert.deepEqual(call, [1], "hideAll discards"); f.pill.destroy(); }
  { const { f, calls } = await mk(); f.windows[0].destroy();
    assert.ok(calls.length > 0); for (const call of calls) assert.deepEqual(call, [1], "closed discards"); f.pill.destroy(); }
  { const { f, calls, surface } = await mk(); surface.dispose();
    assert.ok(calls.length > 0); for (const call of calls) assert.deepEqual(call, [1], "dispose discards"); f.pill.destroy(); }
});
