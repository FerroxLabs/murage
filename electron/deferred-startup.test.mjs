import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createDeferredStartup } from './deferred-startup.mjs';
import { resumeBackedUpInstall } from './preupgrade-continuation.mjs';
import { runOfflineBackup } from './backup-offline-return.mjs';
const tick = () => new Promise(setImmediate);
function fixture() {
  const events = [], timers = [], cancelled = [];
  const registry = createDeferredStartup({ failure: e => events.push(e.code ?? 'failure'), record: () => events.push('record'), changed: () => events.push('drain'),
    setTimer: fn => { timers.push(fn); return fn; }, clearTimer: fn => cancelled.push(fn) });
  return { registry, events, timers, cancelled };
}
function resumeOptions(operation, overrides = {}) {
  return { operation, currentVersion: '1', backup: { pendingUpgrade: () => ({ phase: 'return-pending', candidate: { version: '2' } }), verifyUpgrade: async () => {}, markUpgradeInstallRequested: async () => {} },
    updater: { resumeInstall: async (candidate, { beforeInstall }) => { await beforeInstall(candidate); return { status: 'install-requested' }; } }, cleanup: async () => {}, ...overrides };
}
test('B4/A2: real resume remains registered after install-requested; late error presents', async () => {
  const f = fixture(), op = f.registry.begin(); let late;
  op.observe(resumeBackedUpInstall(resumeOptions(op, { updater: { resumeInstall: async (candidate, { beforeInstall, onFailure }) => { late = onFailure; await beforeInstall(candidate); return { status: 'install-requested' }; } } })));
  await tick(); assert.equal(f.registry.size, 1); late(Error('late')); assert.deepEqual(f.events, ['failure']); assert.equal(f.registry.size, 0);
});
test('A3: deadline fences real resume before a late verification can install', async () => {
  const f = fixture(), op = f.registry.begin(); let resolve, installed = 0;
  const options = resumeOptions(op); options.backup.verifyUpgrade = () => new Promise(yes => { resolve = yes; }); options.updater.resumeInstall = async () => { installed++; };
  op.observe(resumeBackedUpInstall(options)); f.timers[0](); assert.deepEqual(f.events, ['STARTUP_PRESENTATION_TIMEOUT']);
  resolve(); await tick(); assert.equal(installed, 0); assert.deepEqual(f.events, ['STARTUP_PRESENTATION_TIMEOUT', 'record']);
});
test('B4: failure before and after cleanup in real resume is delivered', async () => {
  for (const after of [false, true]) {
    const f = fixture(), op = f.registry.begin(); const options = resumeOptions(op);
    if (after) options.cleanup = async () => { throw Error('cleanup'); }; else options.backup.verifyUpgrade = async () => { throw Error('verify'); };
    op.observe(resumeBackedUpInstall(options)); await tick(); assert.deepEqual(f.events, ['failure']);
  }
});
test('A2: real offline recovery construction failure propagates', async () => {
  await assert.rejects(runOfflineBackup({ run: async () => { throw Error('backup'); }, shutdownStarted: () => false,
    showBackupMode() { throw Error('construction'); }, destroyProgress() {}, returnToWorkspace() {}, abandon() {} }), /construction/);
});
test('BF-3: recovery presentation cancels offline deadline and queued callbacks', async () => {
  const f = fixture(), op = f.registry.begin();
  op.observe(runOfflineBackup({ operation: op, run: async () => { throw Error(); }, shutdownStarted: () => false,
    showBackupMode() { f.registry.presented(); }, destroyProgress() {}, returnToWorkspace() {}, abandon() {} }));
  await tick(); assert.equal(f.cancelled.length, 1); const before = [...f.events]; f.timers[0](); assert.deepEqual(f.events, before);
  const next = f.registry.begin(); f.registry.presented(); f.timers[1](); assert.equal(next.active(), false); assert.deepEqual(f.events, [...before, 'drain']);
});
