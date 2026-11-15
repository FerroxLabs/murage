// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer/HTTP owner: tri3-g2. Native delivery owner: tri3-g1.
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerCloudMcpCatalog, retireCloudMcpCatalog, hasCloudMcpCatalog } from './mcp-listed.ts';
import { registeredInternalRoute, consumingSinkEntry } from './consuming-sink-inventory.ts';
import { indexCallbackFixture } from './testing/internal-dispatch-fixture.ts';
import { fixture, d, card, baseCard } from './decision/fixture.ts';
import { isQuestionCard, questionsForCard } from '../shared/questions.ts';

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
  const bot = { id: 'bot', name: 'Fixture', threadId: 'thread', modelSelection: { instanceId: 'fixture' } };
  const identity = { approvalId: 'approval', requestRef: 'reference', actionHash: 'action' };
  const message = { id: 'card', card: { ...identity, requestId: 'request', ...(kind === 'question'
    ? { questions: [{ id: 'q', question: 'Choose', options: [{ label: 'One' }], multiSelect: false, allowOther: false }] }
    : { tool: 'Write', ...(kind === 'scoped' ? { approvalScope: 'local-computer' } : {}) }) } };
  const actions = await indexCallbackFixture('channelApprovalActions', {
    store: { bot: () => bot, workspaceChief: () => bot, openRequestCardRows: () => [message], projectBotForTask: () => bot },
    askMessageByRequest: new Map([['thread:request', 'card']]), createHash, redactSecretsInText: (text: string) => text,
    channelHumanIsOwner: () => true, audienceTask: () => ({ threadId: 'thread' }), resolveHumanBinding: () => ({}),
    inertBot: () => false, isQuestionCard, questionsForCard,
    // The integrated channel queue contributes a separate list; these three
    // cases exercise the legacy/native card port and its immutable identity.
    registeredChannelQuestions: () => [],
  });
  expect(actions('bot', () => 'owner').pending()).toEqual([expect.objectContaining(identity)]);
});

it.each([false, true])('a terminal native delivery failure never resends or reports acceptance (concurrent retirement=%s)', async cancelDuringDelivery => {
  const f = fixture('ask');
  const ref = card(d.decide(f.open(), baseCard));
  await d.presentApproval(ref, { title: 'Fixture', subtitle: 'Fixture' });
  f.respond.mockImplementation(async () => {
    if (cancelDuringDelivery) f.publish({ type: 'request.resolved', providerInstanceId: 'p', threadId: 't', turnId: 'turn', requestId: 'r', behavior: 'deny', settlement: 'cancelled' });
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
