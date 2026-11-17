// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { lexWordText, Unreadable, type Word } from './lex.ts';
import { braceCandidates, candidatesOf, expandWord, fork, MAX_INSPECTION_CANDIDATES, newContext } from './walk.ts';
import { collectNoLimits } from '../no-limits-collect.ts';
import { noLimitsProtectedWrite } from '../no-limits-protected.ts';
import { alwaysAskCommand } from '../always-ask.ts';
import { autoVerdict } from '../auto-approve.ts';

const inspection = () => ({ ...newContext('/work'), inspectionExpansion: true as const });

describe('bounded syntax inspection expansion', () => {
  it('reads every candidate at the 1,024-value boundary, including the last protected alternative', () => {
    const word = lexWordText('{1..32}{1..32}');
    const ctx = inspection();
    expect(expandWord(word, ctx)).toHaveLength(MAX_INSPECTION_CANDIDATES);
    expect(braceCandidates(word, ctx)).toHaveLength(MAX_INSPECTION_CANDIDATES);
    const values = candidatesOf(word, ctx);
    expect(values).toHaveLength(MAX_INSPECTION_CANDIDATES);
    expect(values[0]).toMatchObject({ kind: 'literal', text: '11' });
    expect(values.at(-1)).toMatchObject({ kind: 'literal', text: '3232' });
    const alternatives = Array.from({ length: 1023 }, () => './ordinary').concat('~/.ssh/config');
    expect(noLimitsProtectedWrite(`touch {${alternatives.join(',')}}`, { commandCwd: '/work' }, undefined, true)).toMatchObject({ rule: 'protected-path' });
  });

  it('retains the inspection bound in branches and variable/brace products', () => {
    const ctx = inspection();
    ctx.bound.set('n', expandWord(lexWordText('{1..32}'), ctx));
    const values = candidatesOf(lexWordText('$n{1..32}'), fork(ctx));
    expect(values).toHaveLength(1024);
    expect(values.at(-1)).toMatchObject({ kind: 'literal', text: '3232' });
    const rows = collectNoLimits('f() { touch {1..32}{1..32}; }; f; (touch {1..32}{1..32})', { cwd: '/work' });
    expect(rows.diagnostics).toEqual([]);
    for (const row of rows.commands.filter(row => row.command.name === 'touch')) {
      expect(row.command.operands[0]).toHaveLength(1024);
      expect(row.context.inspectionExpansion).toBe(true);
    }
  });

  it('preserves the ordinary policy ceiling and its fail-closed verdict', () => {
    expect(candidatesOf(lexWordText('{1..512}'), newContext())).toHaveLength(512);
    expect(() => candidatesOf(lexWordText('{1..32}{1..32}'), newContext())).toThrow('too many values');
    expect(alwaysAskCommand('touch {1..32}{1..32}', '/work')).toMatchObject({ rule: 'unreadable' });
  });

  it.each(['{1..33}{1..32}', '{1..512}{1..512}', '{1..32}{1..32}{a,b}'])('rejects a product beyond the hard bound: %s', raw => {
    expect(() => expandWord(lexWordText(raw), inspection())).toThrow(Unreadable);
    expect(() => braceCandidates(lexWordText(raw), inspection())).toThrow(Unreadable);
    expect(() => candidatesOf(lexWordText(raw), inspection())).toThrow(Unreadable);
    // Inspection must propagate this refusal, never report an empty set of writes.
    expect(() => noLimitsProtectedWrite(`touch ${raw} ./notes`, { commandCwd: '/work' })).toThrow(Unreadable);
  });

  it('rejects the Cartesian size before reading or copying its option payloads', () => {
    const word = lexWordText('{1..32}{1..33}');
    const last = word.parts[1];
    if (last?.kind !== 'brace') throw Error('expected brace fixture');
    for (const alt of last.alts) Object.defineProperty(alt.parts, Symbol.iterator, {
      value: () => { throw Error('oversized product payload was read'); },
    });
    expect(() => expandWord(word, inspection())).toThrow('too many values');
    expect(() => braceCandidates(word, inspection())).toThrow('too many values');
  });

  it('bounds long-prefix character copying even with an admissible candidate count', () => {
    const word = lexWordText('x'.repeat(2048) + '{1..32}{1..32}');
    expect(() => expandWord(word, inspection())).toThrow('expansion work limit');
    expect(() => braceCandidates(word, inspection())).toThrow('expansion work limit');
    expect(() => noLimitsProtectedWrite('touch ' + 'x'.repeat(2048) + '{1..32}{1..32}', { commandCwd: '/work' })).toThrow(Unreadable);
  });

  it('bounds cumulative part copying for long sequences of tiny parts', () => {
    const word: Word = { parts: Array.from({ length: 400 }, () => ({ kind: 'lit', text: 'x', quote: 'single' })) };
    expect(() => expandWord(word, inspection())).toThrow('expansion work limit');
    expect(() => braceCandidates(word, inspection())).toThrow('expansion work limit');
  });

  it.each(['{1..32}{1..32}', '{1..33}{1..32}'])('keeps a later wipe held at No limits: %s', raw => {
    const command = `touch ${raw} ./notes; rm -rf /`;
    expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, 'Bash', command, {
      fullAccessOrigin: 'owner', ownerStarted: true, outsideRead: null, commandCwd: '/work', commandText: command,
    })).toMatchObject({ approve: null, source: 'always-ask' });
  });
});
