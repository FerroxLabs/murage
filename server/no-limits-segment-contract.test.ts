// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { segments } from './shell/segments.ts';
import { commandRoles } from './shell/roles.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
// MAIN r2 H3 supersedes the r1 opaque depth placeholder: inner code stays visible.
it('H3 excess executable depth is segmented flat', () => {
  const result = segments('echo $(touch /etc/x)', { maxDepth: 0 });
  expect(result.truncated).toBe(false);
  expect(result.segments.some(s=>s.depth===0&&s.words[0]?.text==='touch'&&s.words[1]?.text==='/etc/x')).toBe(true);
});
it('L7 optional case-pattern parentheses never create a subshell', () => {
  const result = segments('case x in (a) touch ./a;; (b) touch ./b;; esac');
  expect(result.segments.map(s => s.group)).toEqual(expect.arrayContaining([0]));
  expect(result.segments.every(s => s.group === 0)).toBe(true);
});
it('L11 a PowerShell script block is an expansion word', () => {
  const result = segments('& { touch /etc/x }', { dialect: 'pwsh' });
  expect(result.segments[0]?.words[0]).toMatchObject({ origin: 'expansion', text: undefined });
});
it('L5 wrapper identity is supplied by the one command table', () => {
  const result = segments("sudo -u root env -C /etc bash <<'EOF'\ntouch x\nEOF", { command: commandRoles });
  expect(result.segments.some(s => s.via === 'heredoc-code' && s.words[0]?.text === 'touch')).toBe(true);
});
const rows = [
  { id: 'unknown-cd-protected', command: 'if; cd "$x"; touch config', cwd: '/etc', protect: true },
  { id: 'unknown-cd-ordinary', command: 'if; cd "$x"; touch config', cwd: '/work', protect: false },
];
describe.each(['owner', 'routine'] as const)('contract cwd: %s', origin => {
  describe.each(rows)('$id', row => {
    const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: row.cwd, commandText: row.command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
    const bot = { autoApprove: true, fullAccess: true, noLimits: true };
    it('No limits retains the pre-cd possibility', () => {
      const hit = noLimitsProtectedWrite(row.command, ctx, undefined, true);
      const action = autoVerdict(bot, 'Bash', row.command, ctx);
      const finalized = finalizeNoLimits(bot, 'Bash', row.command, ctx, { approve: null, source: 'unread-call' });
      if (row.protect) { expect(hit).toMatchObject({ rule: 'protected-path' }); expect(action.approve).toBeTruthy(); expect(finalized.approve).toBeTruthy(); }
      else { expect(hit).toBeNull(); expect(action.approve).toBeTruthy(); expect(finalized.approve).toBeTruthy(); }
    });
    it('Full access snapshot', () => {
      const full = { ...bot, noLimits: false };
      expect({ action: autoVerdict(full, 'Bash', row.command, ctx), finalized: finalizeNoLimits(full, 'Bash', row.command, ctx, { approve: null, source: 'unread-call' }), inputs: ctx }).toMatchSnapshot();
    });
  });
});
