// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 downgrade message, shell side of the start path. A server child that stopped because the data was saved by a newer Murage
// (MEMORY_SCHEMA_UNSUPPORTED or MEMORY_SCHEMA_NEWER, in the note the real server writer leaves) ends the start on ONE plain screen: what
// to install (the version in data-version.json when it is newer than this build, else the latest version), a Download button to the
// releases page, and Quit. Never the restore page, never another start. main.mjs runs as it ships: the start, the start decision and
// showDesktopRecovery are taken from its source text, as electron/memory-upgrade-window.test.mjs does.
import { withHideInherit } from '../shared/win-hide-child-process.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, test } from 'vitest';
import { launchSecretVia, sendLaunchSecretParent } from './launch-secret.mjs';
import { closedControlDirectory } from './backup-closed-controller.mjs';
import { desktopFluxEnvironment } from './workspace-credentials.mjs';
import { MEMORY_INDEX_STOPPED, clearMemoryUpgradeStatus, readMemoryUpgradeStatus, upgradeTimeoutCode } from './memory-upgrade-status.mjs';
import { memoryUpgradeReporter } from '../server/memory/upgrade-status.ts';
import { MemoryMigrationError } from '../server/memory/schema.ts';

// Absent before the fix: the start then falls through to what it did before, and the assertions below say what is wrong with that.
const marker = await import('../shared/data-version-marker.mjs').catch(() => ({}));
const screen = await import('./newer-data-window.mjs').catch(() => ({}));

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const between = (a, b) => { const at = source.indexOf(a); assert.ok(at >= 0, a); return source.slice(at, source.indexOf(b, at)); };
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const DOWNLOAD = 'https://murage.ai/download';
const SENTENCE = 'Your Murage data was saved by a newer version. Install Murage 1.0.21 or newer to open it. Your data is safe and unchanged.';
const LATEST = 'Your Murage data was saved by a newer version. Install the latest version of Murage to open it. Your data is safe and unchanged.';

async function start({ error, newest, running = '1.0.20' }) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'murage-newer-data-')); roots.push(dataDir);
  if (newest) writeFileSync(path.join(dataDir, 'data-version.json'), JSON.stringify({ v: 1, newest }));
  const seen = { starts: 0, recovery: 0, external: [], quits: 0, windows: [], slog: [] };
  const appEvents = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), { pid: process.pid, postMessage() {} });
  const owner = { utilityServerLeaseEnvironment: () => ({ MURAGE_INTERNAL_DATA_DIR_LEASE: 'private-fixture-capability' }) };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.url = null; this.focused = 0; this.destroyed = false; seen.windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: (fn) => { this.openHandler = fn; } }); }
    static getAllWindows() { return seen.windows.filter(w => !w.destroyed); }
    isDestroyed() { return this.destroyed; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    focus() { this.focused++; } show() {} destroy() { this.destroyed = true; }
  }
  const scope = {
    MEMORY_INDEX_STOPPED, upgradeTimeoutCode, withHideInherit, readMemoryUpgradeStatus, clearMemoryUpgradeStatus,
    ...marker, ...screen,
    path, process: { platform: 'win32', env: {}, resourcesPath: '/fixture/resources' }, restoredConnections: null, restoredHarnessEnvironment: env => env,
    app: { isPackaged: true, getVersion: () => running, getPath: () => '/fixture/user-data', getAppPath: () => '/fixture/resources/app.asar', getLocale: () => 'en-US', on: appEvents.on.bind(appEvents), quit: () => { seen.quits++; } },
    companionToken: 'private-companion', modelProviderCommitToken: 'private-model-provider-commit', mcpCommitToken: 'private-mcp-commit',
    secureCredentials: {}, credentialStoreUnavailable: false, desktopSurfaceSecret: '', browserHost: null,
    launchSecretVia, sendLaunchSecretParent, managedComposioChildEnvironment: (_url, _keys, env) => env, composioBrokerUrl: () => null, fluxComposioBrokerUrlValue: () => '', composioLegacyUntilValue: () => '', phoneSecretsEnv: () => '{}',
    watchMemoryUpgrade: () => ({ stop() {} }), showMemoryUpgradeProgress: () => {}, closeMemoryUpgradeWindow: () => {}, memoryUpgradeBlockedSentence: () => '',
    harnessResourceEnvironment: () => ({}), packagedGepaManifestEnvironment: () => ({ MURAGE_GEPA_MANIFEST_SHA256: '' }), workspaceCredentialEnv: () => ({}), desktopFluxEnvironment, secretSaveRefusedReason: async () => '',
    slog: line => seen.slog.push(String(line)),
    utilityProcess: { fork: (_entry, _args, options) => { proc.environment = options.env; return proc; } },
    receiveDesktopSurfaceSecret: () => false, receiveBrowserControlHold: () => false, receiveBrowserLifecycleCleanup: () => false, syncBrowserConnection: () => {},
    // Each forked child refuses the data: the server's own writer leaves the note, exactly as a refused open does (database.ts
    // upgrade.blocked), and the child exits before it answers.
    pollServerIdentity: async () => { seen.starts++; memoryUpgradeReporter(dataDir, path.basename).blocked(error); return { outcome: 'exited' }; },
    SERVER_BOOT_TIMEOUT_MS: 25, SERVER_BOOT_SLOW_LIMIT_MS: 25, portAvailable: async () => true, compileCacheEnvironment: () => ({}), desktopMark: () => {},
    desktopDataOwner: owner, desktopDataDir: dataDir, closedControlDirectory, assertDesktopStartupActive: () => {}, desktopShutdownStarted: false,
    trackOwnedServerChild: () => ({ exit: new Promise(() => {}), stop: async () => {} }),
    systemLanguage: () => 'en-US',
    crypto: globalThis.crypto, setTimeout, clearTimeout, setImmediate,
    memoryUpgradeBlocked: null, serverStartSlow: false, serverStartConflictOnly: false, serverReady: false, serverProc: null, SERVER_PORT: null,
    startupSplash: null, startupSplashClosing: false, startupSplashCloseAttempt: null, backgroundLifecycle: null, desktopStartupFulfilled: false, shutdownCause: null,
    noteShutdownCause() {}, recordStartupRefusal() {}, requestOwnerQuit: () => { seen.quits++; },
    BrowserWindow: Window, electronIpcMain: { handle() {}, removeHandler() {} }, dialog: {}, __dirname: '/fixture', APP_ICON: '/fixture/icon.png',
    osShell: { openExternal: async url => { seen.external.push(url); } },
    // The restore page: any call is the failure this file is about.
    openInstallationRecoveryWindow: () => { seen.recovery++; const window = new Window({ recovery: true }); return { window, loaded: Promise.resolve() }; },
    desktopRecoveryMode: false, recoveryWindow: null, backupScheduleHost: null,
    readPersistedSkin: () => null, nativeTheme: { shouldUseDarkColors: false }, LOG_DIR: '/fixture/logs',
    canRestoreSeparateInstallation() {}, canCaptureSeparateInstallation() {}, runSnapshotDesktopRecovery() {}, runSeparateDesktopRecovery() {}, runEncryptedSeparateDesktopRecovery() {},
    runDesktopRecovery() {}, requireDesktopBackupTool() {}, deferredStartup: { presented() { seen.presented = true; } }, recoveryActivateRegistered: false,
    startupDecisionPending: false, updateRecoveryWords: () => ({}), returnAuthority: { userQuitRequested: false }, updateRequester: false,
    fallbackDesktopStartup() {}, terminalDesktopStartup() {}, startupSettleDeps: {},
  };
  const ctx = vm.createContext(scope);
  vm.runInContext(between('function closeStartupSplash(', '/** Help menu:')
    + between('async function startServerOn(', 'async function startServerPackaged(')
    + between('async function startServerPackaged(', 'function syncManagedComposioCredentials(')
    + between('let recoveryAttempt = null;', 'function canRestoreSeparateInstallation(')
    // The start's own decision once the server could not start, as main.mjs has it.
    + 'async function decide() { serverReady = await startServerPackaged();\n' + between('  if (app.isPackaged && !serverReady) {', '  if (serverReady && companionEnabledAtRest())') + '}', ctx);
  await ctx.decide();
  await new Promise(resolve => setImmediate(resolve));
  const shown = seen.windows.filter(w => !w.options?.recovery);
  return { seen, ctx, shown, page: shown[0]?.url ? decodeURIComponent(shown[0].url) : '' };
}

for (const [name, error] of [
  ['MEMORY_SCHEMA_UNSUPPORTED (an unknown memory object, as 1.0.19 checkpoint rows are to 1.0.18)', new Error('MEMORY_SCHEMA_UNSUPPORTED')],
  ['MEMORY_SCHEMA_NEWER (a newer memory format)', new MemoryMigrationError('MEMORY_SCHEMA_NEWER', 'MEMORY_SCHEMA_NEWER: newer', { newerVersion: 14 })],
]) test(`${name}: one plain screen names the version in the marker, Download opens the releases page, no restore page, no second start`, async () => {
  const { seen, shown, page } = await start({ error, newest: '1.0.21' });
  assert.equal(seen.recovery, 0, 'the restore/recovery page must never open for data a newer Murage saved');
  assert.equal(seen.starts, 1, 'the start must not be tried again on another port or a second pass');
  assert.equal(shown.length, 1, 'exactly one screen');
  assert.ok(page.includes(SENTENCE), `the sentence is on the screen: ${page.slice(0, 200)}`);
  const win = shown[0];
  assert.equal(win.options.webPreferences?.preload, undefined, 'an inert page: no preload');
  assert.equal(win.options.webPreferences?.nodeIntegration, false);
  assert.equal(win.options.webPreferences?.sandbox, true);
  // Download: the page's button names its action in the title (no preload), the shell opens the releases page in the browser.
  const prevented = [];
  win.webContents.emit('page-title-updated', { preventDefault: () => prevented.push(1) }, 'murage-newer-data:download:1');
  await Promise.resolve();
  assert.deepEqual(seen.external, [DOWNLOAD]);
  assert.equal(prevented.length, 1);
  // Any other title, and any link the page might open, does nothing.
  win.webContents.emit('page-title-updated', { preventDefault() {} }, 'https://example.invalid/');
  assert.deepEqual(win.openHandler?.({ url: 'https://example.invalid/' }), { action: 'deny' });
  assert.deepEqual(seen.external, [DOWNLOAD]);
  assert.equal(seen.quits, 0);
  // Quit, and closing the window, end Murage; nothing starts again.
  win.webContents.emit('page-title-updated', { preventDefault() {} }, 'murage-newer-data:quit:2');
  assert.equal(seen.quits, 1);
  win.emit('close');
  assert.equal(seen.quits, 2);
  assert.equal(seen.starts, 1);
  assert.equal(seen.recovery, 0);
});

test('no marker (data from a build before 1.0.20) or a marker no newer than this build: the screen says the latest version', async () => {
  for (const newest of [undefined, '1.0.20', '1.0.3', 'not-a-version']) {
    const { seen, page } = await start({ error: new Error('MEMORY_SCHEMA_UNSUPPORTED'), newest });
    assert.equal(seen.recovery, 0, `marker ${newest}: the restore/recovery page must never open for data a newer Murage saved`);
    assert.ok(page.includes(LATEST), `${newest}: ${page.slice(0, 200)}`);
    assert.ok(!/1\.0\.(20|3)\b/.test(page), `${newest}: no version is named that would not open the data`);
  }
});

test('the same screen again (a second window activation) focuses it, never a second window or the restore page', async () => {
  const { seen, ctx, shown } = await start({ error: new Error('MEMORY_SCHEMA_UNSUPPORTED'), newest: '1.0.21' });
  ctx.showDesktopRecovery('MEMORY_UPGRADE_BLOCKED');
  assert.equal(seen.windows.filter(w => !w.options?.recovery).length, 1);
  assert.equal(shown[0].focused, 1);
  assert.equal(seen.recovery, 0);
});

test('control: a refusal that is not about newer data (no disk space) still opens the recovery page as before', async () => {
  const { seen, shown } = await start({ error: new MemoryMigrationError('MEMORY_MIGRATION_DISK_SPACE', 'MEMORY_MIGRATION_DISK_SPACE: short', { needBytes: 10, freeBytes: 1, shortBytes: 9 }), newest: '1.0.21' });
  assert.equal(seen.recovery, 1);
  assert.equal(shown.length, 0);
  assert.equal(seen.starts, 1);
});
