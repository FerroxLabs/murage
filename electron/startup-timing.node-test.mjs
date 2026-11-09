// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice A: the splash's clock. Grace, dwell, the one fade and the hand-off to the main window (tests A1 to A9, A14).
// Fake timers and fake windows throughout: nothing here waits in real time.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import path from "node:path";
import {
  SPLASH_FADE_AT_MS, SPLASH_FADE_MS, SPLASH_GRACE_MS, SPLASH_MIN_DWELL_MS, createStartupSplash, splashMode,
} from "./startup-splash.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

function fakeClock() {
  let now = 0, id = 0;
  const queue = [];
  const timers = {
    now: () => now,
    setTimeout: (fn, ms) => { const handle = { id: ++id, at: now + ms, fn }; queue.push(handle); return handle; },
    clearTimeout: (handle) => { const at = queue.indexOf(handle); if (at >= 0) queue.splice(at, 1); },
  };
  const advance = (to) => {
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (!next || next.at > to) break;
      queue.shift(); now = next.at; next.fn();
    }
    now = to;
  };
  return { timers, advance, pending: () => queue.length, get now() { return now; } };
}

function fixture(options = {}) {
  const clock = fakeClock();
  const log = { shown: [], js: [], marks: [], reveals: [], windows: [] };
  class Window extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.dead = false; log.windows.push(this); this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, executeJavaScript: (code) => { log.js.push({ at: clock.now, code }); return Promise.resolve(); } }); }
    loadURL() { return Promise.resolve(); }
    show() { log.shown.push(clock.now); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; }
  }
  const splash = createStartupSplash({ BrowserWindow: Window, mode: "tip", timers: clock.timers, onMark: (name) => log.marks.push([name, clock.now]), ...options });
  const reveal = () => log.reveals.push(clock.now);
  const fades = () => log.js.filter((entry) => entry.code.includes('"kind":"fade"'));
  return { clock, log, splash, reveal, fades };
}

test("A0 the constants are the spec's: 600 grace, 1200 dwell, fade at 1600 for 800", () => {
  assert.deepEqual([SPLASH_GRACE_MS, SPLASH_MIN_DWELL_MS, SPLASH_FADE_AT_MS, SPLASH_FADE_MS], [600, 1200, 1600, 800]);
});

test("A1 grace: a window ready at 400 ms never shows the splash", () => {
  const f = fixture();
  assert.equal(f.log.windows[0].opts.show, false, "created hidden");
  f.clock.advance(400);
  assert.deepEqual(f.log.shown, []);
  f.splash.whenRevealable(f.reveal);
  assert.deepEqual(f.log.reveals, [400], "the window opens at once");
  f.clock.advance(5000);
  assert.deepEqual(f.log.shown, [], "the grace timer was cancelled: nothing of ours ever appears");
  assert.deepEqual(f.log.marks, []);
});

test("A2 grace: a window ready at 700 ms shows the splash at 600 ms and reveals at 1800 ms (dwell)", () => {
  const f = fixture();
  f.clock.advance(599);
  assert.deepEqual(f.log.shown, []);
  f.clock.advance(600);
  assert.deepEqual(f.log.shown, [600]);
  assert.deepEqual(f.log.marks, [["splash.shown", 600]]);
  f.clock.advance(700);
  f.splash.whenRevealable(f.reveal);
  f.clock.advance(1799);
  assert.deepEqual(f.log.reveals, []);
  f.clock.advance(1800);
  assert.deepEqual(f.log.reveals, [1800]);
  f.clock.advance(10000);
  assert.deepEqual(f.log.reveals, [1800], "once");
});

test("A3 dwell never delays the reveal by more than 1200 ms", () => {
  for (const ready of [601, 700, 900, 1500, 1700, 1900, 2300, 2500, 3000, 9000]) {
    const f = fixture();
    f.clock.advance(ready);
    f.splash.whenRevealable(f.reveal);
    f.clock.advance(ready + 5000);
    assert.equal(f.log.reveals.length, 1, `ready ${ready}`);
    assert.ok(f.log.reveals[0] >= ready, `ready ${ready}: never before the window is ready`);
    assert.ok(f.log.reveals[0] - ready <= SPLASH_MIN_DWELL_MS, `ready ${ready}: held ${f.log.reveals[0] - ready}`);
  }
});

test("A4 fade fires once at 1600 ms on a tip start that is still loading, and the reveal waits for it to finish", () => {
  const f = fixture();
  f.clock.advance(1599);
  assert.equal(f.fades().length, 0);
  f.clock.advance(1600);
  assert.deepEqual(f.fades().map((entry) => entry.at), [1600]);
  assert.deepEqual(f.log.marks.map((entry) => entry[0]), ["splash.shown", "splash.fade"]);
  f.clock.advance(9000);
  assert.equal(f.fades().length, 1, "one fade, never a second");
  // a window that becomes ready in the middle of the fade is shown when the fade is done
  const g = fixture();
  g.clock.advance(2000);
  g.splash.whenRevealable(g.reveal);
  g.clock.advance(3000);
  assert.deepEqual(g.log.reveals, [1600 + SPLASH_FADE_MS]);
  // and one that is ready well after it is shown at once
  const h = fixture();
  h.clock.advance(5000);
  h.splash.whenRevealable(h.reveal);
  assert.deepEqual(h.log.reveals, [5000]);
});

test("A4b a window ready before 1600 ms (even at 1599) cancels the fade", () => {
  const f = fixture();
  f.clock.advance(1599);
  f.splash.whenRevealable(f.reveal);
  f.clock.advance(5000);
  assert.equal(f.fades().length, 0);
  assert.deepEqual(f.log.reveals, [1800]);
});

test("A5 no fade on first install, update or memory upgrade starts", () => {
  for (const mode of ["first", "update"]) {
    const f = fixture({ mode });
    f.clock.advance(6000);
    assert.equal(f.fades().length, 0, mode);
    assert.deepEqual(f.log.shown, [600], mode);
  }
  const memory = fixture();
  memory.clock.advance(300);
  memory.splash.set({ mode: "blocking", keepOpen: true, title: "x" });
  memory.clock.advance(6000);
  assert.equal(memory.fades().length, 0, "an upgrade view never fades");
  assert.deepEqual(memory.log.shown, [300], "an upgrade is not held back by the grace");
  const classic = fixture({ mode: undefined });
  assert.equal(classic.log.windows[0].opts.show, true, "the window made for a memory upgrade when there was no splash is drawn at once");
  classic.clock.advance(6000);
  assert.equal(classic.fades().length, 0);
});

test("A6 reduced motion: no fade, reveal not held for a fade", () => {
  const f = fixture({ reducedMotion: true });
  f.clock.advance(1700);
  f.clock.advance(2000);
  assert.equal(f.fades().length, 0);
  f.splash.whenRevealable(f.reveal);
  assert.deepEqual(f.log.reveals, [2000], "dwell long over, nothing else holds it");
  const g = fixture({ reducedMotion: true });
  g.clock.advance(700);
  g.splash.whenRevealable(g.reveal);
  g.clock.advance(3000);
  assert.deepEqual(g.log.reveals, [1800], "the dwell still applies");
});

test("A7 nothing but the main window's own ready-to-show ever reveals it, and the hold is bounded and fires once", () => {
  // rc7 deliberately has no timer that shows a window that has not painted (startup-paint.test.mjs): the splash must not add one
  const f = fixture();
  f.clock.advance(60000);
  assert.deepEqual(f.log.reveals, [], "no reveal without the window's ready");
  f.splash.whenRevealable(f.reveal);
  assert.deepEqual(f.log.reveals, [60000]);
  f.clock.advance(120000);
  assert.deepEqual(f.log.reveals, [60000], "exactly once");
  const late = fixture();
  late.clock.advance(700);
  late.splash.whenRevealable(late.reveal);
  late.clock.advance(701);
  late.splash.close();
  late.clock.advance(60000);
  assert.deepEqual(late.log.reveals, [], "closing the splash during the dwell drops the pending reveal (the caller's own paths close and reveal)");
});

// ---- the real createWindow from main.mjs, with a real splash on a fake clock

const createWindowBody = main.slice(main.indexOf("function createWindow("), main.indexOf("// Local-control screen preview"));
function windowFixture({ quiet = false } = {}) {
  const f = fixture();
  const marks = [];
  class MainWindow extends EventEmitter {
    visible = false;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, getURL: () => "" });
    isDestroyed() { return this.destroyed; }
    show() { this.visible = true; this.shownAt = f.clock.now; }
    loadURL() { return new Promise(() => {}); }
  }
  const noop = () => {};
  const ctx = vm.createContext({
    BrowserWindow: MainWindow, app: { isPackaged: true }, desktopRecoveryMode: false,
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: {} }), getAllDisplays: () => [] },
    resolveWindowState: () => ({ bounds: {} }), readWindowState: noop, readPersistedSkin: noop,
    nativeTheme: {}, skinChrome: () => ({}), windowChromeOptions: () => ({}), APP_ICON: "",
    path, __dirname: "/fixture", process: { platform: "linux", env: {} },
    rendererOriginArguments: () => [], trustedRendererOrigin: noop, cloudHome: null, cloudLive: {},
    slog: noop, desktopMark: (name) => marks.push([name, f.clock.now]), startupSplash: f.splash,
    closeStartupSplash: () => { f.splash.close(); ctx.startupSplash = null; ctx.splashClosedAt = f.clock.now; },
    pendingRevealWindows: new Set(), attachUpdaterWindow: noop, installWindowStatePersistence: noop,
    applyUnreadBadge: noop, createMainWindowOpenHandler: noop, createMainNavigationGuard: () => ({ willNavigate: noop, willRedirect: noop }),
    createRendererRecovery: () => ({}), serverReady: true, SERVER_PORT: 8799, noteVersionStarted: noop,
    startupIpc: { deliver: noop }, setTimeout: noop,
    appReadiness: { track: noop, flush: noop, ready: () => true, defer: noop }, cloudLinks: { drain: noop }, rendererSessions: { track: noop }, deliverPackageInstall: noop, flushCloudLinkEvent: noop,
  });
  vm.runInContext(createWindowBody, ctx);
  const win = ctx.createWindow({ quiet });
  return { ...f, ctx, win, marks };
}

test("A7b a window closed or swapped during a scheduled dwell is never shown; the swap still takes the reveal over", () => {
  const closed = windowFixture();
  closed.clock.advance(700);
  closed.win.emit("ready-to-show");
  assert.equal(closed.win.visible, false, "held for the dwell");
  closed.win.destroyed = true;
  closed.clock.advance(5000);
  assert.equal(closed.win.visible, false, "a destroyed window is never shown");

  const swapped = windowFixture();
  swapped.clock.advance(700);
  swapped.win.emit("ready-to-show");
  assert.equal(swapped.ctx.pendingRevealWindows.has(swapped.win), true, "still pending (a swap can take it over) until the moment it is shown");
  swapped.ctx.pendingRevealWindows.delete(swapped.win); // what replaceMainWindow does
  swapped.clock.advance(5000);
  assert.equal(swapped.win.visible, false, "the swapped-out window is never shown");

  const normal = windowFixture();
  normal.clock.advance(700);
  normal.win.emit("ready-to-show");
  normal.clock.advance(1799);
  assert.equal(normal.win.visible, false);
  normal.clock.advance(1800);
  assert.equal(normal.win.visible, true);
  assert.equal(normal.win.shownAt, 1800);
  assert.equal(normal.ctx.splashClosedAt, 1800, "the splash closes in the same moment as the show");
  assert.deepEqual(normal.marks.filter((m) => m[0] === "splash.handoff"), [["splash.handoff", 1800]]);
  assert.equal(normal.ctx.pendingRevealWindows.has(normal.win), false);
});

test("A7c quiet launches close the splash at ready-to-show with no dwell", () => {
  const f = windowFixture({ quiet: true });
  f.clock.advance(700);
  f.win.emit("ready-to-show");
  assert.equal(f.ctx.splashClosedAt, 700);
  assert.equal(f.win.visible, false, "a quiet window is not shown");
  const fast = windowFixture();
  fast.win.emit("ready-to-show");
  assert.equal(fast.win.visible, true, "ready inside the grace: shown at once");
  assert.equal(fast.log.shown.length, 0, "and the splash was never drawn");
});

test("A8 login launch and backup-mode relaunch create no splash (existing behaviour pinned)", () => {
  const at = main.lastIndexOf("startupSplash = createStartupSplash({ BrowserWindow, dark: nativeTheme");
  assert.ok(at > 0, "the packaged start creates the splash here");
  const before = main.slice(Math.max(0, at - 1400), at);
  assert.match(before, /app\.isPackaged && !process\.argv\.includes\(BACKUP_MODE_ARGUMENT\) && !process\.argv\.includes\("--murage-login"\)/);
  assert.match(before, /if \(!wasOpenedAtLogin\) \{/);
  assert.match(before, /getLoginItemSettings\(\)\.wasOpenedAtLogin === true/);
  assert.equal(main.split("startupSplash = createStartupSplash(").length - 1, 2, "one at start, one for a memory upgrade that has no splash");
});

test("A9 mode is first with no last-started-version and no picture, update when firstStartOfVersion, else tip", () => {
  const dir = path.resolve("/fixture/userData");
  const files = new Map();
  const fsImpl = { existsSync: (file) => files.has(file), readFileSync: (file) => files.get(file) };
  const version = "1.0.19", record = path.join(dir, "last-started-version"), picture = { v: 1 };
  assert.equal(splashMode({ userData: dir, appVersion: version, picture: null, fsImpl }), "first");
  assert.equal(splashMode({ userData: dir, appVersion: version, picture, fsImpl }), "tip", "a saved picture means it has started before");
  files.set(record, "1.0.18\n");
  assert.equal(splashMode({ userData: dir, appVersion: version, picture: null, fsImpl }), "update");
  assert.equal(splashMode({ userData: dir, appVersion: version, picture, fsImpl }), "update");
  files.set(record, "1.0.19\n");
  assert.equal(splashMode({ userData: dir, appVersion: version, picture: null, fsImpl }), "tip");
  assert.equal(splashMode({ userData: () => dir, appVersion: () => version, picture, fsImpl }), "tip");
  assert.equal(splashMode({ userData: "relative", appVersion: version, fsImpl }), "tip", "an unreadable location is a daily start");
  assert.match(main, /const mode = splashMode\(\{ userData: splashUserData, appVersion: splashVersion, picture \}\)/);
  assert.match(main, /startupSplash = createStartupSplash\(\{ BrowserWindow, dark: nativeTheme\.shouldUseDarkColors[^\n]*mode, picture,/);
});

test("A14 closing the splash clears the grace and fade timers", () => {
  const f = fixture();
  assert.equal(f.clock.pending(), 2, "a grace timer and a fade timer");
  f.splash.close();
  assert.equal(f.clock.pending(), 0);
  f.clock.advance(10000);
  assert.deepEqual(f.log.shown, []);
  assert.equal(f.fades().length, 0);
  const shown = fixture();
  shown.clock.advance(700);
  shown.splash.close();
  assert.equal(shown.clock.pending(), 0, "the fade timer is gone too once drawn");
  shown.clock.advance(10000);
  assert.equal(shown.fades().length, 0);
});

test("A14b the 1.0.18 timeline marks are kept: created in main, shown and fade from the splash clock, handoff at the reveal", () => {
  assert.match(main, /desktopMark\("splash\.created"\)/);
  assert.match(main, /desktopMark\("splash\.handoff"\)/);
  assert.match(main, /onMark: desktopMark/);
  assert.doesNotMatch(main, /desktopMark\("splash\.shown"\)/, "shown is marked when the grace draws the window");
});
