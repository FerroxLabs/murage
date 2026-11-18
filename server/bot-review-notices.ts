// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store, BotRecord, Message } from './store.ts';
import { murageLine } from './murage-line.ts';
/** Navigation to owner review carries no permission-card authority. */
export function botReviewNotice(store: Store, bot: BotRecord): Message | undefined {
  const pending = bot.staged ?? bot.pendingRevision;
  if (!pending || pending.reason === 'turn-open') return;
  const previous = store.keyedCards(bot.threadId, "botReview", bot.id)[0];
  if (previous) return;
  return store.appendMessage(bot.threadId, murageLine({ role: 'bot', kind: 'options', card: {
    options: [], botReviewId: bot.id, title: `${bot.name} is waiting for your review`,
    subtitle: 'Read the full bot setup and held work before switching it on.',
  } }));
}
export function closeBotReviewNotice(store: Store, bot: BotRecord): void {
  const row = store.keyedCards(bot.threadId, "botReview", bot.id)[0];
  if (row?.card) store.patchMessage(bot.threadId, row.id, { card: { ...row.card, answered: 'reviewed' } });
}
