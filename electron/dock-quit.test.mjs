import { createReturnAuthority, revokeReturn, joinExplicitQuit } from './backup-offline-return.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'vitest';
import { settleDesktopStartup, fallbackDesktopStartup, terminalDesktopStartup } from './startup-settle.mjs';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
function fixture(failCleanup) {
  const logs = [], surfaces = [], queue = [];
  let handler;
  const ctx = vm.createContext({ shutdownCause: null, quitRequested: false, startupFailureExit: false,
    returnAuthority: createReturnAuthority(), revokeReturn,
    joinExplicitQuit: options => joinExplicitQuit({ ...options, scheduleExit: fn => queue.push(fn), setTimer() {} }),
    startupDecisionPending: false, updateRecoveryDescriptor: null, updateRequester: false,
    finishUpdateWait() {}, takeBackupProgress: () => null, cleanupFailed: () => surfaces.push('recovery'),
    noteShutdownCause() {}, app: { on: (_, fn) => { handler = fn; }, quit() {} },
    recordStartupRefusal: error => logs.push(error.code), slog: line => logs.push(line),
    backgroundLifecycle: null, cuaCleanedUp: false, desktopCleanup: null, desktopCleanupStage: 'owned harness',
    cleanupDesktopForExit: () => failCleanup ? Promise.reject(Error('held')) : Promise.resolve(),
    setImmediate: fn => queue.push(fn), dialog: { showErrorBox: () => surfaces.push('dialog') },
  });
  vm.runInContext(source.slice(source.indexOf('app.on("before-quit", (e) => {')), ctx);
  handler({ preventDefault() {} });
  const deps = { cause: () => ctx.shutdownCause, record() {}, closeSplash() {},
    closedBackup: () => false, packaged: () => true, shutdownStarted: () => false,
    automatic: () => surfaces.push('automatic'), showRecovery: () => surfaces.push('window'),
    showError: () => surfaces.push('A7'), retain: () => surfaces.push('retained window'),
    cleanup: async () => {}, exit() {}, success() {} };
  return { ctx, logs, surfaces, deps, queue };
}
for (const failCleanup of [false, true]) test(`DQ-1: unmarked Dock Quit stays unclassified and opens no UI (cleanup fails: ${failCleanup})`, async () => {
  const f = fixture(failCleanup);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.ctx.shutdownCause, 'unclassified');
  assert.ok(f.logs.some(line => /unclassified/i.test(line)));
  await settleDesktopStartup(Promise.reject(Error('late startup')), f.deps);
  await fallbackDesktopStartup(Error('fallback'), f.deps);
  await terminalDesktopStartup(Error('terminal'), f.deps);
  await settleDesktopStartup(Promise.reject(Error('backup')), { ...f.deps, closedBackup: () => true, finishClosedBackup: () => f.surfaces.push('backup window') });
  assert.deepEqual(f.surfaces, []);
});
