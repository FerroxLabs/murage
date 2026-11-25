// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner report 2026-11-21 (1.0.20): at No limits an engine question was shown
// as numbered plain text ("Question 1 of 1 ...") instead of the question card.
// A question is not an approval: it keeps its interactive card at every level.
import { describe, expect, it } from 'vitest';
import { fixture, d, card, baseCard } from './fixture.ts';
import { isQuestionCard, questionsForCard } from '../../shared/questions.ts';

const QUESTIONS = [{ id: 'plan', question: 'Which plan should I sign up for?', multiSelect: false, allowOther: true,
  options: [{ label: 'Yes, sign up (Recommended)' }, { label: 'Free plan first' }, { label: 'Hold off' }] }];
/** The shape a provider's own question tool arrives in: a permission request flagged as a question. */
const toolQuestion = { requestType: 'permission', questionTool: true, tool: 'AskUserQuestion', questions: QUESTIONS };
const nativeQuestion = { requestType: 'question', questions: QUESTIONS };
const rows = (f: ReturnType<typeof fixture>, kind: string) =>
  (f.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND kind=?').get('t', kind) as { n: number }).n;
async function ask(f: ReturnType<typeof fixture>, id: string, extra: object) {
  const outcome = d.decide(f.open(id, {}, extra), baseCard);
  const ref = card(outcome);
  await d.presentApproval(ref, { title: 'Your bot has a question', subtitle: 'Fixture' });
  const record = d.readApproval(ref.approvalId)!;
  return { outcome, ref, record, message: f.store.messageById('t', record.chatMessageId)! };
}

describe('a question at No limits is the interactive card, never numbered text', () => {
  it.each([['question tool', toolQuestion], ['native question', nativeQuestion]] as const)('%s: one question card and no text row', async (_name, extra) => {
    const f = fixture(); // owner typed turn at No limits
    const { outcome, record, message } = await ask(f, 'q', extra);
    expect(outcome.kind).toBe('question');
    expect(record.why).toBe('question');
    expect(message.kind).toBe('options');
    expect(message.text ?? '').not.toMatch(/Question \d+ of \d+/);
    expect(rows(f, 'options')).toBe(1);
    expect(rows(f, 'text')).toBe(0);
    expect(isQuestionCard(message.card)).toBe(true);
    expect(message.card!.requestId).toBe('q');
    expect(message.card!.approvalId).toBe(record.ref.approvalId);
    expect(questionsForCard(message.card).map(q => q.options.map(o => o.label))).toEqual([QUESTIONS[0].options.map(o => o.label)]);
    expect(f.respond).not.toHaveBeenCalled();
  });

  it('a choices-only question is still a card with its one-tap choices', async () => {
    const f = fixture();
    const { message } = await ask(f, 'q', { requestType: 'question', summary: 'Pick a color', choices: ['Red', 'Blue'] });
    expect(message.kind).toBe('options');
    expect(isQuestionCard(message.card)).toBe(true);
    expect(message.card!.options).toEqual(['Red', 'Blue']);
    expect(rows(f, 'text')).toBe(0);
  });

  it('the card answer reaches the engine through the registered record and the card records it', async () => {
    const f = fixture();
    const { message } = await ask(f, 'q', toolQuestion);
    // The card's answer route finds the record by the card's own chat row.
    const registered = d.lookupApproval('t', message.id)!;
    expect(registered.state).toBe('open');
    const answers = [{ id: 'plan', selected: ['Free plan first'] }];
    await d.answerApproval(registered.ref, { behavior: 'answer', message: 'Free plan first', answers });
    expect(f.respond).toHaveBeenCalledOnce();
    expect(f.respond.mock.calls[0][1]).toMatchObject({ behavior: 'answer', message: 'Free plan first', answers });
    expect(d.readApproval(registered.ref.approvalId)!.state).toBe('answered');
    const settled = f.store.messageById('t', message.id)!.card!;
    expect(settled.answered).toBe('answer');
    expect(settled.dismissed).toBe(false);
    expect(settled.answers).toEqual(answers);
  });

  it('a typed reply still answers the open card, and the card shows the answer', async () => {
    const f = fixture();
    const { ref, message } = await ask(f, 'q', toolQuestion);
    expect((await d.answerQuestionReply('t', '3')).kind).toBe('answered');
    expect(f.respond.mock.calls[0][1]).toMatchObject({ behavior: 'answer', message: 'Hold off', answers: [{ id: 'plan', selected: ['Hold off'] }] });
    expect(d.readApproval(ref.approvalId)!.state).toBe('answered');
    const settled = f.store.messageById('t', message.id)!.card!;
    expect(settled.answered).toBe('answer');
    expect(settled.answers).toEqual([{ id: 'plan', selected: ['Hold off'] }]);
    expect(rows(f, 'text')).toBe(0);
  });

  it('a skipped question card reads as skipped, not as a denied approval', async () => {
    const f = fixture();
    const { ref, message } = await ask(f, 'q', toolQuestion);
    await d.answerApproval(ref, { behavior: 'deny', message: 'Skipped' });
    const settled = f.store.messageById('t', message.id)!.card!;
    expect(settled.answered).toBe('skipped');
    expect(settled.dismissed).toBe(false);
  });

  it('an ordinary message while the card waits does not re-post the question as text', async () => {
    const f = fixture();
    const { ref } = await ask(f, 'q', toolQuestion);
    expect((await d.answerQuestionReply('t', 'Please do another task')).kind).toBe('answered'); // free text is this question's "Other"
    expect(d.readApproval(ref.approvalId)!.state).toBe('answered');
    const g = await ask(f, 'q2', { requestType: 'question', summary: 'Pick a color', choices: ['Red', 'Blue'] });
    expect((await d.answerQuestionReply('t', 'Please do another task')).kind).toBe('send');
    await d.relistQuestions('t');
    expect(rows(f, 'text')).toBe(0);
    expect(rows(f, 'options')).toBe(2);
    expect(d.readApproval(g.ref.approvalId)!.state).toBe('open');
  });

  it('a secret answer never lands on the card', async () => {
    const f = fixture();
    const secret = [{ id: 'key', question: 'Paste the code', options: [], multiSelect: false, allowOther: true, secret: true }];
    const { ref, message } = await ask(f, 'q', { requestType: 'question', questions: secret });
    await d.answerApproval(ref, { behavior: 'answer', message: '', answers: [{ id: 'key', selected: [], other: 'fixture-code' }] });
    expect(f.respond).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.store.messageById('t', message.id)!.card)).not.toContain('fixture-code');
  });

  it.each(['ask', 'auto', 'full'] as const)('the same question at %s is the same kind of card', async level => {
    const f = fixture(level);
    const { message } = await ask(f, 'q', nativeQuestion);
    expect(message.kind).toBe('options');
    expect(isQuestionCard(message.card)).toBe(true);
    expect(rows(f, 'text')).toBe(0);
  });
});
