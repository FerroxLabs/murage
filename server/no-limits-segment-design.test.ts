// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { commandRoles,writeSlots } from './shell/roles.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const held = { approve: null, source: 'unread-call' as const };
import { segmentDesignRows as rows } from './testing/no-limits-segment-design-cases.ts';

describe.each(['owner', 'routine'] as const)('segment design: %s', origin => {
  describe.each(rows)('$id', ({ command, protect, classifierOnly }) => {
    const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
    it('No limits write positions', () => {
      if(classifierOnly){const roles=commandRoles(['ln','-s','~/.ssh/config','./x']);expect(roles.slots.find(slot=>slot.value==='~/.ssh/config')?.role).toBe('read');expect(writeSlots(roles).map(slot=>slot.value)).toEqual(['./x']);return;}
      const hit = noLimitsProtectedWrite(command, ctx, command === 'mystery /; & $cmd' ? 'pwsh' : undefined, true);
      const action = autoVerdict(bot, 'Bash', command, ctx);
      const finalized = finalizeNoLimits(bot, 'Bash', command, ctx, held);
      if (protect) {
        expect(hit).toMatchObject({ rule: 'protected-path' });
        expect(action.approve).toBeTruthy();
        expect(finalized.approve).toBeTruthy();
      } else {
        expect(hit).toBeNull();
        expect(action.approve).not.toBeNull();
        expect(finalized.approve).not.toBeNull();
      }
    });
    it('Full access snapshot', () => {
      const full = { ...bot, noLimits: false };
      expect({ action: autoVerdict(full, 'Bash', command, ctx), finalized: finalizeNoLimits(full, 'Bash', command, ctx, held), inputs: ctx }).toMatchSnapshot();
    });
  });
});
