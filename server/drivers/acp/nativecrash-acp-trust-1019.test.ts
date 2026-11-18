// SPDX-License-Identifier: AGPL-3.0-or-later
// nativecrash G3a (ACF1, ACF2, ACF3, ACT, AC6b): folder-trust replies written after the turn's binding was revoked claim the fenced refusal at their own
// literal site and the turn ends memory-refused (STAGE2 sec. 5). Real Fuigo driver against the fake ACP CLI's trust modes.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../../config.ts';
import { FuigoAgentDriver } from './fuigo.ts';
import { fencedRefusals, fencedTurnInput, type FencedRefusal } from '../engine-input.ts';
import { buildPrompt, promptPart, noneRef } from '../../memory/prompt-parts.ts';
import { checkedOpenTurns } from '../../memory/lineage-write.ts';
import { consumingFixture } from '../../testing/consuming-fixture.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';
import { expectMemoryRefused, watchEscapes } from '../../testing/nativecrash-harness.ts';
import type { FolderTrustTurnInput, ProviderInstance } from '../../contracts.ts';

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'fake-acp-cli.ts');
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
let home: string;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); home = realpathSync(mkdtempSync(join(tmpdir(), 'nc-trust-'))); mkdirSync(join(home, '.fuigo'), { recursive: true }); writeFileSync(join(home, '.fuigo', 'auth.json'), '{}'); });
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

const create = async (threadId: string, environment: Record<string, string>, folder?: string) => {
  instance = await FuigoAgentDriver.create({ instanceId: threadId, displayName: 'NC', environment: { HOME: home, FAKE_ACP_MODE: 'folder-trust', FAKE_ACP_MCP_READY: '1', ...environment },
    enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const f = consumingFixture(undefined, { threadId }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const cwd = folder ?? fixtureBotFolder();
  return { f, recorder, cwd };
};
const send = (c: Awaited<ReturnType<typeof create>>, threadId: string, folderTrust: Partial<FolderTrustTurnInput>) =>
  instance!.adapter.sendTurn(fencedTurnInput({ cwd: c.cwd, threadId, text: 'go', releaseBinding: c.f.binding, folderTrust: { key: c.cwd, folder: c.cwd, sources: ['AGENTS.md'], trustKeys: [], rejects: [], ...folderTrust },
    prompt: buildPrompt(c.f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: c.f.f.db, retained: c.f.turn, reader: checkedOpenTurns(c.f.turn)[0]!.reader! }));
const mine = (site: string, threadId: string) => fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).site === site && r.threadId === threadId);
const trustAnswer = (label: string) => ({ behavior: 'answer', answers: [{ id: 'folderTrust', selected: [label] }] }) as never;

// ACF2: generation 2 card; the reply write is the claim site (the card hook is only the second join).
it('acp folder-trust v2 card answer after a revoke claims acp.trust.v2', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const c = await create('nc-trust-v2', { FAKE_ACP_TRUST_V: '2', FAKE_ACP_TRUST_ON_PROMPT: '1' });
  const sent = await send(c, 'nc-trust-v2', {});
  const opened = await c.recorder.until(e => e.type === 'request.opened') as unknown as { requestId: string; questions: Array<{ options: Array<{ label: string }> }> };
  c.f.replace();
  await instance!.adapter.respondToRequest('nc-trust-v2', opened.requestId, trustAnswer(opened.questions[0]!.options[0]!.label)).catch(() => undefined);
  await expectMemoryRefused(c.recorder, watch, sent.turnId);
  const r = mine('acp.trust.v2', 'nc-trust-v2');
  expect(r, 'one refusal record for the v2 reply').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// ACF3: generation 1 stored decision answers the engine's request with no card; the revoke lands before the request.
it('acp folder-trust legacy stored-decision reply after a revoke claims acp.trust.legacy', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-trust-gate-')), 'go');
  const c = await create('nc-trust-legacy', { FAKE_ACP_VERSION: 'fuigo 1.0.34', FAKE_ACP_REQUEST_GATE: gate });
  const sent = await send(c, 'nc-trust-legacy', { decision: 'reject', fromRecord: true });
  await c.recorder.until(e => e.type === 'session.started');
  c.f.replace();
  writeFileSync(gate, '');
  await expectMemoryRefused(c.recorder, watch, sent.turnId);
  const r = mine('acp.trust.legacy', 'nc-trust-legacy');
  expect(r, 'one refusal record for the legacy reply').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// ACF1: generation 1 card; the engine asks after the revoke (gate), the owner answers, the reply write is refused and claims acp.trust.v1.
it('acp folder-trust v1 card answer after a revoke claims acp.trust.v1', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-trust-gate-')), 'go');
  const c = await create('nc-trust-v1', { FAKE_ACP_REQUEST_GATE: gate });
  const sent = await send(c, 'nc-trust-v1', {});
  await c.recorder.until(e => e.type === 'session.started');
  c.f.replace();
  writeFileSync(gate, '');
  const opened = await c.recorder.until(e => e.type === 'request.opened') as unknown as { requestId: string; questions: Array<{ options: Array<{ label: string }> }> };
  await instance!.adapter.respondToRequest('nc-trust-v1', opened.requestId, trustAnswer(opened.questions[0]!.options[0]!.label)).catch(() => undefined);
  await expectMemoryRefused(c.recorder, watch, sent.turnId);
  const r = mine('acp.trust.v1', 'nc-trust-v1');
  expect(r, 'one refusal record for the v1 card reply').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// A gated generation 2 request raised after the revoke; the engine's own reply is what the refusal lands on.
const gatedV2 = async (threadId: string, environment: Record<string, string>, folderTrust: Partial<FolderTrustTurnInput>, folder?: string) => {
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-trust-gate-')), 'go');
  const c = await create(threadId, { FAKE_ACP_TRUST_V: '2', FAKE_ACP_VERSION: 'fuigo 1.0.62', FAKE_ACP_REQUEST_GATE: gate, ...environment }, folder);
  const sent = await send(c, threadId, folderTrust);
  await c.recorder.until(e => e.type === 'session.started');
  c.f.replace();
  writeFileSync(gate, '');
  return { c, sent };
};

// ACT: the thread desk Murage made, process-capable engine: the grant is written without a card; the write after the revoke claims acp.trust.auto.
it('acp folder-trust v2 desk auto grant after a revoke claims acp.trust.auto', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'nc-trust-data-')));
  const desk = join(dataDir, 'workspaces', 'bot_1', 'threads', 'thread-1');
  mkdirSync(join(desk, '.murage-procedures'), { recursive: true }); mkdirSync(join(desk, 'outputs'), { recursive: true });
  const { c, sent } = await gatedV2('nc-trust-auto', { FAKE_ACP_TRUST_KINDS: '', FAKE_ACP_TRUST_WORKSPACE: desk }, { key: desk, folder: desk, sources: [],
    managedDesk: { botId: 'bot_1', threadId: 'thread-1', desk, bundleIds: ['bundle_a'], dataDir, ownerPicked: false } } as never, desk);
  await expectMemoryRefused(c.recorder, watch, sent.turnId);
  const r = mine('acp.trust.auto', 'nc-trust-auto');
  expect(r, 'one refusal record for the desk auto grant').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// AC6b: a picked folder on a turn that is NOT No limits, with no card and a process-only grant: its own control-reply site.
it('acp folder-trust v2 no-card-pick process grant after a revoke claims acp.reply.control.b', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const cwd = fixtureBotFolder();
  const { c, sent } = await gatedV2('nc-trust-ctlb', {}, { noCardPickKeys: [cwd] }, cwd);
  await expectMemoryRefused(c.recorder, watch, sent.turnId);
  const r = mine('acp.reply.control.b', 'nc-trust-ctlb');
  expect(r, 'one refusal record for the no-card-pick grant').toHaveLength(1);
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});
