// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q2 (1.0.4): the one parser for a bot's ```murage-question and ```murage-widget fenced blocks, used by the server (the
// assistant-text fold materialises closed question fences as cards) and by the client (it hides a closed fence only when its
// card exists, and shows an unclosed question fence as a quiet line while the reply streams). Pure: no I/O.
//
// Fences follow CommonMark: an opening line of three or more backticks or tildes (indented at most three spaces) with an
// info string, closed by a line of the same character, at least as long, with nothing else on it. A fence inside another
// code block is that block's text, never a fence of its own. Each kind is numbered on its own, in the order it appears.
import { QUESTION_FENCE, WIDGET_FENCE } from "./ask-wording.ts";

/** The fence a bot writes to show a widget (QW Q4: the fold materialises it as a widget row). One source: shared/ask-wording.ts. */
export { WIDGET_FENCE };

export type MurageFenceKind = typeof QUESTION_FENCE | typeof WIDGET_FENCE;

export interface MurageFence {
  kind: MurageFenceKind;
  /** Its place among the fences of the same kind in this text, from 0. */
  index: number;
  /** The text between the opening and closing lines. */
  body: string;
  /** Where the opening line starts, and where the block ends (after the closing line and its line break). */
  start: number;
  end: number;
}

export interface MurageFenceScan {
  /** Every closed murage fence, in order. */
  closed: MurageFence[];
  /** A murage fence opened and never closed (the reply is still streaming, or the bot never closed it): from `start` to the end. */
  open?: { kind: MurageFenceKind; index: number; start: number };
}

const OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function kindOf(info: string): MurageFenceKind | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return word === QUESTION_FENCE ? QUESTION_FENCE : word === WIDGET_FENCE ? WIDGET_FENCE : null;
}

/** Scan a bot's text for its murage fences. */
export function scanMurageFences(text: string): MurageFenceScan {
  const closed: MurageFence[] = [];
  const counts: Record<MurageFenceKind, number> = { [QUESTION_FENCE]: 0, [WIDGET_FENCE]: 0 };
  let fence: { char: string; length: number; kind: MurageFenceKind | null; start: number; bodyStart: number } | null = null;
  let at = 0;
  while (at <= text.length) {
    const lineEnd = text.indexOf("\n", at);
    const next = lineEnd === -1 ? text.length + 1 : lineEnd + 1;
    const line = text.slice(at, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, "");
    if (!fence) {
      const opening = OPENING.exec(line);
      // a backtick fence's info string never holds a backtick (CommonMark)
      if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
        fence = { char: opening[1]![0]!, length: opening[1]!.length, kind: kindOf(opening[2]!), start: at, bodyStart: Math.min(next, text.length) };
      }
    } else {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === fence.char && closing[1]!.length >= fence.length) {
        if (fence.kind) {
          closed.push({ kind: fence.kind, index: counts[fence.kind]++, body: text.slice(fence.bodyStart, at), start: fence.start, end: Math.min(next, text.length) });
        }
        fence = null;
      }
    }
    if (lineEnd === -1) break;
    at = next;
  }
  return { closed, ...(fence?.kind ? { open: { kind: fence.kind, index: counts[fence.kind], start: fence.start } } : {}) };
}

/** The closed fences of one kind. */
export function closedFences(text: string, kind: MurageFenceKind): MurageFence[] {
  return scanMurageFences(text).closed.filter((fence) => fence.kind === kind);
}
