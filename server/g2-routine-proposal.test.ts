// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Routine proposal and confirmation owner: tri3-g2. Decision cancellation owner: tri3-g2.
import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';

it('parks only asking proposals under an independent Ask generation', async () => {
  const context = new AsyncLocalStorage<any>(), proofs = new WeakMap();
  const token = { generation: 'parent', threadId: 'thread', botId: 'bot' };
  const principal = { personId: 'workspace-owner', revision: 1 };
  const parent = { ...token, principal: JSON.stringify(principal), initiator: { k: 'owner-typed' }, roomOwnerOnly: true };
  const saveContinuation = vi.fn(), deleteContinuation = vi.fn(), claim = {};
  let retained: unknown;
  const { withRoutineProposalAuthority } = wiring(['withRoutineProposalAuthority'], {
    serviceNoLimits: () => false, decisionProvenance: new Map([['parent', parent]]),
    internalCapabilities: { isActive: (value: unknown) => value === token }, threadHumanPrincipal: () => principal,
    randomUUID: () => 'fixture', decisionServiceContext: context, decisionHttpProofs: proofs,
    issueDecisionClaim: (proof: object) => {
      expect(context.getStore()).toMatchObject({ generation: 'routine-offer:fixture', recoveredLevel: 'ask' });
      expect(proofs.get(proof)).toMatchObject({ generation: 'routine-offer:fixture' });
      return claim;
    },
    saveContinuation, deleteContinuation, routineRequests: { pendingApprovals: () => [{ proof: retained }] },
  });
  await withRoutineProposalAuthority(token, async (authority: any) => {
    retained = authority.proof;
    expect(authority.claim).toBe(claim);
    expect(authority.identity.generation).not.toBe(token.generation);
  });
  expect(saveContinuation).toHaveBeenCalledOnce();
  expect(deleteContinuation).not.toHaveBeenCalled();
  expect(context.getStore()).toBeUndefined();
});

it('retains the initiating generation for automatic No limits execution', async () => {
  const token = { generation: 'parent', threadId: 'thread', botId: 'bot' }, authority = {};
  const issueDecisionAuthority = vi.fn(async () => authority), run = vi.fn(async () => 'done');
  const { withRoutineProposalAuthority } = wiring(['withRoutineProposalAuthority'], { serviceNoLimits: () => true, issueDecisionAuthority });
  expect(await withRoutineProposalAuthority(token, run)).toBe('done');
  expect(issueDecisionAuthority).toHaveBeenCalledExactlyOnceWith(token);
  expect(run).toHaveBeenCalledExactlyOnceWith(authority);
});

it.each(['current', 'relinked', 'other-audience', 'missing-source'])('confirmation revalidates its durable source: %s', mode => {
  const principal = { personId: 'workspace-owner', revision: 1 };
  const saved = { principal: JSON.stringify(principal), actor: 'owner', roomOwnerOnly: true, initiator: { k: 'owner-typed' } };
  const { routineApprovalCurrent } = wiring(['routineApprovalCurrent'], {
    routineRequests: { pendingApprovals: () => [{ ref: 'request', proof: { kind: 'background-job', id: 'source', botId: 'bot', threadId: 'thread' } }] },
    connectorThread: () => true, readContinuation: () => mode === 'missing-source' ? undefined : saved,
    threadHumanPrincipal: () => mode === 'relinked' ? { ...principal, revision: 2 } : principal,
    turnAudienceIsOwner: () => mode !== 'other-audience',
  });
  expect(routineApprovalCurrent('request', 'bot', 'thread')).toBe(mode === 'current');
  expect(routineApprovalCurrent('other-request', 'bot', 'thread')).toBe(false);
  expect(routineApprovalCurrent('request', 'other-bot', 'thread')).toBe(false);
});
