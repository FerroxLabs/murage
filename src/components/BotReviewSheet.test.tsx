import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { BotReviewFields, BotReviewActions } from './BotReviewSheet';
const spec: import('../../shared/bot-review').BotReviewSpec = {
  id: 'susan', name: 'Susan', role: 'Researcher', instructions: 'full instructions '.repeat(600) + 'LAST INSTRUCTION', modelSelection: { instanceId: 'fixture', model: 'wanted-model' },
  section: 'Studio', lead: false, archived: false, autoApprove: false, fullAccess: false, noLimits: false,
  alwaysAllow: ['tool:alpha'], tasks: [{ threadId: 'task-one', autoApprove: false, fullAccess: true, noLimits: false, alwaysAllow: ['tool:beta'] }],
  staged: { rev: 2, at: 1, generation: 'G', byThreadId: 'T', byBotId: 'chief', reason: 'outside', source: 'web page',
    intended: { autoApprove: true, fullAccess: false, noLimits: false, lead: true, modelSelection: { instanceId: 'fixture', model: 'intended-model' } },
    heldWork: [{ kind: 'delegate', fromBotId: 'chief', fromThreadId: 'T', text: 'first work '.repeat(600) + 'LAST WORK' }] }, pendingRevision: null,
};
for (const renderer of ['bot-review@1', 'bot-review-phone@1']) it(`${renderer} renders every complete field and saved approval, without clipping`, () => {
  const html = renderToStaticMarkup(createElement(BotReviewFields, { spec, renderer }));
  for (const value of ['Susan', 'Researcher', 'LAST INSTRUCTION', 'wanted-model', 'intended-model', 'Studio', 'tool:alpha', 'tool:beta', 'task-one', 'web page', 'LAST WORK', 'Lead', 'Level', 'Auto', 'Full access']) expect(html).toContain(value);
  expect(html).not.toMatch(/line-clamp|truncate|text-overflow/);
});
it('a revision shows old and proposed words in its diff and leaves no proposed field out', () => {
  const html = renderToStaticMarkup(createElement(BotReviewFields, { spec: { ...spec, staged: null, pendingRevision: { rev: 3, at: 2, generation: 'G', byThreadId: 'T', byBotId: 'chief', reason: 'outside', baseRevision: 'old', fields: { instructions: 'replacement instructions', role: 'Writer', name: 'Sable Trainee', section: 'Writing', lead: true, restore: true } } }, renderer: 'bot-review@1' }));
  for (const value of ['<del', '<ins', 'replacement', 'LAST INSTRUCTION', 'Writer', 'Sable Trainee', 'Writing', 'Restore']) expect(html).toContain(value);
});
it('only desktop and attested phone sheets offer activation; all surfaces can discard', () => {
  for (const surface of ['computer', 'cloud-desktop', 'phone-app', 'cloud-phone', 'other-owner', 'push']) {
    const html = renderToStaticMarkup(createElement(BotReviewActions, { surface, pending: false, multiple: false, busy: false, onAction: () => {} }));
    expect(html).toContain('Discard'); expect(html.includes('Activate')).toBe(['computer', 'cloud-desktop', 'phone-app'].includes(surface));
  }
});
it('the exact-call card draws complete input and effective authority before issuing its seen receipt', async () => {
  const { BotCallFields } = await import('./BotCallFields');
  const html = renderToStaticMarkup(createElement(BotCallFields, { authority: { spec: { instructions: 'complete '.repeat(600) + 'LAST CALL WORD' }, effective: { level: 'Auto', target: { alwaysAllow: ['scope:exact'], tasks: [{ alwaysAllow: ['scope:task'] }] } }, specDigest: 'abc' } }));
  for (const text of ['LAST CALL WORD', 'scope:exact', 'scope:task', 'bot-card@1']) expect(html).toContain(text);
  expect(html).not.toMatch(/line-clamp|truncate/);
});
