// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { lex, Unreadable } from './shell/lex.ts';

// Sean 2026-11-12 02:05Z: protected files run; raw findings and Full twins remain pinned.
const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const held = { approve: null, source: 'unread-call' as const };
const cases = [
  ['lexer later operand', (path: string) => `touch {1..513} ${path}`],
  ['lexer for body', (path: string) => `for x in {1..513}; do printf x >> ${path}; done`],
  ['lexer later command', (path: string) => `touch {1..513} ./notes; printf x >> ${path}`],
  ['lexer earlier operand', (path: string) => `touch ${path} {1..513}`],
  ['lexer redirect', (path: string) => `touch {1..513} >> ${path}`],
  ['lexer while body', (path: string) => `while touch {1..513} ./condition; do printf x >> ${path}; done`],
  ['lexer until body', (path: string) => `until touch {1..513} ./condition; do printf x >> ${path}; done`],
  ['lexer case body', (path: string) => `case {1..513} in *) touch ${path};; esac`],
  ['lexer function body', (path: string) => `f() { touch {1..513} ${path}; }; f`],
  ['lexer nested shell', (path: string) => `sh -c 'for x in {1..513}; do touch ${path}; done'`],
  ['lexer fixed prefix', (path: string) => `touch ${path}/{1..513}`],
  ['lexer stepped range', (path: string) => `touch {1..999..2} ${path}`],
  ['lexer option expansion', (path: string) => `touch -{a,b} ${path}`],
  ['lexer parameter expansion', (path: string) => `touch ${'${!unknown}'} ${path}`],
  ['lexer quoted parameter', (path: string) => `touch "${'${!unknown}'}" ${path}`],
  ['lexer nested brace', (path: string) => `touch {a,{b,c}} ${path}`],
  ['lexer comma limit', (path: string) => `touch {${Array.from({ length: 513 }, () => 'x').join(',')}} ${path}`],
  // Syntax/quote failures still escape the reader; inspect literal tokens in the raw text.
  ['fallback syntax', (path: string) => `if; touch ${path}`],
  ['fallback quoted literal', (path: string) => `if; touch '${path}'`],
  ['fallback quote', (path: string) => `touch ${path}; echo "unfinished`],
] as const;

describe.each(['owner', 'routine'] as const)('lexer recovery: %s', origin => {
  const originContext: AutoContext = {
    fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work',
    ...(origin === 'routine' ? { routineLevel: true } : {}),
  };
  describe.each(cases)('%s', (_name, makeCommand) => {
    it.each([true, false])('No limits protected=%s', protectedWrite => {
      const command = makeCommand(protectedWrite ? '~/.ssh/config' : './notes');
      const context = { ...originContext, commandText: command };
      const finding = noLimitsProtectedWrite(command, context, undefined, true);
      const finalized = finalizeNoLimits(bot, 'Bash', command, context, held);
      const verdict = autoVerdict(bot, 'Bash', command, context);
      if (protectedWrite) {
        expect(finding).toMatchObject({ rule: 'protected-path' });
        expect(finalized).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' });
        expect(verdict).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' });
      } else {
        expect(finding).toBeNull();
        expect(finalized).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' });
        expect(verdict).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' });
      }
    });
    it.each([true, false])('Full access snapshot protected=%s', protectedWrite => {
      const command = makeCommand(protectedWrite ? '~/.ssh/config' : './notes');
      const context = { ...originContext, commandText: command };
      const full = { ...bot, noLimits: false };
      // Captured on d3284bec4b before Round 3. Never update for No limits recovery.
      expect({ verdict: autoVerdict(full, 'Bash', command, context), finalized: finalizeNoLimits(full, 'Bash', command, context, held) }).toMatchSnapshot();
    });
  });
});

it('the legacy lexer still throws for an over-cap range', () => {
  expect(() => lex('touch {1..513} ./notes')).toThrow(Unreadable);
});

it.each(['{1..513}', '{1..999..2}', '-{a,b}'])('No limits lexer keeps an unknown word and the suffix: %s', word => {
  let tokens: ReturnType<typeof lex> = [];
  expect(() => { tokens = lex(`touch ${word} ./notes; printf x >> ~/.ssh/config`, true); }).not.toThrow();
  expect(tokens[1]).toMatchObject({ kind: 'word', word: { parts: [{ kind: 'var', name: '-unread-word' }] } });
  expect(tokens[2]).toMatchObject({ kind: 'word', word: { parts: [{ kind: 'lit', text: './notes' }] } });
  expect(tokens.at(-2)).toMatchObject({ kind: 'word', word: { parts: [{ kind: 'tilde' }, { kind: 'lit', text: '/.ssh/config' }] } });
});
