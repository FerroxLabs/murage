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
  describe.each(rows)('$id', ({ id, command, protect, classifierOnly }) => {
    const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
    it('No limits write positions', () => {
      if(classifierOnly){const roles=commandRoles(['ln','-s','~/.ssh/config','./x']);expect(roles.slots.find(slot=>slot.value==='~/.ssh/config')?.role).toBe('read');expect(writeSlots(roles).map(slot=>slot.value)).toEqual(['./x']);return;}
      const hit = noLimitsProtectedWrite(command, ctx, command === 'mystery /; & $cmd' ? 'pwsh' : undefined, true);
      const action = autoVerdict(bot, 'Bash', command, ctx);
      const finalized = finalizeNoLimits(bot, 'Bash', command, ctx, held);
      // MAIN RULING NARROW-WIPE 2026-11-14: heredocs, opaque execution and reader doubts alone run; literal executed root wipes still card.
      // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: read-17 begins with NUL,
      // so its ANSI-quoted command word cannot execute rm; the other twins stay.
      const cards=new Set(['read-15','read-16','read-18']);
      const expected=cards.has(id)?{approve:null,source:'always-ask'}:{approve:'auto-approved Bash (no limits)',source:'no-limits'};
      if (protect) {
        expect(hit).toMatchObject({ rule: 'protected-path' });
        expect(action).toMatchObject(expected);
        expect(finalized).toMatchObject(expected);
      } else {
        expect(hit).toBeNull();
        expect(action).toMatchObject(expected);
        expect(finalized).toMatchObject(expected);
      }
    });
    it('Full access snapshot', () => {
      const full = { ...bot, noLimits: false };
      expect({ action: autoVerdict(full, 'Bash', command, ctx), finalized: finalizeNoLimits(full, 'Bash', command, ctx, held), inputs: ctx }).toMatchSnapshot();
    });
  });
});

it('a literal root wipe still stops at authenticated No limits',()=>{
 const command='rm -rf /',ctx:AutoContext={fullAccessOrigin:'owner',ownerStarted:true,commandText:command,commandCwd:'/work',workFolder:'/work'};
 expect(autoVerdict(bot,'Bash',command,ctx)).toMatchObject({approve:null,source:'always-ask',rule:'delete-root'});
 expect(finalizeNoLimits(bot,'Bash',command,ctx,held)).toMatchObject({approve:null,source:'always-ask',rule:'delete-root'});
});
