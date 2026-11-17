// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createBackgroundLifecycle } from "./background-lifecycle.mjs";
import { parseMurageTask, routeMurageTask } from "./badge-surfaces.mjs";
import windowState from "./window-state.cjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
function mainFunction(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return main.slice(start, main.indexOf("\n}", start) + 2);
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function lifecycleFixture() {
  const calls = [];
  let menu, paused = false, summary = { needsYou: 2, items: [], bots: [{ id: "helper", chief: false }, { id: "chief", chief: true }] };
  const options = {
    platform: "linux", loadPreferences: () => ({}), window: () => null,
    login: { read: () => ({ supported: false }) }, createTray: () => ({ isDestroyed: () => false, destroy() {} }),
    setTrayMenu: (_tray, value) => { menu = value; }, probeTray: () => true,
    openWindow: () => calls.push("open"), openInbox: () => calls.push("inbox"), openTarget: target => calls.push(target),
    harness: { get: async route => { calls.push(route); return summary; } },
    automationStatus: async () => ({ paused }),
    setAutomationsPaused: async value => { calls.push(["paused", value]); paused = value; return { paused }; },
    setInterval: () => ({ unref() {} }), clearInterval() {},
  };
  const lifecycle = createBackgroundLifecycle(options);
  return { lifecycle, options, calls, menu: () => menu, summary: value => { summary = value; } };
}

test("Needs you shares the tray Inbox handler and opens the window before navigation", async () => {
  const f = lifecycleFixture();
  await f.lifecycle.start();
  f.calls.length = 0;
  f.lifecycle.openNeedsYou();
  assert.deepEqual(f.calls, ["open", "inbox"]);
  f.calls.length = 0;
  f.menu().find(item => item.label === "See all in Inbox").click();
  assert.deepEqual(f.calls, ["open", "inbox"]);
  f.lifecycle.dispose();
});

test("Chief action reads the current Chief even before tray startup and uses the existing compose target", async () => {
  const f = lifecycleFixture();
  await f.lifecycle.newChiefTask();
  assert.deepEqual(f.calls, ["open", "/api/desktop/tray", { kind: "compose", botId: "chief" }]);
  f.calls.length = 0;
  f.summary({ needsYou: 0, items: [], bots: [{ id: "helper" }] });
  await f.lifecycle.newChiefTask();
  assert.deepEqual(f.calls, ["open", "/api/desktop/tray"]);
  f.calls.length = 0;
  f.summary({ bots: [{ id: "unconfirmed", chief: true }] });
  await f.lifecycle.newChiefTask();
  assert.deepEqual(f.calls, ["open", "/api/desktop/tray"]);
});

test("Pause uses the tray admission setter and repeated actions never resume automations", async () => {
  const f = lifecycleFixture();
  await f.lifecycle.start();
  f.calls.length = 0;
  await f.lifecycle.pauseAutomations();
  await f.lifecycle.pauseAutomations();
  assert.deepEqual(f.calls, [["paused", true], ["paused", true]]);
  assert.equal(f.lifecycle.status().automationsPaused, true);
  f.menu().find(item => item.label === "Resume automations").click();
  await tick();
  assert.deepEqual(f.calls, [["paused", true], ["paused", true], ["paused", false]]);
  assert.equal(f.lifecycle.status().automationsPaused, false);
  f.lifecycle.dispose();
});

test("launch dispatch waits for startup, then checks current preferences; recovery and shutdown suppress it", async () => {
  for (const task of ["new-chief", "needs-you", "pause"]) {
    let release, badgeMenu = true;
    const calls = [];
    const scope = {
      desktopStartup: new Promise(resolve => { release = resolve; }), desktopRecoveryMode: false, desktopShutdownStarted: false,
      notifySurfaces: { get: () => ({ badgeMenu }) }, routeMurageTask, parseMurageTask, process: { argv: [`--murage-task=${task}`] },
      backgroundLifecycle: { open: () => calls.push("open"), openNeedsYou: () => calls.push("needs-you"),
        newChiefTask: () => calls.push("new-chief"), pauseAutomations: () => calls.push("pause") }, slog: () => calls.push("error"),
    };
    vm.createContext(scope);
    vm.runInContext(mainFunction("dispatchBadgeTask"), scope);
    // Execute the actual cold-start call, while desktopStartup is still pending.
    const launch = main.match(/^dispatchBadgeTask\(parseMurageTask\(process.argv\)\);$/m);
    assert.ok(launch);
    vm.runInContext(launch[0], scope);
    assert.deepEqual(calls, []);
    badgeMenu = false;
    release(); await tick();
    assert.deepEqual(calls, ["open"]);
    calls.length = 0; badgeMenu = true;
    vm.runInContext(launch[0], scope); await tick();
    assert.deepEqual(calls, [task]);
    calls.length = 0; scope.desktopRecoveryMode = true;
    vm.runInContext(launch[0], scope); await tick();
    assert.deepEqual(calls, []);
    scope.desktopRecoveryMode = false; scope.desktopShutdownStarted = true;
    vm.runInContext(launch[0], scope); await tick();
    assert.deepEqual(calls, []);
  }
});

test("failed task reads or admission writes open Murage without unhandled rejections", async () => {
  const calls = [];
  const dispatch = vm.runInNewContext(`${mainFunction("dispatchBadgeTask")}; dispatchBadgeTask`, {
    desktopStartup: Promise.resolve(), desktopRecoveryMode: false, desktopShutdownStarted: false,
    notifySurfaces: { get: () => ({ badgeMenu: true }) }, routeMurageTask,
    backgroundLifecycle: { open: () => calls.push("open"), pauseAutomations: async () => { throw new Error("unavailable"); } },
    slog: () => calls.push("error"),
  });
  dispatch("pause"); await tick();
  assert.deepEqual(calls, ["error", "open"]);
});

test("badge input preserves local and open-Cloud unread totals and uses summary.needsYou", () => {
  const calls = [], window = {};
  const scope = {
    cloudHome: { windows: () => new Map([["open", {}]]) }, cloudUnreadCounts: new Map([["open", 6], ["closed", 99]]),
    unreadCount: 3, mainWindow: window, normalizeUnreadCount: windowState.normalizeUnreadCount,
    backgroundLifecycle: { summary: () => ({ needsYou: 2 }) },
    badgeSurfaces: { apply: (counts, win) => calls.push([JSON.parse(JSON.stringify(counts)), win]) },
  };
  const apply = vm.runInNewContext(`${mainFunction("applyUnreadBadge")}; applyUnreadBadge`, scope);
  apply();
  assert.deepEqual(calls, [[{ unread: 9, needsYou: 2 }, window]]);
  scope.unreadCount = 998;
  apply();
  assert.equal(calls[1][0].unread, 999);
  assert.match(main, /onChange:state=>\{applyUnreadBadge\(\);/);
});

test("preference set and reset refresh only after the store accepts the change", async () => {
  const calls = [], handlers = new Map();
  let reject = false;
  const store = { set: (key, value) => { if (reject) throw new Error("invalid"); calls.push(["set", key, value]); return "saved"; },
    reset: () => { calls.push("reset"); return "reset state"; } };
  const begin = main.indexOf("ipcMain.handle(\"notify-surfaces:set\","), end = main.indexOf("// The Mac permission prompt", begin);
  const owner = { sync: () => ({ ok: true }), trySet: () => ({ ok: true }) };
  vm.runInNewContext(main.slice(begin, end), { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    notifySurfacesForEvent: () => store, refreshBadgePreferences: () => calls.push("refresh"), initializeGlobalShortcut: async () => owner, shortcutOwner: owner });
  assert.equal(await handlers.get("notify-surfaces:set")(null, "badgeMenu", false), "saved");
  assert.deepEqual(calls, [["set", "badgeMenu", false], "refresh"]);
  calls.length = 0;
  assert.equal(handlers.get("notify-surfaces:reset")(), "reset state");
  assert.deepEqual(calls, ["reset", "refresh"]);
  calls.length = 0; reject = true;
  await assert.rejects(async () => handlers.get("notify-surfaces:set")(null, "badgeMenu", "bad"));
  assert.deepEqual(calls, []);
});

test("badge initialization stays inside the existing attention startup seam", () => {
  assert.match(mainFunction("initializeAttentionActions"), /initializeBadgeSurfaces\(\)/);
  assert.doesNotMatch(mainFunction("acquireDesktopDataOwner"), /[Bb]adgeSurfaces|[Bb]adgeTask/);
  const startup = main.slice(main.indexOf("const desktopStartup = app.whenReady()"), main.indexOf("// With a main window, its first-paint"));
  assert.doesNotMatch(startup, /initializeBadgeSurfaces|dispatchBadgeTask|parseMurageTask/);
  assert.match(mainFunction("initializeBadgeSurfaces"), /refreshBadgePreferences\(\)/);
  const module = readFileSync(new URL("./badge-surfaces.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(module, /setInterval|requestAnimationFrame|new BrowserWindow/);
});
