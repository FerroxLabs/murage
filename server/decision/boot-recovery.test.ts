// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { fixture, d, card, baseCard } from './fixture.ts';
import { readRecord } from './records.ts';
import { decisionRecoveryFailure } from './boot-recovery.ts';

// The start does `try { await recover(); } catch { decisionRecoveryFailed = decisionRecoveryFailure(error) } finally { ... }` before listen.
it('a refused recovery yields a fixed code, and the approval it did not reach stays open and is never run', async () => {
  const f = fixture();
  const call = f.serviceCall();
  const ref = card(d.decide(d.openRequest({ kind: 'service', service: 'email', claim: f.claim, call }), baseCard));
  const respond = vi.fn(async () => ({ state: 'accepted' as const }));
  const item = { approvalId: ref.approvalId, kind: 'email', ref: 'q', epoch: 'e', call, view: { title: 'Queue', subtitle: 'x' }, proof: 'trusted' } as any;
  const source: d.QueueRecoverySource = { kind: 'email', pendingApprovals: () => [item], reopen: (i: d.PendingQueueApproval) => ({ kind: 'service', service: 'email', claim: f.claim, call: i.call }), base: baseCard, respond, cancel: vi.fn(async () => {}), renew: vi.fn(async () => item) } as any;
  let dispose = d.installQueueSources([source]);
  d.attachQueue(ref, { kind: 'email', ref: 'q', call });
  await d.presentApproval(ref, { title: 'Queue', subtitle: 'x' });
  dispose();
  let failure: ReturnType<typeof decisionRecoveryFailure> | null = null;
  try { await d.recover(); } catch (error) { failure = decisionRecoveryFailure(error, 7); }
  expect(failure).toEqual({ code: 'queue-recovery-source-missing', at: 7 });
  expect(readRecord(f.db, ref.approvalId)!.state).toBe('open');
  expect(respond).not.toHaveBeenCalled();
});
it('error text that is not a fixed code is never carried', () => {
  expect(decisionRecoveryFailure(new Error('rm -rf /home/someone: secret'), 1)).toEqual({ code: 'decision-recovery-failed', at: 1 });
  expect(decisionRecoveryFailure('x', 1).code).toBe('decision-recovery-failed');
  expect(decisionRecoveryFailure(new Error('private-fixture'), 1).code).toBe('decision-recovery-failed');
  expect(decisionRecoveryFailure(new Error('private-fixture:account'), 1).code).toBe('decision-recovery-failed');
});
it('the start contains a recovery refusal before listen and reports it in health', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const at = source.indexOf('await recover()');
  const block = source.slice(source.lastIndexOf('decisionRecoveryOpen = true;', at), source.indexOf('const cardSweepHigh ='));
  expect(block).toContain('phoneJobs.approvalQueue();');
  expect(block).toContain('routineRequests.approvalQueue();');
  expect(block).toMatch(/try \{\s*\/\/[^\n]*\n\s*botAccessApprovalQueue\(store\);[\s\S]*roomShareApprovalQueue\(database\(\)\);[\s\S]*producerQueue\(kind\)[\s\S]*await recover\(\);\s*\}\s*catch \(error\) \{\s*bootCaught\("decisions\.recover", error\);[^\n]*\n\s*decisionRecoveryFailed = decisionRecoveryFailure\(error\)/);
  expect(block).toContain('finally { decisionRecoveryOpen = false; decisionRecoveryContexts.clear(); }');
  expect(source).toMatch(/unresolvedFrameDrops,\s*\/\/[^\n]*\n\s*decisionRecoveryFailed,/);
});
