// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Word } from './shell/lex.ts';
import { braceCandidates, candidatesOf, expandWord, type WalkContext } from './shell/walk.ts';
import { anchoredPath, lexicalPath, noLimitsDisk, resolveNoLimitsPath, spellPath, type FsContext } from './no-limits-fs.ts';
import { compileProducerGlob, producerGlobCharacterUncertain, producerGlobMatches, type ProducerTraversalPattern } from './no-limits-glob.ts';

export interface ProducerValueBudget { remaining: number }
export interface ProducerValue {
  readonly value?: string; readonly rawValue?: string; readonly unknownCause?: string;
  readonly traversalPatterns?: readonly ProducerTraversalPattern[];
}
export const dynamicProducerWord = (word: Word): boolean => word.parts.some(part =>
  part.kind === 'brace' ? part.alts.some(dynamicProducerWord) : !['lit', 'tilde', 'glob'].includes(part.kind));

export function expandProducerGlob(path: string, context: FsContext, word?: Word, limit = 4096): ProducerValue[] {
  if (context.remote) return [{ value: path, unknownCause: 'remote-glob' }];
  const spelled = spellPath(path, context), parts = spelled.split('/');
  // Keep quoted wildcards literal when another part of the same Word globs.
  let maskText = '', mask: boolean[] = [];
  for (const part of word?.parts ?? []) {
    if (!['lit', 'glob', 'tilde'].includes(part.kind)) { maskText = ''; break; }
    const text = part.kind === 'tilde' ? spellPath('~' + part.user, context) : part.kind === 'lit' || part.kind === 'glob' ? part.text : '';
    maskText += text;
    const active = part.kind === 'glob' || part.kind === 'lit' && part.quote === 'none';
    for (let i = 0; i < text.length; i++) mask.push(active);
  }
  if (maskText !== spelled) mask = Array(spelled.length).fill(true);
  let offset = 0;
  const masks = parts.map(part => { const result = mask.slice(offset, offset + part.length); offset += part.length + 1; return result; });
  const patterned = (index: number) => {
    for (let at = 0; at < parts[index]!.length; at++) if (masks[index]![at] && '*?['.includes(parts[index]![at]!)) return true;
    return false;
  };
  const first = parts.findIndex((_, index) => patterned(index));
  if (first < 0) return [{ value: path }];
  const start = parts.slice(0, first).join('/') || (anchoredPath(spelled) ? '/' : '.');
  let components;
  try { components = parts.slice(first).map((part, index) => compileProducerGlob(part, masks[first + index]!)); }
  catch { return [{ value: path, rawValue: path, unknownCause: 'unknown-glob-pattern' }]; }
  const prefixResolution = resolveNoLimitsPath(start, context);
  const prefixes = [...new Set([lexicalPath(start, context), ...(prefixResolution.kind === 'known' ? [prefixResolution.physical] : [])])];
  const traversalPatterns = Object.freeze(prefixes.map(prefix => Object.freeze({ prefix, components: Object.freeze(components) })));
  const output: ProducerValue[] = [];
  let scanned = 0, overflow = false;
  const uncertain = new Set<string>();
  const disk = context.disk ?? noLimitsDisk;
  const unknown = (cause: string) => { uncertain.add(cause); };
  const visit = (base: string, index: number) => {
    if (overflow) return;
    if (index >= parts.length) { output.push({ value: base, rawValue: path, traversalPatterns }); return; }
    const part = parts[index]!, component = components[index - first]!;
    const resolved = resolveNoLimitsPath(base, context);
    if (resolved.kind !== 'known') { unknown('unavailable-glob-directory'); return; }
    if (!resolved.directory) return;
    if (!patterned(index)) {
      const next = base.replace(/\/$/, '') + '/' + part;
      const stat = resolveNoLimitsPath(next, context);
      if (stat.kind === 'known' && stat.exists) visit(next, index + 1);
      else if (stat.kind !== 'known') unknown('unavailable-glob-entry');
      return;
    }
    let names: readonly string[];
    try { names = disk.readdir(resolved.physical); }
    catch { unknown('unreadable-glob-directory'); return; }
    if (component.globstar) unknown('globstar-mode');
    // readdir omits . and ..; shell modes differ about selecting them.
    if (part.startsWith('.') && (producerGlobMatches(component, '.', context.windows) || producerGlobMatches(component, '..', context.windows))) unknown('glob-parent-selection');
    for (const name of names) {
      if (producerGlobCharacterUncertain(component, name, context.windows)) unknown('locale-dependent-glob-entry');
      if ((!name.startsWith('.') || part.startsWith('.')) && producerGlobMatches(component, name, context.windows)) {
        if (++scanned > 4096 || output.length >= limit) { overflow = true; break; }
        visit(base.replace(/\/$/, '') + '/' + name, index + 1);
      }
    }
  };
  visit(start, first);
  if (overflow) unknown('glob-overflow');
  if (!output.length && !uncertain.size) unknown('unmatched-glob');
  for (const unknownCause of uncertain) output.push({ value: path, rawValue: path, traversalPatterns, unknownCause });
  return output;
}

export function producerValues(word: Word | undefined, walk: WalkContext, context: FsContext, budget?: ProducerValueBudget): readonly ProducerValue[] {
  if (!word) return Object.freeze([{ unknownCause: 'missing-operand' }]);
  const dynamic = dynamicProducerWord(word), values: ProducerValue[] = [];
  try {
    // Keep the actual Word for each static brace alternative. A flattened
    // candidate string cannot distinguish a quoted [a] from a bracket class.
    const words = dynamic ? [word] : expandWord(word, walk).flatMap(braceCandidates);
    for (const raw of words) for (const candidate of candidatesOf(raw, walk)) {
      const expanded = candidate.kind === 'glob' ? dynamic ? [{ value: candidate.path, unknownCause: 'dynamic-producer-value' }] : expandProducerGlob(candidate.path, context, raw, Math.min(4096 - values.length, budget?.remaining ?? 4096)) : [{ value: candidate.path,
        ...(candidate.kind !== 'literal' ? { unknownCause: 'unavailable-producer-value' } : {}) }];
      for (const value of expanded) {
        if (values.length >= 4096) { values.push({ unknownCause: 'glob-overflow' }); return Object.freeze(values.map(value => Object.freeze(value))); }
        if (budget && 'traversalPatterns' in value && !value.unknownCause) budget.remaining--;
        values.push(Object.freeze({ ...value, ...(dynamic ? { unknownCause: 'dynamic-producer-value' } : {}) }));
      }
    }
  } catch { values.push(Object.freeze({ unknownCause: 'producer-expansion-overflow' })); }
  return Object.freeze(values.length ? values : [Object.freeze({ unknownCause: 'unavailable-producer-value' })]);
}
