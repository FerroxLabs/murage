// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

// Sean 2026-11-12 02:05Z: protected files run; raw findings and Full twins remain pinned.
const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const held = { approve: null, source: 'unread-call' as const };
const overflow = '{1..32}{1..32}';
const cases = [
  ['for expansion', (path: string) => `for x in ${overflow}; do printf x >> ${path}; done`],
  ['later operand', (path: string) => `touch ${overflow} ${path}`],
  ['earlier operand', (path: string) => `touch ${path} ${overflow}`],
  ['later redirect', (path: string) => `touch ${overflow} >> ${path}`],
  ['while body', (path: string) => `while touch ${overflow} ./condition; do printf x >> ${path}; done`],
  ['until body', (path: string) => `until touch ${overflow} ./condition; do printf x >> ${path}; done`],
  ['case body', (path: string) => `case x in *) touch ${overflow} ${path};; esac`],
  ['function arguments', (path: string) => `f() { printf x >> ${path}; }; f ${overflow}`],
  ['function body', (path: string) => `f() { touch ${overflow} ${path}; }; f`],
  ['nested shell', (path: string) => `sh -c 'for x in ${overflow}; do touch ${path}; done'`],
  ['later command', (path: string) => `touch ${overflow} ./first; printf x >> ${path}`],
  ['unread substitution', (path: string) => `touch "$(for)" ${path}`],
  ['unknown loop variable', (path: string) => `x=~/.ssh/config; for x in ${overflow}; do touch "$x" ${path}; done`],
  ['fixed path prefix', (path: string) => `touch ${path}/${overflow}`],
] as const;

describe.each(['owner', 'routine'] as const)('local unread-word recovery: %s', origin => {
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
      // Captured on 70b2a08789 before the product fix. Never update for No limits recovery.
      expect({ verdict: autoVerdict(full, 'Bash', command, context), finalized: finalizeNoLimits(full, 'Bash', command, context, held) }).toMatchSnapshot();
    });
  });
});
