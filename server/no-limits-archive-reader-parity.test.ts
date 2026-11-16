// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import * as archives from './no-limits-archives.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { readExecutableOwnerNl as readExecutable } from './no-limits-code.ts';
import { ReaderBudget } from './no-limits-budget.ts';
import { canonicalPath } from './decision/action.ts';
import { rows } from './testing/no-limits-archive-cases.ts';

const classifier = vi.spyOn(archives, 'archiveWrites');
const normalized = (paths: string[], cwd: string) => [...new Set(paths.map(path => canonicalPath(path, cwd)))].sort();

describe('both production readers use one archive role classifier', () => {
  it.each(rows)('identical write classifications: %s', (command, _held, cwd = '/w') => {
    classifier.mockClear();
    noLimitsProtectedWrite(command, { commandCwd: cwd });
    const compatibility = classifier.mock.results.flatMap(result => result.type === 'return' ? result.value ?? [] : []);
    expect(classifier.mock.calls.length, 'compatibility must consult shared classifier').toBeGreaterThan(0);
    classifier.mockClear();
    const s1 = readExecutable('sh', command, new ReaderBudget(), 0, cwd);
    expect(classifier.mock.calls.length, 'S1 must consult shared classifier').toBeGreaterThan(0);
    expect(normalized(s1.targets.filter(target => target.op === 'write').map(target => target.path), cwd))
      .toEqual(normalized(compatibility, cwd));
  });
});

it('retains every volume and the unnormalized member destination', () => {
  const read = (command: string) => readExecutable('sh', command, new ReaderBudget(), 0, '/w').targets.filter(target => target.op === 'write').map(target => target.path);
  expect(read('tar -cM -f /etc/first.tar -f /w/second.tar /w/input')).toEqual(expect.arrayContaining(['/etc/first.tar', '/w/second.tar']));
  expect(read('tar -xPf /tmp/a.tar ../etc/hosts')).toContain('/w/../etc/hosts');
});
