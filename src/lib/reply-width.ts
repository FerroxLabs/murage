// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// E35: a bot reply that holds a table runs as wide as the message column
// (--chat-card-pct), so a wide table shows every column instead of hiding the
// last ones behind a sideways scroll; its prose keeps the reading width
// (`.chat-wide` in styles.css). Every other bubble keeps the usual width.

/** A markdown table's divider row, `| --- | :--: |`, read after the line's
 * indentation (a table inside a list item is still a table). */
const TABLE_DIVIDER = /^\|? *:?-{3,}:? *\|/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const FENCE_CLOSE = /^(`+|~+)[ \t]*$/;

/** One pass over the lines. A table shown as an example inside a fenced code
 * block (closed or still streaming) is code, not a table; a fence closes on
 * the same character at least as long, as Markdown reads it. */
export function replyHasTable(text: string): boolean {
  if (!text.includes("---") || !text.includes("|")) return false;
  let fence: { char: string; length: number } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimStart();
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) fence = { char: open[1][0], length: open[1].length };
    else if (TABLE_DIVIDER.test(line)) return true;
  }
  return false;
}

export const BUBBLE_WIDTH = "w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))]";
export const WIDE_REPLY_WIDTH = "chat-wide w-full max-w-[var(--chat-card-pct)]";
// Every row that shows a reply (the settled bubble, the one arriving, the one
// streaming) sizes it here, so a table reply does not jump width as it lands.

/** The width classes for one transcript bubble. A person's own message never widens. */
export function bubbleWidth(text: string, user: boolean): string {
  return !user && replyHasTable(text) ? WIDE_REPLY_WIDTH : BUBBLE_WIDTH;
}
