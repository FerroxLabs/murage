// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are reader inputs only; fixtures contain ordinary files and links.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoVerdict } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { collectProducer } from './no-limits-producers.ts';
import { newContext, simpleCommand } from './shell/walk.ts';
import { lex } from './shell/lex.ts';
import { inspectOwnerOperation } from './no-limits-inspection.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'murage-s5-')); roots.push(cwd);
  symlinkSync('/etc', join(cwd, 'h'));
  return cwd;
}
for (const [id, command] of [
  ['A1', 'tar -xf /tmp/a.tar -C /etc'],
  ['A2', 'tar -xPf /tmp/a.tar -C /etc ../etc/hosts'],
  ['A3', 'cd /nope; tar -xf a.tar -C /etc'],
  ['A4', 'ln -s -t /etc /tmp/blob'],
] as const) it(`S5 Full access still cards a real ${id} protected write`, () => {
  const context = { commandCwd: id === 'A4' ? fixture() : '/w', commandText: command,
    fullAccessOrigin: 'owner' as const, ownerStarted: true, outsideRead: null };
  expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path' });
  // OVERREACH #6: the owner's own Full access turn runs a protected-path write, as No limits does
  expect(autoVerdict({ autoApprove: true, fullAccess: true }, 'Bash', command, context).approve).toBeTruthy();
});
for (const command of [
  'tar -xf /tmp/a.tar -C "$dest"', 'unzip /tmp/a.zip -d "$dest"',
  'tar "$options" -f /tmp/a.tar -C /w', 'tar -xf /tmp/a.tar "$member"',
]) it(`S5 unknown archive values remain findings: ${command}`, () => {
  const result = inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd: '/w', cwdInvalid: false });
  expect(result.decisions.length).toBeGreaterThan(0);
});
it('S5 reading a protected archive cannot taint an ordinary sibling write', () => {
  const command = 'tar -xf /etc/archive.tar -C /w; printf x > /w/notes';
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd: '/w', cwdInvalid: false }).decisions).toEqual([]);
});
it('S5 an unknown archive input stays a read when the destination is known', () => {
  const result = inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: 'tar -xf "$archive" -C /w', cwd: '/w', cwdInvalid: false });
  expect(result.hazards.filter(hazard => hazard.role === 'archive-input')).toEqual([]);
  expect(result.decisions).toEqual([]);
});
it('S5 members are rooted at their positional extraction destination', () => {
  const command = 'tar -xPf /tmp/a.tar -C /w/sub ../../ordinary/hosts';
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd: '/etc', cwdInvalid: false }).decisions).toEqual([]);
});
it('S5 unknown cwd keeps named protected member suffixes', () => {
  const result = inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: 'tar -xf /tmp/a.tar hosts', cwdInvalid: false });
  expect(result.decisions).toContainEqual(expect.objectContaining({ reason: 'unknown-cwd-protected-suffix' }));
});
it('S5 target-directory link text taints a later write through the new link', () => {
  const cwd = fixture(); const out = join(cwd, 'out'); mkdirSync(out);
  const command = `ln -s -t ${out} /etc/hosts; printf x > ${out}/hosts`;
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd, cwdInvalid: false }).decisions.length).toBeGreaterThan(0);
  expect(noLimitsProtectedWrite(command, { commandCwd: cwd })).toMatchObject({ rule: 'protected-path' });
});

it('S5 an implicit unknown extraction root is not a global producer dependency', () => {
  const walk = newContext();
  const args = lex('-xf /tmp/a.tar').filter(token => token.kind === 'word').map(token => token.word);
  const operation = collectProducer('archive', simpleCommand('tar', args, walk), {}, walk)!;
  expect(operation.unknownDestination).toBe(false);
  expect(operation.destinationRoots.every(root => root.path !== undefined)).toBe(true);
});

for (const protectedTail of [true, false]) it(`S5 member climbs retain the physical extraction root, protected=${protectedTail}`, () => {
  const cwd = fixture(); mkdirSync(join(cwd, 'a/b'), { recursive: true }); mkdirSync(join(cwd, 'physical'));
  // The scratch root may be nested below /work; three climbs must still reach /etc.
  symlinkSync('/tmp', join(cwd, 'a/b/root'));
  const command = `tar -xPf /tmp/a.tar -C ${cwd}/a/b/root ../../../${protectedTail ? 'etc' : 'ordinary'}/hosts`;
  const result = inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd, cwdInvalid: false });
  expect(result.decisions.length > 0).toBe(protectedTail);
  expect(!!noLimitsProtectedWrite(command, { commandCwd: cwd })).toBe(protectedTail);
});
it('S5 relative unzip roots are known when cwd is known', () => {
  const command = 'unzip /tmp/a.zip -d out ../ordinary/notes';
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd: '/w', cwdInvalid: false }).decisions).toEqual([]);
});

for (const protectedTail of [true, false]) it(`S5 member climbs retain links inside the member path, protected=${protectedTail}`, () => {
  const cwd = fixture(); symlinkSync('/tmp', join(cwd, 'jump'));
  const command = `tar -xPf /tmp/a.tar -C ${cwd} jump/../${protectedTail ? 'etc' : 'ordinary'}/hosts`;
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd, cwdInvalid: false }).decisions.length > 0).toBe(protectedTail);
  expect(!!noLimitsProtectedWrite(command, { commandCwd: cwd })).toBe(protectedTail);
});
it('S5 member climbs do not hide exhausted links', () => {
  const cwd = fixture(); symlinkSync('loop', join(cwd, 'loop'));
  const command = `tar -xPf /tmp/a.tar -C ${cwd} loop/../notes`;
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd, cwdInvalid: false }).decisions.length).toBeGreaterThan(0);
  expect(noLimitsProtectedWrite(command, { commandCwd: cwd })).toMatchObject({ rule: 'protected-path' });
});

it('S5 legacy fallback normalizes a member climb out of a protected prefix', () => {
  const command = 'tar -xPf /tmp/a.tar /etc/../ordinary/notes';
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd: '/w', cwdInvalid: false }).decisions).toEqual([]);
  expect(noLimitsProtectedWrite(command, { commandCwd: '/w' })).toBeNull();
});
it('S5 a dangling member link before a climb retains its uncertainty', () => {
  const cwd = fixture(); symlinkSync('/etc/murage-s5-absent', join(cwd, 'jump'));
  const command = `tar -xPf /tmp/a.tar -C ${cwd} jump/../hosts`;
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd, cwdInvalid: false }).decisions.length).toBeGreaterThan(0);
  expect(noLimitsProtectedWrite(command, { commandCwd: cwd })).toMatchObject({ rule: 'protected-path' });
});

it('S5 absolute member retains a prior producer dependency before its climb', () => {
  const cwd = fixture(); mkdirSync(join(cwd, 'a/b'), { recursive: true });
  mkdirSync(join(cwd, 'physical')); mkdirSync(join(cwd, 'extract'));
  const command = `ln -s ${cwd}/physical ${cwd}/a/b/jump; tar -xPf /tmp/a.tar -C ${cwd}/extract ${cwd}/a/b/jump/../../../etc/hosts`;
  const result = inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd, cwdInvalid: false });
  expect(result.hazards).toContainEqual(expect.objectContaining({ cause: 'producer-dependency' }));
  expect(result.decisions.length).toBeGreaterThan(0);
  expect(noLimitsProtectedWrite(command, { commandCwd: cwd })).toMatchObject({ rule: 'protected-path' });
});
it('S5 ordinary member climbs without a producer retain their lexical destination', () => {
  const cwd = fixture(); mkdirSync(join(cwd, 'a/b'), { recursive: true }); mkdirSync(join(cwd, 'extract'));
  const command = `tar -xPf /tmp/a.tar -C ${cwd}/extract ${cwd}/a/b/jump/../../../ordinary/notes`;
  expect(inspectOwnerOperation({ kind: 'exec', dialect: 'sh', text: command, cwd, cwdInvalid: false }).decisions).toEqual([]);
  expect(noLimitsProtectedWrite(command, { commandCwd: cwd })).toBeNull();
});
