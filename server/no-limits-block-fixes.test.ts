// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoVerdict } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

const bot = { id: 'block-fixture', autoApprove: true, fullAccess: true, noLimits: true };
const owner = { fullAccessOrigin: 'owner' as const, ownerStarted: true, outsideRead: null };
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'murage-block-policy-'));
  fixtures.push(cwd);
  return cwd;
}
function denied(command: string, cwd: string) {
  const context = { ...owner, commandCwd: cwd, commandText: command };
  expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path', classification: 'deny' });
  expect(autoVerdict(bot, 'Bash', command, context)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
}
function runs(command: string, cwd: string) {
  const context = { ...owner, commandCwd: cwd, commandText: command };
  expect(noLimitsProtectedWrite(command, context)).toBeNull();
  expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
}

describe('No limits review BLOCK reproductions', () => {
  it.each([
    `python3 -c 'import cffi; cffi.FFI().dlopen(None)'`,
    `node -e 'require("ffi-napi")'`,
    `ruby -e 'require "fiddle"; Fiddle.dlopen(nil)'`,
  ])('BLOCK-1 native tooling without a protected write runs: %s', command => runs(command, fixture()));
  it('BLOCK-1 native syscall with a protected write remains denied', () => {
    denied(`python3 -c 'import ctypes; ctypes.CDLL(None).syscall(87, b"/etc/passwd")'`, fixture());
  });
  it('BLOCK-2 relative cd changes directory once', () => {
    const cwd = fixture();
    mkdirSync(join(cwd, 'sub'));
    symlinkSync('/etc/hosts', join(cwd, 'sub/h'));
    denied('cd sub && printf x > h', cwd);
  });
  it.each(['ln -s /tmp/blob ./etc-link', 'ln --symbolic /tmp/blob ./etc-link'])('BLOCK-3 directory symlink destination is followed: %s', command => {
    const cwd = fixture();
    symlinkSync('/etc', join(cwd, 'etc-link'));
    denied(command, cwd);
  });
  it('BLOCK-3 explicit no-target-directory replaces the link itself', () => {
    const cwd = fixture();
    symlinkSync('/etc', join(cwd, 'etc-link'));
    runs('ln -sfT /tmp/blob ./etc-link', cwd);
  });
  it.each(['-t /tmp', '-t/tmp', '--target-directory /tmp', '--target-directory=/tmp'])(
    'BLOCK-4 target-directory keeps protected source text as data: %s', option => runs(`ln -s ${option} /etc/hosts`, fixture()));
  it.each([9, 41])('BLOCK-5 %s dangling link substitutions cannot lose a protected target', count => {
    const cwd = fixture();
    for (let i = 0; i < count; i++) symlinkSync(i === count - 1 ? '/etc/murage-fixture-absent' : `h${i + 1}`, join(cwd, `h${i}`));
    denied('printf x > h0', cwd);
  });
  it('BLOCK-5 ordinary dangling chains still run within the resolution budget', () => {
    const cwd = fixture();
    for (let i = 0; i < 9; i++) symlinkSync(i === 8 ? join(cwd, 'out') : `h${i + 1}`, join(cwd, `h${i}`));
    runs('printf x > h0', cwd);
  });
  it('BLOCK-6 pending relative link text is based at LINK parent', () => {
    const cwd = fixture();
    // This shell text is inspected only; no /tmp/h or protected target is written.
    denied('ln -s ../etc/hosts /tmp/h; printf x > /tmp/h', cwd);
  });
  it('BLOCK-6 pending relative link uses a resolved LINK parent', () => {
    const cwd = fixture();
    symlinkSync('/tmp', join(cwd, 'tmp-link'));
    denied('ln -s ../etc/hosts ./tmp-link/h; printf x > ./tmp-link/h', cwd);
  });
  it('BLOCK-6 relative source is not based at command cwd', () => {
    const cwd = fixture();
    runs(`ln -s ../out ${cwd}/h; printf x > ${cwd}/h`, '/etc');
  });
});
