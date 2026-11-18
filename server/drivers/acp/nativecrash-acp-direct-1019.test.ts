// SPDX-License-Identifier: AGPL-3.0-or-later
// nativecrash G3 (ACD, LLD-acp, LLI-acp; STAGE2 sec. 5).
// ACD: a fenced refusal that escapes every request handler is claimed at "acp.dispatch"; it never floats as an unhandled rejection.
// LLD-acp: a refusal the driver raises itself (no engine request behind it) is recorded at "acp.direct.<line>" with the lease as closer.
// LLI-acp: a Stop after a driver claim joins the driver's one close; after a lease-won refusal the Stop body still runs and resolves.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDirs } from '../../config.ts';
import { createAcpDriver, type AcpSupport } from './core.ts';
import { hermesAcpSupport } from './hermes.ts';
import { fencedRefusals, fencedTurnInput, type FencedRefusal } from '../engine-input.ts';
import { buildPrompt, promptPart, noneRef } from '../../memory/prompt-parts.ts';
import { checkedOpenTurns } from '../../memory/lineage-write.ts';
import { consumingFixture } from '../../testing/consuming-fixture.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';
import { bindFixtureAdapter } from '../../testing/mcp-admission-fixture.ts';
import { expectDefinedRefusal, expectMemoryRefused, watchEscapes } from '../../testing/nativecrash-harness.ts';
import type { ProviderInstance } from '../../contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, '..', '..', 'testing', 'fake-acp-cli.ts');
const FAKE_MCP = join(HERE, '..', '..', 'testing', 'fake-c11-mcp.mjs');
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { vi.unstubAllEnvs(); for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

const baseSupport = (driverKind: string, extra: Partial<AcpSupport> = {}): AcpSupport => ({ driverKind, displayName: 'Hermes', models: { default: '', options: [] }, defaultCli: FAKE_CLI,
  nativeSource: 'test.acp', loginNote: 'unused', spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
  normalizeAsk: hermesAcpSupport.normalizeAsk, fluxReach: () => 'elsewhere' as const, ...extra } as AcpSupport);
const create = async (support: AcpSupport, id: string, environment: Record<string, string>) => {
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: id, displayName: 'Hermes', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: false }), environment });
  return instance;
};
const refusalsOf = (threadId: string, site: string): FencedRefusal[] =>
  fencedRefusals().filter((x): x is FencedRefusal => x.threadId === threadId && ((x as FencedRefusal).site === site || ((x as FencedRefusal).joins ?? []).includes(site)));
const within = <T,>(work: Promise<T>, ms: number): Promise<T | 'hung'> => Promise.race([work, new Promise<'hung'>(r => setTimeout(() => r('hung'), ms))]);
const peer = (tools: string[]) => ({ command: process.execPath, args: [FAKE_MCP], env: { FIXTURE_TOOLS: JSON.stringify(tools) } });

// ACD: the permission request handler throws the fence's refusal out of the dispatch (no inner catch owns it).
it('ACD a refusal escaping the request dispatch claims acp.dispatch', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const f = consumingFixture(undefined, { threadId: 'nc-acd' }); cleanups.push(() => f.close());
  const support = baseSupport('ncAcd', { normalizeAsk: () => { f.replace(); throw Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { code: 'MEMORY_CONTEXT_REVOKED' }); } });
  await create(support, 'nc-acd', { FAKE_ACP_MODE: 'permission' });
  const recorder = recordEvents(instance!.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance!.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-acd', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const r = refusalsOf('nc-acd', 'acp.dispatch');
  expect(r, 'one refusal record for the dispatch').toHaveLength(1);
  expect(r[0]!.kind).toBe('turn');
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// LLI-acp (driver won): the prompt write is refused and the driver closes; a Stop for that turn joins the close and reports it confirmed.
it('LLI-acp Stop after a driver claim joins the one close', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-lli-gate-')), 'go');
  await create(baseSupport('ncLli'), 'nc-lli', { FAKE_ACP_SESSION_NEW_GATE: gate });
  const f = consumingFixture(undefined, { threadId: 'nc-lli' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance!.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance!.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-lli', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await new Promise(r => setTimeout(r, 800));
  f.replace();
  writeFileSync(gate, '');
  // No lease R: the prompt write's claim is kind submission and keeps submission_refused (fence-kind rule, model r4 rows 70/114/120/127).
  await expectDefinedRefusal(recorder, watch, sent.turnId);
  const ends = recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ends, 'exactly one terminal event').toHaveLength(1);
  expect(ends[0]).toMatchObject({ ok: false, stopReason: 'submission_refused' });
  const r = refusalsOf('nc-lli', 'acp.prompt');
  expect(r).toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  const stopped = await within(instance!.adapter.interruptTurn!('nc-lli', sent.turnId), 10_000);
  expect(stopped, 'the Stop reports the driver close, not a second close of a turn it cannot find').toEqual({ closeConfirmed: (await r[0]!.teardown).confirmed });
  expect(stopped).toEqual({ closeConfirmed: true });
  // A Stop naming another turn is not this refusal's Stop.
  expect(await within(instance!.adapter.interruptTurn!('nc-lli', 'another-turn'), 10_000)).toEqual({ closeConfirmed: false, reason: 'stop-failed' });
});

// LLD-acp :3105: a mounted turn on an engine with its own tools is refused before anything is started.
it('LLD-acp a capacity refusal before launch is recorded at acp.direct.3105 with the lease as closer', async () => {
  await create(baseSupport('ncLldA', { ownTools: true }), 'nc-lld-a', { FAKE_ACP_MODE: 'no-auth' });
  bindFixtureAdapter(instance!.adapter);
  let threw: unknown;
  await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'nc-lld-a', text: 'go', integrations: { agents: peer(['one']) } } as never).catch(error => { threw = error; });
  expect((threw as Error | undefined)?.message).toBe('MEMORY_CONTEXT_REVOKED');
  const r = refusalsOf('nc-lld-a', 'acp.direct.3105');
  expect(r, 'one refusal record for the direct refusal').toHaveLength(1);
  expect(r[0]!.closer).toBe('lease');
  expect(r[0]!.kind).toBe('turn');
});

// LLD-acp :7292 (load-proof): the mounted servers never report ready inside the wait, so the turn is refused with no prompt sent.
// LLI-acp (lease won): nothing in the driver closes this refusal, so a Stop must run its own body and resolve.
it('LLD-acp a load-proof refusal is recorded at acp.direct.7292 with the lease as closer, and a Stop after it resolves', async () => {
  vi.stubEnv('MURAGE_ACP_MCP_LISTED_MS', '1500');
  await create(baseSupport('ncLldB', { ownTools: false, mcpListedWait: true }), 'nc-lld-b', { FAKE_ACP_MODE: 'no-auth', FAKE_ACP_MCP_LIST: 'all:initializing' });
  bindFixtureAdapter(instance!.adapter);
  const recorder = recordEvents(instance!.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'nc-lld-b', text: 'go', integrations: { agents: peer(['one']) } } as never);
  const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId) as unknown as { ok: boolean; stopReason: string | null };
  expect(done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  const r = refusalsOf('nc-lld-b', 'acp.direct.7292');
  expect(r, 'one refusal record for the load-proof refusal').toHaveLength(1);
  expect(r[0]!.closer).toBe('lease');
  expect(r[0]!.kind).toBe('turn');
  expect(await within(instance!.adapter.interruptTurn!('nc-lld-b'), 10_000), 'the Stop body runs as the close and resolves').toEqual({ closeConfirmed: true });
});
