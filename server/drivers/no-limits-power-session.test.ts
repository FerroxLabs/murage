// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HOST_POWER_CODE, HOST_POWER_MESSAGE } from '../host-power.ts';
import { hostPowerRefused, resetShutdownDropForTests, spawnCli } from '../procs.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import type { ProviderDriver } from "../contracts.ts";
import { ensureDirs } from '../config.ts';
import { hostPowerDeps, hostPowerProbeDeps, HOST_POWER_TEST_UNWRAPPED, NO_LIMITS_SEATBELT_POWER_PROFILE, resetSeatbeltSelectionsForTests } from '../host-power.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { recordEvents } from '../testing/events.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { GeminiAgentDriver } from './acp/gemini.ts';
import { AntigravityDriver } from './antigravity.ts';
import { PiDriver } from './pi.ts';
import { MuseCodeDriver } from './muse-code.ts';
import { createFixtureAcpDriver as createAcpDriver } from '../testing/acp-support-fixture.ts';
import { canonFile, prepareHookCanon } from '../hook-safety.ts';
// The addon procs.ts asks for the Windows privilege removal: the real lookup unless a test puts a stand-in here.
const addonState = vi.hoisted(() => ({ addon: undefined as unknown }));
vi.mock('../engine-exclusion.ts', async original => {
  const actual = await original<typeof import('../engine-exclusion.ts')>();
  return { ...actual, loadExclusionAddon: () => (addonState.addon === undefined ? actual.loadExclusionAddon() : addonState.addon) };
});
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const asPlatform = <T>(platform: NodeJS.Platform, run: () => T): T => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  try { return run(); } finally { Object.defineProperty(process, 'platform', platformDescriptor); }
};
const original = { ...hostPowerDeps }, probes = { ...hostPowerProbeDeps };
afterEach(() => { addonState.addon = undefined; resetShutdownDropForTests(); Object.assign(hostPowerDeps, original); Object.assign(hostPowerProbeDeps, probes); resetSeatbeltSelectionsForTests(); (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = true; vi.restoreAllMocks(); });
// The three macOS Seatbelt retry tests below are skipped on Windows because that wrapper does not exist there (procs.ts plans
// sandbox-exec or bwrap only off win32); the Windows rule for the same No limits turns is the twin at the end of this file.
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
        if (name === 'Pi') expect(await instance.adapter.awaitTurnTeardown?.('power-owner', sent.turnId)).toMatchObject({ closeConfirmed: true });
      }
      // The fallback is cached across turns: each exact rule set is probed once, never again (a lower level, e.g. Muse's catalog host, probes its own).
      const probed = probe.mock.calls.map(call => String((call[1] as string[])[1]));
      expect(probed.length).toBeGreaterThan(0);
      if (!probePasses) expect(new Set(probed).size).toBe(probed.length);
      const diagnostics = warn.mock.calls.filter(([line]) => String(line).includes('No limits session'));
      expect(diagnostics).toHaveLength(1);
      expect(String(diagnostics[0]![0])).toContain(probePasses ? 'sandbox_apply: Operation not permitted' : 'fixture profile refused');
      const notices = recorder.events.filter(e => e.type === 'item.started' && e.toolKind === 'notice' && e.title?.includes('shutdown and restart protection'));
      expect(notices).toHaveLength(1);
    } finally { recorder.stop(); await instance.dispose(); await removeTempDir(root); }
  }, 60000);
}
// ASTRA n4:6069: the fixture above refuses EVERY wrapped launch, so it also passes when a driver skips the narrower rule sets and
// runs unwrapped at once. Here the sandbox-exec stand-in refuses only the first K exact profiles of the ladder (strongest first),
// logs every launch it is asked for, and runs the engine under the next one. The launch log must be the ladder in order: each
// narrower profile tried before the next, nothing skipped, and the unwrapped run only after the last profile was refused.
for (const [name, driver, fake, env] of [
  ['ACP', GeminiAgentDriver, 'fake-acp-cli.ts', { GEMINI_API_KEY: 'fixture-only' }],
  ['Antigravity', AntigravityDriver, 'fake-agy-cli.ts', { FAKE_AGY_RUN_HOOKS: '1' }],
  ['Pi', PiDriver, 'fake-pi-cli.ts', {}],
  ['Muse', MuseCodeDriver, 'fake-muse-cli.ts', { META_API_KEY: 'fixture-only' }],
] as const) {
  for (const refusedCount of [1, 3]) it.skipIf(process.platform === 'win32')(`N6 E3 ${name} retries the exact profile ladder in order when only the first ${refusedCount} profile(s) are refused at launch`, async () => {
    ensureDirs(); const root = mkdtempSync(join(tmpdir(), 'nolim-power-ladder-'));
    // The ladder, written out here and not taken from host-power.ts: all No limits rules, then one rule fewer (strongest first), then one.
    const [header, ...rules] = NO_LIMITS_SEATBELT_POWER_PROFILE.split(/(?=\(deny )/);
    expect(rules.map(rule => rule.split(/\s/)[1])).toEqual(['mach-lookup', 'iokit-open']);
    const ladder = [header + rules.join(''), header + rules[1], header + rules[0]];
    expect(ladder.length).toBe(3);
    for (let i = 0; i < refusedCount; i++) writeFileSync(join(root, `refuse.${i}`), ladder[i]!);
    const log = join(root, 'launches'), wrapper = join(root, 'sandbox');
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n--END--\\n' "$2" >> '${log}'\nprintf '%s' "$2" > '${root}/current'\nfor f in '${root}'/refuse.*; do\n  if [ -e "$f" ] && cmp -s '${root}/current' "$f"; then echo "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2; exit 71; fi\ndone\nshift 2\nexec "$@"\n`); chmodSync(wrapper, 0o755);
    const cli = join(process.cwd(), 'server/testing', fake); chmodSync(cli, 0o755);
    Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
    vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: 0, stderr: '' });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixtureDriver = driver as ProviderDriver;
    const instance = await fixtureDriver.create({ instanceId: `ladder-${name}`, displayName: name, enabled: true, config: fixtureDriver.decodeConfig({ cli }), environment: { HOME: root, USERPROFILE: root, ...env } });
    const recorder = recordEvents(instance.adapter);
    try {
      const sent = await instance.adapter.sendTurn({ threadId: 'ladder-owner', text: 'fixture only', cwd: root, stopLine: true, noLimits: true });
      const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 20000);
      expect(done, JSON.stringify(recorder.events.filter(e => e.type === 'runtime.error'))).toMatchObject({ ok: true });
      const launched = existsSync(log) ? readFileSync(log, 'utf8').split('--END--\n').filter(Boolean).map(profile => profile.replace(/\n$/, '')) : [];
      // Every profile up to the first one sandbox-exec takes (or, when it takes none, the whole ladder), in ladder order, once each.
      expect(launched.filter(profile => ladder.includes(profile))).toEqual(ladder.slice(0, Math.min(refusedCount + 1, ladder.length)));
      if (refusedCount >= ladder.length) {
        const notices = recorder.events.filter(e => e.type === 'item.started' && e.toolKind === 'notice' && e.title?.includes('shutdown and restart protection'));
        expect(notices).toHaveLength(1);
      }
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
    toolTripwire: true, toolTripwireMatcher: () => '.+', fluxReach: () => "elsewhere" as const
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
for (const failureSite of ['mount', 'arguments', 'spawn'] as const) it.skipIf(process.platform === "win32")(`R2 ACP replacement ${failureSite} failure settles and releases resources`, async () => {
  ensureDirs(); const root = mkdtempSync(join(tmpdir(), 'nolim-retry-failure-'));
  const wrapper = join(root, 'sandbox');
  writeFileSync(wrapper, '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2\nexit 71\n'); chmodSync(wrapper, 0o755);
  const cli = join(process.cwd(), 'server/testing/fake-acp-cli.ts'); chmodSync(cli, 0o755);
  Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
  vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: 0, stderr: '' });
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const release = vi.fn(); let mounts = 0, argumentsBuilt = 0, spawns = 0;
  const driver = createAcpDriver({ driverKind: 'retryFailureFixture', displayName: 'Retry fixture', defaultCli: cli,
    models: { default: '', options: [] }, nativeSource: 'fixture.acp', loginNote: 'unused',
    prepareMcpLaunch: () => { if (++mounts === 2 && failureSite === 'mount') throw new Error('fixture replacement mount failed'); return release; },
    spawnArgs: () => { if (++argumentsBuilt === 2 && failureSite === 'arguments') throw new Error('fixture replacement arguments failed'); return []; },
    secretEnv: () => { if (++spawns === 2 && failureSite === 'spawn') throw new Error('fixture replacement spawn failed'); return {}; },
    pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
  });
  const instance = await driver.create({ instanceId: 'retry-failure', displayName: 'Retry fixture', enabled: true, config: driver.decodeConfig({ cli }), environment: { HOME: root, USERPROFILE: root } });
  const recorder = recordEvents(instance.adapter);
  try {
    const sent = await instance.adapter.sendTurn({ threadId: 'retry-failure-owner', text: 'fixture only', cwd: root, stopLine: true, noLimits: true });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 4000)).toMatchObject({ ok: false, stopReason: 'rpc_error' });
    expect(recorder.events.filter(e => e.type === 'runtime.error')).toEqual([expect.objectContaining({ message: expect.stringContaining(`fixture replacement ${failureSite} failed`) })]);
    expect(release).toHaveBeenCalledTimes(failureSite === 'mount' ? 1 : 2);
    // The same conversation admits a fresh turn after the failed replacement.
    const next = await instance.adapter.sendTurn({ threadId: 'retry-failure-owner', text: 'fixture next', cwd: root, stopLine: true, noLimits: true });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === next.turnId, 10000)).toMatchObject({ ok: true });
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(root); }
}, 30000);
useOutsideStoreFixture();
// Windows twin of the N6 power fallback: no wrapper, so no cached fallback. A failed shutdown-privilege drop refuses every
// No limits engine launch, each time, with the host's sentence (the Windows one on win32), and no engine process is ever started. Runs everywhere by
// simulating the platform at launch only (the real win32 run takes the same branch).
it('N6 Windows twin: a failed privilege drop refuses every No limits launch, twice, before any engine process exists', async () => {
  for (const addon of [{ dropShutdownPrivileges: () => ({ ok: false, step: 'verify', error: 0 }) }, null]) {
    resetShutdownDropForTests(); addonState.addon = addon;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let n = 0; n < 2; n++) {
      const child = asPlatform('win32', () => spawnCli(process.execPath, ['-e', ''], { cwd: fixtureBotFolder(), stdio: ['pipe', 'pipe', 'pipe'] }, { name: `Local\\murage-pip-eng-twin-${n}`, hostPower: true, noLimitsSession: {} }));
      expect(child.pid).toBeUndefined();
      const errors: NodeJS.ErrnoException[] = [];
      child.on('error', error => errors.push(error));
      await new Promise(resolve => child.on('close', resolve));
      expect(errors.map(error => [error.code, error.message])).toEqual([[HOST_POWER_CODE, HOST_POWER_MESSAGE]]);
      expect(hostPowerRefused(child)).toBe(true);
    }
    vi.restoreAllMocks();
  }
});
