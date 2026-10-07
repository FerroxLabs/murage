// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A review run's verdict as a block in the reviewer's reply (lane review,
// SPEC-P 5.1a). Every engine can write text, so the verdict never depends on
// the engine reaching project_review_result; the tool stays an equivalent
// answer where it is mounted. The opening line carries a nonce made for this
// run, which the result under review (another bot's words, quoted in the
// prompt) cannot know, so a block quoted from it never counts.

export const REVIEW_BLOCK_CLOSE = "</murage-review>";
export const reviewBlockOpen = (nonce: string) => `<murage-review nonce="${nonce}">`;
/** A reply longer than this is not read for a verdict. */
const REVIEW_REPLY_LIMIT = 60_000;
const NOTES_LIMIT = 500;

export interface ReviewVerdict { verdict: "pass" | "changes"; notes?: string }

/** The body's first word decides: pass or changes (markdown emphasis and a
 * trailing colon or dash allowed); the rest is the notes. */
function verdictOf(body: string): ReviewVerdict | null {
  const match = /^[\s*_`"'>#-]*(pass|changes)\b[\s*_`"'.:,;!-]*([\s\S]*)$/i.exec(body.trim());
  if (!match) return null;
  const notes = match[2]!.trim().slice(0, NOTES_LIMIT);
  return { verdict: match[1]!.toLowerCase() as "pass" | "changes", ...(notes ? { notes } : {}) };
}

/** The last block of this run that reads as a verdict, or null. */
export function readReviewVerdict(text: string, nonce: string): ReviewVerdict | null {
  if (!/^[a-f0-9]{32}$/.test(nonce) || text.length > REVIEW_REPLY_LIMIT) return null;
  const open = reviewBlockOpen(nonce);
  for (let at = text.lastIndexOf(open); at >= 0; at = at > 0 ? text.lastIndexOf(open, at - 1) : -1) {
    const close = text.indexOf(REVIEW_BLOCK_CLOSE, at + open.length);
    if (close < 0) continue;
    const verdict = verdictOf(text.slice(at + open.length, close));
    if (verdict) return verdict;
  }
  return null;
}

/** The reply as the room shows it: each of this run's blocks becomes one
 * plain "Verdict: ..." line. */
export function reviewReplyShown(text: string, nonce: string): string {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return text;
  const open = reviewBlockOpen(nonce);
  let out = text;
  for (let at = out.indexOf(open); at >= 0; at = out.indexOf(open, at)) {
    const close = out.indexOf(REVIEW_BLOCK_CLOSE, at + open.length);
    if (close < 0) break;
    const verdict = verdictOf(out.slice(at + open.length, close));
    const line = verdict ? `Verdict: ${verdict.verdict}.${verdict.notes ? ` ${verdict.notes}` : ""}` : "";
    out = out.slice(0, at) + line + out.slice(close + REVIEW_BLOCK_CLOSE.length);
    at += line.length;
  }
  return out.trim();
}
