// SPDX-License-Identifier: AGPL-3.0-or-later
// nativecrash G3b (ACX): the session/cancel Murage writes on a LIVE turn is a fenced send; written after the revoke it claims the refusal at its own
// site, and the driver's own reason (here gate_incident) is only the secondary (STAGE2 sec. 5). Real driver against the fake ACP CLI.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../../config.ts';
import { createAcpDriver, type AcpSupport } from './core.ts';
import { hermesAcpSupport } from './hermes.ts';
import { fuigoAcpSupport } from './fuigo.ts';
import { fencedRefusals, fencedTurnInput, type FencedRefusal } from '../engine-input.ts';
import { buildPrompt, promptPart, noneRef } from '../../memory/prompt-parts.ts';
import { checkedOpenTurns } from '../../memory/lineage-write.ts';
import { consumingFixture } from '../../testing/consuming-fixture.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';
import { expectMemoryRefused, watchEscapes } from '../../testing/nativecrash-harness.ts';
import type { ProviderInstance } from '../../contracts.ts';

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'fake-acp-cli.ts');
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

// ACX tripwire: an execute tool call arrives with no allow, after the revoke (gated step); tripTool's cancel is refused.
it('acp tool tripwire cancel after a revoke claims acp.cancel.tripwire', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-cancel-gate-')), 'go');
  const support = { driverKind: 'ncCancelTrip', displayName: 'Hermes', models: { default: '', options: [] }, defaultCli: FAKE_CLI, nativeSource: 'test.acp', loginNote: 'unused',
    spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true, toolTripwire: true, toolTripwireMatcher: () => '(?!(?:read_file)$).+',
    normalizeAsk: hermesAcpSupport.normalizeAsk, fluxReach: () => 'elsewhere' as const } as AcpSupport;
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: 'nc-cancel-trip', displayName: 'Hermes', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: true }),
    environment: { FAKE_ACP_MODE: 'fuigo-script', FAKE_ACP_MCP_READY: '1', FAKE_ACP_SCRIPT: JSON.stringify([
      { gate, at: 0, update: { sessionUpdate: 'tool_call', toolCallId: 'execution', title: 'terminal', kind: 'execute', rawInput: { command: 'echo safe' }, status: 'in_progress' } },
      { gate, at: 2000, result: { stopReason: 'end_turn' } }]) } });
  const f = consumingFixture(undefined, { threadId: 'nc-cancel-trip' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-cancel-trip', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'session.started');
  f.replace();
  writeFileSync(gate, '');
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const r = fencedRefusals().filter((x): x is FencedRefusal => (x as FencedRefusal).site === 'acp.cancel.tripwire' && x.threadId === 'nc-cancel-trip');
  expect(r, 'one refusal record for the tripwire cancel').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// ACX posture: a posture restart after the revoke writes session/cancel on the live turn; the refused write claims acp.cancel.posture and the
// restart ends there (no second launch, no POSTURE_CONTINUATION relaunch), so the replacement process is never spawned.
it('acp posture-restart cancel after a revoke claims acp.cancel.posture and does not relaunch', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const scratch = mkdtempSync(join(tmpdir(), 'nc-cancel-posture-'));
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'posture-acp-restart.mjs'); chmodSync(cli, 0o755);
  const log = join(scratch, 'frames.jsonl'), witness = join(scratch, 'written.txt');
  let ask = true;
  const Driver = createAcpDriver({ driverKind: 'ncCancelPosture', displayName: 'Posture', models: { default: '', options: [] }, defaultCli: cli, nativeSource: 'test.acp', loginNote: 'unused',
    spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
    askStop: { beforeSpawn: true, apply: async ({ env, askLevel }) => { env.POSTURE_READONLY = askLevel ? '1' : '0'; } }, fluxReach: () => 'elsewhere' as const } as AcpSupport);
  instance = await Driver.create({ instanceId: 'nc-cancel-posture', displayName: 'Posture', enabled: true, environment: { POSTURE_LOG: log, POSTURE_WITNESS: witness, POSTURE_HANG_NORMAL: '0' }, config: { cli, fullAuto: false } as never });
  const f = consumingFixture(undefined, { threadId: 'nc-cancel-posture' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-cancel-posture', text: 'go', askLevel: true, routeAsks: true, releaseBinding: f.binding,
    permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true },
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'content.delta');
  f.replace();
  ask = false;
  await instance.adapter.onPostureChange!('nc').catch(() => {});
  // The explicit exit returns before the old process is closed a second time (that wait ends with the terminal).
  expect(recorder.events.some(e => e.type === 'turn.completed'), 'restart ended before the terminal').toBe(false);
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const r = fencedRefusals().filter((x): x is FencedRefusal => (x as FencedRefusal).site === 'acp.cancel.posture' && x.threadId === 'nc-cancel-posture');
  expect(r, 'one refusal record for the posture cancel').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
  const frames = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  expect(frames.filter(x => x.launch), 'no replacement launch after the claim').toHaveLength(1);
  expect(frames.filter(x => x.method === 'session/cancel'), 'no session/cancel bytes').toHaveLength(0);
});

// ACC: the Flux retry notice (a spent allowance) makes the driver cancel the prompt; after the revoke that cancel is refused and claims acp.cancel.flux.
it('acp flux-retry cancel after a revoke claims acp.cancel.flux and arms no cancel deadline', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-cancel-flux-')), 'go');
  const support = { driverKind: 'fuigoAgent', displayName: 'Agent', models: { default: '', options: [] }, defaultCli: FAKE_CLI, nativeSource: 'test.acp', loginNote: 'unused',
    spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true, requestBaseUrl: () => 'https://api.fluxrouter.ai/v1', applyFluxMemory: fuigoAcpSupport.applyFluxMemory,
    normalizeAsk: hermesAcpSupport.normalizeAsk, fluxReach: () => 'elsewhere' as const } as AcpSupport;
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: 'nc-cancel-flux', displayName: 'Agent', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: true }),
    environment: { FAKE_ACP_MODE: 'fuigo-script', FAKE_ACP_MCP_READY: '1', FAKE_ACP_SCRIPT: JSON.stringify([
      { gate, at: 0, update: { sessionUpdate: 'retry_state', type: 'retrying', attempt: 1, upstream: { state: 'credit_exhausted', http_status: 402 } } },
      { gate, at: 3000, result: { stopReason: 'end_turn' } }]) } });
  const f = consumingFixture(undefined, { threadId: 'nc-cancel-flux' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-cancel-flux', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'session.started');
  f.replace();
  writeFileSync(gate, '');
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const r = fencedRefusals().filter((x): x is FencedRefusal => (x as FencedRefusal).site === 'acp.cancel.flux' && x.threadId === 'nc-cancel-flux');
  expect(r, 'one refusal record for the flux-retry cancel').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});
