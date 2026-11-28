// 1.0.23 livebrowser: a browser whose close fails or hangs never stays "still closing". A daemon proven to be this session's is
// stopped by its exact process number within a bound; a refusal with no daemon left is cleared at boot and by Restart; and the
// next turn's registration (registerBrowserBinding, the turn path) gets the browser. A session that still shows a live daemon
// and cannot be proven ours stays refused.
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { registerBrowserBinding } from './browser-binding-registration.ts';
import { captureDaemonIdentity } from './browser-daemon-identity.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import type { NativeBrowser } from './browser-native-relay.ts';
const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'murage-close-bound-')); dirs.push(dir); return dir; };
/** A real process standing in for the session's daemon. */
const daemon = async () => {
  const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' }); children.push(child);
  await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
  const exited = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)));
  return { child, exited };
};
const fakeNative = (over: Partial<NativeBrowser> = {}): NativeBrowser => ({ protected: async () => false, request: async () => ({ tools: [] }), command: async () => ({}), connect: async () => 'stream', input() {}, resetStream() {}, close: async () => {}, ...over });
const nextTurn = (controller: UnifiedBrowserController, spec: { command: string; args: string[]; env: Record<string, string> }) =>
  registerBrowserBinding({ controller, botId: 'bot', memo: 'memo', key: 'key', spec, fresh: () => true, bindings: new Map() }).then(() => 'published', (error: { code?: string }) => error.code ?? 'error');
const failedState = (stateFile: string, socketDir: string, extra: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify([['key', { generation: 1, held: false, owner: null, protectedDocument: false, protectedReason: null,
  closeFailed: true, ...extra, closeTarget: { botId: 'bot', command: '/fixture/no-engine', socketDir, session: 'session' } }]]));

/** An engine binary that really hangs: a private copy of bash, with BASH_ENV (passed through the controller's closeSpec seam) running a sleep before
 * bash opens the "script" named by the close-owned arguments. The same binary is the session's daemon, so its program matches the engine as in production. */
const hangingEngine = (dir: string) => {
  const engine = join(dir, 'engine'); copyFileSync('/bin/bash', engine); chmodSync(engine, 0o755);
  const hang = join(dir, 'hang.sh'); writeFileSync(hang, 'echo $$ > "$HANG_PID_FILE"\nexec /bin/sleep 600\n');
  return { engine, env: { BASH_ENV: hang, HANG_PID_FILE: join(dir, 'hang.pid') } };
};

it('W1 a close that never settles on the production relay: the identified daemon is stopped by its exact pid within the bound and the next turn gets the browser', async () => {
  const dir = tempDir(); const { engine, env } = hangingEngine(dir);
  const child = spawn(engine, ['-c', '/bin/sleep 600; :'], { stdio: 'ignore' }); children.push(child);
  await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
  const exited = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)));
  const identity = await captureDaemonIdentity(child.pid!, engine);
  expect(identity?.pid).toBe(child.pid);
  const spec = { command: engine, args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  // The session's ownership record names this daemon, so the real close-only relay goes on to the real close-owned command, which never answers.
  writeFileSync(join(dir, 'session.owner.json'), JSON.stringify({ v: 1, session: 'session', launchId: null, daemon: { pid: child.pid, start: identity!.start, exe: realpathSync(engine) }, group: { kind: 'none' } }));
  writeFileSync(join(dir, 'control.json'), JSON.stringify([['key', { generation: 1, held: false, owner: null, protectedDocument: false, protectedReason: null,
    closeFailed: true, closeRefused: false, daemonIdentity: identity, closeTarget: { botId: 'bot', command: engine, socketDir: dir, session: 'session' } }]]));
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'),
    closeSpec: target => ({ command: target.command, args: [], env: { AGENT_BROWSER_SOCKET_DIR: target.socketDir, AGENT_BROWSER_SESSION: target.session, ...env } }) });
  const started = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error'),
    new Promise<string>(resolve => { timer = setTimeout(() => resolve('still closing'), 20_000); })]).finally(() => clearTimeout(timer));
  expect(existsSync(join(dir, 'hang.pid'))).toBe(true); // the real close-owned command was started and hung
  expect(outcome).toBe('restarted');
  expect(Date.now() - started).toBeLessThan(12_000);
  expect(await exited).toBe('SIGKILL');
  expect(controller.holdState('key')).toMatchObject({ closing: false, closeFailed: false });
  expect(await nextTurn(controller, spec)).toBe('published');
  try { process.kill(Number(readFileSync(join(dir, 'hang.pid'), 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
}, 40_000);

it('W2 boot: a saved refusal with no daemon identity and nothing of the session left is cleared, and the first turn gets the browser', async () => {
  const dir = tempDir(), stateFile = join(dir, 'control.json'); failedState(stateFile, dir, { closeRefused: false });
  const controller = new UnifiedBrowserController({ stateFile });
  await controller.recoverClosedEntries();
  expect(await nextTurn(controller, { command: '/fixture/no-engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } })).toBe('published');
}, 30_000);

it('W3 Restart: the same saved refusal is cleared by the owner Restart, which no longer fails again on the missing ownership record', async () => {
  const dir = tempDir(), stateFile = join(dir, 'control.json'); failedState(stateFile, dir);
  const controller = new UnifiedBrowserController({ stateFile });
  const outcome = await controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');
  expect(outcome).toBe('restarted');
  expect(controller.holdState('key')).toMatchObject({ closing: false, closeFailed: false });
  expect(await nextTurn(controller, { command: '/fixture/no-engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } })).toBe('published');
}, 30_000);

it('W4 fail-closed: a session whose pid file names a live process and no proven identity stays refused, and that process is left alone', async () => {
  const dir = tempDir(), stateFile = join(dir, 'control.json'); failedState(stateFile, dir);
  const { child } = await daemon(); writeFileSync(join(dir, 'session.pid'), String(child.pid));
  const controller = new UnifiedBrowserController({ stateFile });
  await controller.recoverClosedEntries();
  const outcome = await controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');
  expect(outcome).toBe('browser_close_failed');
  expect(await nextTurn(controller, { command: '/fixture/no-engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } })).toBe('browser_closing');
  expect(child.exitCode === null && child.signalCode === null).toBe(true);
}, 30_000);

it('W5 a daemon check that never answers cannot hold the close open: Restart settles within the bound', async () => {
  const dir = tempDir();
  const spec = { command: '/fixture/engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'), judgeDaemon: () => new Promise(() => {}),
    createNative: () => fakeNative({ daemonIdentity: { pid: 2_000_000_000, start: '1', bootId: 'fixture-boot' }, close: async () => { throw new Error('close refused'); } }) });
  await controller.register('key', spec, 'bot'); await controller.connect('key');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error'),
    new Promise<string>(resolve => { timer = setTimeout(() => resolve('still closing'), 15_000); })]).finally(() => clearTimeout(timer));
  expect(outcome).toBe('browser_close_failed');
  expect(controller.holdState('key')).toMatchObject({ closeFailed: true });
}, 30_000);

it('W6 a close that answered with a refusal (not a missing answer) never stops the daemon, even one proven to be the session\'s', async () => {
  const dir = tempDir(); const { child } = await daemon();
  const identity = await captureDaemonIdentity(child.pid!, '/bin/sleep');
  const spec = { command: '/bin/sleep', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'),
    createNative: () => fakeNative({ daemonIdentity: identity, close: async () => { throw Object.assign(new Error('not proven'), { name: 'OwnedCloseError', code: 'ownership_unproven' }); } }) });
  await controller.register('key', spec, 'bot'); await controller.connect('key');
  const outcome = await controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');
  expect(child.exitCode === null && child.signalCode === null).toBe(true);
  expect(outcome).toBe('browser_close_failed');
}, 30_000);

it('W7 a recorded pid whose program is not the engine binary is never stopped, even when its close does not answer', async () => {
  const dir = tempDir(); const { child } = await daemon();
  const identity = await captureDaemonIdentity(child.pid!, '/bin/sleep');
  const spec = { command: join(dir, 'engine'), args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  writeFileSync(spec.command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'),
    createNative: () => fakeNative({ daemonIdentity: identity, close: () => new Promise<void>(() => {}) }) });
  await controller.register('key', spec, 'bot'); await controller.connect('key');
  const outcome = await controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');
  expect(child.exitCode === null && child.signalCode === null).toBe(true);
  expect(outcome).toBe('browser_close_failed');
}, 30_000);

it('W6b with no daemon identity, a deliberate refusal still stands even though the session files name nothing running', async () => {
  const dir = tempDir();
  const spec = { command: '/fixture/engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'),
    createNative: () => fakeNative({ close: async () => { throw Object.assign(new Error('helpers left'), { name: 'OwnedCloseError', code: 'orphans_remain' }); } }) });
  await controller.register('key', spec, 'bot'); await controller.connect('key');
  const outcome = await controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');
  expect(outcome).toBe('browser_close_failed');
}, 30_000);

it('W8 a deliberate refusal survives a server restart: boot recovery and Restart never clear it from empty session files', async () => {
  const dir = tempDir(), stateFile = join(dir, 'control.json');
  const spec = { command: '/fixture/engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  const first = new UnifiedBrowserController({ stateFile,
    createNative: () => fakeNative({ close: async () => { throw Object.assign(new Error('helpers left'), { name: 'OwnedCloseError', code: 'orphans_remain' }); } }) });
  await first.register('key', spec, 'bot'); await first.connect('key');
  await first.restart('key', 'owner').catch(() => {});
  const restored = new UnifiedBrowserController({ stateFile, createNative: () => fakeNative({ close: async () => { throw new Error('Browser ownership is unconfirmed; try closing it again'); } }) });
  await restored.recoverClosedEntries();
  expect(await nextTurn(restored, spec)).toBe('browser_closing');
  const outcome = await restored.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');
  expect(outcome).toBe('browser_close_failed');
}, 30_000);

it('W9 upgrade (1.0.24 browserclosing, reverses the 1023 ruling by Sean log N5): a refusal saved before its reason was kept, with no daemon identity and nothing of the session left, is cleared at boot and the first turn gets the browser', async () => {
  const dir = tempDir(), stateFile = join(dir, 'control.json'); failedState(stateFile, dir);
  const controller = new UnifiedBrowserController({ stateFile });
  await controller.recoverClosedEntries();
  expect(await nextTurn(controller, { command: '/fixture/no-engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } })).toBe('published');
}, 30_000);

it('W10 upgrade (1.0.24 browserclosing): shutting the server down keeps a legacy refusal legacy (never saved as deliberate), so the next boot clears it from the empty session files', async () => {
  const dir = tempDir(), stateFile = join(dir, 'control.json'); failedState(stateFile, dir);
  const before = new UnifiedBrowserController({ stateFile });
  await before.close();
  const after = new UnifiedBrowserController({ stateFile });
  await after.recoverClosedEntries();
  expect(await nextTurn(after, { command: '/fixture/no-engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } })).toBe('published');
}, 30_000);

it('W11 upgrade: forgetting a profile (a release that may run unattended) never clears a refusal saved before its reason was kept', async () => {
  const dir = tempDir(), stateFile = join(dir, 'control.json'); failedState(stateFile, dir);
  const controller = new UnifiedBrowserController({ stateFile });
  const outcome = await controller.forgetEntry('key').then(() => 'forgotten', (error: { code?: string }) => error.code ?? 'error');
  expect(outcome).toBe('browser_close_failed');
  expect(controller.holdState('key')).toMatchObject({ closeFailed: true });
}, 30_000);
