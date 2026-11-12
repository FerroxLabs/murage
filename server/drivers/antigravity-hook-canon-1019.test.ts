import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const state = vi.hoisted(() => { vi.resetModules(); return { fail: '' as string, serial: 0, owner: undefined as undefined | { revoke(): void; stop(): void }, resolvedAtRevoke: [] as unknown[] }; });
// This seam supplies only ordinary fixture files. Filesystem repair and races
// are exercised by the canonical writer's own suite; these rows drive the adapter.
vi.mock('../hook-canon.ts', async original => ({
  ...await original<typeof import('../hook-canon.ts')>(),
  registerCanon: (files: any[]) => ({ id: String(++state.serial), files }),
  ensureCanon: (set: any, at: string) => {
    if (state.fail === at) return { ok: false, path: set.files[0].path, why: 'mode', error: 'fixture lock' };
    for (const file of set.files) { mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 }); writeFileSync(file.path, file.bytes, { mode: 0o600 }); }
    return { ok: true, restored: [] };
  },
  ensureAllLive: () => [], dropCanon: () => {},
}));
vi.mock('../hook-safety.ts', async original => {
  const actual = await original<typeof import('../hook-safety.ts')>();
  return { ...actual, ownHookCanon: (set: any, owner: any) => { state.owner = owner; actual.ownHookCanon(set, owner); } };
});
import { AntigravityDriver, ANTIGRAVITY_HOOK_SKIPPED } from './antigravity.ts';
import { ensureDirs } from '../config.ts';
import { recordEvents, type EventRecorder } from '../testing/events.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { ProviderInstance } from '../contracts.ts';
const cli = fileURLToPath(new URL('../testing/fake-agy-cli.ts', import.meta.url));
let root = ''; let instance: ProviderInstance | undefined; let recorder: EventRecorder | undefined;
beforeEach(() => { ensureDirs(); state.fail = ''; state.owner = undefined; state.resolvedAtRevoke = [];  root = mkdtempSync(join(tmpdir(), 'agy-trip-')); chmodSync(cli, 0o755); });
afterEach(async () => { recorder?.stop(); await instance?.dispose(); instance = undefined; removeTempDirSync(root); });
async function start(status: 'DONE' | 'ERROR', decision: 'allow' | 'deny' | undefined, ask = false, tool = 'run_command', revokeRace = false) {
  const home = join(root, 'home'); const work = join(root, 'work'); mkdirSync(home); mkdirSync(work);
  const dump = join(root, 'dump.json');
  instance = await AntigravityDriver.create({ instanceId: 'agy-trip', displayName: 'Antigravity', enabled: true,
    config: { cli, fullAuto: !ask }, environment: { HOME: home, FAKE_AGY_DUMP: dump, FAKE_AGY_TOOL_CALLS: JSON.stringify([{ name: tool, args: { CommandLine: 'echo fixture' } }]),
      FAKE_AGY_RUN_HOOKS: '1', FAKE_AGY_SKIP_HOOKS: decision === undefined ? '1' : '0', FAKE_AGY_REPORT_STATE: status } });
  recorder = recordEvents(instance.adapter);
  instance.adapter.onEvent(event => { if (event.type === 'request.opened') {
    if (revokeRace) {
      state.owner!.revoke();
      state.resolvedAtRevoke = recorder!.events.filter(e => e.type === 'request.resolved');
    }
    void instance!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: decision === 'allow' ? 'allow' : 'deny' }).catch(() => {});
    if (revokeRace) state.owner!.stop();
  } });
  await instance.adapter.sendTurn({ threadId: 'agy-trip', text: 'fixture', cwd: work, ...(ask ? { askLevel: true } : { routeAsks: true }) });
  await recorder.until(event => event.type === 'turn.completed', 15000);
  return { incident: recorder.events.some(event => event.type === 'item.started' && event.itemType === 'tool' && event.title === ANTIGRAVITY_HOOK_SKIPPED), dump };
}
describe('T17 Antigravity records decisions, including Ask-stop turns', () => {
  for (const [status, decision, incident] of [
    ['DONE', 'allow', false], ['DONE', 'deny', true], ['DONE', undefined, true],
    ['ERROR', 'allow', false], ['ERROR', 'deny', false], ['ERROR', undefined, true],
  ] as const) it(`${status} with ${decision ?? 'no decision'}`, async () => { expect((await start(status, decision)).incident).toBe(incident); });
  it('Ask-stop allows a read DONE without a relay', async () => { expect((await start('DONE', undefined, true, 'read_file')).incident).toBe(false); });
  it('Ask-stop non-read DONE is an incident without dereferencing a relay', async () => { expect((await start('DONE', undefined, true)).incident).toBe(true); });
  for (const at of ['V-A2', 'V-A3']) it(`T22 ${at} refuses launch with the typed repair failure`, async () => {
    state.fail = at;
    await expect(start('DONE', 'allow', at === 'V-A3')).rejects.toMatchObject({ code: 'hook-repair-failed' });
    expect(JSON.parse(readFileSync(join(root, 'dump.json'), 'utf8')).argv).toEqual(['--version']);
  });
  for (const at of ['V-A4', 'V-A5']) it(`T22 ${at} stops the active turn`, async () => {
    state.fail = at;
    await start('DONE', 'allow');
    expect(recorder!.events.filter(event => event.type === 'turn.completed')).toEqual([expect.objectContaining({ ok: true, stopReason: 'cancelled' })]);
    if (at === 'V-A4') expect(recorder!.events.some(event => event.type === 'request.opened')).toBe(false);
  });
  it('T22 V-A1 repair failure bypasses accept-edits fallback', async () => {
    state.fail = 'V-A1';
    await expect(start('DONE', 'allow')).rejects.toMatchObject({ code: 'hook-repair-failed' });
    const dump = JSON.parse(readFileSync(join(root, 'dump.json'), 'utf8'));
    expect(dump.argv).toEqual(['--version']);
  });
});

it('V-ANY revocation settles pending permission before a racing approval and child shutdown', async () => {
  await start('DONE', 'allow', false, 'run_command', true);
  expect(state.resolvedAtRevoke).toEqual([expect.objectContaining({ type: 'request.resolved', behavior: 'deny', source: 'system' })]);
  expect(recorder!.events.some(e => e.type === 'request.resolved' && e.behavior === 'allow')).toBe(false);
});
