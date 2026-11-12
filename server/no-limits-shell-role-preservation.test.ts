// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { readExecutableOwnerNl as readExecutable } from './no-limits-code.ts';
import { describeOwnerNoLimits as describeAction } from './decision/action.ts';
it.each(['rm -rf /*', 'rm -rf /etc/*', 'rm -rf "$HOME"/*'])('preserves existing destructive operand evidence: %s', command => {
  expect(readExecutable('sh', command).classes.length).toBeGreaterThan(0);
});
it.each(['rm -rf ./out/*', 'echo "rm -rf /*"'])('keeps ordinary and quoted data operands running: %s', command => {
  expect(readExecutable('sh', command).classes).toEqual([]);
});

it.each([
  ['set --; tar -tf /tmp/a > /etc/list', '/w', true],
  ['set --; unzip -t /tmp/a.zip > /etc/list', '/w', true],
  ['set --; tar -tf /tmp/a > ./list', '/w', false],
  ['set --; env -C /w tar -tf /tmp/a > ./list', '/etc', true],
  ['set --; env -C /etc echo x > ./list', '/w', false],
  ['cd /etc > ./list', '/w', false],
  ['set --; cd "$dest"; tar -xf /tmp/a', '/etc', true],
  ['set --; cd "$dest"; tar -xf /tmp/a', '/w', false],
  ['set --; echo "$(cd /etc)" "$(tar -xf /tmp/a)"', '/w', false],
  ['set --; echo "$(cd /etc; tar -xf /tmp/a)"', '/w', true],
  ["set --; env -C /etc bash <<'EOF'\ntar -xf /tmp/a\nEOF", '/w', true],
  ["set --; env -C ./out bash <<'EOF'\ntar -xf /tmp/a\nEOF", '/w', false],
] as const)('keeps redirect and nested cwd semantics: %s', (command, cwd, held) => {
  expect(protectedEvidence(describeAction({ tool: 'Bash', input: { command, cwd } })).length > 0).toBe(held);
});
it('resolves a bound archive listing mode before classifying device writes', () => {
  expect(readExecutable('sh', 'mode=-tf; tar "$mode" /dev/sda', undefined, 0, '/w').classes).toEqual([]);
});
it('preserves the existing disk class for an actual archive device output', () => {
  expect(readExecutable('sh', 'mode=-cf; tar "$mode" /dev/sda ./input', undefined, 0, '/w').classes).toContain('disk');
});
it('treats a commented fork example as data', () => {
  expect(readExecutable('sh', '# :(){ :|:& };:').classes).toEqual([]);
});
it('retains executable ANSI-quoted colon fork evidence', () => {
  expect(readExecutable('sh', String.raw`$'\072'(){ $'\072'|$'\072'& };$'\072'`).classes).toContain('fork');
});

it('retains the existing NFKC colon fork spelling', () => {
  expect(readExecutable('sh', '：(){ ：|：& };：').classes).toContain('fork');
});

// MAIN r2 H1/r2.1: owner evidence is authoritative; legacy protectedEvidence stays Full access.
import { ownerNlProtectedEvidence } from './no-limits-authority.ts';
const protectedEvidence=(action:ReturnType<typeof describeAction>)=>ownerNlProtectedEvidence(action.ownerAuthority);
