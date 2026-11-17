// SPDX-License-Identifier: AGPL-3.0-or-later
// Limit producer/HTTP owner: tri3-g2. Registered decision store owner: tri3-g2.
import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';
import { limitOfferCard } from './limit-continuation.ts';
import { postKept } from './limit-backup-gate.ts';

it.each(['current', 'hidden-after-list', 'principal-changed', 'not-owner'])('limit publication registers an Ask card at the final choice check: %s', async mode => {
  let principal = { personId: 'workspace-owner', revision: 1 };
  let release!: (choices: unknown[]) => void;
  const choices = new Promise<unknown[]>(resolve => { release = resolve; });
  const context = new AsyncLocalStorage<any>(), proofs = new WeakMap();
  const order: string[] = [];
  const claim = {}, ref = { approvalId: 'approval' };
  let durableProof: unknown;
  const open = vi.fn((request: any) => {
    order.push('register');
    expect(request.authority.claim).toBe(claim);
    expect(request.authority.proof).toBe(durableProof);
    expect(request.base).toEqual({ approve: null, source: 'no-grant' });
    expect(request.action.limitOffer.choices).toHaveLength(mode === 'hidden-after-list' ? 0 : 1);
    expect(request.action.title).toBeUndefined();
    return { outcome: { kind: 'card', ref } };
  });
  const presentNow = vi.fn((_request: unknown, actualRef: unknown) => { order.push('present'); expect(actualRef).toBe(ref); });
  const remove = vi.fn();
  const { postLimitOffer } = wiring(['postLimitOffer'], {
    randomUUID: () => 'fixture-generation', connectorThread: () => true,
    turnAudienceIsOwner: () => mode !== 'not-owner', threadHumanPrincipal: () => principal,
    makeDecisionProvenance: (_bot: string, _thread: string, generation: string) => ({ generation, principal: JSON.stringify(principal) }),
    decisionServiceContext: context, decisionHttpProofs: proofs,
    issueDecisionClaim: (proof: object) => {
      expect(context.getStore().recoveredLevel).toBe('ask');
      expect(proofs.get(proof)).toMatchObject({ botId: 'bot', threadId: 'thread' });
      return claim;
    },
    saveContinuation: async (proof: object) => { durableProof = proof; }, deleteContinuation: remove,
    limitChoicesFor: () => choices, postKept, limitOfferCard,
    backupUsable: () => { order.push('check'); return mode !== 'hidden-after-list'; },
    serviceQueue: () => ({ open, presentNow }), producerQueue: () => ({ pendingApprovals: () => open.mock.calls.length ? [{ proof: durableProof }] : [] }),
    rememberCarry: vi.fn(), limitCardPhoneCarry: new Map(),
  });
  const pending = postLimitOffer({ ownerDirect: true, routine: false, botId: 'bot', threadId: 'thread', selection: { instanceId: 'from', model: 'model' }, engineName: 'Fixture', sourceMessageId: 'source' }, 'limit-fixture', { until: 100, resetsAt: null }, 1);
  if (mode === 'principal-changed') principal = { ...principal, revision: 2 };
  release([{ engine: 'Backup', selection: { instanceId: 'backup', model: 'model' }, billing: 'own-key' }]);
  await pending;
  if (mode === 'principal-changed' || mode === 'not-owner') {
    expect(open).not.toHaveBeenCalled(); expect(presentNow).not.toHaveBeenCalled();
  } else {
    // No asynchronous handoff separates the last live engine check from S1.
    expect(order).toEqual(['check', 'register', 'present']);
    expect(presentNow).toHaveBeenCalledTimes(1);
  }
});
