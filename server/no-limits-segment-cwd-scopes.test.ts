// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
const cases = [
  ['sibling substitutions', 'if; echo $(cd /etc) $(touch ./notes)', false],
  ['parenthesized cwd', '(cd /etc); touch ./notes; if;', false],
  ['wrapper cwd', 'if; env -C /etc printf x; touch ./notes', false],
  ['changed protected cwd', 'if; cd /etc; touch ./notes', true],
  ['changed ordinary cwd', 'if; cd ./safe; touch ./notes', false],
] as const;
describe.each(['owner', 'routine'] as const)('cwd scopes %s', origin => {
  describe.each(cases)('%s', (_name, command, protect) => {
    const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
    it('No limits', () => {
      const bot = { autoApprove: true, fullAccess: true, noLimits: true };
      const hit = noLimitsProtectedWrite(command, ctx, undefined, true);
      const action = autoVerdict(bot, 'Bash', command, ctx);
      const finalized = finalizeNoLimits(bot, 'Bash', command, ctx, { approve: null, source: 'unread-call' });
      if (protect) { expect(hit).toMatchObject({ rule: 'protected-path' }); expect(action).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); expect(finalized).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); }
      else { expect(hit).toBeNull(); expect(action).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); expect(finalized).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' }); }
    });
    it('Full access snapshot', () => {
      const full = { autoApprove: true, fullAccess: true, noLimits: false };
      expect({ action: autoVerdict(full, 'Bash', command, ctx), finalized: finalizeNoLimits(full, 'Bash', command, ctx, { approve: null, source: 'unread-call' }), inputs: ctx }).toMatchSnapshot();
    });
  });
});
