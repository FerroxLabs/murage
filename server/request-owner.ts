// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AMEND-13 Rule 83b (Astra a13 r1 item 6): who an answer to a room card goes
 * to. The card's own member raised the request, so its provider holds it;
 * the member busy now may be someone else entirely. The busy member stands in
 * only for a card that names no member (an older durable card).
 */
export function requestOwnerId(input: { busyBotId?: string | null; cardBotId?: string }): string | undefined {
  return input.cardBotId || input.busyBotId || undefined;
}
