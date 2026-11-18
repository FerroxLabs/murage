// SPDX-License-Identifier: AGPL-3.0-or-later
// G0-ORD / LL / LLA witnesses (nativecrash stage 2): one closer per refusal, lease wins only on positive no-driver signals, J0 registers the
// refusal before the interrupt, and the composite close settles FIRST.
import { describe, expect, it, vi } from 'vitest';
import { refuseConsumingTurn } from './consuming-turn-response.ts';
import { createLedgerLease } from './ledger-refusal.ts';
import { k2Lease, k2Check, k2Verdict } from '../testing/nativecrash-k2.ts';
import { fencedRefusalRegistry, composeClose, withinFenceCall, fencedRefusals, refusalFor, EngineInputRevoked, releaseNativeAnswer, releasingEngineInput, type FencedRefusal } from './drivers/engine-input.ts';

const verdict = { state: 'checking', reason: 'not-built' } as const;
let n = 0;
function rig() {
  const identity = { botId: 'B', threadId: `T${++n}`, dispatchGeneration: `g0-${n}-${Math.random()}`, lineageTurnIds: ['x'], adapterLeaseId: 'l' };
  const calls = { interrupt: 0, confirmed: 0, settle: 0 };
  const lease = createLedgerLease(identity, {
    seal() {}, interrupt: async () => { calls.interrupt++; return true; }, settle() { calls.settle++; }, present() {}, quarantine() {}, confirmed() { calls.confirmed++; },
  });
  const refusals = () => fencedRefusals().filter((r): r is FencedRefusal => (r as FencedRefusal).dispatchGeneration === identity.dispatchGeneration);
  return { identity, lease, calls, refusals };
}
const claim = (identity: { dispatchGeneration: string; threadId: string }) =>
  refusalFor(new EngineInputRevoked(verdict), 'fake.ask.answer', { engine: 'fake', threadId: identity.threadId, binding: { identity } as never, target: { id: 'proc' } });

describe('LL J0 + one closer', () => {
  it('J0 registers R before the interrupt: the verdict R exists synchronously after onLedgerRefused', () => {
    const { lease, refusals } = rig(); lease.attach('p1');
    withinFenceCall(() => lease.onLedgerRefused(verdict));
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]!.closer).toBeNull();
    expect(refusals()[0]!.lease).toBeDefined();
  });
  it('LLF-EARLY: the driver claim wins the close; interruptTurn is never called', async () => {
    const { lease, identity, calls, refusals } = rig(); lease.attach('p1');
    withinFenceCall(() => lease.onLedgerRefused(verdict));
    const R = claim(identity)!;
    expect([R, R.closer]).toEqual([refusals()[0], 'driver']);
    await new Promise(r => setTimeout(r, 5)); // the driver closes later than the claim; the lease must not step in
    await R.close(async () => ({ confirmed: true }));
    await lease.teardownConfirmed;
    expect(calls).toEqual({ interrupt: 0, confirmed: 1, settle: 1 });
  });
  it('LLF-LATE: lease wins on a revoke outside a fence call; a late driver claim joins and never closes; interruptTurn called once', async () => {
    const { lease, identity, calls, refusals } = rig(); lease.attach('p1');
    lease.onLedgerRefused(verdict); // a Tl revoke outside any fence call: R.noClaim() at J0
    expect(refusals()[0]!.closer).toBe('lease');
    const R = claim(identity)!;
    expect([R, R.closer, R.joins]).toEqual([refusals()[0], 'lease', ['fake.ask.answer']]);
    await lease.teardownConfirmed;
    expect(calls.interrupt).toBe(1);
    expect(refusals()).toHaveLength(1);
    expect(await R.teardown).toEqual({ confirmed: true });
  });
  it('AG1-CLOSER: a refusal raised inside a native answer release (agy cloud arm) is no fence call: the lease closes at once, interruptTurn once, the arm claim joins "agy.ask"', async () => {
    const { lease, identity, calls, refusals } = rig(); lease.attach('p1');
    let releasing: boolean | undefined;
    const binding = { identity, onLedgerRefused: (v: typeof verdict) => { releasing = releasingEngineInput(identity.dispatchGeneration); lease.onLedgerRefused(v); } };
    // the answer's descriptor is refused inside the release (unregistered sink): the ledger refusal fires with the native wire on the stack
    expect(() => releaseNativeAnswer(binding as never, 'no-such-sink', '{}', () => undefined)).toThrow(EngineInputRevoked);
    expect(releasing).toBe(true);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]!.closer).toBe('lease');
    const R = refusalFor(new EngineInputRevoked(verdict), 'agy.ask', { engine: 'agy', threadId: identity.threadId, binding: { identity } as never, target: { id: 'proc' } })!;
    expect([R, R.closer, R.joins]).toEqual([refusals()[0], 'lease', ['agy.ask']]);
    await lease.teardownConfirmed;
    expect(calls.interrupt).toBe(1);
    expect(await R.teardown).toEqual({ confirmed: true });
  });
  it('LLA: admissionNotLaunched hands the close to the lease at once; interruptTurn is never called', async () => {
    const { lease, calls, refusals } = rig();
    lease.admissionNotLaunched();
    lease.onLedgerRefused(verdict);
    expect(refusals()[0]!.closer).toBe('lease');
    await lease.teardownConfirmed;
    expect(calls.interrupt).toBe(0);
    expect(await refusals()[0]!.teardown).toEqual({ confirmed: true });
  });
});

describe('G0-ORD composite close', () => {
  it('settles the owner FIRST: no close part runs before settleFenced resolves', async () => {
    const order: string[] = []; let settled = false;
    const owner = { settleFenced: async () => { order.push('settle:start'); await Promise.resolve(); settled = true; order.push('settle:done'); } };
    const r = await composeClose(owner, async () => { order.push(`part:${settled}`); return { confirmed: true }; }, async () => ({ confirmed: false, reason: 'timeout' as const }))();
    expect(order).toEqual(['settle:start', 'settle:done', 'part:true']);
    expect(r).toEqual({ confirmed: false, reason: 'timeout' });
  });
  it('a throwing settle or part is stop-failed, never a rejection', async () => {
    expect(await composeClose({ settleFenced: async () => { throw new Error('x'); } }, async () => ({ confirmed: true }))()).toEqual({ confirmed: false, reason: 'stop-failed' });
    expect(await composeClose({}, async () => { throw new Error('y'); })()).toEqual({ confirmed: false, reason: 'stop-failed' });
  });
});

describe('G0-K2 helper backstop', () => {
  it('lease-won refusal: k2Check passes with interruptTurn once', async () => {
    const rig = k2Lease(); rig.lease.attach('p1');
    rig.lease.onLedgerRefused(k2Verdict);
    await k2Check(rig, { closer: 'lease' });
  });
  it('driver-won refusal: k2Check passes with K3 (interruptTurn 0)', async () => {
    const rig = k2Lease(); rig.lease.attach('p1');
    withinFenceCall(() => rig.lease.onLedgerRefused(k2Verdict));
    const R = claim(rig.identity)!;
    await R.close(async () => ({ confirmed: true }));
    await k2Check(rig, { closer: 'driver' });
  });
  it('K3 negative: a driver win that also called interruptTurn fails the backstop', async () => {
    const rig = k2Lease(); rig.lease.attach('p1');
    withinFenceCall(() => rig.lease.onLedgerRefused(k2Verdict));
    const R = claim(rig.identity)!;
    rig.calls.interrupt++; // the port called interruptTurn although the driver owns the close
    await R.close(async () => ({ confirmed: true }));
    await expect(k2Check(rig, { closer: 'driver' })).rejects.toThrow(/K3/);
  });
});

describe('G0-W refusal registry byTurn', () => {
  it('finds the lease R by its provider turn id, whether the refusal or the hand-back came first', () => {
    const a = rig(); a.lease.attach('turn-a');
    withinFenceCall(() => a.lease.onLedgerRefused(verdict));
    expect(fencedRefusalRegistry.byTurn('turn-a')).toBe(a.lease.fencedRefusal);
    expect(a.lease.fencedRefusal!.turnId).toBe('turn-a');
    const b = rig();
    withinFenceCall(() => b.lease.onLedgerRefused(verdict));
    expect(fencedRefusalRegistry.byTurn('turn-b')).toBeUndefined();
    b.lease.attach('turn-b');
    expect(fencedRefusalRegistry.byTurn('turn-b')).toBe(b.lease.fencedRefusal);
    expect(fencedRefusalRegistry.byTurn('turn-none')).toBeUndefined();
    expect(fencedRefusalRegistry.byTurn(undefined)).toBeUndefined();
  });
});

describe('G0 refusal registry: one generation, two turns', () => {
  it('a closed refusal of turn 1 is not inherited by turn 2 of the same generation (new R, own close, Stop sees no refusal in between)', async () => {
    const identity = { botId: 'B', threadId: `T${++n}`, dispatchGeneration: `g0-two-${n}-${Math.random()}`, lineageTurnIds: ['x'], adapterLeaseId: 'l' };
    const interrupted: string[] = [];
    const ports = { seal() {}, interrupt: async (id: string) => { interrupted.push(id); return true; }, settle() {}, present() {}, quarantine() {}, confirmed() {} };
    const first = createLedgerLease(identity, ports); first.attach('turn-1');
    first.onLedgerRefused(verdict);
    await first.teardownConfirmed;
    const R1 = first.fencedRefusal!;
    expect([R1.outcome, interrupted]).toEqual(['closed', ['turn-1']]);
    // the rebuild admits the next turn under the same dispatch generation
    const second = createLedgerLease(identity, ports); second.attach('turn-2');
    expect(fencedRefusalRegistry.byGeneration(identity.dispatchGeneration)).toBeUndefined(); // a Stop of live turn 2 must not join R1
    const driver = refusalFor(new EngineInputRevoked(verdict), 'fake.ask.answer', { engine: 'fake', threadId: identity.threadId, binding: { identity } as never, target: { id: 'proc-2' } })!;
    expect(driver).not.toBe(R1);
    expect([driver.closer, driver.outcome]).toEqual(['driver', undefined]); // turn 2's driver owns a close that has not run yet
    withinFenceCall(() => second.onLedgerRefused(verdict));
    expect(second.fencedRefusal).toBe(driver);
    expect(fencedRefusalRegistry.byTurn('turn-2')).toBe(driver);
    expect(fencedRefusalRegistry.byTurn('turn-1')).toBe(R1);
    await driver.close(async () => ({ confirmed: true }));
    await second.teardownConfirmed;
    expect(interrupted).toEqual(['turn-1']);
  });
  it('lease-closed twice: turn 2 gets its own interruptTurn', async () => {
    const identity = { botId: 'B', threadId: `T${++n}`, dispatchGeneration: `g0-two-${n}-${Math.random()}`, lineageTurnIds: ['x'], adapterLeaseId: 'l' };
    const interrupted: string[] = [];
    const ports = { seal() {}, interrupt: async (id: string) => { interrupted.push(id); return true; }, settle() {}, present() {}, quarantine() {}, confirmed() {} };
    const first = createLedgerLease(identity, ports); first.attach('turn-1');
    first.onLedgerRefused(verdict);
    await first.teardownConfirmed;
    const second = createLedgerLease(identity, ports); second.attach('turn-2');
    second.onLedgerRefused(verdict);
    await second.teardownConfirmed;
    expect(second.fencedRefusal).not.toBe(first.fencedRefusal);
    expect(interrupted).toEqual(['turn-1', 'turn-2']);
  });
});

describe('LLX lease-only refusal origins', () => {
  it('refuseConsumingTurn outside a fence call: the lease closes at once (interruptTurn once, before 5000 ms), one R, closer lease, joins []', async () => {
    vi.useFakeTimers();
    try {
      const { lease, identity, calls, refusals } = rig(); lease.attach('p1');
      const binding = { identity, onLedgerRefused: lease.onLedgerRefused } as never;
      expect(() => refuseConsumingTurn(binding, verdict)).toThrow(/MEMORY_CONTEXT_REVOKED/);
      await vi.advanceTimersByTimeAsync(100);
      expect(refusals()).toHaveLength(1);
      expect([refusals()[0]!.closer, refusals()[0]!.joins]).toEqual(['lease', []]);
      expect(calls.interrupt).toBe(1); // child alive after revoke otherwise: the immediate takeClose is the only caller before 5000 ms
      expect(await refusals()[0]!.teardown).toEqual({ confirmed: true });
    } finally { vi.useRealTimers(); }
  });
});
