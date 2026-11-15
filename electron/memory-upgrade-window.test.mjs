import { withHideInherit } from '../shared/win-hide-child-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'vitest';
import { launchSecretVia, sendLaunchSecretParent } from './launch-secret.mjs';
import { closedControlDirectory } from './backup-closed-controller.mjs';
import { desktopFluxEnvironment } from './workspace-credentials.mjs';
import { openInstallationRecoveryWindow } from './installation-recovery-window.mjs';
import { MEMORY_INDEX_STOPPED, upgradeTimeoutCode } from './memory-upgrade-status.mjs';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const between = (a,b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
for (const outcome of ['timeout', 'exited']) test(`BF-B2: ${outcome} during upgrade retains a window until recovery exists`, async () => {
  const events = [];
  let windows = 1, quits = 0, splashDestroyed = false;
  const queue = [], recoveryWindows = [];
  const appEvents = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), { pid: 12, postMessage() {} });
  const owner = { utilityServerLeaseEnvironment:()=>({MURAGE_INTERNAL_DATA_DIR_LEASE:"private-fixture-capability"}) };
  const scope = {
    MEMORY_INDEX_STOPPED, upgradeTimeoutCode, withHideInherit,
    path, process:{platform:"linux",env:{},resourcesPath:"/fixture/resources"},restoredConnections:null,restoredHarnessEnvironment:env=>env,
    app:{isPackaged:true,getVersion:()=>"1.0.0",getPath:()=>"/fixture/user-data",getAppPath:()=>"/fixture/resources/app.asar"}, companionToken:"private-companion",
    modelProviderCommitToken:"private-model-provider-commit",
    mcpCommitToken:"private-mcp-commit",
    secureCredentials:{},credentialStoreUnavailable:false,desktopSurfaceSecret:"",browserHost:null,
    launchSecretVia,sendLaunchSecretParent,managedComposioChildEnvironment:(_url,_keys,env)=>env, composioBrokerUrl:()=>null, fluxComposioBrokerUrlValue:()=>"", composioLegacyUntilValue:()=>"", phoneSecretsEnv:()=>"{}",
    watchMemoryUpgrade:()=>({stop(){}}),showMemoryUpgradeProgress:()=>{},closeMemoryUpgradeWindow:()=>{},clearMemoryUpgradeStatus:()=>{},memoryUpgradeBlockedSentence:()=>"",readMemoryUpgradeStatus:()=>null,harnessResourceEnvironment:()=>({}),packagedGepaManifestEnvironment:()=>({MURAGE_GEPA_MANIFEST_SHA256:""}),workspaceCredentialEnv:()=>({}),desktopFluxEnvironment,secretSaveRefusedReason:async()=>"",slog:()=>{},
    utilityProcess:{fork:(_entry,_args,options)=>{proc.environment=options.env;return proc;}},
    receiveDesktopSurfaceSecret:()=>false,receiveBrowserControlHold:()=>false,receiveBrowserLifecycleCleanup:()=>false,syncBrowserConnection:()=>{},
    pollServerIdentity: async () => ({ outcome }),SERVER_BOOT_TIMEOUT_MS:25,SERVER_BOOT_SLOW_LIMIT_MS:25,portAvailable: async () => true,compileCacheEnvironment:()=>({}),desktopMark:()=>{},
    desktopDataOwner:owner,desktopDataDir:"/canonical/installation",closedControlDirectory,assertDesktopStartupActive:()=>{},desktopShutdownStarted:false,
    trackOwnedServerChild:(child)=>({exit:new Promise(()=>{}),stop: async () => { events.push("child stopped"); while (queue.length) queue.shift()(); }}),
    // The app locale handed to the server for channel replies (U25); none in this fixture.
    systemLanguage:()=>undefined,
  };
  class Window extends EventEmitter {
    visible = true;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
    constructor() { super(); windows++; recoveryWindows.push(this); events.push('recovery created'); }
    static getAllWindows() { return [...(splashDestroyed ? [] : [splashWin]), ...recoveryWindows]; }
    isDestroyed() { return false; }
    loadFile() { return Promise.resolve(); }
  }
  const splashWin = { isDestroyed: () => splashDestroyed };
  Object.assign(scope, {
    crypto: globalThis.crypto, setTimeout, clearTimeout, memoryUpgradeBlocked: null, upgradeScreen: {}, lastUpgradeView: 'upgrade',
    startupSplashClosing: false, startupSplashCloseAttempt: null, setImmediate: fn => queue.push(fn),
    backgroundLifecycle: null, desktopStartupFulfilled: false, shutdownCause: null,
    noteShutdownCause() {}, recordStartupRefusal() {},
    startupSplash: { upgrading: true, win: splashWin, close() {
      splashDestroyed = true; windows--; events.push('splash closed');
      if (!windows) queue.push(() => appEvents.emit('window-all-closed'));
    } },
    readMemoryUpgradeStatus: () => outcome === 'timeout' ? { state: 'upgrading' } : { state: 'blocked', code: 'MEMORY_MIGRATION_DISK' },
    BrowserWindow: Window, electronIpcMain: { handle() {}, removeHandler() {} }, dialog: {}, __dirname: '/fixture',
    openInstallationRecoveryWindow, desktopRecoveryMode: false, recoveryWindow: null, backupScheduleHost: null,
    readPersistedSkin: () => null, nativeTheme: {}, LOG_DIR: '/fixture/logs',
    canRestoreSeparateInstallation() {}, canCaptureSeparateInstallation() {}, runSnapshotDesktopRecovery() {},
    runSeparateDesktopRecovery() {}, runEncryptedSeparateDesktopRecovery() {}, runDesktopRecovery() {}, requireDesktopBackupTool() {},
    deferredStartup: { presented() {} }, recoveryActivateRegistered: false,
    startupDecisionPending: false, recoveryAttempt: null, updateRecoveryWords: () => ({}),
    returnAuthority: { userQuitRequested: false }, updateRequester: false,
  });
  scope.app.getLocale = () => 'en'; scope.app.on = appEvents.on.bind(appEvents); scope.app.quit = () => { quits++; };
  const ctx = vm.createContext(scope);
  vm.runInContext(between('function closeStartupSplash(', '/** Help menu:')
    + between('app.on("window-all-closed"', 'app.on("will-quit"')
    + between('function closeMemoryUpgradeWindow(', 'function syncBrowserConnection(')
    + between('async function startServerOn(', 'async function startServerPackaged(')
    + between('function showDesktopRecovery(', 'function canRestoreSeparateInstallation('), ctx);
  const result = await ctx.startServerOn(8799);
  assert.equal(result.reason, 'memory-blocked');
  assert.equal(quits, 0, 'stopping the child must not close the only window and quit');
  const recovery = ctx.showDesktopRecovery('MEMORY_UPGRADE_BLOCKED');
  await Promise.resolve();
  assert.equal(recovery.visible, true);
  assert.equal(quits, 0);
  assert.equal(windows, 1);
  assert.ok(events.indexOf('recovery created') < events.indexOf('splash closed'));
});
