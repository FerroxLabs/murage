// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { segmentDesignRows } from './testing/no-limits-segment-design-cases.ts';
import { newContext, walkScript } from './shell/walk.ts';
import { ownerMarks, withoutDoubts } from './shell/marks.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { Unreadable } from './shell/lex.ts';
it('DIFF-WALK: every readable protected design row is at least as strict as shared write roles', () => {
  let compared = 0;
  for (const row of segmentDesignRows) {
    if (!row.protect) continue;
    const command = row.command.replace(/^if;\s*/, '');
    try { ownerMarks(() => withoutDoubts(() => walkScript(command, newContext('/work'), { command: () => null, redirect: () => null, forkBomb: () => null }))); }
    catch (e) { if (e instanceof Unreadable) continue; throw e; }
    expect(noLimitsProtectedWrite(command, { commandCwd: '/work' }, undefined, true), command).toMatchObject({ rule: 'protected-path' });
    compared++;
  }
  expect(compared).toBeGreaterThan(10);
});

// Full access twins of the readable (no fallback-trigger) forms. Captured by
// restoring 3b6e50f868's product files in an isolated scratch tree.
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
describe.each(['owner', 'routine'] as const)('readable forms Full access: %s', origin => {
  it.each(segmentDesignRows)('$id Full access snapshot', row => {
    const command = row.command.replace(/^if;\s*/, '');
    const ctx: AutoContext = { fullAccessOrigin: origin, ownerStarted: origin === 'owner', outsideRead: null, commandCwd: '/work', commandText: command, ...(origin === 'routine' ? { routineLevel: true } : {}) };
    const full = { autoApprove: true, fullAccess: true, noLimits: false };
    expect({ action: autoVerdict(full, 'Bash', command, ctx), finalized: finalizeNoLimits(full, 'Bash', command, ctx, { approve: null, source: 'unread-call' }), inputs: ctx }).toMatchSnapshot();
  });
});
