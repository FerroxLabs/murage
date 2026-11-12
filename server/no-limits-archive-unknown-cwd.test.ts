// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { describeOwnerNoLimits as describeAction } from './decision/action.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

// A relative destination needs a known cwd before it can name a system path.
// These commands are reader inputs only; no archive or filesystem write runs.
it.each([
  'unzip /tmp/a.zip -d etc',
  'tar -cf etc/a.tar /etc/hosts',
  'tar -tf /tmp/a.tar --index-file=etc/list',
])('relative archive output keeps the same meaning in both readers: %s', command => {
  for (const [cwd, held] of [[undefined, false], ['/w', false], ['/', true]] as const) {
    const action = describeAction({ tool: 'Bash', input: { command, ...(cwd ? { cwd } : {}) } } as Parameters<typeof describeAction>[0]);
    expect(protectedEvidence(action).length > 0, `S1 cwd=${cwd}`).toBe(held);
    expect(!!noLimitsProtectedWrite(command, { commandCwd: cwd }), `compatibility cwd=${cwd}`).toBe(held);
  }
});

// MAIN r2 H1/r2.1: owner evidence is authoritative; legacy protectedEvidence stays Full access.
import { ownerNlProtectedEvidence } from './no-limits-authority.ts';
const protectedEvidence=(action:ReturnType<typeof describeAction>)=>ownerNlProtectedEvidence(action.ownerAuthority);
