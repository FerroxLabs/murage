// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits } from './auto-approve.ts';
import { describeOwnerNoLimits as describeAction } from './decision/action.ts';
import { archiveWrites } from './no-limits-archives.ts';
import { segmentRows, archiveMatrix } from './testing/no-limits-archive-design-cases.ts';

for (const [command, held] of segmentRows) {
  it(`S1 protected=${held}: ${command}`, () => {
    expect(protectedEvidence(describeAction({ tool: 'Bash', input: { command, cwd: '/w' } })).length > 0).toBe(held);
  });
}
describe.each(archiveMatrix)('archive projection %s %j', (program, args, expected, cwd = '/w') => {
  it('retains exactly the write destinations', () => {
    const candidates = args.map(path => [{ kind: 'literal' as const, path, text: path }]);
    expect([...new Set(archiveWrites(program, args, candidates, cwd))].sort()).toEqual([...new Set(expected)].sort());
  });
});
const fullRows = [...segmentRows.map(([command]) => command), ...archiveMatrix.map(([program, args]) => [program, ...args].join(' '))];
describe.each(fullRows)('Full access %s', command => {
  it('keeps the baseline verdict bytes', () => {
    const context = { fullAccessOrigin: 'owner' as const, ownerStarted: true, outsideRead: null, commandCwd: '/w', commandText: command };
    const full = { autoApprove: true, fullAccess: true, noLimits: false };
    expect({ command, cwd: context.commandCwd, verdict: autoVerdict(full, 'Bash', command, context), finalized: finalizeNoLimits(full, 'Bash', command, context, { approve: null, source: 'unread-call' }) }).toMatchSnapshot();
  });
});

// MAIN r2 H1/r2.1: owner evidence is authoritative; legacy protectedEvidence stays Full access.
import { ownerNlProtectedEvidence } from './no-limits-authority.ts';
const protectedEvidence=(action:ReturnType<typeof describeAction>)=>ownerNlProtectedEvidence(action.ownerAuthority);
