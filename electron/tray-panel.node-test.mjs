// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTrayPanel } from "./tray-panel.mjs";
import { createAttentionIpc } from "./attention-ipc.mjs";
import { createAttentionWindowHost } from "./attention-window-host.mjs";

function fixture(platform, protect = true) {
  const windows = [], registered = [], unregistered = [], timers = new Map(); let timerId = 0;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.id = windows.length + 1;
      this.webContents.send = channel => this.webContents.emit(channel);
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; }; windows.push(this); }
    setContentProtection(value) { this.protected = value; if (!protect) throw Error("unavailable"); }
    setBounds(bounds) { this.bounds = bounds; }
    async loadURL(url) { this.url = url; }
    show() { this.visible = true; } focus() {} hide() { this.visible = false; }
    isDestroyed() { return !!this.destroyed; }
    close() { let prevented = false; this.emit("close", { preventDefault: () => { prevented = true; } }); if (!prevented) this.destroy(); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const area = { x: -800, y: 20, width: 800, height: 600 };
  const gate = createAttentionIpc({ urlFor: kind => `file:///fixture/${kind}.html` });
  const panel = createTrayPanel({ BrowserWindow: Window, platform, tray: { getBounds: () => ({ x: -5, y: 590, width: 20, height: 20 }) },
    screen: { getDisplayNearestPoint: () => ({ workArea: area }), getPrimaryDisplay: () => ({ workArea: area }) },
    attentionIpc: { register: (...args) => { registered.push(args); gate.register(...args); }, unregister: id => { unregistered.push(id); gate.unregister(id); } },
    loadUrlFor: kind => `file:///fixture/${kind}.html`, presence: () => ({ sharing: true }), now: () => 0,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimer: id => timers.delete(id) });
  return { panel, windows, timers, area, registered, unregistered, gate };
}
for (const [platform, kind] of [["win32", "flyout"], ["darwin", "popover"], ["linux", "popup"]]) {
  test(`${platform}: lazy creation, exact URL, protection, clamping and teardown`, async () => {
    const f = fixture(platform); assert.equal(f.windows.length, 0); assert.equal(f.panel.isOpen(), false);
    await f.panel.show(); const w = f.windows[0]; assert.equal(f.panel.isOpen(), true);
    assert.deepEqual(f.registered, [[1, kind]]); assert.equal(w.url, `file:///fixture/${kind}.html`);
    assert.equal(w.options.frame, platform === "linux"); assert.equal(w.options.show, false); assert.equal(w.options.skipTaskbar, true);
    assert.equal(w.options.resizable, false); assert.equal(w.options.alwaysOnTop, undefined);
    assert.equal(w.options.type, platform === "darwin" ? "panel" : undefined);
    assert.equal(w.protected, platform === "linux" ? undefined : true);
    assert.deepEqual({ ...w.options.webPreferences, preload: "preload" }, { preload: "preload", contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
    assert.match(w.options.webPreferences.preload, /attention-window-preload\.cjs$/);
    assert.ok(w.bounds.x >= f.area.x && w.bounds.y >= f.area.y);
    assert.ok(w.bounds.x + w.bounds.width <= f.area.x + f.area.width);
    assert.ok(w.bounds.y + w.bounds.height <= f.area.y + f.area.height);
    if (platform === "linux") assert.equal(w.bounds.y, f.area.y);
    let denied = 0; for (const event of ["will-navigate", "will-frame-navigate", "will-attach-webview"]) w.webContents.emit(event, { preventDefault: () => denied++ });
    assert.equal(denied, 3); assert.deepEqual(w.openHandler({ url: "https://example.invalid" }), { action: "deny" });
    w.emit("blur"); assert.equal(f.panel.isOpen(), platform === "linux");
    f.panel.hide(); assert.equal(f.timers.size, 1); const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 120000);
    f.panel.hide(); assert.equal([...f.timers.values()][0], timer);
    await f.panel.show(); assert.equal(f.timers.size, 0); assert.equal(f.windows.length, 1);
    timer.callback(); assert.equal(w.destroyed, undefined);
    f.panel.hide(); [...f.timers.values()][0].callback(); assert.equal(w.destroyed, true);
    assert.deepEqual(f.unregistered, [1]); assert.equal(f.panel.isOpen(), false);
    await f.panel.toggle(); assert.equal(f.windows.length, 2); await f.panel.toggle(); assert.equal(f.panel.isOpen(), false);
    f.panel.destroy(); assert.equal(f.timers.size, 0);
  });
}
test("explicit open still works while sharing or when protection is unavailable", async () => {
  const f = fixture("win32", false); await f.panel.show(); assert.equal(f.panel.isOpen(), true); f.panel.destroy();
});
test("a hidden or destroyed pending load cannot show late", async () => {
  const f = fixture("darwin"); const opening = f.panel.show(); f.panel.hide(); await opening;
  assert.equal(f.panel.isOpen(), false); assert.equal(f.windows[0].visible, false);
  const next = f.panel.show(); f.panel.destroy(); await next; assert.equal(f.panel.isOpen(), false);
});
test("Linux native close destroys and unregisters the popup without tray click support", async () => {
  const f = fixture("linux"); await f.panel.show();
  const w = f.windows[0];
  assert.equal(w.options.frame, true);
  const event = { sender: { id: w.webContents.id }, senderFrame: { url: w.url, parent: null } };
  assert.equal(f.gate.authorize(event, "attention-window:items").ok, true);
  w.close();
  assert.equal(w.isDestroyed(), true); assert.equal(f.panel.isOpen(), false);
  assert.deepEqual(f.unregistered, [1]); assert.equal(f.timers.size, 0);
  assert.equal(f.gate.authorize(event, "attention-window:items").reason, "unregistered");
  await f.panel.show(); assert.equal(f.windows.length, 2);
  assert.deepEqual(f.registered, [[1, "popup"], [2, "popup"]]);
  f.panel.destroy(); assert.deepEqual(f.unregistered, [1, 2]);
});
for (const platform of ["win32", "darwin", "linux"]) {
  test(`${platform}: Open, hide, cached re-show, Open renews single-use tokens`, async () => {
    const f = fixture(platform), opened = [];
    const host = createAttentionWindowHost({
      actions: { invalidateSurface() {} }, surfaceFor: () => "flyout",
      readItems: async () => ({ previews: false, items: [{ home: "local", threadId: "t", messageId: "m" }] }),
      openTarget: target => { opened.push(target); if (platform === "linux") f.panel.hide(); else f.windows[0].emit("blur"); },
    });
    await f.panel.show(); const w = f.windows[0];
    const info = { windowId: w.webContents.id, kind: f.registered[0][1] };
    let data = await host.items(info), refreshed, nudges = 0;
    w.webContents.on("attention-window:changed", () => {
      nudges++; refreshed = host.items(info).then(result => { data = result; });
    });
    await f.panel.show(); assert.equal(nudges, 0);
    const oldToken = data.items[0].openToken;
    assert.equal((await host.open(info, oldToken)).ok, true);
    assert.equal(f.panel.isOpen(), false); assert.equal(f.timers.size, 1);
    assert.equal((await host.open(info, oldToken)).ok, false);
    await f.panel.show(); await refreshed;
    assert.equal(nudges, 1); assert.equal(f.windows.length, 1); assert.equal(f.timers.size, 0);
    assert.notEqual(data.items[0].openToken, oldToken);
    assert.equal((await host.open(info, data.items[0].openToken)).ok, true);
    assert.equal((await host.open(info, data.items[0].openToken)).ok, false);
    assert.equal(opened.length, 2); assert.equal(f.panel.isOpen(), false);
    f.panel.destroy();
  });
}
