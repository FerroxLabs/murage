// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { EngineInputRevoked, fencedRefusals, isMemoryRefusal, recordFencedRefusal, refuseFencedNative } from './engine-input.ts';
import { ReleaseCommitFailed } from '../memory/release-transaction.ts';

it('classifies only errors carrying code MEMORY_CONTEXT_REVOKED as a refusal', () => {
  expect(isMemoryRefusal(new EngineInputRevoked({ state: 'checking', reason: 'not-built' }))).toBe(true);
  expect(isMemoryRefusal(Object.assign(new Error('x'), { code: 'MEMORY_CONTEXT_REVOKED' }))).toBe(true);
  expect(isMemoryRefusal({ code: 'MEMORY_CONTEXT_REVOKED' })).toBe(true);
});

it('does not classify by message text, class, name or unrelated codes', () => {
  expect(isMemoryRefusal(new Error('MEMORY_CONTEXT_REVOKED'))).toBe(false);
  expect(isMemoryRefusal(Object.assign(new Error('x'), { name: 'EngineInputRevoked' }))).toBe(false);
  expect(isMemoryRefusal(Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(false);
  expect(isMemoryRefusal(new Error('boom'))).toBe(false);
  for (const v of [undefined, null, 'MEMORY_CONTEXT_REVOKED', 0, true, { code: 'other' }, { code: undefined }]) expect(isMemoryRefusal(v)).toBe(false);
});

it('does not classify a write-started failure as a refusal', () => {
  const failed = Object.create(ReleaseCommitFailed.prototype) as Error;
  expect(isMemoryRefusal(failed)).toBe(false);
  expect(isMemoryRefusal(Object.assign(new Error('x'), { code: 'ASYNC_RELEASE_TRANSACTION' }))).toBe(false);
});

const rec = () => recordFencedRefusal({ engine: 'codex', sink: 'codex:protocol', threadId: 'unit', turnId: null, requestId: 1, method: 'm', generation: null, active: true, termination: 'T-FIX' });

it('refuseFencedNative settles the record from the termination and returns its promise', async () => {
  const refusal = Object.assign(new Error('x'), { code: 'MEMORY_CONTEXT_REVOKED' });
  const r = rec();
  await refuseFencedNative(refusal, r, async () => 'discharged', async () => { throw new Error('unused'); });
  expect(r.outcome).toBe('discharged');
  expect(fencedRefusals()).toContain(r);
});

it('refuseFencedNative falls back to the close when the termination fails and never rejects', async () => {
  const refusal = Object.assign(new Error('x'), { code: 'MEMORY_CONTEXT_REVOKED' });
  const closed = rec(); let fellBack = false;
  await refuseFencedNative(refusal, closed, async () => { throw new Error('teardown failed'); }, async () => { fellBack = true; });
  expect([fellBack, closed.outcome]).toEqual([true, 'closed']);
  const failed = rec();
  await refuseFencedNative(refusal, failed, async () => { throw new Error('a'); }, async () => { throw new Error('b'); });
  expect(failed.outcome).toBe('termination-failed');
});

it('refuseFencedNative rethrows an unrelated error synchronously with the same identity and never terminates', () => {
  const unrelated = new Error('boom'); let terminated = false;
  const stop = async () => { terminated = true; return 'closed' as const; };
  expect(() => refuseFencedNative(unrelated, rec(), stop, async () => { terminated = true; })).toThrow(unrelated);
  const started = Object.create(ReleaseCommitFailed.prototype) as Error;
  expect(() => refuseFencedNative(started, rec(), stop, async () => { terminated = true; })).toThrow(started);
  expect(terminated).toBe(false);
});
