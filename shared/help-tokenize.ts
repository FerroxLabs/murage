// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The help search tokenizer, one function for every script (L-COPY r3, design
// section 5). The docs route (shared/help-search.ts, server/help-routes.ts)
// and the help panel's search over a language's Help pack
// (src/lib/help-pack-search.ts) split words the same way. It lives in its own
// module so the panel's chunk can use it without the docs index.
//
// NFKC, lowercase, then split on anything that is not a letter, a combining
// mark or a digit: marks stay inside their word, so Hindi याद and टीम stay
// whole. A run of Han, Hiragana, Katakana or Hangul has no spaces between
// words, so it becomes its single characters plus each pair of neighbours
// (bigrams): バックアップ matches inside バックアップを. Length by script: a
// Latin (or other spaced-script) word or a number needs 2 or more characters
// and skips the stopwords; a Devanagari word needs 2 or more code points,
// marks included; a CJK single character is kept.

/** Words that carry no signal in a product-help question. Deliberately small:
 * over-trimming loses "can" and "use" from phrases like "how to use". */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "am", "do", "does", "did",
  "of", "in", "on", "at", "it", "its", "this", "that", "these", "those", "and",
  "or", "but", "if", "so", "my", "me", "i", "you", "your", "we", "us", "there",
  "what", "when", "where", "which", "who", "why", "how", "to", "for", "with",
  "can", "will", "would", "should", "murage",
]);

/** Splits text into search words: anything that is not a letter, a mark or a digit. */
export const WORD_SEPARATOR = /[^\p{L}\p{M}\p{N}]+/u;
const CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;
const CJK_RUNS = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]+)/u;
const DEVANAGARI = /\p{scx=Devanagari}/u;

function pushWord(out: string[], word: string): void {
  if (!word) return;
  if (DEVANAGARI.test(word)) {
    if ([...word].length >= 2) out.push(word);
    return;
  }
  if (word.length < 2 || STOPWORDS.has(word)) return;
  out.push(word);
}

function pushCjk(out: string[], run: string): void {
  const chars = [...run];
  for (const char of chars) out.push(char);
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!);
}

/** Fold the endings that product prose varies freely: "approve"/"approval",
 * "connect"/"connection"/"connected", "routine"/"routines". Deliberately a
 * short fixed list rather than a full Porter stemmer: every rule here is one
 * a Murage help question actually needs, and a rule that over-merges ("cost"
 * and "costume") is worse on a corpus this small than a missed variant. */
const SUFFIXES = ["ations", "ation", "ions", "ion", "ments", "ment", "ings", "ing", "als", "al", "ers", "er", "ed", "es", "s"];

export function stem(word: string): string {
  let out = word;
  for (const suffix of SUFFIXES) {
    if (out.length - suffix.length >= 4 && out.endsWith(suffix)) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  // "approve" → "approv" meets "approval" → "approv"; "routine" meets "routines".
  return out.length > 4 && out.endsWith("e") ? out.slice(0, -1) : out;
}

/** Lowercase, split on non-letters, drop stopwords; CJK runs become characters
 * plus bigrams. Variants are folded by `stem` at match time, not here, so the
 * index keeps the words the docs actually use and a result can still be
 * quoted verbatim. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.normalize("NFKC").toLowerCase().split(WORD_SEPARATOR)) {
    if (!piece) continue;
    if (!CJK.test(piece)) { pushWord(out, piece); continue; }
    // A piece that mixes scripts ("autoで", "ok日本"): CJK runs and the words between them, each by its own rule.
    for (const part of piece.split(CJK_RUNS)) {
      if (!part) continue;
      if (CJK.test(part)) pushCjk(out, part);
      else pushWord(out, part);
    }
  }
  return out;
}
