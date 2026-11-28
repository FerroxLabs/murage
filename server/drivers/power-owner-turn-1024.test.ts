// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #5 (1.0.24 q1024-power): the power block wraps a guest or unattended turn only. The owner's own turn runs unwrapped, so
// "could not block shut down" can never end it. Entry point: each real driver's sendTurn (ACP, Antigravity, Pi, Muse), which reaches
// engineJob -> spawnCli -> planHostPower; the sandbox-exec stand-in refuses every launch and logs each one it was asked for.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderDriver } from '../contracts.ts';
import { ensureDirs } from '../config.ts';
import { hostPowerDeps, hostPowerProbeDeps, HOST_POWER_TEST_UNWRAPPED, resetSeatbeltSelectionsForTests } from '../host-power.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { recordEvents } from '../testing/events.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { resetShutdownDropForTests } from '../procs.ts';
import { GeminiAgentDriver } from './acp/gemini.ts';
import { AntigravityDriver } from './antigravity.ts';
import { PiDriver } from './pi.ts';
import { ProviderRegistry } from '../harness/registry.ts';
import { MuseCodeDriver } from './muse-code.ts';

useOutsideStoreFixture();
const original = { ...hostPowerDeps }, probes = { ...hostPowerProbeDeps };
afterEach(() => { resetShutdownDropForTests(); Object.assign(hostPowerDeps, original); Object.assign(hostPowerProbeDeps, probes); resetSeatbeltSelectionsForTests(); (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = undefined; vi.restoreAllMocks(); });

for (const [name, driver, fake, env] of [
  ['ACP', GeminiAgentDriver, 'fake-acp-cli.ts', { GEMINI_API_KEY: 'fixture-only' }],
  ['Antigravity', AntigravityDriver, 'fake-agy-cli.ts', { FAKE_AGY_RUN_HOOKS: '1' }],
  ['Pi', PiDriver, 'fake-pi-cli.ts', {}],
  ['Muse', MuseCodeDriver, 'fake-muse-cli.ts', { META_API_KEY: 'fixture-only' }],
] as const) {
  for (const audience of ['owner', 'guest'] as const) it.skipIf(process.platform === 'win32')(`W-OWNER ${name}: the ${audience}'s turn ${audience === 'owner' ? 'runs unwrapped and is never refused for the block' : 'is still wrapped and refused when the wrap fails'}`, async () => {
    ensureDirs(); const root = mkdtempSync(join(tmpdir(), 'power-owner-'));
    const log = join(root, 'launches'), wrapper = join(root, 'sandbox');
    writeFileSync(wrapper, `#!/bin/sh\necho launched >> '${log}'\necho "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2\nexit 71\n`); chmodSync(wrapper, 0o755);
    const cli = join(process.cwd(), 'server/testing', fake); chmodSync(cli, 0o755);
    Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
    vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: 0, stderr: '' });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixtureDriver = driver as ProviderDriver;
    const instance = await fixtureDriver.create({ instanceId: `owner-${name}-${audience}`, displayName: name, enabled: true, config: fixtureDriver.decodeConfig({ cli }), environment: { HOME: root, USERPROFILE: root, ...env } });
    const recorder = recordEvents(instance.adapter);
    try {
      const sent = await instance.adapter.sendTurn({ threadId: `owner-${audience}`, text: 'fixture only', cwd: root, stopLine: true, ...(audience === 'owner' ? { hostPowerOwnerTurn: true as const } : {}) });
      const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 20000);
      const launches = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
      if (audience === 'owner') {
        // First the behaviour: the owner's turn never reaches the power wrapper (the engines but Muse, whose own start-up probes run it, outside any turn).
        if (name !== 'Muse') expect(launches, 'the owner turn was handed to the power wrapper').toBe(0);
        // Muse: its start-up probes are wrapped outside any turn, so the wrapper IS live and refusing; the owner's turn must still complete.
        else expect(launches, 'the power wrapper was not in effect for the probes').toBeGreaterThan(0);
        expect(done, JSON.stringify(recorder.events.filter(e => e.type === 'runtime.error'))).toMatchObject({ ok: true });
      } else {
        expect(launches).toBeGreaterThan(0);
        expect(done).toMatchObject({ ok: false });
      }
    } finally { recorder.stop(); await instance.dispose(); await removeTempDir(root); }
  }, 60000);
}

// The production decoration path: the registry wraps every instance with the owner-turn decorator, the server's resolver says which
// thread is the owner's, and the turn input given to sendTurn carries NO mark of its own. Entry: ProviderRegistry.load -> adapter.sendTurn.
for (const audience of ['owner', 'guest'] as const) it.skipIf(process.platform === 'win32')(`W-REGISTRY Pi through the registry: the ${audience}'s thread ${audience === 'owner' ? 'runs unwrapped' : 'is wrapped'}`, async () => {
  ensureDirs(); const root = mkdtempSync(join(tmpdir(), 'power-owner-reg-'));
  const log = join(root, 'launches'), wrapper = join(root, 'sandbox');
  writeFileSync(wrapper, `#!/bin/sh\necho launched >> '${log}'\necho "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2\nexit 71\n`); chmodSync(wrapper, 0o755);
  const cli = join(process.cwd(), 'server/testing/fake-pi-cli.ts'); chmodSync(cli, 0o755);
  Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
  vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: 0, stderr: '' });
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // On the base there is no decorator module: the resolver is then never installed and the owner thread stays wrapped (the behaviour under test).
  const owner = await import('../harness/power-owner-adapter.ts').catch(() => null);
  owner?.setOwnerTurnResolver((threadId: string) => threadId === 'reg-owner');
  const registry = new ProviderRegistry([PiDriver as ProviderDriver]);
  await registry.load({ pi: { driver: (PiDriver as ProviderDriver).driverKind, config: { cli }, environment: { HOME: root, USERPROFILE: root } } as never });
  const live = registry.get('pi')!;
  const recorder = recordEvents(live.adapter);
  try {
    const threadId = audience === 'owner' ? 'reg-owner' : 'reg-guest';
    const sent = await live.adapter.sendTurn({ threadId, text: 'fixture only', cwd: root, stopLine: true });
    const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 20000);
    const launches = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    if (audience === 'owner') { expect(launches, 'the owner thread was handed to the power wrapper').toBe(0); expect(done).toMatchObject({ ok: true }); }
    else { expect(launches).toBeGreaterThan(0); expect(done).toMatchObject({ ok: false }); }
  } finally { recorder.stop(); await live.dispose?.(); owner?.setOwnerTurnResolver(() => false); await removeTempDir(root); }
}, 60000);
