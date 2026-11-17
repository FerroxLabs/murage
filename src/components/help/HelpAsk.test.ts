// @vitest-environment jsdom
// The default gate includes *.test.ts. Keep the design's mounted TSX suite on
// that gate without changing the integration owner's Vite configuration.
import './HelpAsk.test.tsx';

// Pure behavioral regressions recovered from 19ef45264's HelpAsk.test.ts;
// wire expectations are updated to the ruling, and source-text checks are
// replaced by the mounted suite above.
import { expect, it } from 'vitest';
import { askText, askView, chiefOf, createAskLifetime } from './HelpAsk';
import { feedbackEnvelopeForScreen, resolveHelpScreen } from '../../lib/screen-envelope';
it('UI-PREVIEW GUARD: the fixed catalogue title never contains the private bot name', () => {
  const title = feedbackEnvelopeForScreen(resolveHelpScreen({ activeView: 'chat', bot: { id: 'private', name: 'Dana Private' }, connected: true })).title;
  expect(askText('  first\n second  ', title)).toBe(`first\n second\n\n(Asked from help on the ${title} screen.)`);
  expect(title).not.toContain('Dana');
});
it('GUARD: only the visible workspace Chief can receive a Help question', () => {
  const helper = { id: 'helper', name: 'Other' } as any; const chief = { id: 'chief', chiefOfStaff: true, chiefScope: 'workspace' } as any;
  expect(chiefOf([helper])).toBeUndefined(); expect(chiefOf([{ ...chief, hidden: true }])).toBeUndefined(); expect(chiefOf([helper, chief])?.id).toBe('chief');
});
it('GUARD: answer identity is the exact current bound turn, never the latest reply', () => {
  const record = { gen: 1, sendId: 's', botId: 'b', threadId: 't', question: 'Q', text: 'Q', phase: 'accepted' } as const;
  const bot = { id: 'b', threadId: 't', messages: [{ id: 'own', role: 'user', sendId: 's', dispatchedIn: 'turn' }, { id: 'yes', role: 'bot', kind: 'text', turnId: 'turn', text: 'answer' }, { id: 'no', role: 'bot', kind: 'text', turnId: 'later', text: 'other answer' }] } as any;
  expect(askView(record, bot)).toMatchObject({ s: 'running', turnId: 'turn', answer: [{ id: 'yes' }] });
});
it('UI-STALE GUARD: closed opening attempts and old-account patches are fenced', () => {
  const life = createAskLifetime(); life.authorize({ owner: 'store', account: 'a' }); const opening = life.open(); const action = opening.begin();
  const record = life.submit({ sendId: 's', botId: 'b', threadId: 't', question: 'Q', text: 'Q', phase: 'sending' }, () => {})!;
  opening.close(); expect(action.live()).toBe(false); life.authorize({ owner: 'store', account: 'b' }); life.patch(record.gen, { cancel: 'removed' }); expect(life.record).toBeNull();
});
