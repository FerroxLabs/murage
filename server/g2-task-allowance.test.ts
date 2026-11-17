// SPDX-License-Identifier: AGPL-3.0-or-later
// Approval HTTP and task allowance producer owner: tri3-g2. Native receipt owner: tri3-g1.
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';

it.each(['open-allow', 'replayed-allow', 'open-deny', 'unoffered-scope', 'failed-delivery'])('registered native answers retain only an accepted fresh task allowance: %s', async mode => {
  const card = { taskAllowKey: 'stop:delete:fixture-folder', cardClass: 'stop-line', requestId: 'request' };
  const row = { id: 'card', card };
  const grant = vi.fn(() => true), recipients = vi.fn();
  const hits = new Map([['thread:request', { path: 'fixture-folder' }]]);
  const original = hits.get('thread:request');
  const registered = { state: mode === 'replayed-allow' ? 'answered' : 'open', ref: {} };
  const { deliverAnswer } = wiring(['deliverAnswer'], {
    HIGHLEVEL_REQUEST_PREFIX: 'highlevel-', RELEASE_SUPERSEDED: 'superseded', publishAnswerAllowed: () => true,
    homeExecutionGate: undefined, assertWorkResume: () => {}, askMessageByRequest: new Map([['thread:request', 'card']]),
    store: { messageById: () => row, patchMessage: vi.fn(), appendMessage: vi.fn() },
    registry: { get: () => undefined }, routines: undefined, murageLine: (row: unknown) => row, isQuestionCard: () => false, lookupApproval: () => registered,
    stopHitByRequest: hits, rememberStopRecipients: recipients, taskAllowances: { grant }, cardKeysOf: () => [],
    taskScopeOffered: () => mode !== 'unoffered-scope',
    answerRegisteredApproval: async () => {
      // Runtime resolution can consume the in-flight card maps before the
      // transport promise returns. The authoritative card scope was captured.
      hits.delete('thread:request');
      return mode === 'failed-delivery' ? 'unavailable' : mode === 'open-deny' ? 'rejected' : 'allowed-once';
    },
  });
  const receipt: { taskAdded?: string[] } = {};
  expect(await deliverAnswer('thread', 'provider', 'request', mode === 'open-deny' ? 'deny' : 'allow', undefined, { id: 'bot', name: 'Fixture' }, undefined, { allowForTask: true, receipt })).toBe(mode === 'failed-delivery' ? 'unavailable' : mode === 'open-deny' ? 'rejected' : 'allowed-once');
  if (mode === 'open-allow') {
    expect(grant).toHaveBeenCalledExactlyOnceWith('bot', 'thread', card.taskAllowKey);
    expect(recipients).toHaveBeenCalledExactlyOnceWith('bot', original, 'thread');
    expect(receipt.taskAdded).toEqual([card.taskAllowKey]);
  } else { expect(grant).not.toHaveBeenCalled(); expect(receipt.taskAdded).toBeUndefined(); }
});
