// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Local, non-model text checks for bot learning (batch B4, design section 11).
// Nothing here calls a model or the network. It answers three questions:
//  - which part of an owner message is really somebody else's words (a pasted
//    email, a quote block, a forward)?
//  - what can be said about a prospect's message without repeating it?
//  - how does text get scrubbed of contact details and secrets before it is
//    kept as evidence?

export interface TextSegment { text: string; party: "owner" | "third-party" }

const QUOTE_LINE = /^\s*>/;
const FORWARD_HEADER = /^\s*(?:-{2,}\s*(?:original message|forwarded message)\s*-{2,}|begin forwarded message:?|_{5,}|-{5,}\s*forwarded message\s*-{5,})/i;
const MAIL_HEADER = /^\s*(?:from|sent|to|cc|date|subject)\s*:\s*\S/i;
const WROTE_LINE = /^\s*on .{6,120}\bwrote:\s*$/i;

/** Splits a message into owner words and pasted third-party words. A quote
 * marker (`>`), a "From:" style header block, a forward banner or an "On ...
 * wrote:" line starts third-party text; headers and forwards run to the end of
 * the message (what follows a pasted email header is the pasted email). */
export function classifyPastedText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  const push = (party: TextSegment["party"], line: string) => {
    const last = out[out.length - 1];
    if (last && last.party === party) last.text += "\n" + line; else out.push({ text: line, party });
  };
  const lines = text.split(/\r?\n/);
  let rest = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!rest) {
      const headerBlock = MAIL_HEADER.test(line) && /^\s*from\s*:/i.test(line) && lines.slice(i + 1, i + 4).some(l => MAIL_HEADER.test(l));
      if (FORWARD_HEADER.test(line) || headerBlock) rest = true;
      else if (WROTE_LINE.test(line)) { push("third-party", line); rest = true; continue; }
    }
    push(rest || QUOTE_LINE.test(line) ? "third-party" : "owner", line);
  }
  return out.filter(segment => segment.text.trim().length > 0);
}

export const hasPastedThirdParty = (text: string): boolean => classifyPastedText(text).some(s => s.party === "third-party");

const TOPICS: Array<[RegExp, string]> = [
  [/\b(?:price|pricing|cost|how much|quote|discount|fee|fees|rate|rates|\$\d)/i, "price"],
  [/\b(?:when|schedule|timeline|deadline|today|tomorrow|next week|available|availability)\b/i, "timing"],
  [/\b(?:refund|cancel|complain|problem|broken|angry|disappointed|not working)\b/i, "a problem"],
  [/\b(?:thanks|thank you|appreciate)\b/i, "thanks"],
  [/\b(?:buy|purchase|sign up|order|interested|demo|trial)\b/i, "buying"],
];

/** A locally generated stand-in for a prospect's message when prospect
 * learning is off: the count of sentences and a tag from a fixed vocabulary.
 * It never contains any of the words, names or numbers of the original. */
export function structuralLine(text: string): string {
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter(part => part.trim().length > 0).length || 1;
  const tags = TOPICS.filter(([pattern]) => pattern.test(text)).map(([, tag]) => tag);
  const asks = text.includes("?") ? "asks" : "says";
  const about = tags.length ? ` about ${tags.slice(0, 2).join(" and ")}` : "";
  return `[customer: ${sentences} sentence${sentences === 1 ? "" : "s"}, ${asks}${about}]`;
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, "[secret]"],
  [/\b(?:bearer|token|password|passwd|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "[secret]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/https?:\/\/[^\s)>\]]+/gi, "[link]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [/(?<![\w.])\+?\d[\d ().-]{7,}\d(?!\w)/g, "[phone]"],
];

/** Removes contact details, links and secret-looking values. Applied to every
 * piece of text kept as learning evidence. */
export function redactLearningText(text: string): string {
  let out = text;
  for (const [pattern, label] of REDACTIONS) out = out.replace(pattern, label);
  return out;
}

const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
function shingles(text: string, size: number): Set<string> {
  const w = words(text), out = new Set<string>();
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(" "));
  return out;
}

/** True when `candidate` repeats a run of `size` consecutive words from any of
 * the prospect texts, or a short prospect text whole. Used to keep prospect
 * wording out of lessons and guides. */
export function repeatsProspectText(candidate: string, prospectTexts: readonly string[], size = 4): boolean {
  const own = shingles(candidate, size);
  const flat = words(candidate).join(" ");
  for (const text of prospectTexts) {
    const w = words(text);
    if (!w.length) continue;
    if (w.length < size) { if (w.length >= 3 && ` ${flat} `.includes(` ${w.join(" ")} `)) return true; continue; }
    for (const piece of shingles(text, size)) if (own.has(piece)) return true;
  }
  return false;
}
