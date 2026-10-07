// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStartupSplash, splashPage, STARTUP_STAGES, FIRST_AFTER_UPDATE_NOTE, firstStartOfVersion, noteVersionStarted } from "./startup-splash.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

function fakeBrowserWindow(log) {
  return class {
    constructor(options) {
      log.options = options;
      this.destroyed = false;
      this.webContents = { setWindowOpenHandler() {}, on() {} };
    }
    loadURL(url) { log.url = url; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; log.destroyed = (log.destroyed ?? 0) + 1; }
  };
}

test("splash is inert: no preload, no node, sandboxed, data: page only", () => {
  const log = {};
  const splash = createStartupSplash({ BrowserWindow: fakeBrowserWindow(log) });
  assert.equal(splash.open, true);
  assert.equal(log.options.webPreferences.preload, undefined);
  assert.equal(log.options.webPreferences.nodeIntegration, false);
  assert.equal(log.options.webPreferences.sandbox, true);
  assert.match(log.url, /^data:text\/html/);
  assert.doesNotMatch(log.url, /127\.0\.0\.1/);
});

test("close is idempotent and destroys the window once", () => {
  const log = {};
  const splash = createStartupSplash({ BrowserWindow: fakeBrowserWindow(log) });
  splash.close();
  splash.close();
  assert.equal(log.destroyed, 1);
  assert.equal(splash.open, false);
});

test("a failing window constructor never breaks startup", () => {
  const splash = createStartupSplash({ BrowserWindow: class { constructor() { throw new Error("no display"); } } });
  assert.equal(splash.open, false);
  assert.doesNotThrow(() => splash.close());
});

test("the page carries no app UI or send affordance", () => {
  const page = decodeURIComponent(splashPage({ dark: true }));
  assert.match(page, /Starting Murage/);
  assert.doesNotMatch(page, /<input|<textarea|<button|<script/i);
});

test("no timed 'still starting' line; a first start after an update says so, and only then", () => {
  const plain = decodeURIComponent(splashPage());
  assert.match(plain, /Starting Murage/);
  assert.doesNotMatch(plain, /Still starting|First start after an update/);
  const noted = decodeURIComponent(splashPage({ pct: 50, line: "Checking your skills", note: FIRST_AFTER_UPDATE_NOTE }));
  assert.match(noted, /First start after an update takes a little longer/);
  assert.doesNotMatch(noted, /<script|\u2014|\bsafe|safety/i);
});

test("first start of a version is detected from the last version that finished starting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splash-"));
  try {
    assert.equal(firstStartOfVersion({ userData: dir, appVersion: "1.0.0" }), false, "a brand-new install is not an update");
    noteVersionStarted({ userData: dir, appVersion: "1.0.0" });
    assert.equal(firstStartOfVersion({ userData: dir, appVersion: "1.0.0" }), false);
    assert.equal(firstStartOfVersion({ userData: dir, appVersion: "1.0.1" }), true);
    assert.equal(firstStartOfVersion({ userData: "relative", appVersion: "1.0.0" }), false);
    const broken = { existsSync: () => true, readFileSync: () => { throw new Error("io"); } };
    assert.equal(firstStartOfVersion({ userData: dir, appVersion: "1.0.0", fsImpl: broken }), false);
  } finally { safeWipeSync(dir); }
});

test("the splash denies navigation and popups", () => {
  const handlers = {};
  const BW = class {
    constructor() {
      this.webContents = {
        setWindowOpenHandler: (fn) => { handlers.open = fn; },
        on: (name, fn) => { handlers[name] = fn; },
      };
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; }
    destroy() {}
  };
  createStartupSplash({ BrowserWindow: BW });
  assert.deepEqual(handlers.open(), { action: "deny" });
  let prevented = false;
  handlers["will-navigate"]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test("the splash shows the inline Murage mark above the text, with no scripts or network loads", () => {
  for (const dark of [false, true]) {
    const page = decodeURIComponent(splashPage({ dark }));
    assert.match(page, /<svg class="m"[^>]*aria-label="Murage"/);
    assert.ok(page.indexOf("<svg") < page.indexOf("Starting Murage"));
    assert.match(page, /prefers-color-scheme:dark/);
    assert.doesNotMatch(page, /<script|<img|<link|<iframe|<object|<embed|@import|url\(|https?:|\bsrc=|\bhref=|on\w+=/i);
    assert.match(page, new RegExp(dark ? "#16171a" : "#f7f7f8"));
  }
  assert.match(splashPage(), /^data:text\/html/);
});

test("stage messages map to increasing percentages and never move the bar backwards", () => {
  const order = ["module.loaded", "database.open", "store.ready", "skillSweep.done", "listen", "ready"];
  const pcts = order.map(name => STARTUP_STAGES[name].pct);
  assert.deepEqual(pcts, [30, 45, 50, 85, 95, 100]);
  const urls = [];
  const BW = class {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    loadURL(url) { urls.push(url); return Promise.resolve(); }
    isDestroyed() { return false; }
    destroy() {}
  };
  const splash = createStartupSplash({ BrowserWindow: BW, dark: true });
  assert.equal(urls.length, 1);
  assert.equal(splash.stage("database.open"), true);
  assert.equal(splash.stage("module.loaded"), false); // late
  assert.equal(splash.stage("database.open"), false); // repeat
  assert.equal(splash.stage("bogus"), false);
  assert.equal(splash.stage("__proto__"), false);
  assert.equal(splash.stage("skillSweep.done"), true);
  assert.equal(splash.stage("store.ready"), false); // late
  assert.equal(urls.length, 3);
  const last = decodeURIComponent(urls[2]);
  assert.match(last, /width:85%/);
  assert.match(last, /Almost ready/);
  assert.match(last, /#16171a/); // same background, no flash
  assert.doesNotMatch(last, /<script|\u2014|\bsafe|safety/i);
});

test("the lines walk Starting, conversations, memory, skills, almost ready", () => {
  assert.match(decodeURIComponent(splashPage()), /Starting Murage/);
  assert.equal(STARTUP_STAGES["module.loaded"].line, "Opening your conversations");
  assert.equal(STARTUP_STAGES["database.open"].line, "Loading your memory");
  assert.equal(STARTUP_STAGES["store.ready"].line, "Checking your skills");
  assert.match(decodeURIComponent(splashPage({ pct: 50, line: "Checking your skills" })), /width:50%/);
});

test("the version helpers never throw, even when the app paths are unavailable", () => {
  assert.equal(firstStartOfVersion({ userData: () => { throw new Error("no app"); }, appVersion: () => "1.0.0" }), false);
  assert.doesNotThrow(() => noteVersionStarted({ userData: () => { throw new Error("no app"); }, appVersion: () => "1.0.0" }));
});

test("startup settling leaves the splash for the real window's ready-to-show, and closes it when there is no window", () => {
  const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const fn = /function closeSplashWhenNoMainWindow\(\) \{[^}]*\}/.exec(main)?.[0];
  assert.ok(fn, "main.mjs names the settle handler");
  assert.match(main, /desktopStartup\.finally\(closeSplashWhenNoMainWindow\)/);
  const run = (mainWindow) => { let closed = 0; new Function("mainWindow", "closeStartupSplash", `${fn};closeSplashWhenNoMainWindow();`)(mainWindow, () => { closed++; }); return closed; };
  assert.equal(run({ isDestroyed: () => false }), 0, "a live main window keeps the splash until it paints");
  assert.equal(run(null), 1, "no window at all closes it");
  assert.equal(run({ isDestroyed: () => true }), 1, "a destroyed window closes it");
});
