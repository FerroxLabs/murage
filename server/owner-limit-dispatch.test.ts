// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: nl-backup owns continuation dispatch; salv-spend owns the spending gate.
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';
import { OwnerLimitContinuations, LimitApplications, type OwnerLimitSnapshot } from './owner-limit-continuation.ts';
import { createSpendGate, decodeLimitsBody } from './spend-gate.ts';

it.each(['paid-below-budget', 'pause-exactly-100-percent', 'provider-budget', 'unknown-meter', 'credential-rotation', 'stop-during-spend', 'principal-during-spend', 'downgrade-during-spend', 'row-removed', 'selection-replaced', 'row-cancelled', 'source-replaced'])(
  'the real spending callback fences an unlimited continuation: %s', async mode => {
    const db = new DatabaseSync(':memory:'), applications = new LimitApplications(() => db);
    const snapshot: OwnerLimitSnapshot = { botId: 'bot', threadId: 'thread', generation: 'owner-turn', sourceMessageId: 'source', sourceDigest: 'digest', principal: 'owner', policy: 'unlimited', epoch: 0 };
    let principal=snapshot.principal;
    let policy = true, currentKey = 'fixture-account-credential';
    const tickets = new OwnerLimitContinuations(s => policy && applications.epoch(s.threadId) === s.epoch);
    const ticket = tickets.authorizeRaisedCard(snapshot, true)!;
    const application = applications.prepare(snapshot, { instanceId: 'paid-backup', model: 'fixture' }, 'raised');
    tickets.select(ticket, application);
    let reads = 0;
    const gate = createSpendGate({ enabled: true, limitUsd: () => 100,
      credentials: () => [{ id: 'account', kind: 'account', key: () => currentKey }],
      read: async () => {
        reads++;
        if(mode==='principal-during-spend')principal='replacement-owner';
        if (mode === 'stop-during-spend') { tickets.cancel('thread'); applications.cancel('thread'); }
        if (mode === 'downgrade-during-spend') policy = false;
        if (mode === 'credential-rotation') { currentKey = 'replacement-fixture-credential'; return { kind: 'failed' }; }
        if (mode === 'unknown-meter') return { kind: 'failed' };
        return { kind: 'body', decoded: decodeLimitsBody({ key_id: 'fixture', key_monthly_budget_usd: mode === 'provider-budget' ? 1 : null,
          key_monthly_token_limit: null, spent_usd_this_month: 1, tokens_this_month: 0, spend_basis: 'customer_billed_sale',
          resets_at: '2026-12-01T00:00:00Z', as_of: '2026-11-14T12:00:00Z', account_id: 'fixture-account', month: '2026-11',
          account_spent_usd_this_month: mode === 'pause-exactly-100-percent' ? 100 : 99, account_as_of: '2026-11-14T12:00:00Z' })! };
      }, now: () => Date.parse('2026-11-14T12:00:00Z'),
      loadAccount: () => ({ accountId: 'fixture-account', accountAsOf: null, capability: 'on', capAsOf: null, capCredId: null }),
    });
    const submit = vi.fn(() => 'submitted');
    const { dispatchSpendTurn } = wiring(['dispatchSpendTurn', 'claimOwnerLimitDispatch', 'validateOwnerLimitDispatch'], {
      internalTurnOwners: new Map([['thread', { generation: 'successor' }]]),
      limitActiveDispatches: new Map([['successor', { ticket, application }]]),
      ownerLimitSnapshot: () => ({ ...snapshot, principal, policy: policy ? snapshot.policy : 'ask', epoch: applications.epoch('thread') }),
      ownerLimitContinuations: tickets, limitApplications: applications, ownerLimitSelectionCurrent: () => true,
      limitFailovers: { get: () => mode === 'row-removed' ? undefined : ({ rowId: application.rowId, resendSendId: application.sendId, botId: 'bot', threadId: 'thread', sourceMessageId: mode === 'source-replaced' ? 'other-source' : 'source', hop: 1, state: mode === 'row-cancelled' ? 'cancelled' : 'applied', to: application.to, from: { instanceId: 'primary', model: 'fixture' } }) },
      store: { taskByThread: () => ({ limitFailover: application.rowId, modelSelection: mode === 'selection-replaced' ? { ...application.to, model: 'other' } : application.to }) }, assertBackupStillUsable() {},
      isFluxHost: () => true, spendGate: gate, DirectTurnSetupCancelled: Error,
    });
    try {
      const result = Promise.resolve().then(() => dispatchSpendTurn({ threadId: 'thread', providerRoute: { preset: 'flux', apiKey: currentKey } }, {}, submit));
      if (mode === 'paid-below-budget') { await expect(result).resolves.toBe('submitted'); expect(submit).toHaveBeenCalledOnce(); }
      else { await expect(result).rejects.toThrow(); expect(submit).not.toHaveBeenCalled(); }
      expect(reads).toBeGreaterThan(0);
    } finally { db.close(); }
  });
