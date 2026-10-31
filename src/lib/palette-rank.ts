// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one word matcher behind find (SETTINGS-UX-1011 S3): Settings search (lib/settings-search.ts) and the command
// palette's name lists share it. No library and no index: tokens, stems, prefixes and one typo on long tokens.
// Kept free of imports so the palette can load it on the first paint without the Settings words.

/** Words a person adds that say nothing about what they want ("pair my phone"); dropped while another token is left. */
const FILLER = new Set(["a", "an", "the", "my", "of", "for", "to", "and", "i", "me", "is", "please"]);

/** One query or field, split on spaces and punctuation, lower-cased, accents and apostrophes gone ("What's new" is whats, new). */
export function findTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The query's tokens, without filler words unless the query is nothing but filler. */
export function queryTokens(query: string): string[] {
  const all = findTokens(query);
  const kept = all.filter((token) => !FILLER.has(token));
  return kept.length ? kept : all;
}

function stemStep(word: string): string {
  if (/ications?$/.test(word)) return word.replace(/ications?$/, "i");
  if (/ies$/.test(word)) return word.slice(0, -2);
  if (/ss$/.test(word)) return word;
  if (/(x|z|ch|sh|ss)es$/.test(word)) return word.slice(0, -2);
  if (/[^su]s$/.test(word)) return word.slice(0, -1);
  if (/ing$/.test(word) && word.length >= 6) return word.slice(0, -3);
  if (/ed$/.test(word) && word.length >= 6) return word.slice(0, -2);
  if (/y$/.test(word)) return `${word.slice(0, -1)}i`;
  return word;
}

/** Strips trailing s / es / ing / ed, and turns -ication, -ies and a final y into i, until nothing more changes, so
 *  notify, notifies and notification all meet at "notifi" (series stays "seri", never "ser"). Short words are left alone. */
export function findStem(word: string): string {
  let current = word;
  while (current.length >= 4) {
    const next = stemStep(current);
    if (next === current || next.length < 3 || /i$/.test(current) && /i$/.test(next)) break;
    current = next;
  }
  return current;
}

/** True when `a` and `b` are at most one edit apart: one insert, delete, swap of neighbours, or change. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** How well one query token meets one field token: 0 exact (or same stem), 1 prefix, 2 one typo (raw tokens, both of
 *  5+ letters), -1 not at all. */
export function tokenMatch(query: string, field: string): -1 | 0 | 1 | 2 {
  if (query === field) return 0;
  const qs = findStem(query), fs = findStem(field);
  if (qs === fs) return 0;
  if (field.startsWith(query) || fs.startsWith(qs)) return 1;
  if (query.length >= 5 && field.length >= 5 && withinOneEdit(query, field)) return 2;
  return -1;
}

/** The best match any token of `field` gives `query` (see tokenMatch). */
export function bestTokenMatch(query: string, field: readonly string[]): -1 | 0 | 1 | 2 {
  let best: -1 | 0 | 1 | 2 = -1;
  for (const token of field) {
    const match = tokenMatch(query, token);
    if (match === 0) return 0;
    if (match !== -1 && (best === -1 || match < best)) best = match;
  }
  return best;
}

/** Ranking for the command palette's name lists (bots, rooms).
 *
 * Tiers: the whole name, then a name that starts with what was typed, then every typed word starting a word of the
 * name ("ops lead" finds "Lead of Ops"), then the old plain substring, then one typo. Within each tier the input
 * order is preserved: the caller's list already encodes a meaningful order (pinned first, recency, ...) and
 * re-sorting it here would fight that. */
export function rankByName<T extends { name: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  // empty query = switcher mode: everything, untouched
  if (!q) return [...items];
  // Every typed word counts for a name (a bot may be called "An"); punctuation alone is matched as written.
  const tokens = findTokens(q);
  const tiers: T[][] = [[], [], [], [], []];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name === q) { tiers[0].push(item); continue; }
    if (name.startsWith(q)) { tiers[1].push(item); continue; }
    const words = findTokens(name);
    const matches = tokens.map((token) => bestTokenMatch(token, words));
    if (tokens.length && matches.every((match) => match === 0 || match === 1)) tiers[2].push(item);
    else if (name.includes(q)) tiers[3].push(item);
    else if (tokens.length && matches.every((match) => match !== -1)) tiers[4].push(item);
  }
  return tiers.flat();
}
