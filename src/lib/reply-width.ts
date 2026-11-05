// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// E35: a bot reply that holds a table runs as wide as the message column
// (--chat-card-pct), so a wide table shows every column instead of hiding the
// last ones behind a sideways scroll; its prose keeps the reading width
// (`.chat-wide` in styles.css). Every other bubble keeps the usual width.

/** A markdown table's divider row: `| --- | :--: |`. */
const TABLE_DIVIDER = /^ {0,3}\|? *:?-{3,}:? *\|/m;

export function replyHasTable(text: string): boolean {
  return TABLE_DIVIDER.test(text);
}

export const BUBBLE_WIDTH = "w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))]";
export const WIDE_REPLY_WIDTH = "chat-wide w-full max-w-[var(--chat-card-pct)]";

/** The width classes for one transcript bubble. A person's own message never widens. */
export function bubbleWidth(text: string, user: boolean): string {
  return !user && replyHasTable(text) ? WIDE_REPLY_WIDTH : BUBBLE_WIDTH;
}
