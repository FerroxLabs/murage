import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { awaitOwnedWork, OWNED_WORK_TIMEOUT_MS } from './server-child-lifecycle.mjs';
import { createLocalEngineLogin } from './engine-login-local.mjs';

// Execute the production cleanup function with only synthetic owned resources.
// In particular, no Electron app, installed engine or user's profile is opened.
function fixture({ login, android = Promise.resolve() }) {
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function cleanupDesktopForExit(');
  const end = source.indexOf('// Electron restarts a lost GPU', start);
  const done = () => Promise.resolve();
  const release = vi.fn();
  const deps = {
    backupScheduleHost: null, serverStopReason: { logOnce() {} }, stopDeskPresence() {}, sentinelHost: null,
    stopAutomaticRemoteBackups() {}, desktopShutdownStarted: false,
    localEngineLogin: { shutdown: () => login }, modelSignIn: { dispose() {} }, mcpServers: { dispose() {} },
    notificationAuthorization: { invalidate() {} }, showApprovalNotification: { dispose() {} }, bannerNative: null,
    attentionSurfaces: null, desktopBackupTool: { invalidate() {}, settled: done }, desktopResticTool: null,
    remoteBackupAttestation: { abort() {} }, managedComposioShutdown: { abort() {} },
    cuaCleanedUp: false, desktopCleanup: null, syncCompanionKeepAwake() {}, androidDevice: { stop: () => android },
    nativeActions: { appleSpeech: false }, stopRecorder: done, browserSurface: null,
    desktopCleanupStage: '', ownedRelaunchHelpers: new Set(), awaitOwnedWork, ownedServerChildren: new Set(),
    SERVER_CHILD_STOP_TIMEOUT_MS: 17000, desktopStartup: Promise.resolve(), backupToolCheck: Promise.resolve(),
    backupRemoteOperations: new Set(), credentialWrites: new Set(), companionStarts: new Set(),
    stopDesktopCompanion: done, browserLifecycleCleanups: new Map(), browserHost: null,
    cuaReady: Promise.resolve(), CUA_STOP_TIMEOUT_MS: 2500, stopCua: done,
    desktopDataOwner: { release }, exitedServerChildren: new Set(),
  };
  const cleanup = new Function('deps', `with (deps) { ${source.slice(start, end)}; return cleanupDesktopForExit; }`)(deps);
  return { deps, release, run: () => cleanup('internal') };
}
afterEach(() => vi.useRealTimers());

it.each(['login', 'android'])('GH21: a stalled %s stop settles visibly without releasing installation ownership', async stalled => {
  vi.useFakeTimers();
  const f = fixture({ login: Promise.resolve(), [stalled]: new Promise(() => {}) });
  let outcome = 'pending';
  const result = f.run().then(() => { outcome = 'done'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(OWNED_WORK_TIMEOUT_MS + 1);
  expect(outcome).toBe('failed');
  expect(f.deps.desktopCleanupStage).toBe('android helper');
  expect(f.release).not.toHaveBeenCalled();
  expect(f.deps.cuaCleanedUp).toBe(false);
  if (outcome !== 'pending') await result;
});

it('GH21: cleanup may be retried after the owned sign-in finishes', async () => {
  vi.useFakeTimers();
  let finish;
  const f = fixture({ login: new Promise(resolve => { finish = resolve; }) });
  let rejected = false;
  const first = f.run().catch(() => { rejected = true; });
  await vi.advanceTimersByTimeAsync(OWNED_WORK_TIMEOUT_MS + 1);
  expect(rejected).toBe(true); expect(f.release).not.toHaveBeenCalled();
  finish(); await vi.advanceTimersByTimeAsync(0); await first;
  await f.run(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.deps.cuaCleanedUp).toBe(true);
});

it('GH21: a real sign-in already checking its final reply cannot hold backup cleanup forever', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 4242 });
  let finishReply;
  const reply = new Promise(resolve => { finishReply = resolve; });
  const api = vi.fn(async path => {
    if (path === '/api/engine-signin-recipe') return { status: 200, body: { kind: 'headless', argv: ['synthetic-engine', 'login'], env: {} } };
    if (path === '/api/engine-signin-probe') return { status: 200, body: { authenticated: true } };
    if (path === '/api/engine-setup-check') return reply;
    throw Error('Unexpected synthetic request');
  });
  const runner = createLocalEngineLogin({ api, spawn: () => child, killTree() {} });
  expect(await runner.start({ sender: { send() {} }, instanceId: 'synthetic' })).toMatchObject({ ok: true });
  child.emit('close', 0);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(api).toHaveBeenCalledWith('/api/engine-setup-check', { instanceId: 'synthetic' }, { timeoutMs: 120000 });
  const f = fixture({ login: Promise.resolve() });
  f.deps.localEngineLogin = runner;
  let outcome = 'pending';
  const cleanup = f.run().then(() => { outcome = 'done'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(OWNED_WORK_TIMEOUT_MS + 1);
  expect(outcome).toBe('failed');
  expect(f.release).not.toHaveBeenCalled();
  finishReply({ status: 200, body: { result: 'ready' } });
  await cleanup; await f.run();
  expect(runner.isOpen()).toBe(false);
  expect(f.release).toHaveBeenCalledTimes(1);
});
