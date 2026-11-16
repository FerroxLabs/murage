// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store, BotRecord, Message } from './store.ts';
import { murageLine } from './murage-line.ts';
/** The ordinary persisted card index supplies Needs you, Today and phone discovery from one item. */
export function botReviewNotice(store: Store, bot: BotRecord): Message | undefined {
  const pending = bot.staged ?? bot.pendingRevision;
  if (!pending || pending.reason === 'turn-open') return;
  const requestId = `bot-review-${bot.id}`;
  const previous = store.cardForRequest(bot.threadId, requestId, m => !!m.card?.botReviewId && !m.card.answered);
  if (previous) return;
  return store.appendMessage(bot.threadId, murageLine({ role: 'bot', kind: 'options', card: {
    requestId, botReviewId: bot.id, title: `${bot.name} is waiting for your review`,
    subtitle: 'Read the full bot setup and held work before switching it on.', tool: 'review_bot', options: ['Review'],
  } }));
}
export function closeBotReviewNotice(store: Store, bot: BotRecord): void {
  const row = store.cardForRequest(bot.threadId, `bot-review-${bot.id}`, m => !!m.card?.botReviewId && !m.card.answered);
  if (row?.card) store.patchMessage(bot.threadId, row.id, { card: { ...row.card, answered: 'reviewed' } });
}
