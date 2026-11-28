import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { registerBrowserBinding } from './browser-binding-registration.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const nativeWith = (close: () => Promise<void>, identity = true) => ({ protected: async () => false, request: async () => ({}), command: async () => ({}), connect: async () => 's', input() {}, resetStream() {}, close, ...(identity ? { daemonIdentity: { pid: 123, start: '100', bootId: 'fixture-boot' } } : {}) });
// A close that failed (the previous browser turn's teardown) is persisted; the next process or turn meets it as "closing".
async function failedClose(dir: string, identity = true) {
  const stateFile = join(dir, 'control.json');
  const native = nativeWith(async () => { throw new Error('close timeout'); }, identity);
  const controller = new UnifiedBrowserController({ stateFile, createNative: () => native as never, judgeDaemon: async () => 'unknown' });
  const spec = { command: 'engine', args: [], env: { AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: 'session' } };
  await controller.register('key', spec, 'bot'); await controller.connect('key');
  await expect(controller.restart('key', 'owner')).rejects.toMatchObject({ status: 503 });
  return { stateFile, spec };
}
const open = (spec: { command: string }, controller: UnifiedBrowserController) => registerBrowserBinding({ controller, botId: 'bot', memo: 'memo', key: 'key', spec: spec as never, fresh: () => true, bindings: new Map() });
it('W1 a new turn after a failed close whose daemon is verifiably gone registers and reuses the browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-closing-')); dirs.push(dir);
  const { stateFile, spec } = await failedClose(dir);
  const controller = new UnifiedBrowserController({ stateFile, createNative: () => nativeWith(async () => {}) as never, judgeDaemon: async () => 'gone' });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: true, closing: true });
  await expect(open(spec, controller)).resolves.toMatchObject({ key: 'key' });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: false, closing: false, registered: true });
});
it('W2 an unconfirmed daemon keeps the exclusion: the turn still refuses with browser_closing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-closing-')); dirs.push(dir);
  const { stateFile, spec } = await failedClose(dir);
  const controller = new UnifiedBrowserController({ stateFile, createNative: () => nativeWith(async () => {}) as never, judgeDaemon: async () => 'unknown' });
  await expect(open(spec, controller)).rejects.toMatchObject({ code: 'browser_closing' });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: true });
});
it('W3 a close still running is waited for, then the turn registers (no early refusal)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-closing-')); dirs.push(dir);
  let release!: () => void, entered!: () => void; const inside = new Promise<void>(r => { entered = r; });
  const native = nativeWith(async () => { entered(); await new Promise<void>(r => { release = r; }); });
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'), createNative: () => native as never, judgeDaemon: async () => 'unknown' });
  const spec = { command: 'engine', args: [], env: {} }; await controller.register('key', spec, 'bot'); await controller.connect('key');
  const restarting = controller.restart('key', 'owner'); await inside;
  const turn = open(spec, controller); let done = false; void turn.then(() => { done = true; });
  await new Promise(r => setTimeout(r, 20)); expect(done).toBe(false);
  release(); await restarting; await turn; expect(done).toBe(true);
});
it('W4 a failed close with no recorded daemon identity and no live session files no longer strands the turn (the 1.0.22 stuck state)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-closing-')); dirs.push(dir);
  const { stateFile, spec } = await failedClose(dir);
  // The persisted entry of an unanswered close that recorded no daemon identity (what the 1.0.22 log shows after a restart).
  const saved = JSON.parse(readFileSync(stateFile, 'utf8')); delete saved[0][1].daemonIdentity; saved[0][1].closeRefused = false; writeFileSync(stateFile, JSON.stringify(saved));
  // The production judge: with no identity it is unknown, so only the session's own (empty) files can prove it gone.
  const controller = new UnifiedBrowserController({ stateFile, createNative: () => nativeWith(async () => {}, false) as never });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: true, closing: true });
  await expect(open(spec, controller)).resolves.toMatchObject({ key: 'key' });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: false, closing: false });
});
it('W4b the real 1.0.22 entry (closeRefused never written, no daemon identity, empty session files) no longer strands the turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-closing-')); dirs.push(dir);
  const { stateFile, spec } = await failedClose(dir);
  // 1.0.22 wrote neither closeRefused nor a daemon identity: take both keys out of the persisted entry.
  const saved = JSON.parse(readFileSync(stateFile, 'utf8')); delete saved[0][1].daemonIdentity; delete saved[0][1].closeRefused; writeFileSync(stateFile, JSON.stringify(saved));
  expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8'))[0][1])).not.toContain('closeRefused');
  const controller = new UnifiedBrowserController({ stateFile, createNative: () => nativeWith(async () => {}, false) as never });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: true, closing: true });
  await expect(open(spec, controller)).resolves.toMatchObject({ key: 'key' });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: false, closing: false });
});
it('W4c a refusal saved as deliberate (closeRefused true) is still never cleared by empty session files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-closing-')); dirs.push(dir);
  const { stateFile, spec } = await failedClose(dir);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8')); delete saved[0][1].daemonIdentity; saved[0][1].closeRefused = true; writeFileSync(stateFile, JSON.stringify(saved));
  const controller = new UnifiedBrowserController({ stateFile, createNative: () => nativeWith(async () => {}, false) as never });
  await expect(open(spec, controller)).rejects.toMatchObject({ code: 'browser_closing' });
  expect(controller.holdState('key')).toMatchObject({ closeFailed: true });
});
