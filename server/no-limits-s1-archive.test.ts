// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { readExecutableOwnerNl as readExecutable } from './no-limits-code.ts';
import { ReaderBudget } from './no-limits-budget.ts';
import { describeOwnerNoLimits as describeAction, canonicalPath } from './decision/action.ts';

// These are reader inputs only. No archive is opened and no command is executed.
import { rows } from './testing/no-limits-archive-cases.ts';

describe('S1 archive modes share compatibility classifications', () => {
  it.each(rows)('%s (protected write: %s)', (command, held, cwd = '/w') => {
    const compatibility = noLimitsProtectedWrite(command, { commandCwd: cwd });
    const read = readExecutable('sh', command, new ReaderBudget(), 0, cwd);
    const s1 = protectedEvidence(describeAction({ tool: 'Bash', input: { command, cwd } } as Parameters<typeof describeAction>[0]));
    const context = { commandCwd: cwd, commandText: command, fullAccessOrigin: 'owner' as const, ownerStarted: true, outsideRead: null };
    const verdict = autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, 'Bash', command, context);
    expect(verdict.approve, 'Sean 2026-11-12: protected archive writes are not wipes').toBeTruthy();
    expect(!!compatibility, 'compatibility mode twin').toBe(held);
    expect(!!s1.length, 'S1 mode twin').toBe(held);
    expect(!!s1.length, 'reader decision parity').toBe(!!compatibility);
    expect(read.classes, 'archive writes are deny evidence, not wipes').toEqual([]);
  });
});

it.each([
  'tar -tf /tmp/a.tar > /etc/list',
  'unzip -p /tmp/a.zip > /etc/output',
  "'tar' -xf /tmp/a.tar -C /etc",
])('S1 retains archive redirects and quoted executable names: %s', command => {
  const read = readExecutable('sh', command, new ReaderBudget(), 0, '/w');
  expect(read.targets.some(target => target.op === 'write' && /^\/etc(?:\/|$)/.test(canonicalPath(target.path, '/w')))).toBe(true);
});

it.each([
  ['tar -xf /tmp/a.tar', false],
  ['unzip /tmp/a.zip', false],
  ['tar -xf /tmp/a.tar -C ordinary', false],
  ['tar -xf /tmp/a.tar -C /etc', true],
  ['tar -xPf /tmp/a.tar /etc/hosts', true],
])('unknown cwd does not invent an extraction root: %s', (command, held) => {
  const action = describeAction({ tool: 'Bash', input: { command } } as Parameters<typeof describeAction>[0]);
  expect(protectedEvidence(action).length > 0).toBe(held);
  expect(!!noLimitsProtectedWrite(command)).toBe(held);
});

// MAIN r2 H1/r2.1: owner evidence is authoritative; legacy protectedEvidence stays Full access.
import { ownerNlProtectedEvidence } from './no-limits-authority.ts';
const protectedEvidence=(action:ReturnType<typeof describeAction>)=>ownerNlProtectedEvidence(action.ownerAuthority);
