// One definition of "this @ starts a mention", shared by server routing
// (server/store.ts `mentionedBots` / `roomResponders`) and the composer's
// preview of who will answer (src/lib/group-routing.ts). The two used to
// carry copies that accepted only whitespace before the @ and only ASCII
// after the name, so `**@Atlas**`, `(@Atlas)` and `【@Atlas】` never routed,
// and `@Atlas調査` did (upstream #1607, 7d085cdc).
//
// Only opening punctuation and Markdown markers count as a boundary: `/@bot`
// stays a URL path and `user@bot` stays an address.
const OPENING_MENTION_BOUNDARY = /[(*_~[{<'"‘“〈《「『【（]/u;

/** Does the @ at `at` start a standalone mention? */
export function isMentionBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const before = text[at - 1];
  return /\s/u.test(before) || OPENING_MENTION_BOUNDARY.test(before);
}

/** Would `value` extend a matched name into a longer word? Any Unicode
 * letter, digit or mark does. Underscores do only when a word character
 * follows them: `@everyone_else` is another name, while the closing `_` of
 * `_@Atlas_` (Markdown emphasis) ends the mention. */
export function isMentionNameContinuation(value: string | undefined): boolean {
  return value !== undefined && /^_*[\p{L}\p{N}\p{M}]/u.test(value);
}

/** Does `name` appear as a mention at `at`? Compares a slice of the original
 * text rather than a lowercased copy of all of it: lowercasing can change a
 * string's length ("İ" becomes two code units), which would shift every
 * offset after it. */
function mentionAt(text: string, at: number, name: string): boolean {
  const end = at + 1 + name.length;
  return text.slice(at + 1, end).toLowerCase() === name.toLowerCase() && !isMentionNameContinuation(text.slice(end));
}

/** Is `@everyone` mentioned anywhere in the text? */
export function mentionsEveryone(text: string): boolean {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (isMentionBoundary(text, at) && mentionAt(text, at, "everyone")) return true;
  }
  return false;
}

/** Resolve @mentions against a roster: names match case-insensitively,
 * longest name wins (so "@New Bot 2" never half-matches "New Bot"), hidden
 * bots are skipped and results are deduped, in order of first mention. */
export function mentionedPeers<T extends { name: string; hidden?: boolean }>(text: string, peers: readonly T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const found: T[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!isMentionBoundary(text, at)) continue;
    const hit = candidates.find((p) => mentionAt(text, at, p.name));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}
