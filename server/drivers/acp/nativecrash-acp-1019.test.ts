// SPDX-License-Identifier: AGPL-3.0-or-later
// RED-ONLY witness (cl-nativecrash): ACP permission answer (core.ts approval delivery -> approval-delivery.ts writeAcpResponse :60).
// The turn's binding is revoked while a permission card is open; the owner's answer is then fenced. No unhandledRejection /
// uncaughtException may escape, and the turn must end in a defined terminal refusal (never an engine left waiting).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../../config.ts';
import { GrokAgentDriver } from './grok.ts';
import { fencedRefusals, fencedTurnInput, unawaitedTeardowns, type FencedRefusal } from '../engine-input.ts';
import { buildPrompt, promptPart, noneRef } from '../../memory/prompt-parts.ts';
import { checkedOpenTurns } from '../../memory/lineage-write.ts';
import { consumingFixture } from '../../testing/consuming-fixture.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';
import { expectMemoryRefused, watchEscapes } from '../../testing/nativecrash-harness.ts';
import { writeAcpResponse } from './approval-delivery.ts';
import type { ProviderInstance } from '../../contracts.ts';
import { PassThrough } from 'node:stream';

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'fake-acp-cli.ts');
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); mkdtempSync(join(tmpdir(), 'nc-acp-')); process.env.FAKE_ACP_MODE = 'permission'; });
afterEach(async () => { delete process.env.FAKE_ACP_MODE; for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

// :60 in isolation: the fenced write reports through done(), it never throws.
it('writeAcpResponse on a revoked binding reports a write failure and does not throw (:60)', () => {
  const f = consumingFixture(undefined, { threadId: 'nc-acp-w' }); cleanups.push(() => f.close());
  f.replace();
  let got: unknown = 'not called'; const stream = new PassThrough();
  expect(() => writeAcpResponse(stream, { jsonrpc: '2.0', id: 1, result: {} }, error => { got = error; }, undefined, f.binding)).not.toThrow();
  expect(got).toBeInstanceOf(Error);
  expect(stream.read()).toBeNull();
});

// core: an owner allow arrives after the binding was revoked.
it('acp permission answer on a revoked turn ends in a defined refusal (core -> :60)', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await GrokAgentDriver.create({ instanceId: 'nc-acp', displayName: 'NC', environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const f = consumingFixture(undefined, { threadId: 'nc-acp' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-acp', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  const opened = await recorder.until(e => e.type === 'request.opened') as unknown as { requestId: string };
  f.replace();
  let threw: unknown;
  await instance.adapter.respondToRequest('nc-acp', opened.requestId, { behavior: 'allow' }).catch(error => { threw = error; });
  // The owner's answer is refused with the typed terminal delivery error (handled by the route), never an escape; the turn's own end is below.
  expect.soft(threw, 'respondToRequest rejects with the typed engine_stopped delivery error').toMatchObject({ reason: 'engine_stopped', terminal: true });
  await expectMemoryRefused(recorder, watch, sent.turnId);
  // AC1a (STAGE2 sec. 5): the claim is the first statement of the sendPermission callback; one R, the driver closes, one terminal.
  const mine = fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).site === 'acp.permission.answer' && r.threadId === 'nc-acp');
  expect(mine, 'one refusal record for the permission answer').toHaveLength(1);
  expect(mine[0]!.kind).toBe('turn');
  expect(mine[0]!.closer).toBe('driver');
  expect((await mine[0]!.teardown).confirmed).toBe(true);
  expect(unawaitedTeardowns().filter(r => r.threadId === 'nc-acp')).toEqual([]);
});

// AC1c (STAGE2 sec. 5): the auto-allow reply of a fullAuto instance is written after the revoke; sendPermission's done is required, so the
// refusal is claimed at its own literal site (tip: the error was dropped at `done?.()`, no record, the turn ran on).
it('acp auto-allow reply after a revoke claims the fenced refusal (acp.approval.auto.allow)', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-acp-gate-')), 'go');
  process.env.FAKE_ACP_REQUEST_GATE = gate; cleanups.push(() => { delete process.env.FAKE_ACP_REQUEST_GATE; });
  instance = await GrokAgentDriver.create({ instanceId: 'nc-acp-auto', displayName: 'NC', environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } });
  const f = consumingFixture(undefined, { threadId: 'nc-acp-auto' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-acp-auto', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'session.started');
  f.replace();
  writeFileSync(gate, '');
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).site.startsWith('acp.approval.auto.') && r.threadId === 'nc-acp-auto');
  expect(mine, 'one refusal record for the auto reply').toHaveLength(1);
  expect(mine[0]!.closer).toBe('driver');
  expect((await mine[0]!.teardown).confirmed).toBe(true);
});

// AC1b (STAGE2 sec. 5): an elicitation-form answer written after the revoke. Tip: the write's error became `false`, the card stayed OPEN
// (deliverNative does not commit a refused answer while stdin is writable) and no refusal was recorded. Now: the refusal is claimed at
// "acp.question" (deliverNative's `refused` hook), the answer resolves unavailable, the turn ends memory-refused.
it('acp elicitation answer after a revoke claims the fenced refusal (acp.question)', async () => {
  process.env.FAKE_ACP_MODE = 'elicitation-form';
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await GrokAgentDriver.create({ instanceId: 'nc-acp-q', displayName: 'NC', environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const f = consumingFixture(undefined, { threadId: 'nc-acp-q' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-acp-q', text: 'deploy', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('deploy', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  const opened = await recorder.until(e => e.type === 'request.opened') as unknown as { requestId: string };
  f.replace();
  await instance.adapter.respondToRequest('nc-acp-q', opened.requestId, { behavior: 'answer', message: 'production',
    answers: [{ id: 'environment', selected: ['production'] }, { id: 'features', selected: ['cdn'] }, { id: 'confirm', selected: ['Yes'] }] } as never).catch(() => undefined);
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).site === 'acp.question' && r.threadId === 'nc-acp-q');
  expect(mine, 'one refusal record for the question answer').toHaveLength(1);
  expect(mine[0]!.closer).toBe('driver');
  expect((await mine[0]!.teardown).confirmed).toBe(true);
});

// AC6a: a question the entry cannot read is answered with the vendor's "nobody answered"; written after the revoke, that reply claims acp.reply.control.a.
it('acp unreadable elicitation reply after a revoke claims acp.reply.control.a', async () => {
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-acp-gate-')), 'go');
  process.env.FAKE_ACP_MODE = 'elicitation-malformed';
  process.env.FAKE_ACP_REQUEST_GATE = gate;
  cleanups.push(() => { delete process.env.FAKE_ACP_REQUEST_GATE; });
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await GrokAgentDriver.create({ instanceId: 'nc-acp-ctla', displayName: 'NC', environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const f = consumingFixture(undefined, { threadId: 'nc-acp-ctla' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-acp-ctla', text: 'deploy', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('deploy', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'session.started');
  f.replace();
  writeFileSync(gate, '');
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).site === 'acp.reply.control.a' && r.threadId === 'nc-acp-ctla');
  expect(mine, 'one refusal record for the unreadable-question reply').toHaveLength(1);
  expect(mine[0]!.closer).toBe('driver');
  expect((await mine[0]!.teardown).confirmed).toBe(true);
});

// AC7: the -32601 answer to a vendor method nothing knows; written after the revoke it claims acp.reply.unknown.
it('acp unknown vendor request reply after a revoke claims acp.reply.unknown', async () => {
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-acp-gate-')), 'go');
  process.env.FAKE_ACP_MODE = 'unknown-request';
  process.env.FAKE_ACP_REQUEST_GATE = gate;
  cleanups.push(() => { delete process.env.FAKE_ACP_REQUEST_GATE; });
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await GrokAgentDriver.create({ instanceId: 'nc-acp-unk', displayName: 'NC', environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const f = consumingFixture(undefined, { threadId: 'nc-acp-unk' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-acp-unk', text: 'deploy', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('deploy', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'session.started');
  f.replace();
  writeFileSync(gate, '');
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).site === 'acp.reply.unknown' && r.threadId === 'nc-acp-unk');
  expect(mine, 'one refusal record for the unknown-request reply').toHaveLength(1);
  expect(mine[0]!.closer).toBe('driver');
  expect((await mine[0]!.teardown).confirmed).toBe(true);
});

// AC8 / G-NULL (STAGE2 sec. 5, OPEN AC8-JOIN): an engine ask that arrives after the turn ended is answered by the "ended" reply, but send()
// short-circuits on a halted turn before any byte or lease lookup (Fa#4), so that reply never reaches fenceBeforeWrite: no response frame,
// no refusal record, whatever the binding. A guard, not a claim site: if the short-circuit is lost, a frame or a record appears and this fails.
it('acp late ask after Stop: the ended reply writes no frame and records no refusal (G-NULL guard, AC8)', async () => {
  const gate = join(mkdtempSync(join(tmpdir(), 'nc-acp-gate-')), 'go'), rpcLog = join(mkdtempSync(join(tmpdir(), 'nc-acp-rpc-')), 'rpc.jsonl');
  process.env.FAKE_ACP_REQUEST_GATE = gate; process.env.FAKE_ACP_RPC_LOG = rpcLog;
  cleanups.push(() => { delete process.env.FAKE_ACP_REQUEST_GATE; delete process.env.FAKE_ACP_RPC_LOG; });
  instance = await GrokAgentDriver.create({ instanceId: 'nc-acp-ended', displayName: 'NC', environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } });
  const f = consumingFixture(undefined, { threadId: 'nc-acp-ended' }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  await instance.adapter.sendTurn(fencedTurnInput({ cwd: fixtureBotFolder(), threadId: 'nc-acp-ended', text: 'go', releaseBinding: f.binding,
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  await recorder.until(e => e.type === 'session.started');
  f.replace();
  await instance.adapter.interruptTurn('nc-acp-ended').catch(() => {});
  writeFileSync(gate, '');
  await recorder.until(e => e.type === 'turn.completed');
  await new Promise(r => setTimeout(r, 600));
  const frames = readFileSync(rpcLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(frames.filter(x => x.method === undefined), 'no response frame after the turn ended').toHaveLength(0);
  expect(fencedRefusals().filter(r => r.threadId === 'nc-acp-ended' && (r as FencedRefusal).site === 'acp.reply.ended'), 'no acp.reply.ended record').toHaveLength(0);
});
