import { expect, it, vi } from 'vitest';
import { completeDecisionGeneration } from './generation-retirement.ts';
import { fixture, d, card, baseCard } from './fixture.ts';
function queued(f: ReturnType<typeof fixture>, epoch = 'e', question = false) {
  const original = f.serviceCall(undefined, epoch);
  const call = question ? { ...original, tool: 'ask_user', input: { question: 'Choose', options: ['One', 'Two'] }, approval: { ...original.approval!, action: { requestId: 'q', emailSend: { sendId: 'q' }, question: 'Choose', options: ['One', 'Two'] } } } : original;
  const outcome = d.decide(d.openRequest({ kind: 'service', service: 'email', claim: f.claim, call }), baseCard);
  expect(outcome.kind).toBe(question ? 'question' : 'card');
  const ref = card(outcome);
  return { call, ref, item: { kind: 'email' as const, ref: 'q', approvalId: ref.approvalId, epoch, proof: 'trusted', call: call as d.PendingQueueApproval['call'], view: { title: 'Queued', subtitle: 'Fixture' } } };
}

it.each([{ level: 'ask', question: false }, { level: 'unlimited', question: false }, { level: 'unlimited', question: true }] as const)('H2 repeated answered service cards release active capacity at $level (question=$question)', async ({ level, question }) => {
  const f = fixture(level); let pending: d.PendingQueueApproval[] = [];
  const respond = vi.fn(async (item: d.PendingQueueApproval) => { pending = pending.filter(p => p !== item); return { state: 'accepted' as const }; });
  const cancel = vi.fn(async () => {});
  const dispose = d.installQueueSources([{ kind: 'email', pendingApprovals: () => pending, reopen: () => { throw new Error('unexpected recovery'); }, base: baseCard, respond, cancel, renew: async () => pending[0]! }]);
  try {
    for (let i = 0; i < 70; i++) {
      const q = queued(f, `e${i}`, question); pending.push(q.item);
      d.attachQueue(q.ref, { kind: 'email', ref: 'q', call: q.call }); await d.presentApproval(q.ref, q.item.view);
      await completeDecisionGeneration({ threadId: 't', generation: 'g' });
      expect(d.readApproval(q.ref.approvalId)?.state).toBe('open');
      const answer: d.ApprovalAnswer = question ? { behavior: 'answer', message: 'One' } : { behavior: 'deny' };
      await d.answerApproval(q.ref, answer);
      expect(d.readApproval(q.ref.approvalId)).toMatchObject({ state: 'answered', delivery: 'accepted' });
      await completeDecisionGeneration({ threadId: 't', generation: 'g' });
    }
    expect(respond).toHaveBeenCalledTimes(70); expect(cancel).not.toHaveBeenCalled(); expect(pending).toEqual([]);
    f.setLevel('ask');
    const next = queued(f, 'next'); pending.push(next.item);
    d.attachQueue(next.ref, { kind: 'email', ref: 'q', call: next.call }); await d.presentApproval(next.ref, next.item.view);
    expect(d.readApproval(next.ref.approvalId)?.state).toBe('open');
  } finally { dispose(); f.dispose(); }
});

it('H2 natural retirement fences already answered service entries', async () => {
  const f = fixture(), q = queued(f); let pending = [q.item];
  const dispose = d.installQueueSources([{ kind: 'email', pendingApprovals: () => pending, reopen: () => { throw new Error('unexpected recovery'); }, base: baseCard,
    respond: async () => { pending = []; return { state: 'accepted' }; }, cancel: vi.fn(), renew: async () => pending[0]! }]);
  try {
    d.attachQueue(q.ref, { kind: 'email', ref: 'q', call: q.call }); await d.presentApproval(q.ref, q.item.view);
    const handle = d.openRequest({ kind: 'service', service: 'email', claim: f.claim, call: q.call });
    await d.answerApproval(q.ref, { behavior: 'deny' });
    await completeDecisionGeneration({ threadId: 't', generation: 'g' });
    const execute = vi.fn();
    expect(d.executeServiceSync(handle, execute).kind).toBe('refuse'); expect(execute).not.toHaveBeenCalled();
    expect(d.readApproval(q.ref.approvalId)).toMatchObject({ state: 'answered', delivery: 'accepted' });
  } finally { dispose(); f.dispose(); }
});
