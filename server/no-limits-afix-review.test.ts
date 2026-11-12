// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { newContext, walkScript } from './shell/walk.ts';
import { Unreadable } from './shell/lex.ts';

const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const owner: AutoContext = { fullAccessOrigin: 'owner', ownerStarted: true, outsideRead: null, commandCwd: '/work' };
const held = { approve: null, source: 'unread-call' as const };

describe.each(['owner', 'routine'] as const)('afix BLOCK-1: %s executable suffix after an unread command', origin => {
  const originContext: AutoContext = { ...owner, fullAccessOrigin: origin, ...(origin === 'routine' ? { routineLevel: true, ownerStarted: false } : {}) };
  it.each([
    'eval "$x"; printf x >> ~/.ssh/config',
    'eval "$x" && printf x >> ~/.ssh/config',
    'eval "$x" || printf x >> ~/.ssh/config',
    'eval "$x" | tee ~/.ssh/config',
    '(eval "$x"; printf x >> ~/.ssh/config)',
    'sh -c \'eval "$x"; printf x >> ~/.ssh/config\'',
    'eval "$x"; cd /etc; printf x >> hosts',
    'eval "$x"; ln -s /etc/hosts ./h; printf x >> ./h',
    'eval "$x"; eval "$y"; printf x >> ~/.ssh/config',
    'if eval "$x"; then printf x >> ~/.ssh/config; fi',
    'while eval "$x"; do printf x >> ~/.ssh/config; done',
    'f() { eval "$x"; printf x >> ~/.ssh/config; }; f',
    `printf x >"$(sh -c '\"')" >> ~/.ssh/config`,
    'printf x >{1..32}{1..32} >> ~/.ssh/config',
    `printf "$(sh -c '\"')" "$(touch ~/.ssh/config)"`,
    `printf "$(sh -c '\"')$(touch ~/.ssh/config)"`,
    // The nested parser cannot read this component; its siblings still run.
    'printf "$(for)" "$(touch ~/.ssh/config)"',
    'printf "$(for)$(touch ~/.ssh/config)"',
    'printf x >"$(for)" >> ~/.ssh/config',
  ])('retains the protected write: %s', command => {
    const context = { ...originContext, commandText: command };
    expect(noLimitsProtectedWrite(command, context, undefined, true)).toMatchObject({ rule: 'protected-path' });
    expect(finalizeNoLimits(bot, 'Bash', command, context, held)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
    expect(autoVerdict(bot, 'Bash', command, context)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
  });
  it.each([
    'eval "$x"; printf x >> ./notes',
    'eval "$x"; printf "%s" "printf x >> ~/.ssh/config"',
    'eval "$x"',
    `printf x >"$(sh -c '\"')" >> ./notes`,
  ])('ordinary work and printed command text still run: %s', command => {
    const context = { ...originContext, commandText: command };
    expect(noLimitsProtectedWrite(command, context, undefined, true)).toBeNull();
    expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
  });
});

it('the ordinary policy walker still stops on unreadable components', () => {
  let redirects = 0;
  expect(() => walkScript('eval "$x"; printf x >> /etc/hosts', newContext('/work'), {
    command: () => null,
    redirect: () => { redirects++; return null; },
    forkBomb: () => null,
  })).toThrow(Unreadable);
  expect(redirects).toBe(0);
});

