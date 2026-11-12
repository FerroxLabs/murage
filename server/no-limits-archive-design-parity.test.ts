// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import * as archives from './no-limits-archives.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { readExecutableOwnerNl as readExecutable } from './no-limits-code.ts';
import { canonicalPath } from './decision/action.ts';
import { archiveMatrix } from './testing/no-limits-archive-design-cases.ts';
const classifier = vi.spyOn(archives, 'archiveWrites');
it.each(archiveMatrix)('reader parity %s %j', (program, args, _paths, cwd = '/w') => {
  const command = [program, ...args].join(' ');
  classifier.mockClear();
  noLimitsProtectedWrite(command, { commandCwd: cwd });
  const legacy = classifier.mock.results.flatMap(result => result.type === 'return' ? result.value ?? [] : []);
  expect(classifier.mock.calls.length).toBeGreaterThan(0);
  const normalize = (paths: string[]) => [...new Set(paths.map(path => canonicalPath(path, cwd)))].sort();
  expect(normalize(readExecutable('sh', command, undefined, 0, cwd).targets.filter(target => target.op === 'write').map(target => target.path))).toEqual(normalize(legacy));
});
it('projects long positional root chains without losing the final protected root', () => {
  const args = ['-xf./a', ...Array.from({ length: 3000 }, () => '-C.'), '-C/etc'];
  const paths = archives.archiveWrites('tar', args, args.map(path => [{ kind: 'literal', path, text: path }]), '/w');
  expect(paths).toEqual(['/etc']);
});
