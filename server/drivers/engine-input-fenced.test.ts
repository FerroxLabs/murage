// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EngineInputRevoked, fencedOf, fencedRefusals, refusalFor, refusalForVerdict, unawaitedTeardowns, type FencedRefusal, type RefusalLease } from './engine-input.ts';

const refusal = () => new EngineInputRevoked({ state: 'checking', reason: 'not-built' });
let seq = 0;
const ctx = (extra: Record<string, unknown> = {}) => {
  const g = `gen-${++seq}-${Math.random()}`;
  return { engine: 'fake', threadId: `t-${seq}`, binding: { identity: { dispatchGeneration: g } } as never, owner: { teardowns: [] as Promise<unknown>[] } as { fenced?: FencedRefusal; teardowns: Promise<unknown>[] }, generation: 1, target: { id: 'proc' }, ...extra };
};

describe('G0-R refusalFor', () => {
  it('the same error twice is one R and the second site joins', () => {
    const e = refusal(); const c = ctx();
    const a = refusalFor(e, 'fake.ask.one', c)!;
    const b = refusalFor(e, 'fake.ask.two', c)!;
    expect(b).toBe(a);
    expect(a.site).toBe('fake.ask.one');
    expect(a.joins).toEqual(['fake.ask.two']);
    expect(fencedRefusals().filter(r => r === a)).toHaveLength(1);
  });
  it('a verdict R joins a later driver claim by dispatch generation', () => {
    const c = ctx();
    const lease: RefusalLease = {};
    const v = refusalForVerdict({ state: 'checking', reason: 'not-built' }, 'lease.ledger', { lease, binding: c.binding, engine: 'fake', threadId: c.threadId })!;
    const d = refusalFor(refusal(), 'fake.ask.late', c)!;
    expect(d).toBe(v);
    expect(v.lease).toBe(lease);
    expect(v.joins).toEqual(['fake.ask.late']);
  });
  it('a non-refusal is undefined; an unrelated Error is not registered', () => {
    const before = fencedRefusals().length;
    expect(refusalFor(new Error('boom'), 'fake.x', ctx())).toBeUndefined();
    expect(refusalFor(undefined, 'fake.x', ctx())).toBeUndefined();
    expect(fencedRefusals().length).toBe(before);
  });
  it('claims the owner and registers the teardown (first claim wins)', () => {
    const c = ctx(); const R = refusalFor(refusal(), 'fake.a', c)!;
    expect(c.owner.fenced).toBe(R);
    expect(c.owner.teardowns).toHaveLength(1);
    expect(fencedOf({ fenced: undefined, releaseBinding: c.binding } as never)).toBe(R);
  });
});

describe('G0-R one closer and one writer', () => {
  it('takeClose is a sync CAS: one winner, a late driver is an exclusion', async () => {
    const c = ctx(); const R = refusalFor(refusal(), 'fake.a', c)!;
    expect(R.closer).toBe('driver');
    expect(R.takeClose('lease')).toBe(false);
    let calls = 0;
    const r = await R.close(async () => { calls++; return { confirmed: true }; });
    expect(r).toEqual({ confirmed: true });
    expect(await R.teardown).toEqual({ confirmed: true });
    expect(calls).toBe(1);
    expect(R.outcome).toBe('closed');
    expect((await R.close(async () => { calls++; return { confirmed: true }; }))).toEqual({ confirmed: true });
    expect(calls).toBe(1);
  });
  it('a throwing close never rejects and reports stop-failed', async () => {
    const R = refusalFor(refusal(), 'fake.a', ctx())!;
    expect(await R.close(async () => { throw new Error('x'); })).toEqual({ confirmed: false, reason: 'stop-failed' });
    expect(R.outcome).toBe('termination-failed');
  });
  it('a claim with no target hands the close to the lease at once', async () => {
    const R = refusalFor(refusal(), 'fake.direct', ctx({ target: null }))!;
    expect(R.closer).toBe('lease');
    expect(await R.closeOwner).toBe('lease');
  });
  it('write latches only after the sink commits; a failing sink can be retried', async () => {
    const R = refusalFor(refusal(), 'fake.a', ctx())!;
    let n = 0;
    await expect(R.write(() => { n++; throw new Error('busy'); })).rejects.toThrow('busy');
    expect(R.written).toBe(false);
    await R.write(() => { n++; });
    await R.write(() => { n++; });
    expect([n, R.written]).toEqual([2, true]);
  });
  it('reserveWrite returns the promise that resolves when write commits', async () => {
    const R = refusalFor(refusal(), 'fake.a', ctx())!;
    const done = R.reserveWrite(); let resolved = false; void done.then(() => { resolved = true; });
    await Promise.resolve(); expect(resolved).toBe(false);
    await R.write(() => {}); await done; expect(resolved).toBe(true);
  });
  it('an un-awaited teardown is listed until someone reads it', async () => {
    const R = refusalFor(refusal(), 'fake.a', ctx({ owner: null }))!;
    expect(unawaitedTeardowns()).toContain(R);
    void R.teardown;
    expect(unawaitedTeardowns()).not.toContain(R);
  });
});
