// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { fixture, card, d, baseCard } from './fixture.ts';
import { DATA_DIR } from '../config.ts';
import { flushDecisionLog, readDecisions } from '../decision-log.ts';

it('an accepted native question skip records once across concurrent clicks and replay', async () => {
  const f = fixture('unlimited');
  try {
    const ref = card(d.decide(f.open('accepted-skip', {}, { requestType: 'question', tool: 'AskUserQuestion', summary: 'Choose a format', choices: ['Short', 'Long'] }), baseCard));
    await d.presentApproval(ref, { title: 'Question', subtitle: 'Choose a format' });
    expect(f.store.messageById('t', d.readApproval(ref.approvalId)!.chatMessageId)).toMatchObject({ kind: 'text', turnId: 'turn' });
    await Promise.all([d.answerApproval(ref, { behavior: 'deny' }), d.answerApproval(ref, { behavior: 'deny' })]);
    await d.answerApproval(ref, { behavior: 'deny' });
    await flushDecisionLog(DATA_DIR);
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(readDecisions(DATA_DIR, 100).filter(row => row.requestId === 'accepted-skip')).toEqual([
      expect.objectContaining({ decision: 'question-skipped', source: 'user', botId: 'b', threadId: 't' }),
    ]);
  } finally { f.dispose(); }
});

it('a failed native question skip never records a delivered human decision', async () => {
  const f = fixture('ask');
  f.respond.mockResolvedValue({ state: 'failed' });
  try {
    const ref = card(d.decide(f.open('failed-skip', {}, { requestType: 'question', tool: 'AskUserQuestion' }), baseCard));
    await d.presentApproval(ref, { title: 'Question', subtitle: 'Choose a format' });
    await d.answerApproval(ref, { behavior: 'deny' });
    await flushDecisionLog(DATA_DIR);
    expect(d.readApprovalExecution(ref).delivery).toBe('failed');
    expect(readDecisions(DATA_DIR, 100).filter(row => row.requestId === 'failed-skip' && row.decision === 'question-skipped')).toEqual([]);
  } finally { f.dispose(); }
});
