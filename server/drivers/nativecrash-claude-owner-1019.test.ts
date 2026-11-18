// SPDX-License-Identifier: AGPL-3.0-or-later
// CL1-4 owner composite + turn-level terminal (nativecrash G2 claude, STAGE2 rows CL1-4, N3, N5). A fenced broker reply on a live turn is
// ONE turn refusal that the driver closes: the captured turn settles once as memory-refused (never a generic "engine exited" error,
// never left running on a revoked binding), the proxy connection is closed AND the captured session is retired and confirmed gone.
import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../config.ts';
import { ClaudeDriver, createPermissionBroker, resetClaudeMcpReadinessForTests } from './claude.ts';
import { resetClaudeVersionGate } from './claude-guards.ts';
import { fencedRefusals as ringRefusals, refusalFor, type FencedRefusal } from './engine-input.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { closeTurnLineage } from '../memory/lineage-write.ts';
import { recordEvents } from '../testing/events.ts';
import { fixtureMountTurn } from '../testing/mcp-admission-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { expectMemoryRefused, watchEscapes } from '../testing/nativecrash-harness.ts';
import type { ProviderInstance } from '../contracts.ts';

const fencedRefusals = () => ringRefusals() as readonly unknown[] as readonly FencedRefusal[];
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-claude-cli.ts');
const ENV_KEYS = ['FAKE_CLAUDE_PERM_INPUT', 'FAKE_CLAUDE_ELICIT', 'FAKE_CLAUDE_ELICIT_LOG', 'FAKE_CLAUDE_BG_ASKS', 'FAKE_CLAUDE_BG_TASKS', 'FAKE_CLAUDE_BG_RESULT_ON_STOP'] as const;
const ELICIT = { subtype: 'elicitation', mcp_server_name: 'fixturesrv', display_name: 'Fixture', message: 'Run it?', mode: 'form', elicitation_id: 'el-1',
  requested_schema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Run it' } }, required: ['confirm'] }, property_order: ['confirm'] };
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetClaudeVersionGate(); resetClaudeMcpReadinessForTests();
  for (const c of cleanups.splice(0).reverse()) await c();
  await instance?.dispose().catch(() => {}); instance = undefined;
});
async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`owner rig deadline: ${what}`); await new Promise(r => setTimeout(r, 10)); }
}
const mine = (threadId: string) => fencedRefusals().filter(r => r.threadId === threadId);

// Broker seam, site 4 (unshowable question, the same refusedReply every CL1-4 site calls): with a live owner the claim is a DRIVER close whose
// composite settles the owner FIRST, then closes the connection and runs the session's retire part; one R, teardown confirmed.
it('CL1-4 owner composite (broker seam): a fenced local reply claims the close for the driver; owner settles first, then connection + retire', async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nc-clown-'))); cleanups.push(() => removeTempDir(dir));
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const f = consumingFixture(undefined, { threadId: 'nc-clown-b' }); cleanups.push(() => f.close());
  const order: string[] = []; let sockClosed = false;
  const owner = { settleFenced: async () => { order.push('settle'); } };
  const broker = await createPermissionBroker({ releaseBinding: f.binding, threadId: 'nc-clown-b', socketPaths: [join(dir, 'b.sock')], onAsk: () => {}, onResolve: () => {}, isActive: () => true,
    refusalCtx: () => ({ owner, target: owner, close: () => async () => { order.push(`retire:conn-closed=${sockClosed}`); return { confirmed: true }; } }) });
  cleanups.push(() => broker.close());
  const sock: Socket = connect(broker.socketPath); sock.on('error', () => {}); cleanups.push(() => sock.destroy());
  sock.on('close', () => { sockClosed = true; });
  await new Promise<void>(resolve => sock.once('connect', () => resolve()));
  f.replace();
  sock.write(JSON.stringify({ t: 'ask', id: 'q-bad', kind: 'question', tool: 'AskUserQuestion', input: { questions: 'not-an-array' } }) + '\n');
  await until(() => mine('nc-clown-b').length > 0, 'the fenced broker reply was classified');
  const rec = mine('nc-clown-b');
  expect(rec.map(r => [r.site, r.kind, r.closer]), 'ONE turn refusal, closed by the driver').toEqual([['claude.broker.4', 'turn', 'driver']]);
  expect(await rec[0]!.teardown).toEqual({ confirmed: true });
  expect(order[0], 'the owner turn settles FIRST, inside the composite').toBe('settle');
  expect(order).toHaveLength(2);
  await until(() => sockClosed, 'the proxy connection is closed (fail-closed deny)');
  expect((owner as { fenced?: unknown }).fenced, 'the refusal is attached to its owner turn').toBe(rec[0]);
  expect(watch.escaped).toEqual([]);
}, 60_000);

// Driver rig (real child, live turn): the owner answers a permission card after the turn's binding was revoked. The receipt write is
// fenced (claude.broker.finish, the same refusedReply as CL1-4): the turn must end ONCE as memory-refused and its child be retired.
it('CL owner composite (driver rig): a fenced owner answer on a live turn ends the turn memory-refused and retires the captured child', async () => {
  process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ command: 'ls' });
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await ClaudeDriver.create({ instanceId: 'nc-clown', displayName: 'Claude', environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: 'acceptEdits' } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const input = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: 'nc-clown', text: '__fixture_permission_tool__' });
  const sent = await instance.adapter.sendTurn(input);
  const card = await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId) as unknown as { requestId: string };
  closeTurnLineage(input.releaseBinding!.turn);
  await instance.adapter.respondToRequest('nc-clown', card.requestId, { behavior: 'allow' } as never).catch(() => {});
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const rec = mine('nc-clown');
  expect(rec.map(r => [r.site, r.kind, r.closer]), 'ONE turn refusal, closed by the driver').toEqual([['claude.broker.finish', 'turn', 'driver']]);
  expect(await rec[0]!.teardown, 'connection closed AND the captured session retired, confirmed').toEqual({ confirmed: true });
  expect(instance.adapter.hasSession('nc-clown'), 'the session of the refused turn is gone').toBe(false);
  expect(recorder.events.filter(e => e.type === 'runtime.error' && e.turnId === sent.turnId), 'a refusal is not an engine error').toEqual([]);
  expect(recorder.events.filter(e => e.type === 'request.resolved' && (e as { requestId?: string }).requestId === card.requestId).map(e => (e as { behavior?: string }).behavior), 'the card resolves once as a deny').toEqual(['deny']);
}, 60_000);

it('CL6 turn-level terminal: a fenced control reply settles the captured turn memory-refused before its child is retired (no engine-exit error)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'nc-clown-')); cleanups.push(() => removeTempDir(scratch));
  process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([ELICIT]); process.env.FAKE_CLAUDE_ELICIT_LOG = join(scratch, 'elicit.log');
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await ClaudeDriver.create({ instanceId: 'nc-clown6', displayName: 'Claude', environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: 'bypassPermissions' } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const input = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: 'nc-clown6', text: 'go' });
  const sent = await instance.adapter.sendTurn(input);
  const card = await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId) as unknown as { requestId: string };
  closeTurnLineage(input.releaseBinding!.turn);
  await instance.adapter.respondToRequest('nc-clown6', card.requestId, { behavior: 'answer', answers: [{ id: 'confirm', selected: ['Yes'] }] }).catch(() => {});
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const rec = mine('nc-clown6');
  expect(rec.map(r => [r.kind, r.closer])).toEqual([['turn', 'driver']]);
  expect(await rec[0]!.teardown).toEqual({ confirmed: true });
  expect(recorder.events.filter(e => e.type === 'runtime.error' && e.turnId === sent.turnId), 'a refusal is not an engine error').toEqual([]);
}, 60_000);

// CLR (M7 LATE-OK sibling) on the CL5 rig: the LEASE owns the turn's refusal (registered, noClaim: a Tl revoke outside a fence call) while a
// background helper's ask is open. unanswered: no driver site ever sees the refusal, so only P1's dispatch-generation lookup can attach it.
// answered: the fenced owner answer only joins it and the driver closes nothing; the ask stays unanswered at the CLI. Either way the
// lease's close interrupts the turn and the CLI's successful `result` arrives late, at that Stop: the turn ends memory-refused, never ok.
it.each(['unanswered', 'answered'] as const)('CLR (CL5 rig, ask %s): a late successful result on a lease-owned refusal ends the turn memory-refused', async (mode) => {
  process.env.FAKE_CLAUDE_BG_ASKS = '1'; process.env.FAKE_CLAUDE_BG_TASKS = '1'; process.env.FAKE_CLAUDE_BG_RESULT_ON_STOP = '1';
  const threadId = `nc-clr-${mode}`;
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await ClaudeDriver.create({ instanceId: threadId, displayName: 'Claude', environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: 'acceptEdits' } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const input = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId, text: '__fixture_background__' });
  const sent = await instance.adapter.sendTurn(input);
  const card = await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId) as unknown as { requestId: string };
  const own = refusalFor(Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { code: 'MEMORY_CONTEXT_REVOKED' }), 'lease.ledger',
    { engine: 'claude', threadId, binding: input.releaseBinding!, kind: 'turn', target: undefined })!;
  expect(own.noClaim(), 'the lease owns the close').toBe(true);
  closeTurnLineage(input.releaseBinding!.turn);
  if (mode === 'answered') {
    await instance.adapter.respondToRequest(threadId, card.requestId, { behavior: 'allow' } as never).catch(() => {});
    await until(() => own.joins.some(s => s.startsWith('claude.broker')), 'the fenced owner answer joined');
  }
  expect(recorder.events.some(e => e.type === 'turn.completed'), 'the ask is still unanswered at the CLI; the turn is live').toBe(false);
  // the lease's close (its fallback: the provider turn's interrupt)
  const closed = own.close(async () => { await instance!.adapter.interruptTurn(threadId); return { confirmed: true }; });
  const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect([(done as { ok?: boolean }).ok, (done as { stopReason?: string }).stopReason], 'the late result ends the turn memory-refused').toEqual([false, 'memory-refused']);
  await new Promise(r => setTimeout(r, 300));
  expect(recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'one terminal').toHaveLength(1);
  expect(mine(threadId), "the lease's one record, no second").toEqual([own]);
  expect(own.closer, 'the driver claimed nothing').toBe('lease');
  expect(await closed).toEqual({ confirmed: true });
  expect(watch.escaped).toEqual([]);
}, 60_000);
