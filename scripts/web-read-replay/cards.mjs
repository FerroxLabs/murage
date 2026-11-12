// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Only product message/card events count. Runtime request.opened is NOT a shown card. */
export class CardLedger {
  cards = new Map();
  errors = [];
  errorThreads = [];
  problems(ids) { return this.errors.filter((_, i) => ids.includes(this.errorThreads[i])); }
  observe(threadId, message) {
    if (message?.kind !== 'options' || !message.card) return;
    // New-seat intake and first-launch setup are product onboarding, not tool approval events.
    if (!message.card.requestId && (message.card.intake || message.card.setup)) return;
    if (!message.card || typeof message.card.requestId !== 'string' || !message.card.requestId) {
      this.errors.push('options event without a card requestId'); this.errorThreads.push(threadId);
      return;
    }
    if (typeof threadId !== 'string' || !threadId) { this.errors.push('card without threadId'); this.errorThreads.push(threadId); return; }
    const c = message.card;
    const key = `${threadId}:${c.requestId}`;
    const old = this.cards.get(key);
    this.cards.set(key, { ...old, threadId, requestId: c.requestId, messageId: message.id,
      at: old?.at ?? message.at, reason: c.cardClass?.reason ?? old?.reason ?? 'unclassified',
      initiator: c.cardClass?.noLimits?.initiator ?? old?.initiator,
      origin: c.cardClass?.origin ?? old?.origin, unattended: c.cardClass?.unattended ?? old?.unattended,
      routineId: c.cardClass?.routine?.routineId ?? old?.routineId,
      n2: c.cardClass?.noLimits?.n2 ?? old?.n2,
      tool: c.tool ?? old?.tool, answered: c.answered ?? old?.answered,
      question: !!c.questions, folderTrust: !!c.folderTrust });
  }
  event(frame) {
    if (frame?.kind === 'message' || frame?.kind === 'message.patch') this.observe(frame.threadId, frame.message);
  }
  forThreads(ids) { return [...this.cards.values()].filter(c => ids.includes(c.threadId)); }
}
