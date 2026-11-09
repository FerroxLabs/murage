// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createGlobalShortcut, enableGlobalShortcutPortal, globalShortcutPortalAvailable, SHORTCUT_PORTAL_REASON } from "./global-shortcut.mjs";
import { linuxSessionType } from "./notify-capabilities.mjs";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function fixture({ enabled = true, stored = "Control+A", ownerOptions = {} } = {}) {
  const calls = [], handlers = new Map(), registrations = new Map();
  let taken = false, writeError = false, restoreFailure;
  let state = { ...notifySurfaceDefaults("new", "win32"), shortcut: stored };
  state.surfaces.shortcut = enabled;
  const owner = createGlobalShortcut({ platform: "win32", onTrigger: () => {}, globalShortcut: {
    register: (key, cb) => {
      calls.push(["register", key]);
      if (key === stored && restoreFailure === "throw") throw Error("registration");
      if (taken || (key === stored && restoreFailure === "refuse")) return false;
      registrations.set(key, cb); return true;
    },
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
    reset: () => handlers.get("notify-surfaces:reset")(), taken: () => { taken = true; },
    failWrite: failure => { writeError = true; restoreFailure = failure; } };
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
for (const failure of ["refuse", "throw"]) test(`write failure clears the rejected key when restoring the old key fails: ${failure}`, async () => {
  const f = fixture(); f.failWrite(failure);
  await assert.rejects(f.set("shortcut", "Control+B"), /disk/);
  assert.equal(f.prefs.get().shortcut, "Control+A");
  assert.equal(f.registrations.size, 0);
  assert.equal(f.owner.status().active, false);
  assert.deepEqual(f.calls, [
    ["register", "Control+B"], ["unregister", "Control+A"], ["store", "shortcut", "Control+B"],
    ["register", "Control+A"], ["unregister", "Control+B"],
  ]);
});

// Run the production ready callback and attention initializer with the real shortcut
// controller, session detection and portal adapter. Unrelated backup startup exits
// at its existing blocked branch; all native effects stay inside this VM fixture.
function startupFixture({ platform, env = {}, available = true, enabled = true, stored = "Alt+F2", needsYou = 0, botId = "bot" }) {
  const events = new Map(), registrations = new Map(), calls = [], opens = [], probes = [], routes = [];
  const state = notifySurfaceDefaults("new", platform);
  Object.assign(state, { shortcut: stored, pinnedBotId: botId }); state.surfaces.shortcut = enabled;
  let ready, featureValue = "OtherFeature";
  const readiness = new Promise(resolve => { ready = resolve; });
  const noop = () => {};
  const context = vm.createContext({
    process: { platform, env, argv: [] }, createGlobalShortcut, linuxSessionType,
    enableGlobalShortcutPortal, globalShortcutPortalAvailable,
    app: { isPackaged: false, whenReady: () => readiness, on: (name, cb) => events.set(name, cb),
      commandLine: { getSwitchValue: () => featureValue, appendSwitch: (name, value) => { featureValue = value; } } },
    globalShortcut: {
      register: (key, cb) => { calls.push(["register", key]); registrations.set(key, cb); return true; },
      unregister: key => { calls.push(["unregister", key]); registrations.delete(key); },
    },
    execFile: (file, args, options, cb) => { probes.push([file, args, options]); cb(null, available ? "(<uint32 1>,)" : "(<uint32 0>,)"); },
    initializeNotifySurfaces: () => vm.runInContext("notifySurfaces = fixturePrefs", context),
    fixturePrefs: { get: () => state },
    backgroundLifecycle: { open: () => opens.push(["open"]) },
    openTarget: target => opens.push(["tray:open", plain(target)]),
    sendWhenLoaded: (...args) => opens.push(args),
    harnessJson: async route => { routes.push(route); return { needsYou }; },
    slog: noop, desktopShutdownStarted: false, desktopRecoveryMode: false,
    attentionActions: null, attentionWiring: null, attentionMain: null,
    initializeBadgeSurfaces: noop, createLogindWatcher: () => ({}), spawn: noop,
    powerMonitor: { on: noop }, createLockReader: noop, createLockState: () => ({ onChange: noop }),
    createAttentionActions: () => ({}), wireAttentionInvalidation: noop,
    createPresenceGuard: () => ({ onChange: noop }), createAttentionMain: () => ({}),
    createAttentionIpc: () => ({ install: noop }), electronIpcMain: {},
    takeLaunchCloudLink: async () => false, cloudLive: { start: noop }, desktopMark: noop,
    assertDesktopStartupActive: noop, closedBackupRequested: false,
    dialog: {}, BrowserWindow: {}, session: {}, createServerConnections: noop,
    Menu: { buildFromTemplate: () => ({}), getApplicationMenu: () => null, setApplicationMenu: noop },
    initializeBackupScheduleHost: async () => {}, backupScheduleHost: null,
    BACKUP_MODE_ARGUMENT: "--backup", backupStartupDispatch: () => ({ blocked: true }), showDesktopRecovery: noop,
  });
  const attention = source.slice(source.indexOf("function initializeAttentionActions(){"), source.indexOf("function initializeNotifySurfaces(){"));
  const startup = source.slice(source.indexOf("const desktopStartup = app.whenReady()"), source.indexOf("// With a main window, its first-paint reveal"));
  vm.runInContext(source.match(/^if\(process.platform==="linux".*enableGlobalShortcutPortal.*$/m)[0], context);
  vm.runInContext(`${attention}\n${startup}\n${source.match(/app\.on\("will-quit",\(\)=>shortcutOwner\?\.dispose\(\)\);/)[0]}`, context);
  return { calls, opens, probes, routes, registrations, state, feature: () => featureValue,
    start: async () => { ready(); await vm.runInContext("desktopStartup", context); await vm.runInContext("shortcutReady", context); },
    owner: () => vm.runInContext("shortcutOwner", context),
    repeat: () => vm.runInContext("initializeAttentionActions()", context),
    quit: () => events.get("will-quit")(),
  };
}

for (const [label, platform, env, available] of [
  ["Windows", "win32", {}, true], ["macOS", "darwin", {}, true],
  ["Linux X11", "linux", { XDG_SESSION_TYPE: "x11" }, true],
  ["Wayland portal available", "linux", { XDG_SESSION_TYPE: "wayland" }, true],
  ["Wayland portal unavailable", "linux", { XDG_SESSION_TYPE: "wayland" }, false],
]) test(`production startup registers once and routes the registered callback: ${label}`, async () => {
  for (const [needsYou, botId, expected] of [
    [1, "bot", [["open"], ["startup-background:open-inbox"]]],
    [0, "bot", [["open"], ["tray:open", { kind: "compose", botId: "bot" }]]],
    [0, null, [["open"]]],
  ]) {
    const f = startupFixture({ platform, env, available, needsYou, botId });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.probes, []);
    await f.start();
    assert.ok(f.owner(), "startup creates the shortcut owner");
    f.repeat();
    const wayland = env.XDG_SESSION_TYPE === "wayland";
    assert.equal(f.probes.length, wayland ? 1 : 0);
    assert.equal(f.feature(), wayland ? "OtherFeature,GlobalShortcutsPortal" : "OtherFeature");
    if (!available) {
      assert.deepEqual(f.calls, []);
      assert.equal(f.owner().status().disabledReason, SHORTCUT_PORTAL_REASON);
      assert.deepEqual(f.owner().trySet("Super+B"), { ok: false, reason: "unsupported" });
      assert.equal(f.registrations.size, 0); assert.deepEqual(f.opens, []);
    } else {
      assert.deepEqual(f.calls, [["register", "Alt+F2"]]);
      const press = f.registrations.get("Alt+F2"); press();
      await new Promise(setImmediate);
      assert.deepEqual(f.routes, ["/api/desktop/tray"]); assert.deepEqual(f.opens, expected);
      f.quit(); press(); await new Promise(setImmediate);
      assert.deepEqual(f.calls, [["register", "Alt+F2"], ["unregister", "Alt+F2"]]);
      assert.equal(f.registrations.size, 0); assert.deepEqual(f.opens, expected);
    }
  }
});

test("production startup leaves disabled and unset shortcuts unregistered", async () => {
  for (const options of [{ enabled: false }, { stored: null }]) {
    const f = startupFixture({ platform: "darwin", ...options });
    await f.start();
    assert.ok(f.owner(), "startup creates the shortcut owner even without an active key");
    f.repeat(); f.quit();
    assert.deepEqual(f.calls, []); assert.equal(f.owner().status().active, false);
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
