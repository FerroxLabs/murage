// SPDX-License-Identifier: AGPL-3.0-or-later
// nativecrash G3e (antigravity): a prompt write refused at the submission fence is claimed at "agy.prompt" before the submission settle;
// the claim has the driver as its closer and the terminal follows the fence kind (STAGE2 sec. 5 AGSUB; model r4 0.5, sec. 2 P1/P5):
// kind turn (the lease refused first, the claim joins its R) ends memory-refused; kind submission (no lease R) keeps submission_refused.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDirs } from '../config.ts';
import { AntigravityDriver } from './antigravity.ts';
import { EngineInputRevoked, fencedRefusals, fencedTurnInput, kindUnjoined, unawaitedTeardowns, withinFenceCall, type FencedRefusal } from './engine-input.ts';
import * as relayModule from './antigravity-relay.ts';
import { CliMountRelay } from './cli-mount-relay.ts';
import { fixtureMountTurn } from '../testing/mcp-admission-fixture.ts';
import type { SendTurnInput } from '../contracts.ts';
import { createLedgerLease } from '../ledger-refusal.ts';
import { k2Check, k2Verdict, type K2Lease } from '../../testing/nativecrash-k2.ts';
import { buildPrompt, promptPart, noneRef } from '../memory/prompt-parts.ts';
import { checkedOpenTurns } from '../memory/lineage-write.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { expectDefinedRefusal, watchEscapes } from '../testing/nativecrash-harness.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import type { ProviderInstance } from '../contracts.ts';

const FAKE_CLI = fileURLToPath(new URL('../testing/fake-agy-cli.ts', import.meta.url));
const cleanups: Array<() => unknown> = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

/** One no-relay turn whose lease is replaced inside the final write (the prior fencedWrite), after every earlier fence passed. */
async function refusedPromptWrite(threadId: string, atWrite: (f: ReturnType<typeof consumingFixture>) => void = () => {}) {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const scratch = mkdtempSync(join(tmpdir(), 'nc-agy-sub-')); cleanups.push(() => removeTempDir(scratch));
  instance = await AntigravityDriver.create({ instanceId: threadId, displayName: 'Antigravity', enabled: true, environment: { HOME: scratch }, config: { cli: FAKE_CLI, fullAuto: true } });
  const f = consumingFixture(undefined, { threadId }); cleanups.push(() => f.close());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: scratch, threadId, text: 'go', releaseBinding: f.binding,
    fencedWrite: <T>(write: () => T): T => { f.replace(); atWrite(f); return write(); },
    prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  const mine = () => fencedRefusals().filter((x): x is FencedRefusal => x.threadId === threadId && ((x as FencedRefusal).site === 'agy.prompt' || (x as FencedRefusal).joins?.includes('agy.prompt')));
  return { watch, recorder, sent, f, mine };
}

// AGSUB, kind submission: no lease refused (the boundary took the refusal), so the driver's claim is the first R and the preserved
// submission_refused terminal stays.
it('agy prompt write refused with no lease refusal claims agy.prompt, kind submission, and ends submission_refused', async () => {
  const t = await refusedPromptWrite('nc-agy-sub');
  await expectDefinedRefusal(t.recorder, t.watch, t.sent.turnId);
  const ends = t.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === t.sent.turnId);
  expect(ends, 'exactly one terminal event').toHaveLength(1);
  expect(ends[0]).toMatchObject({ ok: false, stopReason: 'submission_refused' });
  const r = t.mine();
  expect(r, 'one refusal record for the prompt write').toHaveLength(1);
  expect(r[0]!.site).toBe('agy.prompt');
  expect(r[0]!.kind).toBe('submission');
  expect(r[0]!.closer).toBe('driver');
  expect((await r[0]!.teardown).confirmed).toBe(true);
});

// AGSUB, kind turn: the lease refused first inside the fence call (J0), the driver's claim joins that R and wins the close, and the turn
// ends memory-refused. K2/K3 backstop: one R, closer driver, the lease's interruptTurn is never called.
it('agy prompt write refused after the lease refused joins the lease R, kind turn, and ends in lease mode', async () => {
  let rig!: K2Lease;
  let attach = (_id: string) => {};
  const t = await refusedPromptWrite('nc-agy-sub-turn', f => {
    const identity = (f.binding as unknown as { identity: K2Lease['identity'] }).identity;
    const calls = { interrupt: 0, confirmed: 0, settle: 0, present: 0, seal: 0 };
    const lease = createLedgerLease(identity, { seal() { calls.seal++; }, interrupt: async () => { calls.interrupt++; return true; },
      settle() { calls.settle++; }, present() { calls.present++; }, quarantine() {}, confirmed() { calls.confirmed++; } });
    rig = { identity, lease, calls, refusals: () => fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).dispatchGeneration === identity.dispatchGeneration) };
    attach = id => lease.attach(id);
    withinFenceCall(() => lease.onLedgerRefused(k2Verdict));
  });
  attach(t.sent.turnId);
  const r = t.mine();
  expect(r, 'the claim joined the lease R').toHaveLength(1);
  expect((await r[0]!.teardown).confirmed).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  // M5 (AGP): a turn refusal joined to a lease ends in lease mode: the host's refuseTurn is the one terminal, the driver emits none.
  expect(t.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === t.sent.turnId), 'lease mode: no driver turn.completed').toEqual([]);
  expect(t.watch.escaped).toEqual([]);
  expect(r, 'one refusal record, joined by the prompt write').toHaveLength(1);
  expect(r[0]!.site).toBe('lease.ledger');
  expect(r[0]!.joins).toContain('agy.prompt');
  expect(r[0]!.kind).toBe('turn');
  expect((await r[0]!.teardown).confirmed).toBe(true);
  await k2Check(rig, { closer: 'driver' });
  // LLI-agy: a Stop for the turn whose refusal the DRIVER closed joins that one teardown (confirmed); it is never a second stop that
  // finds no live turn and reports stop-failed.
  expect(await instance!.adapter.interruptTurn('nc-agy-sub-turn', t.sent.turnId)).toEqual({ closeConfirmed: true });
  expect(rig.calls.interrupt, 'K3: the lease port is still never called').toBe(0);
});

/** A real lease on a mounted fixture turn's identity, wired the way the server wires it: the binding's refusal reaches the lease. */
function leasedMountTurn(turn: Partial<SendTurnInput> & { threadId: string; cwd: string }) {
  const rig = {} as { -readonly [K in keyof K2Lease]: K2Lease[K] };
  const input = fixtureMountTurn({ text: 'go', ...turn, admissionNotLaunched: () => rig.lease.admissionNotLaunched() } as SendTurnInput, verdict => rig.lease.onLedgerRefused(verdict));
  const identity = (input.releaseBinding as unknown as { identity: K2Lease['identity'] }).identity;
  const calls = { interrupt: 0, confirmed: 0, settle: 0, present: 0, seal: 0 };
  Object.assign(rig, { identity, calls, lease: createLedgerLease(identity, { seal() { calls.seal++; }, interrupt: async () => { calls.interrupt++; return true; },
    settle() { calls.settle++; }, present() { calls.present++; }, quarantine() {}, confirmed() { calls.confirmed++; } }),
    refusals: () => fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).dispatchGeneration === identity.dispatchGeneration) });
  return { input, rig: rig as K2Lease };
}

// LLD-agy (:889): a bound Ask turn with no relay is refused by the driver before any launch. There is no process to claim, so the
// refusal is registered at "agy.direct.889" with a null target and the lease takes the close at once; its teardown resolves (no hang).
it('agy bound Ask turn refused with no relay registers agy.direct.889 and the lease closes it', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const scratch = mkdtempSync(join(tmpdir(), 'nc-agy-lld-')); cleanups.push(() => removeTempDir(scratch));
  instance = await AntigravityDriver.create({ instanceId: 'nc-agy-lld', displayName: 'Antigravity', enabled: true, environment: { HOME: scratch }, config: { cli: FAKE_CLI, fullAuto: false } });
  const open = vi.spyOn(relayModule, 'openAntigravityRelay').mockRejectedValue(new Error('fixture relay unavailable')); cleanups.push(() => open.mockRestore());
  const { input, rig } = leasedMountTurn({ threadId: 'nc-agy-lld', cwd: scratch, routeAsks: true, askLevel: true, permissionNow: () => ({ routeAsks: true, askLevel: true }) });
  const error = await instance.adapter.sendTurn(input).then(() => undefined, e => e);
  expect(error).toMatchObject({ code: 'MEMORY_CONTEXT_REVOKED' });
  const r = rig.refusals();
  expect(r, 'one refusal record for the direct refusal').toHaveLength(1);
  expect(r[0]!.site).toBe('agy.direct.889');
  expect(r[0]!.joins).toContain('lease.ledger');
  expect(r[0]!.kind).toBe('turn');
  expect(r[0]!.closer).toBe('lease');
  expect((await r[0]!.teardown).confirmed).toBe(true);
  await rig.lease.teardownConfirmed;
  expect(rig.calls.interrupt, 'never launched: no adapter interrupt').toBe(0);
  expect(rig.calls.settle, 'one settle').toBe(1);
  expect(unawaitedTeardowns().filter(R => r.includes(R)), 'every teardown has an awaiter').toEqual([]);
  expect(kindUnjoined.count, 'kind-unjoined turn refusal').toBe(0);
  expect(watch.escaped).toEqual([]);
});

// 1.0.20 busy-engines (antigravity family): the driver's own refusal of a bound Ask turn (no relay) reaches the lease as ENGINE_OWN_REFUSAL
// (driverRaised): the verdict the direct turn's lease reads at its seal to end the turn at once, as on 1.0.19, instead of rebuilding it into
// the same refusal (index.ts admitLedgerLease). Before, agy refused with the plain verdict and the turn took its re-prepares first.
it('busy-engines agy: a bound Ask turn refused with no relay gives the lease the driverRaised verdict', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'be-agy-')); cleanups.push(() => removeTempDir(scratch));
  instance = await AntigravityDriver.create({ instanceId: 'be-agy', displayName: 'Antigravity', enabled: true, environment: { HOME: scratch }, config: { cli: FAKE_CLI, fullAuto: false } });
  const open = vi.spyOn(relayModule, 'openAntigravityRelay').mockRejectedValue(new Error('fixture relay unavailable')); cleanups.push(() => open.mockRestore());
  const { input, rig } = leasedMountTurn({ threadId: 'be-agy', cwd: scratch, routeAsks: true, askLevel: true, permissionNow: () => ({ routeAsks: true, askLevel: true }) });
  const error = await instance.adapter.sendTurn(input).then(() => undefined, e => e);
  expect(error).toMatchObject({ code: 'MEMORY_CONTEXT_REVOKED' });
  expect(rig.refusals().map(r => r.site)).toEqual(['agy.direct.889']);
  expect(rig.lease.verdict, 'the verdict the seal reads').toEqual({ state: 'checking', reason: 'not-built', driverRaised: true });
  await rig.lease.teardownConfirmed;
});

// AGK: a mounted turn's Stop is confirmed only when the mount relay finished AND the child tree stopped. The fake holds its close
// (FAKE_AGY_HOLD_CLOSE) across the Stop: the confirmation stays pending while the child lives and lands once the gate releases it.
it('agy mounted turn Stop is not confirmed while the child is held open', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'nc-agy-agk-')); cleanups.push(() => removeTempDir(scratch));
  const gate = join(scratch, 'release');
  cleanups.push(() => writeFileSync(gate, ''));
  instance = await AntigravityDriver.create({ instanceId: 'nc-agy-agk', displayName: 'Antigravity', enabled: true,
    environment: { HOME: scratch, FAKE_AGY_HOLD_CLOSE: gate, FAKE_AGY_HOLD_AFTER_USAGE: '1' }, config: { cli: FAKE_CLI, fullAuto: true } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const { input } = leasedMountTurn({ threadId: 'nc-agy-agk', cwd: scratch, integrations: { custom: { notes: { command: process.execPath, args: [], env: {} } } } as never });
  const sent = await instance.adapter.sendTurn(input);
  await recorder.until(e => e.type === 'turn.started' && e.turnId === sent.turnId);
  await vi.waitFor(() => expect(existsSync(`${gate}.pid`)).toBe(true), { timeout: 10_000, interval: 25 });
  const pid = Number(readFileSync(`${gate}.pid`, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stopping = instance.adapter.interruptTurn('nc-agy-agk', sent.turnId);
  const early = await Promise.race([stopping, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 1_000))]);
  expect(alive(), 'the held child is still running one second after the Stop').toBe(true);
  expect(early, 'Stop is not confirmed while the child runs').toBe('pending');
  writeFileSync(gate, '');
  expect(await stopping).toEqual({ closeConfirmed: true });
  expect(alive(), 'the child is gone at the confirmation').toBe(false);
});

// AG1: a managed Ask card the owner allows after the lease refused. The relay's release of the answer throws the fenced refusal inside
// the hook socket (G0-HK): the relay arm claims "hook.socket.agy" and the answer's transport refusal joins it as "agy.ask". One R (the
// lease's, kind turn). The release is not a fence call, so the lease closes it through its port (one interrupt) and the driver's settle
// ends in lease mode (AGP). At tip the arm is not wired: no join, the card resolves 'unavailable' and the turn ends cancelled.
it('agy managed Ask answer refused at the hook socket claims hook.socket.agy, joins agy.ask, and ends in lease mode', async () => {
  const threadId = 'nc-agy-ag1';
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const scratch = mkdtempSync(join(tmpdir(), 'nc-agy-ag1-')); cleanups.push(() => removeTempDir(scratch));
  instance = await AntigravityDriver.create({ instanceId: threadId, displayName: 'Antigravity', enabled: true,
    environment: { HOME: scratch, FAKE_AGY_RUN_HOOKS: '1', FAKE_AGY_TOOL_CALLS: JSON.stringify([{ name: 'run_command', args: { CommandLine: 'true', Cwd: scratch } }]) },
    config: { cli: FAKE_CLI, fullAuto: false } });
  const { f, rig, calls } = portLease(threadId);
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: scratch, threadId, text: 'go', releaseBinding: f.binding, routeAsks: true,
    permissionNow: () => ({ routeAsks: true }), prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  rig.lease.attach(sent.turnId);
  const opened = await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId) as { requestId: string };
  f.replace();
  await instance.adapter.respondToRequest(threadId, opened.requestId, { behavior: 'allow' });
  await rig.lease.teardownConfirmed;
  const r = rig.refusals();
  expect(r, 'one refusal record for the generation').toHaveLength(1);
  expect(r[0]!.joins).toContain('hook.socket.agy');
  expect(r[0]!.joins).toContain('agy.ask');
  expect(r[0]!.kind).toBe('turn');
  expect(r[0]!.closer, 'a refusal raised inside a native answer release is not in a fence call: the lease closes it').toBe('lease');
  expect((await r[0]!.teardown).confirmed).toBe(true);
  expect(calls.interrupt, 'the lease closes the launched turn through its port once').toBe(1);
  expect(calls.settle, 'one settle').toBe(1);
  // AGP (M4 P1 + M5): the driver's settle attaches the lease R and finishes in lease mode: the host's refuseTurn is the terminal.
  await new Promise(resolve => setTimeout(resolve, 300)); // the child's close (the driver's settle) lands after its confirmed stop
  expect(recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'lease mode: no driver turn.completed').toEqual([]);
  expect(recorder.events.filter(e => e.type === 'request.resolved' && (e as { behavior?: string }).behavior === 'allow'), 'the refused allow never resolves as allowed').toEqual([]);
  expect(unawaitedTeardowns().filter(R => r.includes(R)), 'every teardown has an awaiter').toEqual([]);
  expect(watch.escaped).toEqual([]);
});

/** A real lease on a fixture turn's identity whose port closes through the driver's interruptTurn (the server's wiring). */
function portLease(threadId: string) {
  const rig = {} as { -readonly [K in keyof K2Lease]: K2Lease[K] };
  const f = consumingFixture(undefined, { threadId, onRefused: verdict => rig.lease.onLedgerRefused(verdict) }); cleanups.push(() => f.close());
  const identity = (f.binding as unknown as { identity: K2Lease['identity'] }).identity;
  const calls = { interrupt: 0, confirmed: 0, settle: 0, present: 0, seal: 0 };
  Object.assign(rig, { identity, calls, lease: createLedgerLease(identity, { seal() { calls.seal++; }, interrupt: async (id?: string) => { calls.interrupt++; return (await instance!.adapter.interruptTurn(threadId, id))?.closeConfirmed === true; },
    settle() { calls.settle++; }, present() { calls.present++; }, quarantine() {}, confirmed() { calls.confirmed++; } }),
    refusals: () => fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).dispatchGeneration === identity.dispatchGeneration) });
  return { f, rig: rig as K2Lease, calls };
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'not settled'>(resolve => setTimeout(() => resolve('not settled'), ms))]);

// LLD-agy (:1335, launched): a bound Ask turn whose relay opened but whose hook agy never loaded is refused after the launch. The
// refusal is registered at "agy.direct.1335" with a null target, so the lease closes it through its port; the driver's settle ends in
// lease mode (no driver turn.completed, no driver ledger line), and the lease's Stop, arriving after that settle, confirms the child's
// stop. At the parent the Stop found no live turn and returned stop-failed, so the lease's teardown was never confirmed.
it('agy launched bound Ask turn whose hook never loaded registers agy.direct.1335 and the lease confirms its close', async () => {
  const threadId = 'nc-agy-1335';
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const scratch = mkdtempSync(join(tmpdir(), 'nc-agy-1335-')); cleanups.push(() => removeTempDir(scratch));
  instance = await AntigravityDriver.create({ instanceId: threadId, displayName: 'Antigravity', enabled: true,
    environment: { HOME: scratch, FAKE_AGY_HOOKS_IGNORED: '1' }, config: { cli: FAKE_CLI, fullAuto: false } });
  const { f, rig, calls } = portLease(threadId);
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fencedTurnInput({ cwd: scratch, threadId, text: 'go', releaseBinding: f.binding, askLevel: true,
    permissionNow: () => ({ askLevel: true }), prompt: buildPrompt(f.turn, [promptPart('go', [noneRef('owner-turn')])]) } as never,
    { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! }));
  rig.lease.attach(sent.turnId);
  await vi.waitFor(() => expect(rig.refusals()).toHaveLength(1), { timeout: 10_000, interval: 25 });
  const r = rig.refusals();
  expect(r[0]!.site).toBe('agy.direct.1335');
  expect(r[0]!.kind).toBe('turn');
  expect(r[0]!.closer).toBe('lease');
  expect(await within(r[0]!.teardown, 10_000), 'the lease close is confirmed, not stop-failed').toEqual({ confirmed: true });
  await rig.lease.teardownConfirmed;
  expect(calls.interrupt, 'launched: the lease closes through its port once').toBe(1);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'lease mode: no driver turn.completed').toEqual([]);
  expect(recorder.events.filter(e => e.type === 'runtime.error' && e.turnId === sent.turnId), 'lease mode: no driver ledger line').toEqual([]);
  expect(unawaitedTeardowns().filter(R => r.includes(R)), 'every teardown has an awaiter').toEqual([]);
  expect(watch.escaped).toEqual([]);
});

// agy.mount (LLM consumer, STAGE2 row AGP): the mount relay seals on a ledger refusal and hands the refusal error to the driver's attach
// callback. The driver claims it with refusalFor "agy.mount" (target null, kind turn): the lease takes the close at once, the driver's
// settle ends in lease mode and writes no LEDGER line of its own (the host's refuseTurn is the one terminal). At the parent the callback
// dropped the refusal: no agy.mount site and a driver ledger line beside the lease's.
it('agy mount relay sealed on a ledger refusal claims agy.mount for the lease and writes no driver ledger line', async () => {
  const threadId = 'nc-agy-mount';
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const scratch = mkdtempSync(join(tmpdir(), 'nc-agy-mount-')); cleanups.push(() => removeTempDir(scratch));
  instance = await AntigravityDriver.create({ instanceId: threadId, displayName: 'Antigravity', enabled: true,
    environment: { HOME: scratch, FAKE_AGY_DELAY_MS: '2000' }, config: { cli: FAKE_CLI, fullAuto: true } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const { input, rig } = leasedMountTurn({ threadId, cwd: scratch, integrations: { custom: { notes: { command: process.execPath, args: [], env: {} } } } as never });
  const attach = CliMountRelay.prototype.attach;
  const spy = vi.spyOn(CliMountRelay.prototype, 'attach').mockImplementation(function (this: CliMountRelay, ...args: Parameters<CliMountRelay['attach']>) {
    attach.apply(this, args);
    // the ledger refuses the mount's next release: the lease hears the verdict, the relay seals with the refusal error
    setTimeout(() => { const verdict = { state: 'checking', reason: 'not-built' } as never; rig.lease.onLedgerRefused(verdict); this.seal(undefined, new EngineInputRevoked(verdict)); }, 50);
  });
  cleanups.push(() => spy.mockRestore());
  const sent = await instance.adapter.sendTurn(input);
  rig.lease.attach(sent.turnId);
  await vi.waitFor(() => expect(rig.refusals()[0]?.joins ?? []).toContain('agy.mount'), { timeout: 10_000, interval: 25 });
  const r = rig.refusals();
  expect(r, 'one refusal record for the generation').toHaveLength(1);
  expect(r[0]!.kind).toBe('turn');
  expect(r[0]!.closer).toBe('lease');
  expect(await within(r[0]!.teardown, 10_000)).toEqual({ confirmed: true });
  await rig.lease.teardownConfirmed;
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(recorder.events.filter(e => e.type === 'runtime.error' && e.turnId === sent.turnId), 'lease mode: no driver ledger line').toEqual([]);
  expect(recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'lease mode: no driver turn.completed').toEqual([]);
  expect(unawaitedTeardowns().filter(R => r.includes(R)), 'every teardown has an awaiter').toEqual([]);
  expect(watch.escaped).toEqual([]);
});
