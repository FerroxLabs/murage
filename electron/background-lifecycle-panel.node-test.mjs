// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBackgroundLifecycle } from "./background-lifecycle.mjs";

function fixture(platform, present, initialOn) {
  let on = initialOn, menu, attached, nativeMenu;
  const calls = [], tray = new EventEmitter();
  Object.assign(tray, { isDestroyed: () => false, destroy: () => calls.push("destroyTray"),
    setContextMenu: value => { attached = value; }, popUpContextMenu: value => calls.push(["menu", value]) });
  const lifecycle = createBackgroundLifecycle({ platform, loadPreferences: () => ({}), login: { read: () => ({}) }, window: () => null,
    openWindow: () => calls.push("open"), createTray: click => { tray.on("click", click); return tray; }, probeTray: () => true,
    setTrayMenu: (_tray, items, mode) => { menu = items; nativeMenu = { items }; if (!mode?.manual) attached = nativeMenu; return nativeMenu; },
    automationStatus: async () => ({ paused: false }), setInterval: () => 1, clearInterval: () => {}, trayPanelOn: () => on,
    ...(present ? { trayPanel: { toggle: bounds => calls.push(["toggle", bounds]), show: () => calls.push("show"), hide: () => {}, destroy: () => calls.push("destroyPanel") } } : {}) });
  return { lifecycle, tray, calls, menu: () => menu, attached: () => attached, nativeMenu: () => nativeMenu, setOn: value => { on = value; } };
}
for (const platform of ["win32", "darwin", "linux"]) {
  test(`${platform}: absent and off keep the old click and attached menu`, async () => {
    for (const present of [false, true]) {
      const f = fixture(platform, present, false); await f.lifecycle.start();
      f.tray.emit("click"); f.tray.emit("right-click");
      assert.deepEqual(f.calls, ["open"]); assert.ok(f.attached());
      assert.equal(f.menu()[0].label, "See all in Inbox"); f.lifecycle.dispose();
    }
  });
  test(`${platform}: opt-in toggles left, pops right, and keeps Linux's first item`, async () => {
    const f = fixture(platform, true, true); await f.lifecycle.start();
    const bounds = { x: 4 }; f.tray.emit("click", {}, bounds); f.tray.emit("right-click");
    assert.deepEqual(f.calls[0], ["toggle", bounds]); assert.equal(f.calls[1][0], "menu");
    if (platform === "linux") {
      assert.equal(f.menu()[0].label, "Open quick panel"); f.menu()[0].click(); assert.equal(f.calls[2], "show"); assert.ok(f.attached());
    } else { assert.equal(f.attached(), null); assert.equal(f.calls[1][1], f.nativeMenu()); }
    f.setOn(false); await f.lifecycle.refresh(); f.tray.emit("click");
    assert.equal(f.calls.at(-1), "open"); assert.ok(f.attached()); assert.equal(f.menu()[0].label, "See all in Inbox");
    f.lifecycle.dispose(); assert.equal(f.tray.listenerCount("right-click"), 0);
    assert.deepEqual(f.calls.slice(-2), ["destroyPanel", "destroyTray"]);
  });
}
