// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a screen reader is told about a transcript. The list itself is not a
// live region: rows mount as the reader scrolls up, and those are old
// messages, not news. Only a message that arrives at the tail is announced.

export interface TailState {
  scope: string;
  lastId: string | null;
}

export interface TailLast {
  id: string;
  text: string;
}

const MAX_ANNOUNCED = 400;

/**
 * The next announcement. Opening a conversation (a new scope) announces
 * nothing; after that, a different newest message is announced once.
 */
export function nextTailAnnouncement(
  previous: TailState | null,
  scope: string,
  last: TailLast | null,
): { state: TailState; say: string | null } {
  const state: TailState = { scope, lastId: last?.id ?? null };
  if (!previous || previous.scope !== scope || !last || previous.lastId === last.id) return { state, say: null };
  const text = last.text.trim();
  return { state, say: text ? text.slice(0, MAX_ANNOUNCED) : null };
}

/** The tail of a transcript as the announcer wants it. */
export function tailOf(message: { id: string; text?: string } | undefined): TailLast | null {
  return message ? { id: message.id, text: message.text ?? "" } : null;
}
