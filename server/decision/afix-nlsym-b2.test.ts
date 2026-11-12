// Sean 2026-11-12: protected file operands are permitted at No limits.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { d, fixture, baseRun } from './fixture.ts';

it.each(['-exec', '-execdir'])('H4 %s retains an ordinary plus before a protected operand', action => {
  const f = fixture();
  try {
    const handle = f.open('h4-red', { command: `find . -maxdepth 0 ${action} touch + ~/.ssh/config \\;`, cwd: '/tmp/afix-b2' });
    expect(d.decide(handle, baseRun).kind).toBe('run');
  } finally { f.dispose(); }
});

it.each(['find . -exec ls {} +', 'find . -exec touch + ./notes \\;'])('H4 ordinary twin RUN: %s', command => {
  const f = fixture();
  try {
    expect(d.decide(f.open('h4-run', { command, cwd: '/tmp/afix-b2' }), baseRun).kind).toBe('run');
  } finally { f.dispose(); }
});
