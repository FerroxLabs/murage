// SPDX-License-Identifier: AGPL-3.0-or-later
// nativecrash G3c (ACR): a session rpc (not the prompt) written after the revoke is refused at the write; the refusal is claimed at
// "acp.rpc" before the rpc rejects, so the turn ends memory-refused and the claim has the driver as its closer (STAGE2 sec. 5).
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../../config.ts';
import { createAcpDriver, type AcpSupport } from './core.ts';
import { hermesAcpSupport } from './hermes.ts';
import { fencedRefusals, fencedTurnInput, withinFenceCall, type FencedRefusal } from '../engine-input.ts';
import { createLedgerLease } from '../../ledger-refusal.ts';
import { k2Check, k2Verdict, type K2Lease } from '../../../testing/nativecrash-k2.ts';
import { buildPrompt, promptPart, noneRef } from '../../memory/prompt-parts.ts';
import { checkedOpenTurns } from '../../memory/lineage-write.ts';
import { consumingFixture } from '../../testing/consuming-fixture.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';
import { expectDefinedRefusal, expectMemoryRefused, watchEscapes } from '../../testing/nativecrash-harness.ts';
import type { ProviderInstance } from '../../contracts.ts';

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'fake-acp-cli.ts');
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

// ACR: the revoke lands while session/new is held; the session/set_mode that follows is written after it and refused.
it('acp session rpc after a revoke claims acp.rpc', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-rpc-gate-')), 'go');
  const support = { driverKind: 'ncRpc', displayName: 'Hermes', models: { default: '', options: [] }, defaultCli: FAKE_CLI, nativeSource: 'test.acp', loginNote: 'unused',
    spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
    askStop: { sessionMode: { readOnly: 'ask', normal: 'normal' }, apply: async () => undefined },
    normalizeAsk: hermesAcpSupport.normalizeAsk, fluxReach: () => 'elsewhere' as const } as AcpSupport;
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: 'nc-rpc', displayName: 'Hermes', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: false }),
    environment: { FAKE_ACP_SESSION_NEW_GATE: gate } });
  const f = consumingFixture(undefined, { threadId: 'nc-rpc' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-rpc', text: 'go', askLevel: true, routeAsks: true, releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await new Promise(r => setTimeout(r, 800));
  f.replace();
  writeFileSync(gate, '');
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const r = fencedRefusals().filter((x): x is FencedRefusal => (x as FencedRefusal).site === 'acp.rpc' && x.threadId === 'nc-rpc');
  expect(r, 'one refusal record for the rpc write').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// ACSUB (model r4 0.5, sec. 2 P1/P5; rows 70, 114, 120, 127): the prompt's own refused write is classified at "acp.prompt" and claimed
// before the submission settle; the driver is the closer and the terminal follows the fence kind. Kind submission (no lease R: the
// boundary took it) keeps submission_refused; kind turn (the lease refused first, the claim joins its R) ends memory-refused.
const subSupport = (driverKind: string) => ({ driverKind, displayName: 'Hermes', models: { default: '', options: [] }, defaultCli: FAKE_CLI, nativeSource: 'test.acp', loginNote: 'unused',
  spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
  normalizeAsk: hermesAcpSupport.normalizeAsk, fluxReach: () => 'elsewhere' as const }) as AcpSupport;
const promptClaims = (threadId: string) => fencedRefusals().filter((x): x is FencedRefusal => x.threadId === threadId && ((x as FencedRefusal).site === 'acp.prompt' || (x as FencedRefusal).joins?.includes('acp.prompt')));

// Kind submission: the revoke lands while session/new is held; the session/prompt write that follows is refused with no lease refusal.
it('acp prompt write refused with no lease refusal claims acp.prompt, kind submission, and ends submission_refused', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-sub-gate-')), 'go');
  const Driver = createAcpDriver(subSupport('ncSub'));
  instance = await Driver.create({ instanceId: 'nc-sub', displayName: 'Hermes', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: false }),
    environment: { FAKE_ACP_SESSION_NEW_GATE: gate } });
  const f = consumingFixture(undefined, { threadId: 'nc-sub' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-sub', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await new Promise(r => setTimeout(r, 800));
  f.replace();
  writeFileSync(gate, '');
  await expectDefinedRefusal(recorder, watch, sent.turnId);
  const ends = recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ends, 'exactly one terminal event').toHaveLength(1);
  expect(ends[0]).toMatchObject({ ok: false, stopReason: 'submission_refused' });
  const r = promptClaims('nc-sub');
  expect(r, 'one refusal record for the prompt write').toHaveLength(1);
  expect(r[0]!.site).toBe('acp.prompt');
  expect(r[0]!.kind).toBe('submission');
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// Kind turn: the lease refuses inside the final write's fence call (J0, registers only); the prompt write's claim joins that R, the
// driver wins the close and the turn ends memory-refused. K2/K3 backstop: one R, closer driver, the lease's interruptTurn never called.
it('acp prompt write refused after the lease refused joins the lease R, kind turn, and ends memory-refused', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const Driver = createAcpDriver(subSupport('ncSubTurn'));
  instance = await Driver.create({ instanceId: 'nc-sub-turn', displayName: 'Hermes', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: false }), environment: {} });
  const f = consumingFixture(undefined, { threadId: 'nc-sub-turn' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  let rig!: K2Lease;
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-sub-turn', text: 'go', releaseBinding: f.binding,
    fencedWrite: <T>(write: () => T): T => {
      f.replace();
      const identity = (f.binding as unknown as { identity: K2Lease['identity'] }).identity;
      const calls = { interrupt: 0, confirmed: 0, settle: 0, present: 0, seal: 0 };
      const lease = createLedgerLease(identity, { seal() { calls.seal++; }, interrupt: async () => { calls.interrupt++; return true; },
        settle() { calls.settle++; }, present() { calls.present++; }, quarantine() {}, confirmed() { calls.confirmed++; } });
      rig = { identity, lease, calls, refusals: () => fencedRefusals().filter((x): x is FencedRefusal => (x as FencedRefusal).dispatchGeneration === identity.dispatchGeneration) };
      withinFenceCall(() => lease.onLedgerRefused(k2Verdict));
      return write();
    },
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const r = promptClaims('nc-sub-turn');
  expect(r, 'one refusal record, joined by the prompt write').toHaveLength(1);
  expect(r[0]!.site).toBe('lease.ledger');
  expect(r[0]!.joins).toContain('acp.prompt');
  expect(r[0]!.kind).toBe('turn');
  expect((await r[0]!.teardown).confirmed).toBe(true);
  await k2Check(rig, { closer: 'driver' });
});
