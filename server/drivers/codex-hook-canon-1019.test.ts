import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const canonical = vi.hoisted(() => { vi.resetModules(); return { failAt: '', serial: 0, checks: [] as string[] }; });
// Adapter routing seam only. Canonical filesystem identity and restore are S1.
vi.mock('../hook-canon.ts', async original => ({
  ...await original<typeof import('../hook-canon.ts')>(),
  registerCanon: (files: any[]) => ({ id: String(++canonical.serial), files }),
  ensureCanon: (set: any, at: string) => {
    canonical.checks.push(at);
    if (canonical.failAt === at) return { ok: false, path: set.files[0].path, why: 'mode', error: 'fixture repair obstruction' };
    for (const file of set.files) { mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 }); writeFileSync(file.path, file.bytes, { mode: 0o600 }); }
    return { ok: true, restored: [] };
  },
  ensureAllLive: () => [], dropCanon: () => {},
}));
import { CodexDriver } from './codex.ts';
import { resetIsolationCache } from './isolation-cache.ts';
import { ensureDirs } from '../config.ts';
import { recordEvents, type EventRecorder } from '../testing/events.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { ProviderInstance } from '../contracts.ts';
const cli = fileURLToPath(new URL('../testing/fake-codex-app-server.ts', import.meta.url));
let root = ''; let instance: ProviderInstance | undefined; let recorder: EventRecorder | undefined;
beforeEach(() => { ensureDirs(); resetIsolationCache(); canonical.failAt = ''; canonical.checks = []; root = mkdtempSync(join(tmpdir(), 'codex-canon-')); chmodSync(cli, 0o755); });
afterEach(async () => { recorder?.stop(); await instance?.dispose(); instance = undefined; removeTempDirSync(root); });
async function start(call: Record<string, unknown> = {}) {
  const home = join(root, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), '');
  const dump = join(root, 'dump.json');
  instance = await CodexDriver.create({ instanceId: 'codex-canon', displayName: 'Codex', enabled: true, config: { cli, fullAuto: false },
    environment: { CODEX_HOME: home, FAKE_CODEX_VERSION: 'codex-cli 0.150.0', FAKE_CODEX_DUMP: dump, FAKE_CODEX_GATED_SPAWN_LOG: join(root, 'spawns'),
      FAKE_CODEX_TOOLS: JSON.stringify([{ kind: 'shell', id: 'execution', command: 'echo fixture', ...call }]) } });
  recorder = recordEvents(instance.adapter);
  instance.adapter.onEvent(event => { if (event.type === 'request.opened') void instance!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: 'allow' }); });
  await instance.adapter.sendTurn({ threadId: 'codex-canon', text: 'fixture', cwd: root, integrations: { agents: { command: process.execPath, args: ['-e', ''], env: {} } } });
  const completed = await recorder.until(event => event.type === 'turn.completed', 15000);
  return { completed, dump: () => JSON.parse(readFileSync(dump, 'utf8')) };
}
describe('T17/T22 Codex canonical anchors and helper tripwire', () => {
  it('V-C1 repair refusal prevents launch', async () => {
    canonical.failAt = 'V-C1';
    const result = await start();
    expect(result.completed).toMatchObject({ ok: false, stopReason: 'scope_unavailable' });
    expect(recorder!.events.some(event => event.type === 'runtime.error' && event.localFailure === 'engine-hook-repair-failed')).toBe(true);
    // Version/model discovery may probe app-server before this anchor. No
    // process carrying the scoped hook environment may start after refusal.
    expect(existsSync(join(root, 'spawns'))).toBe(false);
    expect(canonical.checks).toContain('V-C1');
  });
  for (const at of ['V-C2', 'V-C3']) it(`${at} stops through the incident path`, async () => {
    canonical.failAt = at;
    const result = await start();
    expect(result.completed).toMatchObject({ ok: false, stopReason: 'gate_incident' });
    expect(canonical.checks).toContain(at);
    expect(recorder!.events.some(event => event.type === 'runtime.error' && event.message === 'Murage could not confirm its tool check')).toBe(true);
    if (at === 'V-C2') expect(recorder!.events.some(event => event.type === 'request.opened')).toBe(false);
  });
  it('a helper covered by its own PreToolUse allow passes', async () => {
    const result = await start({ helper: true });
    expect(result.completed).toMatchObject({ ok: true });
    expect(result.dump().hookLog).toContainEqual(expect.objectContaining({ id: 'execution', verdict: 'allow' }));
  });
  it('a helper with different permission and execution IDs matches its own turn fallback', async () => {
    const result = await start({ helper: true, hookId: 'helper-permission' });
    expect(result.dump().hookLog).toContainEqual(expect.objectContaining({ id: 'execution', verdict: 'allow' }));
    expect(result.completed).toMatchObject({ ok: true });
    expect(recorder!.events.some(e => e.type === 'runtime.error')).toBe(false);
  });
  it('a helper command with no matching hook trips', async () => {
    const result = await start({ helper: true, hook: false });
    expect(result.completed).toMatchObject({ ok: false, stopReason: 'gate_incident' });
  });
  it('a stale hook delivery from an earlier turn cannot receive an allow', async () => {
    const result = await start({ hookTurnId: 'retired-turn' });
    expect(result.dump().hookLog).toContainEqual(expect.objectContaining({ id: 'execution', verdict: 'deny', reason: expect.stringContaining('earlier turn') }));
    expect(recorder!.events.some(event => event.type === 'request.opened')).toBe(false);
  });
});
