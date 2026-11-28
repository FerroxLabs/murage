// 1.0.24 sweep1: the hung-close bound proven on the PRODUCTION native relay (createNativeBrowser), not a hand-made NativeBrowser.
// The engine is a copy of the shell whose `close-owned` verb never answers, so the relay's own close() (ownership record read, daemon
// identity judged, closeOwnedBrowser -> ownedCloseCli.run) is what hangs. Owners: bound = UnifiedBrowserController (q1023-livebrowser
// code, q1024-browserclosing tests), relay = browser-native-relay.ts, this witness = q1024-sweep1.
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { registerBrowserBinding } from './browser-binding-registration.ts';
import { captureDaemonIdentity } from './browser-daemon-identity.ts';
import { createNativeBrowser } from './browser-native-relay.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'murage-real-relay-')); dirs.push(dir); return dir; };
/** Engine = a private copy of /bin/sh, so the daemon's executable is the engine command. Run from the session dir, `engine close-owned
 * ...` opens the script of that name there, which sleeps well past the bound. */
const fixture = async () => {
  const dir = tempDir(), engine = join(dir, 'engine');
  copyFileSync('/bin/sh', engine); chmodSync(engine, 0o755);
  writeFileSync(join(dir, 'close-owned'), 'echo reached > reached.txt\nexec sleep 40\n');
  const child = spawn(engine, ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' }); children.push(child);
  await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
  const exited = Promise.race([new Promise<string | null>(resolve => child.once('exit', (_code, signal) => resolve(signal))),
    new Promise<string>(resolve => setTimeout(() => resolve('still running'), 20_000).unref())]);
  const identity = (await captureDaemonIdentity(child.pid!, engine))!;
  writeFileSync(join(dir, 'session.owner.json'), JSON.stringify({ v: 1, session: 'session', launchId: null,
    daemon: { pid: child.pid, start: identity.start, exe: engine }, group: { kind: 'none' } }));
  const spec = { command: engine, args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir, HOME: dir } };
  return { dir, child, exited, identity, spec, engine };
};
const nextTurn = (controller: UnifiedBrowserController, spec: { command: string; args: string[]; env: Record<string, string> }) =>
  registerBrowserBinding({ controller, botId: 'bot', memo: 'memo', key: 'key', spec, fresh: () => true, bindings: new Map() }).then(() => 'published', (error: { code?: string }) => error.code ?? 'error');

it('R1 the production relay\'s own close hangs on the engine: Restart still settles within the bound, the identified daemon is stopped, the next turn gets the browser', async () => {
  const { dir, exited, identity, spec } = await fixture();
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'),
    createNative: s => { const native = createNativeBrowser(s); native.seedDaemonIdentity?.(identity); return native; } });
  await controller.register('key', spec, 'bot'); await controller.connect('key').catch(() => {});
  const started = Date.now();
  const outcome = await controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');
  expect(existsSync(join(dir, 'reached.txt'))).toBe(true);
  expect(outcome).toBe('restarted');
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(await exited).toBe('SIGKILL');
  expect(controller.holdState('key')).toMatchObject({ closing: false, closeFailed: false });
  expect(await nextTurn(controller, spec)).toBe('published');
}, 60_000);
