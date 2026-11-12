// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lex, Unreadable } from './shell/lex.ts';
import { ownerMarks, withoutDoubts } from './shell/marks.ts';
import { candidatesOf, UNKNOWN_MARK, type Candidate, type WalkContext } from './shell/walk.ts';
import type { SegWord } from './shell/segments.ts';

/** Preserve known path components when a single word's expansion is UNKNOWN.
 * This is the No limits walker's existing unknown-path rule, shared by readers. */
export function segmentWordPaths(word: SegWord | undefined, ctx: WalkContext): string[] {
  if (!word) return [];
  if (word.text !== undefined) return [word.text];
  if (word.alternatives) return word.alternatives;
  return segmentWordCandidates(word,ctx).map(item => item.kind==='value'&&item.path.startsWith(UNKNOWN_MARK)?item.path.replaceAll(UNKNOWN_MARK,'$__unknown'):item.path.replaceAll(UNKNOWN_MARK, ''));
}
/** Candidate provenance is retained when resolving already-bound option/operand
 * values. Raw SegWords remain unchanged for the separate producer collector. */
export function segmentWordCandidates(word:SegWord|undefined,ctx:WalkContext):Candidate[]{
  if(!word)return [];
  if(word.placeholder)return [{kind:'value',why:'find-placeholder',path:UNKNOWN_MARK,lead:true}];
  try {
    const token = lex(word.raw, true)[0];
    if (token?.kind !== 'word') return [];
    // ${name:?} and ${name?} return the existing bound value; the message
    // after ? is used only when the shell aborts. Preserve that known value
    // in the No limits reader instead of replacing it with an unknown path.
    const expandedWord={...token.word,parts:token.word.parts.map(part=>part.kind==='var'&&(part.op===':?'||part.op==='?')&&ctx.bound.get(part.name)
      ? {...part,op:undefined,word:undefined}:part)};
    return ownerMarks(() => withoutDoubts(() => candidatesOf(expandedWord, { ...ctx, unknownUnreadableWords: true })));
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return [];
  }
}