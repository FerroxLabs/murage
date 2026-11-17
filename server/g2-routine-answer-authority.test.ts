// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable proposal/confirmation producer owner: tri3-g2. Decision registry owner: tri3-g2.
import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';

it.each(['current', 'relinked', 'missing-source', 'automatic-generation'])('re-enters only a live durable Ask proposal at confirmation: %s', mode => {
  const context = new AsyncLocalStorage<any>();
  const proof = { kind: 'background-job', id: mode === 'automatic-generation' ? 'service:turn' : 'routine-offer:fixture', botId: 'bot', threadId: 'thread' };
  const saved = { principal: 'owner', actor: 'owner', roomOwnerOnly: true, level: 'ask', initiator: { k: 'owner-typed' } };
  const makeDecisionProvenance = vi.fn((_bot, _thread, generation, initiator, roomOwnerOnly) => ({ generation, initiator, roomOwnerOnly }));
  const { withRoutineAnswerAuthority } = wiring(['withRoutineAnswerAuthority'], {
    decisionServiceContext: context, routineApprovalCurrent: () => mode !== 'relinked' && mode !== 'missing-source',
    routineRequests: { pendingApprovals: () => [{ ref: 'request', proof }] }, readContinuation: () => mode === 'missing-source' ? undefined : saved,
    makeDecisionProvenance,
  });
  const run = vi.fn(() => {
    if (mode === 'current') expect(context.getStore()).toMatchObject({ generation: proof.id, recoveredLevel: 'ask', roomOwnerOnly: true });
    else expect(context.getStore()).toBeUndefined();
    return 'resolved';
  });
  expect(withRoutineAnswerAuthority({ requestId: 'request', botId: 'bot', threadId: 'thread' }, run)).toBe('resolved');
  expect(run).toHaveBeenCalledOnce();
  expect(context.getStore()).toBeUndefined();
  expect(makeDecisionProvenance).toHaveBeenCalledTimes(mode === 'current' ? 1 : 0);
});

it('Stop cancels the dispatched generation while preserving separately reviewed proposals', () => {
  const revokeInternalGeneration = vi.fn(), revokeInternalThread = vi.fn();
  const run = { botId: 'bot', generation: 'native-generation', phase: 'dispatching' };
  const cancel = vi.fn();
  const { cancelDirectTurnDispatch } = wiring(['cancelDirectTurnDispatch'], {
    directRuns: { get: () => run, cancel }, internalTurnOwners: new Map([['thread', run]]),
    turnRequestByGeneration: new Map(), workAdmission: { liveTurns: () => [] },
    directTurnDispatchClaims: new Map(), revokeInternalGeneration, revokeInternalThread,
  });
  cancelDirectTurnDispatch('bot', 'thread');
  expect(revokeInternalGeneration).toHaveBeenCalledExactlyOnceWith('thread', 'native-generation');
  expect(revokeInternalThread).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledExactlyOnceWith(run);
});
