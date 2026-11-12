// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export type GlobToken = Readonly<{ kind: 'literal' | 'class'; value: string } | { kind: 'any' | 'star' }>;
export interface GlobComponent {
  readonly tokens: readonly GlobToken[];
  readonly literalPrefix: string;
  readonly literalSuffix: string;
  readonly minLength: number;
  readonly characterDependent: boolean;
  readonly globstar: boolean;
}
export interface ProducerTraversalPattern { readonly prefix: string; readonly components: readonly GlobComponent[] }

/** Compile one path component from raw quote masks. Only the single-character
 * class uses RegExp; wildcard matching never uses a backtracking regexp. */
export function compileProducerGlob(text: string, active: readonly boolean[]): GlobComponent {
  const tokens: GlobToken[] = [];
  let globstar = false;
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    if (active[i] && char === '*') {
      if (tokens.at(-1)?.kind === 'star') globstar = true;
      else tokens.push(Object.freeze({ kind: 'star' }));
      i++; continue;
    }
    if (active[i] && char === '?') { tokens.push(Object.freeze({ kind: 'any' })); i++; continue; }
    if (active[i] && char === '[') {
      if (text[i + 1] === '[' && [':', '.', '='].includes(text[i + 2] ?? '')) throw new Error('locale-dependent-glob-class');
      let end = i + 1;
      if (text[end] === '!' || text[end] === '^') end++;
      if (text[end] === ']') end++;
      while (end < text.length && !(text[end] === ']' && active[end])) end++;
      if (end < text.length) {
        let body = '';
        for (let at = i + 1; at < end; at++) {
          const value = text[at]!;
          if (at === i + 1 && active[at] && value === '!') body += '^';
          else if (!active[at] || value === '\\' || value === '[' || value === ']') body += value.replace(/[\\\]\[\^-]/g, '\\$&');
          else body += value;
        }
        if (!body || body === '^') throw new Error('empty-glob-class');
        const value = '[' + body + ']';
        new RegExp('^' + value + '$', 'u');
        tokens.push(Object.freeze({ kind: 'class', value })); i = end + 1; continue;
      }
    }
    tokens.push(Object.freeze({ kind: 'literal', value: char })); i += char.length;
  }
  let prefix = '', suffix = '';
  for (const token of tokens) { if (token.kind !== 'literal') break; prefix += token.value; }
  for (let i = tokens.length - 1; i >= 0; i--) { const token = tokens[i]!; if (token.kind !== 'literal') break; suffix = token.value + suffix; }
  return Object.freeze({ tokens: Object.freeze(tokens), literalPrefix: prefix, literalSuffix: suffix,
    minLength: tokens.filter(token => token.kind !== 'star').length,
    characterDependent: tokens.some(token => token.kind === 'any' || token.kind === 'class'), globstar });
}

const sensitive = new WeakMap<object, RegExp>(), insensitive = new WeakMap<object, RegExp>();
/** O(pattern length * filename length), with no regex wildcard backtracking. */
export function producerGlobMatches(component: GlobComponent, name: string, windows = false): boolean {
  const chars = [...name], tokens = component.tokens;
  if (chars.length < component.minLength) return false;
  const character = (token: GlobToken, value: string): boolean => {
    if (token.kind === 'any') return true;
    if (token.kind === 'literal') return windows ? token.value.toLowerCase() === value.toLowerCase() : token.value === value;
    if (token.kind !== 'class') return false;
    const cache = windows ? insensitive : sensitive;
    let pattern = cache.get(token);
    if (!pattern) { pattern = new RegExp('^' + token.value + '$', windows ? 'iu' : 'u'); cache.set(token, pattern); }
    return pattern.test(value);
  };
  let at = 0, word = 0, star = -1, retry = 0;
  while (word < chars.length) {
    if (at < tokens.length && character(tokens[at]!, chars[word]!)) { at++; word++; continue; }
    if (tokens[at]?.kind === 'star') { star = at++; retry = word; continue; }
    if (star >= 0) { at = star + 1; word = ++retry; continue; }
    return false;
  }
  while (tokens[at]?.kind === 'star') at++;
  return at === tokens.length;
}

/** Byte/character locale can change ? and bracket readings for non-ASCII
 * names. Keep that possible candidate instead of proving absence from it. */
export function producerGlobCharacterUncertain(component: GlobComponent, name: string, windows = false): boolean {
  if (!component.characterDependent || !/[^\x00-\x7f]/.test(name)) return false;
  const key = (text: string) => windows ? text.toLowerCase() : text;
  return key(name).startsWith(key(component.literalPrefix)) && key(name).endsWith(key(component.literalSuffix));
}
