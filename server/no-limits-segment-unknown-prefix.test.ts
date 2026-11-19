// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { readExecutableOwnerNl as readExecutable } from './no-limits-code.ts';
const cases = ['{1..513}', '${!unknown}'];
describe.each(['owner', 'routine'] as const)('unknown word prefix %s', origin => {
  describe.each(cases)('%s', suffix => {
    it.each([true, false])('No limits protected=%s', protect => {
      const command = `if; touch ${protect ? '/etc' : './out'}/${suffix}`;
      const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
      const bot = { autoApprove: true, fullAccess: true, noLimits: true };
      const hit = noLimitsProtectedWrite(command, ctx, undefined, true);
      const action = autoVerdict(bot, 'Bash', command, ctx);
      const finalized = finalizeNoLimits(bot, 'Bash', command, ctx, { approve: null, source: 'unread-call' });
      if (protect) { expect(hit).toMatchObject({ rule: 'protected-path' }); expect(action).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); expect(finalized).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); }
      else { expect(hit).toBeNull(); expect(action).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); expect(finalized).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); }
    });
    it.each([true, false])('Full access snapshot protected=%s', protect => {
      const command = `if; touch ${protect ? '/etc' : './out'}/${suffix}`;
      const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
      const full = { autoApprove: true, fullAccess: true, noLimits: false };
      expect({ action: autoVerdict(full, 'Bash', command, ctx), finalized: finalizeNoLimits(full, 'Bash', command, ctx, { approve: null, source: 'unread-call' }), inputs: ctx }).toMatchSnapshot();
    });
  });
});

describe.each(cases)('S1 unknown prefix %s', suffix => {
  it.each([true, false])('keeps the known path prefix protected=%s', protect => {
    const command = `if; touch ${protect ? '/etc' : './out'}/${suffix}`;
    const result = readExecutable('sh', command, undefined, 0, '/work');
    expect(result.targets.some(t => t.op === 'write' && t.path.startsWith(protect ? '/etc' : '/work/out'))).toBe(true);
  });
});
