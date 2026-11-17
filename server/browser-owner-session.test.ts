import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { BrowserLifecycleGate } from './browser-lifecycle-gate.ts';
import { browserOwnerSessionRequest } from './browser-owner-session.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'murage-owner-session-')); dirs.push(dir);
  const spec = { command: '/fixture/engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  const native = { daemonIdentity: { pid: 123, start: '100', bootId: 'boot' }, seedDaemonIdentity: vi.fn(), protected: async () => false, request: async () => ({ tools: [] }), command: async () => ({}), connect: async () => 'stream', input() {}, resetStream() {}, close: vi.fn(async () => {}) };
  let verdict: 'unknown' | 'alive' | 'gone' = 'alive';
  const stateFile = join(dir, 'control.json');
  let controller = new UnifiedBrowserController({ stateFile, createNative: () => native, judgeDaemon: async () => verdict });
  const bot = { id: 'bot', name: 'Kai', selectionRevision: 0 };
  const bind = vi.fn(async () => { await controller.register('key', spec, bot.id); return { key: 'key' }; });
  const options = { get controller() { return controller; }, lifecycle: new BrowserLifecycleGate(), bot: () => bot, currentKey: () => 'key' as string | null, bind, owner: 'person', canReclaim: true, active: () => true, afterHoldEnded: vi.fn() };
  const request = (method: string, body: Record<string, unknown> = {}, scope?: string) => browserOwnerSessionRequest({ ...options, cloudDesktop: scope === 'owner-desktop' }, method, body);
  const fail = async () => { await bind(); await controller.connect('key'); native.close = vi.fn(async () => { throw new Error('close timeout'); }); await controller.restart('key', 'person').catch(() => {}); };
  return { native, options, bind, bot, request, fail, get controller() { return controller; }, verdict: (v: typeof verdict) => { verdict = v; }, restore() { controller = new UnifiedBrowserController({ stateFile, createNative: () => native, judgeDaemon: async () => verdict }); } };
}
it('T20/T22/M56s/M61s refuses every legacy POST before binding or controller mutation', async () => {
  const f = await fixture();
  for (const action of ['take', 'release', 'reclaim', 'reopen', 'restart', 'retry', 'navigate', 'input']) {
    await expect(f.request('POST', { action })).rejects.toMatchObject({ code: 'client_outdated', status: 409, message: 'Murage was updated. Reload this page, then try again.' });
    await expect(f.request('POST', { action }, 'owner-desktop')).rejects.toMatchObject({ code: 'client_outdated', message: 'Update Murage on this computer, then try again.' });
  }
  expect(f.bind).not.toHaveBeenCalled();
});
it('T15/M50s rejects stale revisions and equal-epoch actions for another key', async () => {
  const f = await fixture();
  for (const body of [{ expectedRevision: 1, expectedKey: 'key' }, { expectedRevision: 0, expectedKey: 'other' }]) await expect(f.request('POST', { action: 'take', ...body })).rejects.toMatchObject({ code: 'revision_changed' });
  expect(f.controller.holdState('key')?.held ?? false).toBe(false);
});
it('T21/M60s status and Hand back bypass binding for a registered held key; hook survives retirement', async () => {
  const f = await fixture();
  const held = await f.request('POST', { action: 'take', expectedRevision: 0, expectedKey: 'key' });
  f.bind.mockClear(); f.bind.mockRejectedValue(new Error('endpoint changed'));
  expect(await f.request('GET')).toMatchObject({ held: true, selectionRevision: 0, sessionKey: 'key' });
  const result = await f.request('POST', { action: 'release', expectedRevision: 0, expectedKey: 'key', control: held.control });
  expect(result).toMatchObject({ held: false }); expect(f.bind).not.toHaveBeenCalled(); expect(f.options.afterHoldEnded).toHaveBeenCalledWith('key');
});
it('T25/M63s restored live close failure stays reachable without binding; Restart seeds the saved identity', async () => {
  const f = await fixture(); await f.fail(); f.restore(); f.bind.mockClear();
  expect(await f.request('GET')).toMatchObject({ closeFailed: true, problem: "Kai's browser didn't close. Tap Restart to try again.", sessionKey: 'key' });
  expect(f.bind).not.toHaveBeenCalled();
  f.native.close = vi.fn(async () => {});
  await f.request('POST', { action: 'restart', expectedKey: 'key', expectedRevision: 0 });
  expect(f.native.seedDaemonIdentity).toHaveBeenCalledWith(f.native.daemonIdentity); expect(f.native.close).toHaveBeenCalledTimes(1);
  expect(f.controller.holdState('key')?.closeFailed).toBe(false);
});
it('T25 GET clears verified termination then binds to supply the restored spec', async () => {
  const f = await fixture(); await f.fail(); f.restore(); f.verdict('gone'); f.bind.mockClear();
  expect(await f.request('GET')).toMatchObject({ closeFailed: false }); expect(f.bind).toHaveBeenCalledTimes(1);
  expect(f.controller.holdState('key')?.registered).toBe(true);
});
it('T25 finds a restored unbound Guest by closeTarget.botId and keeps unknown identity refused', async () => {
  const f = await fixture(); await f.fail(); f.restore(); f.verdict('unknown'); f.options.currentKey = () => null; f.bind.mockClear();
  expect(await f.request('GET')).toMatchObject({ closeFailed: true, sessionKey: 'key' }); expect(f.bind).not.toHaveBeenCalled();
  await expect(f.request('POST', { action: 'restart', expectedKey: 'key', expectedRevision: 0 })).rejects.toMatchObject({ status: 503 });
  expect(f.controller.holdState('key')?.closeFailed).toBe(true);
});
it('T14 Hand back returns its captured success when the pending choice changes selection before refresh',async()=>{
 const f=await fixture();const held=await f.request('POST',{action:'take',expectedRevision:0,expectedKey:'key'});
 f.options.active=()=>f.bot.selectionRevision===0;
 f.options.afterHoldEnded.mockImplementation(()=>{f.bot.selectionRevision=1;});
 await expect(f.request('POST',{action:'release',expectedRevision:0,expectedKey:'key',control:held.control})).resolves.toMatchObject({held:false,selectionRevision:0,sessionKey:'key'});
});
