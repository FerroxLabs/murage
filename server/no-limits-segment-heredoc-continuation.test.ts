// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { segments } from './shell/segments.ts';
const continuation = String.fromCharCode(92, 10);
const cases = [
  ['substitution across a physical newline', (path: string) => ['if; cat <<EOF', '$' + continuation + `(touch ${path})`, 'EOF'].join('\n')],
  ['continued delimiter preserves the later command', (path: string) => ['if; cat <<EOF', 'data', 'EO' + continuation + 'F', `touch ${path}`].join('\n')],
] as const;
it('L5 joins unquoted physical lines before matching the delimiter', () => {
  const s = segments(['cat <<EOF', 'a' + continuation + 'b', 'EO' + continuation + 'F', 'touch ./later'].join('\n'));
  expect(s.segments[0]?.redirects[0]?.heredoc?.body).toBe('ab\n');
  expect(s.segments.some(s => s.words[0]?.text === 'touch')).toBe(true);
});
describe.each(['owner', 'routine'] as const)('continued heredoc %s', origin => {
  describe.each(cases)('%s', (_name, make) => {
    it.each([true, false])('No limits protected=%s', protect => {
      const command = make(protect ? '/etc/hosts' : './notes');
      const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
      const bot = { autoApprove: true, fullAccess: true, noLimits: true };
      const finding = noLimitsProtectedWrite(command, ctx, undefined, true);
      const action = autoVerdict(bot, 'Bash', command, ctx);
      const finalized = finalizeNoLimits(bot, 'Bash', command, ctx, { approve: null, source: 'unread-call' });
      if (protect) { expect(finding).toMatchObject({ rule: 'protected-path' }); expect(action.approve).toBeTruthy(); expect(finalized.approve).toBeTruthy(); }
      else { expect(finding).toBeNull(); expect(action.approve).toBeTruthy(); expect(finalized.approve).toBeTruthy(); }
    });
    it.each([true, false])('Full access snapshot protected=%s', protect => {
      const command = make(protect ? '/etc/hosts' : './notes');
      const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
      const full = { autoApprove: true, fullAccess: true, noLimits: false };
      expect({ action: autoVerdict(full, 'Bash', command, ctx), finalized: finalizeNoLimits(full, 'Bash', command, ctx, { approve: null, source: 'unread-call' }), inputs: ctx }).toMatchSnapshot();
    });
  });
});
