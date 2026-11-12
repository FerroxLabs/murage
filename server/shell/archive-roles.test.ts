// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { archiveRoles, ARCHIVE_PROGRAMS } from './archive-roles.ts';
import { archiveMatrix } from '../testing/no-limits-archive-design-cases.ts';

describe.each(archiveMatrix)('archive roles %s %j', (program, args) => {
  it('recognizes each tool and keeps exact operand locations', () => {
    const roles = archiveRoles(program, args)!;
    expect(ARCHIVE_PROGRAMS.has(program)).toBe(true);
    expect(roles).toBeDefined();
    for (const slot of roles.slots) {
      if (slot.detail === 'flag') continue;
      expect(args[slot.arg]!.slice(slot.offset)).toBe(slot.value);
      if (slot.detail === 'member-out' && slot.root !== -1) expect(roles.slots[slot.root!]!.detail).toMatch(/extract-root|chdir-read/);
    }
  });
});
it('ignores commands outside the archive table', () => { expect(archiveRoles('echo', ['tar'])).toBeUndefined(); });
it('has one root for each positional member and keeps unused directories as reads', () => {
  const roles = archiveRoles('tar', ['-xf./a', '-C/etc', 'hosts', '-C/w', 'other'])!;
  const members = roles.slots.filter(slot => slot.detail === 'member-out');
  expect(members.map(slot => roles.slots[slot.root!]!.value)).toEqual(['/etc', '/w']);
  expect(archiveRoles('tar', ['-xf./a', '-C/etc', '-C/w'])!.slots.find(slot => slot.value === '/etc')!.role).toBe('read');
});
it.each(['tar', 'unzip', '7z'])('%s stdout-only suppresses filesystem extraction', tool => {
  const args = tool === 'tar' ? ['-xOf./a', '-C/etc'] : tool === 'unzip' ? ['-p', './a', '-d/etc'] : ['x', './a', '-so', '-o/etc'];
  const roles = archiveRoles(tool, args)!;
  expect(roles.stdoutOnly).toBe(true);
  expect(roles.slots.filter(slot => slot.role === 'write')).toEqual([]);
});
it('cpio supplies the implicit extraction cwd and treats patterns as values', () => {
  const roles = archiveRoles('cpio', ['-i', '/etc/pattern'])!;
  expect(roles.implicitCwdRoot).toBe(true);
  expect(roles.slots.find(slot => slot.value === '/etc/pattern')!.role).toBe('value');
});
it('every repeated volume is an output', () => {
  expect(archiveRoles('tar', ['-cMf/etc/first', '-f/w/second'])!.slots.filter(slot => slot.detail === 'archive-out').map(slot => slot.value)).toEqual(['/etc/first', '/w/second']);
});
it('tar create reads directories and sources but writes snapshot/index side outputs', () => {
  const roles = archiveRoles('tar', ['-cf./a', '-C/etc', 'hosts', '--listed-incremental=/etc/snapshot', '--index-file=/etc/index'])!;
  expect(roles.slots.filter(slot => slot.role === 'write').map(slot => slot.value)).toEqual(['./a', '/etc/snapshot', '/etc/index']);
});
it('unzip excludes patterns after -x and applies the final directory globally', () => {
  const roles = archiveRoles('unzip', ['./a', 'hosts', '-x', '/etc/excluded', '-d/w'])!;
  expect(roles.slots.filter(slot => slot.detail === 'member-out').map(slot => slot.value)).toEqual(['hosts']);
});
it('archive dash is a stream only in archive-file role', () => {
  expect(archiveRoles('tar', ['-cf-', '--index-file=-'])!.slots.filter(slot => slot.role === 'write').map(slot => slot.detail)).toEqual(['archive-out', 'side-out']);
});

it('unions GNU flag -s and BSD valued -s without losing following members', () => {
  const roles = archiveRoles('tar', ['-xf./a', '-s', 'pattern', '/etc/hosts'])!;
  expect(roles.slots.filter(slot => slot.detail === 'member-out').map(slot => slot.value)).toContain('/etc/hosts');
  expect(roles.slots.some(slot => slot.key === '-s' && slot.value === 'pattern')).toBe(true);
});
it('unions archive modes when an unreadable option word can select the mode', () => {
  const roles = archiveRoles('tar', [undefined, '-f/etc/a', '-C/etc'])!;
  expect(roles.modes).toEqual(expect.arrayContaining(['extract', 'create']));
  expect(roles.slots.some(slot => slot.detail === 'archive-out' && slot.value === '/etc/a')).toBe(true);
  expect(roles.slots.some(slot => slot.detail === 'extract-root' && slot.value === '/etc')).toBe(true);
});
it('limits stdout-only suppression to extraction, retaining create source removal', () => {
  const roles = archiveRoles('tar', ['-cOf./a', '--remove-files', '-C/etc', 'hosts'])!;
  expect(roles.stdoutOnly).toBe(false);
  expect(roles.slots.some(slot => slot.detail === 'member-out' && slot.role === 'write')).toBe(true);
});
it.each([
  ['tar', [undefined, '-t', '-C/etc'], 'extract-root', '/etc'],
  ['tar', ['-c', undefined, '/etc/a'], 'archive-out', '/etc/a'],
  ['cpio', [undefined, '-F/etc/a'], 'archive-out', '/etc/a'],
  ['cpio', [undefined, '/etc'], 'extract-root', '/etc'],
  ['7z', [undefined, '/etc/a'], 'archive-out', '/etc/a'],
  ['7z', ['a', undefined, '/etc/a'], 'archive-out', '/etc/a'],
] as const)('unions unknown option/command readings: %s %j', (program, args, detail, value) => {
  expect(archiveRoles(program, args)!.slots.some(slot => slot.detail === detail && slot.value === value && slot.role === 'write')).toBe(true);
});
it.each([
  ['tar', ['-f', undefined, '-t', '-C/etc']],
  ['tar', [undefined, '-O']],
  ['7z', ['h', undefined, '/etc']],
] as const)('does not invent writes from unknown read-only values: %s %j', (program, args) => {
  const roles = archiveRoles(program, args)!;
  expect(roles.slots.filter(slot => slot.role === 'write')).toEqual([]);
  expect(roles.implicitCwdRoot).toBe(false);
});
