// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { EmailSecretStore, emailCredentialProvider } from './email-secrets.ts';
import { EmailStore, type SendRow } from './email-store.ts';
import { EmailSendService } from './send-service.ts';
import { FluxEmailClient } from './flux-email-client.ts';
import { FakeFlux } from '../testing/fake-flux-email.ts';

// Uses only interfaces present at 7c9ce6fe, so its starting-commit RED is a
// credential-selection assertion rather than an absent-module failure.
it('reconciliation reads the frozen inbox with its retired key after a new account is adopted', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new EmailStore(db), secrets = new EmailSecretStore(() => true), fake = new FakeFlux();
    secrets.replaceAll({ bots: { b1: { token: 'current-account-key', keyId: 'key_current' } },
      retired: { inbox_old: { token: 'retired-account-key', keyId: 'key_old', botId: 'b1' } } });
    store.insertBinding({ botId: 'b1', inboxId: 'inbox_current', address: 'current@murage.email', username: 'current', displayName: 'Current',
      emailKeyRef: 'key_current', fluxAccountId: 'account_current', state: 'active', step: null, opId: null, opStartedAt: null, policy: 'auto', failure: null, updatedAt: 1000 });
    store.setCursor('retired-keys', JSON.stringify([{ botId: 'b1', inboxId: 'inbox_old', keyId: 'key_old' }]), 1000);
    const row: SendRow = { sendId: 'send_old', botId: 'b1', threadId: 'thread_old', generation: 1, inboxId: 'inbox_old', kind: 'send', replyMessageId: null,
      payloadHash: 'hash_old', summary: { to: ['recipient@example.test'], cc: [], subject: 'Old hold', textLength: 3, attachments: [], replySource: null },
      idemSuffix: 0, state: 'approving', code: null, why: null, stopRequested: false, ownerSent: false, replaces: null, receipt: null, revision: 1,
      attempts: [], heldIds: ['hold_old'], approvalId: 'approval_old', messageId: null, reconcileStep: 0, dueAt: 1000,
      createdAt: 1000, updatedAt: 1000, dispatchedAt: 1000, settledAt: null, deliveryNote: null };
    store.insertSend(row);
    const credentials = emailCredentialProvider(secrets, () => null, (botId, inboxId) => {
      const bound = store.getBinding(botId);
      const wantedInbox = inboxId ?? bound?.inboxId;
      const retired = JSON.parse(store.getCursor('retired-keys') ?? '[]').find((ref: any) => ref.botId === botId && ref.inboxId === wantedInbox);
      return retired ? { keyId: retired.keyId, inboxId: wantedInbox ?? null } : bound?.emailKeyRef ? { keyId: bound.emailKeyRef, inboxId: bound.inboxId } : null;
    });
    const client = new FluxEmailClient({ credentials, fetch: fake.fetch, apiBase: 'https://api.flux.test', appBase: 'https://app.flux.test' });
    const service = new EmailSendService({ store, client, installId: 'fixture', authorityFor: () => { throw new Error('Reconciliation must never authorize an effect'); }, now: () => 1000 });
    fake.on('GET', /inboxes\/inbox_old\/messages$/, { status: 200, body: { data: [{ id: 'message_old', client_reference: row.sendId }] } });
    expect(await service.reconcile(row)).toMatchObject({ state: 'sent', messageId: 'message_old' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/v1/email/inboxes/inbox_old/messages', headers: { authorization: 'Bearer retired-account-key' } });
  } finally { db.close(); }
});
