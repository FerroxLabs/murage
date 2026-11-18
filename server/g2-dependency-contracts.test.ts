// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer/HTTP owner: tri3-g2. Native delivery owner: tri3-g1.
import { expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerCloudMcpCatalog, retireCloudMcpCatalog, hasCloudMcpCatalog } from './mcp-listed.ts';
import { registeredInternalRoute, consumingSinkEntry } from './consuming-sink-inventory.ts';
import { bindInternalDispatch } from './testing/internal-authority-fixture.ts';
import { Store } from './store.ts';
import { database } from './database.ts';
import { appendFixtureMessage } from './testing/approval-card.ts';
import { observeVerifiedHuman, linkHumanBinding, bindHumanThread, resolveHumanBinding } from './human-principals.ts';
import { ownerMemoryTicket } from './memory/authority.ts';
import { fixture, d, card, baseCard } from './decision/fixture.ts';

it('catalog acknowledgments admit only an exact registered POST destination owned by this thread', () => {
  const marker = join(tmpdir(), 'catalog-contract.proxy');
  const path = new URL(registerCloudMcpCatalog(marker, 'catalog-thread', 'http://127.0.0.1')).pathname;
  const key = path.split('/').at(-1)!;
  const registry = { project: () => false, email: () => false, mcp: () => false, delegation: () => false, box: () => false,
    catalog: (id: string) => hasCloudMcpCatalog(id, 'catalog-thread') };
  try {
    expect(hasCloudMcpCatalog(key, 'foreign-thread')).toBe(false);
    for (const method of ['GET', 'PUT', 'DELETE']) expect(registeredInternalRoute(method, path, registry)).toBe(false);
    for (const suffix of ['/', '/extra', '?query', 'invalid']) expect(registeredInternalRoute('POST', path + suffix, registry)).toBe(false);
    expect(registeredInternalRoute('POST', path, { ...registry, catalog: () => false })).toBe(false);
    expect(registeredInternalRoute('POST', '/api/internal/unregistered', registry)).toBe(false);
    expect(registeredInternalRoute('POST', path, registry)).toBe(true);
    for (const mode of ['headers', 'body', 'chunk'] as const) {
      const entry = consumingSinkEntry(`POST ${path}:${mode}`, mode)!;
      expect(entry.destination).toBe(`POST ${path}`);
      expect(entry.provenanceProducer).toBe('localJson');
      expect(entry.isRegistered?.()).toBe(true);
    }
    retireCloudMcpCatalog(marker);
    expect(consumingSinkEntry(`POST ${path}:body`, 'body')!.isRegistered?.()).toBe(false);
    expect(registeredInternalRoute('POST', path, registry)).toBe(false);
  } finally { retireCloudMcpCatalog(marker); }
});

it.each(['ordinary', 'scoped', 'question'])('channel %s cards retain the durable approval identity', async kind => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'fixture' }));
  const created = store.createBot({ name: 'Fixture' }, { seedMessages: false });
  // Explicit fixture data; production Store projection and human authority stay real.
  store.bots = [{ ...created, id: 'bot', threadId: 'thread', chiefOfStaff: true, chiefScope: 'workspace',
    tasks: created.tasks!.map(task => ({ ...task, threadId: 'thread' })) }];
  const observed = observeVerifiedHuman({ platform: 'telegram', authorityId: 'fixture', connectionId: 'fixture', userId: 'fixture' });
  const db = database();
  const binding = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(observed)!.intent));
  binding.id = 'owner';
  db.prepare("UPDATE memory_scope_bindings SET id='owner',subject_id='owner',intent=? WHERE id=?").run(JSON.stringify(binding), observed);
  linkHumanBinding(ownerMemoryTicket(), { bindingId: 'owner', expectedRevision: binding.revision, as: 'owner' });
  bindHumanThread('thread', resolveHumanBinding('owner'));
  const message = appendFixtureMessage(store, 'thread', { kind: 'options', role: 'bot', text: 'Fixture', card: { requestId: 'request',
    ...(kind === 'question' ? { questions: [{ id: 'q', question: 'Choose', options: [{ label: 'One' }], multiSelect: false, allowOther: false }] }
      : { tool: 'Write', ...(kind === 'scoped' ? { approvalScope: 'local-computer' } : {}) }) } } as never);
  const identity = { approvalId: message.card!.approvalId, requestRef: message.card!.requestRef, actionHash: message.card!.actionHash };
  const bound = await bindInternalDispatch({ expression: 'async () => {}', scope: { store }, expose: ['channelApprovalActions', 'imageOperations.waiting'] });
  // The real waiting callback owns the pending-request registry; no replacement map or predicate.
  bound.unit['imageOperations.waiting']('thread', true, 'request', message.id, 'bot');
  const actions = bound.unit.channelApprovalActions;
  expect(actions('bot', () => 'owner').pending()).toEqual([expect.objectContaining(identity)]);
});

it.each([false, true])('a terminal native delivery failure never resends or reports acceptance (concurrent retirement=%s)', async cancelDuringDelivery => {
  const f = fixture('ask');
  const ref = card(d.decide(f.open(), baseCard));
  await d.presentApproval(ref, { title: 'Fixture', subtitle: 'Fixture' });
  f.respond.mockImplementation(async () => {
    // Native failure retires the turn before its receipt; a cancelled resolution means Stop (MAIN R1).
    if (cancelDuringDelivery) f.publish({ type: 'turn.completed', providerInstanceId: 'p', threadId: 't', turnId: 'turn', ok: false, stopReason: 'approval_delivery_failed' });
    return { state: 'failed' };
  });
  await d.answerApproval(ref, { behavior: 'allow' });
  await d.answerApproval(ref, { behavior: 'allow' });
  expect(f.respond).toHaveBeenCalledTimes(1);
  expect(d.readApprovalExecution(ref)).toMatchObject({ delivery: 'failed' });
  const record = d.readApproval(ref.approvalId)!;
  expect(f.store.messageById('t', record.chatMessageId)?.card).toMatchObject({
    answered: 'The tool permission could not be delivered. Nothing was confirmed.', dismissed: true,
  });
  expect(f.interrupt).toHaveBeenCalledTimes(1);
  f.dispose();
});
