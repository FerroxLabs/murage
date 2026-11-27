// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness (cl-nativecrash): pi.ts send() (:1191, releaseNativeAnswer "pi:answer"). The binding is revoked while a permission card is
// open; the owner's answer is then fenced. It must not reject or escape as an unhandledRejection/uncaughtException, and the turn must
// end in a defined terminal refusal (the engine holds the turn until its extension_ui_response).
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../config.ts';
import { PiDriver } from './pi.ts';
import { closeTurnLineage } from '../memory/lineage-write.ts';
import { recordEvents } from '../testing/events.ts';
import { fixtureMountTurn } from '../testing/mcp-admission-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { expectMemoryRefused, watchEscapes } from '../testing/nativecrash-harness.ts';
import { FencedRefusal, fencedRefusals, refusalForVerdict, unawaitedTeardowns } from './engine-input.ts';
import type { LineageVerdict } from '../memory/lineage-types.ts';
import type { ProviderInstance } from '../contracts.ts';

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-pi-cli.ts');
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

it('pi permission answer on a revoked turn neither rejects nor leaves the turn open (:1191)', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await PiDriver.create({ instanceId: 'nc-pi', displayName: 'pi', environment: { FAKE_PI_MODE: 'permission' }, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const input = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: 'nc-pi', text: 'go' });
  const sent = await instance.adapter.sendTurn(input);
  const card = await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId) as unknown as { requestId: string };
  closeTurnLineage(input.releaseBinding!.turn); // revoke: the fixture's isCurrent is private; retiring the open lineage turn fences the same way
  let threw: unknown;
  await instance.adapter.respondToRequest('nc-pi', card.requestId, { behavior: 'allow' }).catch(error => { threw = error; });
  expect.soft(threw, 'respondToRequest rejected').toBeUndefined();
  await expectMemoryRefused(recorder, watch, sent.turnId);
  // PIN/PIR: ONE claim at the answer write, the driver closes it (confirmed), the turn never reads as cancelled, no teardown left unawaited
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === 'nc-pi');
  expect(mine.map(r => r.site)).toEqual(['pi.ask']);
  expect(mine[0]!.closer).toBe('driver');
  expect(await mine[0]!.teardown).toEqual({ confirmed: true });
  expect(unawaitedTeardowns().filter(r => r.threadId === 'nc-pi')).toEqual([]);
  expect(recorder.events.filter(e => e.type === 'turn.completed' && (e as unknown as { stopReason?: string }).stopReason === 'cancelled')).toEqual([]);
});

const refusalError = () => Object.assign(new Error('the memory context was revoked'), { code: 'MEMORY_CONTEXT_REVOKED' });
async function startPi(threadId: string, patch: Record<string, unknown>, env: Record<string, string> = {}) {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await PiDriver.create({ instanceId: threadId, displayName: 'pi', environment: env, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const input = { ...fixtureMountTurn({ cwd: fixtureBotFolder(), threadId, text: 'go' }), ...patch };
  const sent = await instance.adapter.sendTurn(input as never);
  return { watch, recorder, sent, input };
}
async function expectSubmissionRefused(threadId: string, site: string, x: Awaited<ReturnType<typeof startPi>>) {
  const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId);
  expect(ended).toMatchObject({ ok: false, stopReason: 'submission_refused' });
  expect(x.watch.escaped).toEqual([]);
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId), 'one terminal').toHaveLength(1);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === threadId);
  expect(mine.map(r => r.site), 'one R').toEqual([site]);
  expect(mine[0]!.kind).toBe('submission');
  expect(await mine[0]!.teardown).toEqual({ confirmed: true });
  expect(unawaitedTeardowns().filter(r => r.threadId === threadId)).toEqual([]);
}

// PISUB-p: the prompt boundary refuses before any write (beforeSubmit), once.
it('pi beforeSubmit refusal is one submission_refused terminal at pi.prompt.prepare', async () => {
  const x = await startPi('nc-pi-p', { beforeSubmit: () => { throw refusalError(); } });
  await expectSubmissionRefused('nc-pi-p', 'pi.prompt.prepare', x);
});

// PISUB: the prompt send's own boundary entry refuses after the setup steps (second attempt), so the catch must classify it.
it('pi prompt send refused after set_thinking_level is submission_refused at pi.prompt, not failed', async () => {
  const x = await startPi('nc-pi-s', { effort: 'high', fencedWrite: () => { throw refusalError(); } });
  await expectSubmissionRefused('nc-pi-s', 'pi.prompt', x);
});

// PIU: the session setup sends (set_model, set_thinking_level) are native writes. The binding is revoked AFTER admission (while the session
// handshake is held), so the :1191 fence refuses the setup send itself and it must be claimed at its own site, never read as a setup failure.
async function piSetupRefused(threadId: string, patch: Record<string, unknown>, site: string) {
  const gate = join(tmpdir(), `${threadId}-${process.pid}.gate`);
  cleanups.push(() => rmSync(gate, { force: true }), () => rmSync(`${gate}.waiting`, { force: true }));
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await PiDriver.create({ instanceId: threadId, displayName: 'pi', environment: { FAKE_PI_SESSION_GATE: gate }, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const input = { ...fixtureMountTurn({ cwd: fixtureBotFolder(), threadId, text: 'go' }), ...patch };
  const sending = instance.adapter.sendTurn(input as never);
  for (let i = 0; i < 400 && !existsSync(`${gate}.waiting`); i++) await new Promise(r => setTimeout(r, 25));
  expect(existsSync(`${gate}.waiting`), 'session handshake held').toBe(true);
  closeTurnLineage(input.releaseBinding!.turn);
  writeFileSync(gate, '');
  const sent = await sending;
  const ended = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ended).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  expect(watch.escaped).toEqual([]);
  expect(recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'one terminal').toHaveLength(1);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === threadId);
  expect(mine.map(r => r.site), 'one R').toEqual([site]);
  expect(await mine[0]!.teardown).toEqual({ confirmed: true });
  expect(unawaitedTeardowns().filter(r => r.threadId === threadId)).toEqual([]);
}
it('pi set_model send on a revoked turn is claimed at pi.setup.model', async () => {
  await piSetupRefused('nc-pi-m', { model: 'openai/gpt-4o' }, 'pi.setup.model');
});
it('pi set_thinking_level send on a revoked turn is claimed at pi.setup.effort', async () => {
  await piSetupRefused('nc-pi-e', { effort: 'high' }, 'pi.setup.effort');
});

// PIJ: two open cards. Card 1's answer is refused (claim "pi.ask"); card 2 is still pending, so the settle's retire-deny is refused too and
// must JOIN the one R (no second record, no second closer, one terminal).
it('pi: a second open card denied at the settle joins the one refusal', async () => {
  const x = await startPi('nc-pi-j', {}, { FAKE_PI_MODE: 'permission2' });
  const cards: string[] = [];
  await x.recorder.until(e => { if (e.type === 'request.opened' && e.turnId === x.sent.turnId) cards.push((e as unknown as { requestId: string }).requestId); return cards.length === 2; });
  closeTurnLineage(x.input.releaseBinding!.turn);
  await instance!.adapter.respondToRequest('nc-pi-j', cards[0]!, { behavior: 'allow' }).catch(() => {});
  await expectMemoryRefused(x.recorder, x.watch, x.sent.turnId);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === 'nc-pi-j');
  expect(mine.map(r => r.site), 'one R').toEqual(['pi.ask']);
  expect(await mine[0]!.teardown).toEqual({ confirmed: true });
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId), 'one terminal').toHaveLength(1);
  expect(unawaitedTeardowns().filter(r => r.threadId === 'nc-pi-j')).toEqual([]);
});

// PI1+: an unshowable dialog is cancelled by the driver itself; with the binding revoked that cancel write is refused. It must end the turn
// as the refusal (not be swallowed as a "non-JSON line" with the turn left open).
it('pi unshowable dialog cancel on a revoked turn is claimed at pi.answer.cancel', async () => {
  const gate = join(tmpdir(), `nc-pi-u-${process.pid}.gate`);
  cleanups.push(() => rmSync(gate, { force: true }), () => rmSync(`${gate}.waiting`, { force: true }));
  const x = await startPi('nc-pi-u', {}, { FAKE_PI_MODE: 'unshowable', FAKE_PI_ASK_GATE: gate });
  for (let i = 0; i < 400 && !existsSync(`${gate}.waiting`); i++) await new Promise(r => setTimeout(r, 25));
  expect(existsSync(`${gate}.waiting`), 'ask held').toBe(true);
  closeTurnLineage(x.input.releaseBinding!.turn);
  writeFileSync(gate, '');
  await expectMemoryRefused(x.recorder, x.watch, x.sent.turnId);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === 'nc-pi-u');
  expect(mine.map(r => r.site), 'one R').toEqual(['pi.answer.cancel']);
  expect(await mine[0]!.teardown).toEqual({ confirmed: true });
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId), 'one terminal').toHaveLength(1);
});

// PIL: a bound turn whose child exits non-zero mid-turn is a lease refusal (the exit path calls refuseConsumingTurn): ONE R at the lease's
// own site "lease.ledger" (no driver claim, joins none), one memory-refused terminal, the child reaped.
it('pi crash mid-turn on a bound turn ends as the lease.ledger refusal, once', async () => {
  const base = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: 'nc-pi-l', text: 'go' });
  // the lease's own refusal handler (ledger-refusal.ts register): a verdict R at "lease.ledger" with no driver claim
  const releaseBinding = { ...base.releaseBinding!, onLedgerRefused: (verdict: LineageVerdict) => {
    refusalForVerdict(verdict, 'lease.ledger', { engine: 'lease', threadId: 'nc-pi-l', binding: { identity: base.releaseBinding!.identity } as never, lease: { late: undefined } })?.noClaim();
    // the lease won the claim: it closes (the real lease's interrupt), confirming at once
    void fencedRefusals().find((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === 'nc-pi-l')?.close(async () => ({ confirmed: true }));
  } };
  const x = await startPi('nc-pi-l', { releaseBinding }, { FAKE_PI_MODE: 'crash-mid-turn' });
  for (let i = 0; i < 400 && !fencedRefusals().some(r => r instanceof FencedRefusal && r.threadId === 'nc-pi-l'); i++) await new Promise(r => setTimeout(r, 25));
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === 'nc-pi-l');
  expect(await mine[0]!.teardown).toEqual({ confirmed: true });
  expect(x.watch.escaped).toEqual([]);
  expect(mine.map(r => r.site), 'one R').toEqual(['lease.ledger']);
  expect(mine[0]!.joins).toEqual([]);
  expect(mine[0]!.closer).toBe('lease');
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId), 'lease mode: the lease owns the terminal').toHaveLength(0);
  expect(unawaitedTeardowns().filter(r => r.threadId === 'nc-pi-l')).toEqual([]);
});

// 1.0.20 busy-engines (pi family): pi exiting mid-turn on a bound turn is the driver's own refusal; it reaches the lease as
// ENGINE_OWN_REFUSAL (driverRaised), the verdict the direct turn's lease reads at its seal to end the turn at once, as on 1.0.19, instead of
// rebuilding it into the same exit (index.ts admitLedgerLease). Before, pi refused with the plain verdict.
it('busy-engines pi: a crash mid-turn on a bound turn gives the lease the driverRaised verdict, once', async () => {
  const base = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: 'be-pi', text: 'go' });
  const verdicts: LineageVerdict[] = [];
  const releaseBinding = { ...base.releaseBinding!, onLedgerRefused: (verdict: LineageVerdict) => {
    verdicts.push(verdict);
    refusalForVerdict(verdict, 'lease.ledger', { engine: 'lease', threadId: 'be-pi', binding: { identity: base.releaseBinding!.identity } as never, lease: { late: undefined } })?.noClaim();
    void fencedRefusals().find((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === 'be-pi')?.close(async () => ({ confirmed: true }));
  } };
  const x = await startPi('be-pi', { releaseBinding }, { FAKE_PI_MODE: 'crash-mid-turn' });
  for (let i = 0; i < 400 && !verdicts.length; i++) await new Promise(r => setTimeout(r, 25));
  expect(verdicts, 'the lease is told once, by the driver').toEqual([{ state: 'checking', reason: 'not-built', driverRaised: true }]);
  expect(x.watch.escaped).toEqual([]);
});
