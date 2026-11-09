// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createGlobalShortcut } from "./global-shortcut.mjs";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function fixture({ enabled = true, stored = "Control+A", ownerOptions = {} } = {}) {
  const calls = [], handlers = new Map(), registrations = new Map();
  let taken = false, writeError = false;
  let state = { ...notifySurfaceDefaults("new", "win32"), shortcut: stored };
  state.surfaces.shortcut = enabled;
  const owner = createGlobalShortcut({ platform: "win32", onTrigger: () => {}, globalShortcut: {
    register: (key, cb) => { calls.push(["register", key]); if (taken) return false; registrations.set(key, cb); return true; },
    unregister: key => { calls.push(["unregister", key]); registrations.delete(key); },
  }, ...ownerOptions });
  owner.sync(enabled ? stored : null); calls.length = 0;
  const prefs = {
    get: () => structuredClone(state),
    set: (key, value) => {
      calls.push(["store", key, value]); if (writeError) throw Error("disk");
      if (key === "surfaces.shortcut") state.surfaces.shortcut = value;
      else state[key] = value;
      return prefs.get();
    },
    reset: () => { if (writeError) throw Error("disk"); state = notifySurfaceDefaults("new", "win32"); return prefs.get(); },
  };
  const begin = source.indexOf('ipcMain.handle("notify-surfaces:set",');
  const end = source.indexOf('// The Mac permission prompt', begin);
  vm.runInNewContext(source.slice(begin, end), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    notifySurfacesForEvent: () => prefs, initializeGlobalShortcut: async () => owner, shortcutOwner: owner, refreshBadgePreferences: () => {},
  });
  return { owner, calls, registrations, prefs, set: (key, value) => handlers.get("notify-surfaces:set")({}, key, value),
    reset: () => handlers.get("notify-surfaces:reset")(), taken: () => { taken = true; }, failWrite: () => { writeError = true; } };
}

test("main IPC refuses a taken or invalid key before storage and preserves the active key", async () => {
  const f = fixture(); f.taken();
  assert.deepEqual(plain(await f.set("shortcut", "Control+B")), { ok: false, reason: "taken" });
  assert.deepEqual(plain(await f.set("shortcut", "B")), { ok: false, reason: "invalid" });
  assert.equal(f.prefs.get().shortcut, "Control+A");
  assert.deepEqual([...f.registrations.keys()], ["Control+A"]);
  assert.deepEqual(f.calls, [["register", "Control+B"]]);
});
test("main IPC registers the new key, releases the old key, then persists", async () => {
  const f = fixture();
  assert.equal((await f.set("shortcut", "Control+B")).shortcut, "Control+B");
  assert.deepEqual(f.calls, [["register", "Control+B"], ["unregister", "Control+A"], ["store", "shortcut", "Control+B"]]);
});
test("main IPC returns the unsupported reason without storing a key on Wayland without a portal", async () => {
  const f = fixture({ enabled: false, stored: null, ownerOptions: { platform: "linux", isWayland: () => true } });
  assert.deepEqual(plain(await f.set("shortcut", "Super+A")), { ok: false, reason: "unsupported" });
  assert.equal(f.prefs.get().shortcut, null); assert.deepEqual(f.calls, []);
});
test("clear, surface off and reset all unregister; enabling rechecks availability", async () => {
  const f = fixture();
  await f.set("surfaces.shortcut", false); assert.equal(f.registrations.size, 0);
  assert.equal(f.prefs.get().shortcut, "Control+A");
  await f.set("surfaces.shortcut", true); assert.equal(f.registrations.size, 1);
  await f.set("shortcut", null); assert.equal(f.registrations.size, 0); assert.equal(f.prefs.get().shortcut, null);
  assert.equal((await f.set("surfaces.shortcut", true)).reason, "invalid");
  await f.set("shortcut", "Control+B"); f.reset();
  assert.equal(f.registrations.size, 0); assert.equal(f.prefs.get().shortcut, null);
  const off = fixture({ enabled: false }); off.taken();
  assert.equal((await off.set("surfaces.shortcut", true)).reason, "taken");
  assert.equal(off.prefs.get().surfaces.shortcut, false);
});
test("recording while disabled tests and stores the key without activating the surface", async () => {
  const f = fixture({ enabled: false, stored: null });
  await f.set("shortcut", "Alt+F2");
  assert.deepEqual(f.calls, [["register", "Alt+F2"], ["store", "shortcut", "Alt+F2"], ["unregister", "Alt+F2"]]);
  assert.equal(f.registrations.size, 0);
});
test("write failure restores the prior registration and keeps preferences; failed reset keeps the key", async () => {
  const f = fixture(); f.failWrite();
  await assert.rejects(f.set("shortcut", "Control+B"), /disk/);
  assert.equal(f.prefs.get().shortcut, "Control+A");
  assert.deepEqual([...f.registrations.keys()], ["Control+A"]);
  await assert.rejects(f.set("shortcut", null), /disk/);
  assert.deepEqual([...f.registrations.keys()], ["Control+A"]);
  assert.throws(() => f.reset(), /disk/);
  assert.deepEqual([...f.registrations.keys()], ["Control+A"]);
});
test("ready initialization syncs once, honours the surface switch, and will-quit disposes", async () => {
  for (const enabled of [true, false]) {
    const events = new Map(), calls = [];
    const begin = source.indexOf("function initializeGlobalShortcut(){");
    const end = source.indexOf("/** S9 can replace", begin);
    const state = notifySurfaceDefaults("new", "win32"); state.shortcut = "Alt+F2"; state.surfaces.shortcut = enabled;
    const owner = { sync: value => calls.push(["sync", value]), dispose: () => calls.push(["dispose"]) };
    const context = vm.createContext({ process: { platform: "win32", env: {} }, createGlobalShortcut: () => owner,
      globalShortcut: {}, openShortcut: () => {}, slog: () => {}, desktopShutdownStarted: false,
      notifySurfaces: { get: () => state }, app: { on: (event, cb) => events.set(event, cb) },
    });
    const init = vm.runInContext(`let shortcutOwner=null,shortcutReady=null;\n${source.slice(begin, end)}\ninitializeGlobalShortcut`, context);
    await init(); await init();
    assert.deepEqual(calls, [["sync", enabled ? "Alt+F2" : null]]);
    vm.runInContext(source.match(/app\.on\("will-quit",\(\)=>shortcutOwner\?\.dispose\(\)\);/)[0], context);
    events.get("will-quit")(); assert.deepEqual(calls.at(-1), ["dispose"]);
  }
});
test("press opens Needs you using the tray Inbox path, or the pinned bot compose seam when nothing waits", async () => {
  for (const [summary, botId, expected] of [
    [{ needsYou: 1 }, "bot", [["open"], ["startup-background:open-inbox"]]],
    [null, "bot", [["open"], ["startup-background:open-inbox"]]],
    [{ needsYou: 0 }, "bot", [["open"], ["tray:open", { kind: "compose", botId: "bot" }]]],
    [{ needsYou: 0 }, null, [["open"]]],
  ]) {
    const calls = [], routes = [];
    const begin = source.indexOf("function openPinnedQuickChat(){");
    const end = source.indexOf("function initializeNotifySurfaces(){", begin);
    const trigger = vm.runInNewContext(`${source.slice(begin, end)}\nopenShortcut`, {
      desktopShutdownStarted: false, desktopRecoveryMode: false,
      harnessJson: async route => { routes.push(route); return summary; },
      notifySurfaces: { get: () => ({ pinnedBotId: botId }) },
      backgroundLifecycle: { open: () => calls.push(["open"]) },
      openTarget: target => calls.push(["tray:open", target]),
      sendWhenLoaded: (...args) => calls.push(args),
    });
    await trigger(); assert.deepEqual(plain(calls), expected); assert.deepEqual(routes, ["/api/desktop/tray"]);
  }
});
