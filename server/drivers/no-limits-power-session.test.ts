// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderDriver } from "../contracts.ts";
import { ensureDirs } from '../config.ts';
import { hostPowerDeps, hostPowerProbeDeps, HOST_POWER_TEST_UNWRAPPED } from '../host-power.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { recordEvents } from '../testing/events.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { GeminiAgentDriver } from './acp/gemini.ts';
import { AntigravityDriver } from './antigravity.ts';
import { PiDriver } from './pi.ts';
import { MuseCodeDriver } from './muse-code.ts';
import { createAcpDriver } from './acp/core.ts';
import { canonFile, prepareHookCanon } from '../hook-safety.ts';
const original = { ...hostPowerDeps }, probes = { ...hostPowerProbeDeps };
afterEach(() => { Object.assign(hostPowerDeps, original); Object.assign(hostPowerProbeDeps, probes); (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = true; vi.restoreAllMocks(); });
for (const [name, driver, fake, env] of [
  ['ACP', GeminiAgentDriver, 'fake-acp-cli.ts', { GEMINI_API_KEY: 'fixture-only' }],
  ['Antigravity', AntigravityDriver, 'fake-agy-cli.ts', { FAKE_AGY_RUN_HOOKS: '1' }],
  ['Pi', PiDriver, 'fake-pi-cli.ts', {}],
  ['Muse', MuseCodeDriver, 'fake-muse-cli.ts', { META_API_KEY: 'fixture-only' }],
] as const) {
  for (const probePasses of [false, true]) it.skipIf(process.platform === "win32")(`N6 E2 ${name} caches power fallback across turns after ${probePasses ? 'real launch refusal despite passing probe' : 'failed probe'}`, async () => {
    ensureDirs(); const root = mkdtempSync(join(tmpdir(), 'nolim-power-session-'));
    const wrapper = join(root, 'sandbox');
    writeFileSync(wrapper, '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2\nexit 71\n'); chmodSync(wrapper, 0o755);
    const cli = join(process.cwd(), 'server/testing', fake); chmodSync(cli, 0o755);
    Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
    const probe = vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: probePasses ? 0 : 71, stderr: probePasses ? '' : 'fixture profile refused' });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixtureDriver = driver as ProviderDriver;
    const instance = await fixtureDriver.create({ instanceId: `power-${name}`, displayName: name, enabled: true, config: fixtureDriver.decodeConfig({ cli }), environment: { HOME: root, USERPROFILE: root, ...env } });
    const recorder = recordEvents(instance.adapter);
    try {
      for (let n = 0; n < 2; n++) {
        const sent = await instance.adapter.sendTurn({ threadId: 'power-owner', text: 'fixture only', cwd: root, stopLine: true, noLimits: true });
        const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 20000);
        expect(done, JSON.stringify(recorder.events.filter(e => e.type === "runtime.error"))).toMatchObject({ ok: true });
      }
      expect(probe).toHaveBeenCalledTimes(1);
      const diagnostics = warn.mock.calls.filter(([line]) => String(line).includes('No limits session'));
      expect(diagnostics).toHaveLength(1);
      expect(String(diagnostics[0]![0])).toContain(probePasses ? 'sandbox_apply: Operation not permitted' : 'fixture profile refused');
      const notices = recorder.events.filter(e => e.type === 'item.started' && e.toolKind === 'notice' && e.title?.includes('shutdown and restart protection'));
      expect(notices).toHaveLength(1);
    } finally { recorder.stop(); await instance.dispose(); await removeTempDir(root); }
  }, 60000);
}
it.skipIf(process.platform === "win32")('N6 ACP power retry retains the replacement hook authority', async () => {
  ensureDirs(); const root = mkdtempSync(join(tmpdir(), 'nolim-power-hook-'));
  const wrapper = join(root, 'sandbox'), overlay = join(root, 'overlay.yaml');
  writeFileSync(wrapper, '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2\nexit 71\n'); chmodSync(wrapper, 0o755);
  writeFileSync(overlay, 'fixture canonical hook');
  const cli = join(process.cwd(), 'server/testing/fake-acp-cli.ts'); chmodSync(cli, 0o755);
  Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
  vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: 0, stderr: '' });
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const driver = createAcpDriver({ driverKind: 'powerHookFixture', displayName: 'Hook fixture', defaultCli: cli,
    models: { default: '', options: [] }, nativeSource: 'fixture.acp', loginNote: 'unused',
    spawnArgs: (_config, _turn, ctx) => { if (ctx) ctx.hookCanon = prepareHookCanon([canonFile(overlay, 'fixture canonical hook', 'config', 'hermes', root)], 'V-H1', 'Hook fixture'); return []; },
    pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
    toolTripwire: true, toolTripwireMatcher: () => '.+',
  });
  const instance = await driver.create({ instanceId: 'power-hook', displayName: 'Hook fixture', enabled: true, config: driver.decodeConfig({ cli }),
    environment: { HOME: root, USERPROFILE: root, FAKE_ACP_MODE: 'fuigo-script', FAKE_ACP_SCRIPT: JSON.stringify([
      { at: 5, request: { id: 71, method: 'session/request_permission', params: { toolCall: { toolCallId: 'power-hook-call', title: 'terminal', kind: 'execute', status: 'pending', rawInput: { command: 'echo safe' } }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } } },
      { at: 30, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture done' } } },
      { at: 60, result: { stopReason: 'end_turn' } },
    ]) } });
  const recorder = recordEvents(instance.adapter);
  try {
    const sent = await instance.adapter.sendTurn({ threadId: 'power-hook-owner', text: 'fixture only', cwd: root, stopLine: true, noLimits: true });
    const ask = await recorder.until(e => e.type === 'request.opened' || e.type === 'turn.completed', 20000);
    expect(ask.type, JSON.stringify(recorder.events.filter(e => e.type === 'runtime.error'))).toBe('request.opened');
    if (ask.type === 'request.opened') await instance.adapter.respondToRequest('power-hook-owner', ask.requestId!, { behavior: 'allow' });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 20000)).toMatchObject({ ok: true });
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(root); }
}, 60000);
useOutsideStoreFixture();
