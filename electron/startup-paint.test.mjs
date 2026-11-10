import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { test } from 'vitest';
import path from 'node:path';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('function createWindow('), source.indexOf('// Local-control screen preview'));
for (const quiet of [false, true]) test(`BF-B1: slow load keeps splash until first paint (quiet=${quiet})`, async () => {
  const timers = [];
  let splash = true, finishLoad;
  class Window extends EventEmitter {
    visible = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, getURL: () => '' });
    isDestroyed() { return false; }
    show() { this.visible = true; }
    loadURL() { return new Promise(resolve => { finishLoad = resolve; }); }
  }
  const noop = () => {};
  const ctx = vm.createContext({ BrowserWindow: Window, app: { isPackaged: true }, desktopRecoveryMode: false,
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: {} }), getAllDisplays: () => [] },
    resolveWindowState: () => ({ bounds: {} }), readWindowState: noop, readPersistedSkin: noop,
    nativeTheme: {}, skinChrome: () => ({}), windowChromeOptions: () => ({}), APP_ICON: '',
    path, __dirname: '/fixture', process: { platform: 'linux', env: {} },
    rendererOriginArguments: () => [], trustedRendererOrigin: noop, cloudHome: null, cloudLive: {},
    slog: noop, desktopMark: noop, startupSplash: { stage: noop }, closeStartupSplash: () => { splash = false; },
    pendingRevealWindows: new Set(), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    WINDOW_REVEAL_FALLBACK_MS: 15000, attachUpdaterWindow: noop, installWindowStatePersistence: noop,
    applyUnreadBadge: noop, appReadiness: { track: noop }, createMainWindowOpenHandler: noop, createMainNavigationGuard: () => ({ willNavigate: noop, willRedirect: noop }),
    createRendererRecovery: () => ({}), serverReady: true, SERVER_PORT: 8799, noteVersionStarted: noop,
  });
  vm.runInContext(body, ctx);
  const win = ctx.createWindow({ quiet });
  for (const timer of timers.filter(t => t.ms <= 16000)) timer.fn();
  assert.equal(splash, true, '15 seconds without content must retain splash');
  assert.equal(win.visible, false, 'pending load must never reveal a blank window');
  finishLoad(); await Promise.resolve();
  assert.equal(splash, true, 'load completion alone is not a first paint');
  win.emit('ready-to-show');
  assert.equal(splash, false);
  assert.equal(win.visible, !quiet);
});

const replaceBody = source.slice(source.indexOf('function replaceMainWindow('), source.indexOf('app.on("before-quit"'));
for (const initiallyVisible of [true, false]) test(`replacement waits for first paint past 15 seconds (visible=${initiallyVisible})`, () => {
  const timers = [];
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    focused = false;
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    isMaximized() { return false; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; }
  }
  const old = new Window();
  old.visible = initiallyVisible;
  old.focused = initiallyVisible;
  const fresh = new Window();
  const ctx = vm.createContext({
    mainWindow: old, pendingSwap: null, replacingMainWindow: false,
    desktopShutdownStarted: false, quitRequested: false, lastWindowReplaceAt: 0,
    pendingRevealWindows: new Set(initiallyVisible ? [] : [old]), maximizeOnShow: new Set(),
    slog() {}, createWindow: ({ quiet }) => {
      assert.equal(quiet, true);
      return fresh;
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    WINDOW_REVEAL_FALLBACK_MS: 15000,
  });
  vm.runInContext(replaceBody, ctx);
  assert.equal(ctx.replaceMainWindow('gpu-lost'), true);
  for (const timer of timers.filter(t => t.ms <= 16000)) timer.fn();
  assert.equal(fresh.visible, false, '15 seconds without paint must not reveal a blank replacement');
  assert.equal(old.destroyed, false, 'retain the old window until its replacement paints');
  assert.equal(old.visible, initiallyVisible);
  fresh.emit('ready-to-show');
  assert.equal(fresh.visible, true);
  assert.equal(fresh.focused, true);
  assert.equal(old.destroyed, true);
  assert.equal(ctx.pendingSwap, null);
});
