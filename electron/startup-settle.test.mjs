import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
function splashFixture({ missing = false, destroys = true } = {}) {
  const ticks = [], windows = [];
  let quit = 0;
  const win = { dead: false, isDestroyed() { return this.dead; } };
  if (!missing) windows.push(win);
  const ctx = vm.createContext({ BrowserWindow: { getAllWindows: () => windows.filter(w => !w.dead) },
    setImmediate: fn => ticks.push(fn), setTimeout: fn => ({ unref() {} }),
    app: { on(_name, fn) { ctx.allClosed = fn; }, quit() { quit++; } },
    backgroundLifecycle: null, process: { platform: 'linux' }, recordStartupRefusal() {}, noteShutdownCause() {}, desktopStartupFulfilled: false, shutdownCause: null,
  });
  const start = main.indexOf('let startupSplash = null;');
  const end = main.indexOf('/** Help menu:', start);
  vm.runInContext(main.slice(start, end), ctx);
  const all = main.indexOf('app.on("window-all-closed"');
  vm.runInContext(main.slice(all, main.indexOf('app.on("will-quit"', all)), ctx);
  ctx.splash = { win: missing ? null : win, close() { if (!missing && destroys) { win.dead = true; ctx.allClosed(); } } };
  vm.runInContext('startupSplash = splash; closeStartupSplash();', ctx);
  return { ctx, ticks, windows, get quit() { return quit; } };
}
test('B1: synchronous splash destruction consumes the guard once', () => {
  const f = splashFixture(); assert.equal(f.quit, 0); f.ctx.allClosed(); assert.equal(f.quit, 1);
});
test('A1: failed splash construction cannot swallow immediate recovery close', () => {
  const f = splashFixture({ missing: true }); f.ctx.allClosed(); assert.equal(f.quit, 1);
});
test('A1: close that destroys nothing clears the guard immediately', () => {
  const f = splashFixture({ destroys: false }); f.ctx.allClosed(); assert.equal(f.quit, 1);
});
test('A1: attempt cleanup is scheduled without depending on closed event', () => {
  const f = splashFixture(); assert.equal(f.ticks.length, 1); f.ticks[0](); f.ctx.allClosed(); assert.equal(f.quit, 1);
});

import { settleDesktopStartup, terminalDesktopStartup } from './startup-settle.mjs';
import { formatDesktopCrashRecord } from './diagnostics.mjs';
function settleFixture(overrides = {}) {
  const calls = []; let retry;
  const deps = { record: () => calls.push('record'), cause: () => null, automatic: () => calls.push('automatic'),
    closedBackup: () => false, finishClosedBackup: () => calls.push('closed'), success: () => calls.push('success'),
    packaged: () => true, shutdownStarted: () => false, closeSplash: () => calls.push('close'),
    showRecovery: () => calls.push('recovery'), showError: () => calls.push('box'), cleanup: async () => calls.push('cleanup'),
    retain: fn => { calls.push('retain'); retry = fn; }, exit: code => calls.push(`exit:${code}`), ...overrides };
  return { deps, calls, retry: () => retry() };
}
test('B2: record then recovery, without closing the last splash first', async () => {
  const f = settleFixture(); await settleDesktopStartup(Promise.reject(Error()), f.deps);
  assert.deepEqual(f.calls, ['record', 'recovery']);
});
test('B2/B8: fallback presents before cleanup and exits explicitly with 1', async () => {
  const f = settleFixture({ packaged: () => false }); await settleDesktopStartup(Promise.reject(Error()), f.deps);
  assert.deepEqual(f.calls, ['record', 'record', 'automatic', 'close', 'box', 'cleanup', 'exit:1']);
});
test('B2: owner and system refusal records and closes splash without new UI', async () => {
  for (const cause of ['owner', 'system']) { const f = settleFixture({ cause: () => cause }); await settleDesktopStartup(Promise.reject(Error()), f.deps); assert.deepEqual(f.calls, ['record', 'close']); }
});
test('B2: closed backup keeps its exception; success uses only finalizer', async () => {
  const f = settleFixture({ closedBackup: () => true }); await settleDesktopStartup(Promise.reject(Error()), f.deps); assert.deepEqual(f.calls, ['closed']);
  await settleDesktopStartup(Promise.resolve(), f.deps); assert.deepEqual(f.calls, ['closed', 'success']);
});
test('B9: failed logging cannot suppress recovery; durable record contains code only', async () => {
  const f = settleFixture({ record: () => { throw Error('storage'); } }); await settleDesktopStartup(Promise.reject(Error()), f.deps); assert.deepEqual(f.calls, ['recovery']);
  assert.equal(formatDesktopCrashRecord({ kind: 'startup-refused', code: 'LEASE_IO', message: '/secret' }), 'event=startup-refused code=LEASE_IO');
  assert.equal(formatDesktopCrashRecord({ kind: 'startup-refused', code: '/secret' }), 'event=startup-refused code=STARTUP_FAILED');
});
test('A7/BF-2: throwing presentation and cleanup retain owned work until confirmed', async () => {
  let live = true;
  const f = settleFixture({ showError() { throw Error('presentation'); }, cleanup: async () => { if (live) throw Error('owned child'); } });
  await terminalDesktopStartup(Error(), f.deps);
  assert.ok(f.calls.includes('record')); assert.ok(f.calls.includes('recovery')); assert.ok(f.calls.includes('retain')); assert.ok(!f.calls.includes('exit:1'));
  live = false; f.retry(); await new Promise(setImmediate); assert.ok(f.calls.includes('exit:1'));
});
test('A8: each fallback dependency throwing is observed by the terminal handler', async () => {
  for (const name of ['closeSplash', 'showError', 'showRecovery', 'automatic']) {
    const f = settleFixture({ packaged: () => false, [name]: () => { throw Error(name); } });
    await settleDesktopStartup(Promise.reject(Error()), f.deps).catch(error => terminalDesktopStartup(error, f.deps));
    assert.ok(f.calls.includes('exit:1'), name);
  }
});
test('B2: main has one observed settle call and no finally splash reaction', () => {
  assert.equal((main.match(/settleDesktopStartup\(desktopStartup,/g) ?? []).length, 1);
  assert.ok(!main.includes('desktopStartup.finally(closeSplashWhenNoMainWindow)'));
  assert.match(main, /settleDesktopStartup\(desktopStartup, startupSettleDeps\)\.catch/);
});
function recoveryFixture({ constructThrows = false } = {}) {
  const calls = [], attempts = [];
  const ctx = vm.createContext({
    startupDecisionPending: false, updateRecoveryWords: () => ({}),
    desktopRecoveryMode: false, serverReady: true, recoveryWindow: null, recoveryActivateRegistered: false,
    desktopDataDir: null, backupScheduleHost: null, BrowserWindow: {}, electronIpcMain: {}, dialog: { showErrorBox() { calls.push('box'); } },
    __dirname: '/fixture', readPersistedSkin: () => 'light', nativeTheme: {},
    canRestoreSeparateInstallation() {}, canCaptureSeparateInstallation() {}, runSnapshotDesktopRecovery() {}, runSeparateDesktopRecovery() {}, runEncryptedSeparateDesktopRecovery() {}, runDesktopRecovery() {}, requireDesktopBackupTool() {},
    closeStartupSplash: () => calls.push('close'),
    app: { on() {}, quit() { calls.push('quit'); } },
    openInstallationRecoveryWindow(options) {
      calls.push('construct'); if (constructThrows) throw Error('construction');
      let reject; const loaded = new Promise((_, no) => { reject = no; });
      const window = { isDestroyed: () => false, focus() {} };
      attempts.push({ options, reject, window }); return { window, loaded };
    },
    recordStartupRefusal: () => calls.push('record'), fallbackDesktopStartup: async () => calls.push('fallback'),
    terminalDesktopStartup() {}, startupSettleDeps: {}, deferredStartup: { presented() {} }, noteShutdownCause() {},
  });
  const start = main.indexOf('function showDesktopRecovery('), end = main.indexOf('function canRestoreSeparateInstallation', start);
  vm.runInContext('let recoveryAttempt = null;\n' + main.slice(start, end), ctx);
  return { ctx, calls, attempts, show: () => ctx.showDesktopRecovery() };
}
test('B3: recovery is constructed before splash removal; construction throw leaves splash', () => {
  const f = recoveryFixture(); f.show(); assert.deepEqual(f.calls, ['construct', 'close']);
  const broken = recoveryFixture({ constructThrows: true }); assert.throws(broken.show); assert.deepEqual(broken.calls, ['construct']);
});
test('B3: every other splash caller keeps its replacement or guarded close', () => {
  const upgradeClose = main.slice(main.indexOf("function closeMemoryUpgradeWindow("), main.indexOf("function syncBrowserConnection("));
  assert.doesNotMatch(upgradeClose, /closeStartupSplash\(/);
  assert.match(main, /win\.once\("ready-to-show", closeStartupSplash\)/);
  assert.match(main, /closeStartupSplash\(\{ afterMainWindowClosed: true \}\)/);
  assert.match(main, /function closeSplashWhenNoMainWindow\(\)/);
});

test('A4: explicit causes supersede automatic, and otherwise first cause wins', () => {
  const start = main.indexOf('let shutdownCause = null;'), end = main.indexOf('function recordStartupRefusal', start);
  const ctx = vm.createContext({ app: { quit() {} } }); vm.runInContext(main.slice(start, end), ctx);
  for (const [sequence, expected] of [[['automatic', 'owner', 'system'], 'owner'], [['automatic', 'system', 'owner'], 'system'], [['owner', 'automatic'], 'owner']]) {
    vm.runInContext('shutdownCause = null;', ctx); for (const cause of sequence) ctx.noteShutdownCause(cause);
    assert.equal(vm.runInContext('shutdownCause', ctx), expected);
  }
});
test('A4: SIGTERM or owner Quit during pending startup rechecks cause at rejection', async () => {
  for (const cause of ['system', 'owner']) {
    let reject, current = 'automatic'; const f = settleFixture({ cause: () => current });
    const settled = settleDesktopStartup(new Promise((_, no) => { reject = no; }), f.deps);
    current = cause; reject(Error()); await settled; assert.deepEqual(f.calls, ['record', 'close']);
  }
  assert.match(main, /signalQuitRequested = true;\s+noteShutdownCause\("system"\)/);
  assert.match(main, /beginQuit: \(\) => \{ noteShutdownCause\("system"\)/);
  assert.match(main, /shutdownCause = app.murageShutdownCause \|\| \(backupInternalQuit \? "automatic" : "unclassified"\)/);
});

test('B6: stale recovery rejection only records; current rejection falls back', async () => {
  const f = recoveryFixture(); f.show(); const old = f.attempts[0]; old.options.onClosed(); f.show();
  old.reject(Error('stale')); await new Promise(setImmediate); assert.deepEqual(f.calls.slice(-1), ['record']); assert.equal(f.attempts.length, 2);
  f.attempts[1].reject(Error('current')); await new Promise(setImmediate); assert.deepEqual(f.calls.slice(-1), ['fallback']);
});
test('B6: owner closing recovery clears attempt identity before late load failure', async () => {
  const f = recoveryFixture(); f.show(); f.attempts[0].options.onClosed(); f.attempts[0].reject(Error()); await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['construct', 'close', 'record']);
});

test('B10: Linux optional URL registration observes a rejected promise', async () => {
  const line = main.split('\n').find(line => line.includes('void ensureLinuxUrlHandler'));
  const warnings = [];
  vm.runInNewContext(line, { app: { isPackaged: true }, process: { platform: 'linux' }, ensureLinuxUrlHandler: () => Promise.reject(Error('home lookup')), console: { warn: line => warnings.push(line) } });
  await new Promise(setImmediate); assert.equal(warnings.length, 1);
});

import { EventEmitter } from 'node:events';
import { acknowledgedRelaunchHandoff } from './desktop-relaunch.mjs';
test('BF-2 integration: owned handoff, real cleanup and retained Quit surface survive throwing presentation', async () => {
  const calls = [], ownedRelaunchHelpers = new Set(), child = new EventEmitter();
  child.pid = 123; child.kill = () => calls.push('kill');
  await assert.rejects(acknowledgedRelaunchHandoff({ app: {}, args: [], platform: 'linux',
    env: { APPIMAGE: '/fixture/app', APPDIR: '/fixture/mount' }, execPath: '/fixture/mount/app',
    spawn: () => child, register: owned => ownedRelaunchHelpers.add(owned), ackMs: 1, stopMs: 1 }), { code: 'HANDOFF_HELPER_ALIVE' });
  let quitRetry;
  const noop = () => {}, settled = () => Promise.resolve();
  const disposable = { dispose: noop, invalidate: noop, settled };
  const ctx = vm.createContext({ Promise, setImmediate, ownedRelaunchHelpers,
    serverStopReason: { logOnce: noop }, stopDeskPresence: noop, sentinelHost: null,
    stopAutomaticRemoteBackups: noop, backupScheduleHost: null, desktopShutdownStarted: false,
    localEngineLogin: { shutdown: settled }, modelSignIn: disposable, mcpServers: disposable,
    notificationAuthorization: disposable, showApprovalNotification: disposable,
    desktopBackupTool: disposable, desktopResticTool: null, remoteBackupAttestation: { abort: noop }, managedComposioShutdown: { abort: noop },
    cuaCleanedUp: false, desktopCleanup: null, syncCompanionKeepAwake: noop,
    androidDevice: { stop: settled }, nativeActions: {}, stopRecorder: settled, browserSurface: null,
    desktopCleanupStage: '', awaitOwnedWork: promise => promise, ownedServerChildren: [],
    SERVER_CHILD_STOP_TIMEOUT_MS: 100, desktopStartup: Promise.resolve(), backupToolCheck: Promise.resolve(),
    backupRemoteOperations: [], credentialWrites: [], companionStarts: [], stopDesktopCompanion: settled,
    browserLifecycleCleanups: new Map(), browserHost: null, cuaReady: Promise.resolve(), stopCua: settled,
    CUA_STOP_TIMEOUT_MS: 100, desktopDataOwner: { release: () => calls.push('release') }, exitedServerChildren: [],
    recordStartupRefusal: () => calls.push('record'), shutdownCause: null, noteShutdownCause: noop,
    startupFailureExit: false, closedBackupRequested: false, closeStartupSplash: noop,
    showDesktopRecovery: () => { calls.push('recovery'); throw Error('recovery'); },
    dialog: { showErrorBox: () => { calls.push('box'); throw Error('box'); }, showMessageBox: options => {
      calls.push('surface'); assert.deepEqual(Array.from(options.buttons), ['Quit']);
      return new Promise(resolve => { quitRetry = resolve; });
    } }, app: { exit: code => calls.push(`exit:${code}`) },
  });
  const start = main.indexOf('function cleanupDesktopForExit(');
  vm.runInContext(main.slice(start, main.indexOf('// Electron restarts', start)), ctx);
  const depsStart = main.indexOf('const startupSettleDeps = {');
  vm.runInContext(main.slice(depsStart, main.indexOf('void settleDesktopStartup(desktopStartup', depsStart)) + '\nglobalThis.deps = startupSettleDeps;', ctx);
  await terminalDesktopStartup(Error('handoff'), ctx.deps);
  assert.ok(calls.includes('record')); assert.ok(calls.includes('box')); assert.ok(calls.includes('recovery'));
  assert.ok(calls.includes('surface')); assert.ok(!calls.includes('release')); assert.ok(!calls.includes('exit:1'));
  child.emit('spawn'); assert.ok(!calls.includes('exit:1'));
  child.emit('exit'); quitRetry();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.ok(calls.includes('release')); assert.equal(calls.at(-1), 'exit:1');
});
test('BF-1: surviving handoff helper uses fallback instead of reopening local startup', async () => {
  const f = settleFixture();
  await settleDesktopStartup(Promise.reject({ code: 'HANDOFF_HELPER_ALIVE' }), f.deps);
  assert.ok(f.calls.includes('box')); assert.ok(!f.calls.includes('recovery'));
});
