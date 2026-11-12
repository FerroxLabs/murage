// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
const cases = [
  ['function keyword', (path: string) => `if; function f { touch ${path}; }`],
  ['named coprocess', (path: string) => `if; coproc worker { touch ${path}; }`],
] as const;
describe.each(['owner', 'routine'] as const)('structured bodies %s', origin => {
  describe.each(cases)('%s', (_name, make) => {
    it.each([true, false])('No limits protected=%s', protect => {
      const command = make(protect ? '/etc/hosts' : './notes');
      const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
      const bot = { autoApprove: true, fullAccess: true, noLimits: true };
      const hit = noLimitsProtectedWrite(command, ctx, undefined, true);
      const action = autoVerdict(bot, 'Bash', command, ctx);
      const finalized = finalizeNoLimits(bot, 'Bash', command, ctx, { approve: null, source: 'unread-call' });
      if (protect) { expect(hit).toMatchObject({ rule: 'protected-path' }); expect(action.approve).toBeTruthy(); expect(finalized.approve).toBeTruthy(); }
      else { expect(hit).toBeNull(); expect(action.approve).toBeTruthy(); expect(finalized.approve).toBeTruthy(); }
    });
    it.each([true, false])('Full access snapshot protected=%s', protect => {
      const command = make(protect ? '/etc/hosts' : './notes');
      const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
      const full = { autoApprove: true, fullAccess: true, noLimits: false };
      expect({ action: autoVerdict(full, 'Bash', command, ctx), finalized: finalizeNoLimits(full, 'Bash', command, ctx, { approve: null, source: 'unread-call' }), inputs: ctx }).toMatchSnapshot();
    });
  });
});
