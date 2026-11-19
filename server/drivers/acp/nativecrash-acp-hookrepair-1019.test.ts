// SPDX-License-Identifier: AGPL-3.0-or-later
// nativecrash G3b (ACX): the session/cancel of a failed hook repair is a fenced send; written after the revoke it claims acp.cancel.hookrepair.
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const canon = vi.hoisted(() => { vi.resetModules(); return { broken: false }; });
vi.mock('../../hook-canon.ts', async original => ({
  ...await original<typeof import('../../hook-canon.ts')>(),
  ensureCanon: () => canon.broken ? { ok: false, path: '/nc-overlay', why: 'changed', error: 'fixture repair obstruction' } : { ok: true, restored: [] },
  ensureAllLive: () => [], dropCanon: () => {},
}));
import { ensureDirs } from '../../config.ts';
import { createAcpDriver, type AcpSupport } from './core.ts';
import { hermesAcpSupport } from './hermes.ts';
import { checkHookCanon } from '../../hook-safety.ts';
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
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); canon.broken = false; });
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

it('acp hook-repair cancel after a revoke claims acp.cancel.hookrepair', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const set = { id: 'fixture-hermes', files: [{ path: '/nc-overlay', bytes: Buffer.from('canonical overlay'), sha256: '', kind: 'config', engine: 'hermes', root: '/' }] } as never;
  const support = { driverKind: 'ncCancelHook', displayName: 'Hermes', models: { default: '', options: [] }, defaultCli: FAKE_CLI, nativeSource: 'test.acp', loginNote: 'unused',
    spawnArgs: (_config: unknown, _turn: unknown, ctx?: { hookCanon?: unknown }) => { if (ctx) ctx.hookCanon = set; return []; }, pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
    toolTripwire: true, toolTripwireMatcher: () => '(?!(?:read_file)$).+', normalizeAsk: hermesAcpSupport.normalizeAsk, fluxReach: () => 'elsewhere' as const } as AcpSupport;
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: 'nc-cancel-hook', displayName: 'Hermes', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: true }),
    environment: { FAKE_ACP_MODE: 'fuigo-script', FAKE_ACP_MCP_READY: '1', FAKE_ACP_SCRIPT: '[]' } });
  const f = consumingFixture(undefined, { threadId: 'nc-cancel-hook' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-cancel-hook', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'session.started');
  f.replace();
  canon.broken = true;
  expect(checkHookCanon(set, 'V-H2', 'hermes')).toBe(false);
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const r = fencedRefusals().filter((x): x is FencedRefusal => (x as FencedRefusal).site === 'acp.cancel.hookrepair' && x.threadId === 'nc-cancel-hook');
  expect(r, 'one refusal record for the hook-repair cancel').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});
