// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoVerdict } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

const bot = { id: 'symlink-fixture', autoApprove: true, fullAccess: true, noLimits: true };
const owner = { fullAccessOrigin: 'owner' as const, ownerStarted: true, outsideRead: null };
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'murage-symlink-policy-'));
  fixtures.push(cwd);
  return cwd;
}
function denied(command: string, cwd: string) {
  const context = { ...owner, commandCwd: cwd, commandText: command };
  expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path', classification: 'deny', reason: 'protected-path' });
  expect(autoVerdict(bot, 'Bash', command, context)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
}

// MAIN 2026-11-12 supersedes permission holds; the reader still reports protected targets.
// G-NL r3 ruling (MAIN 2026-11-11 13:13Z): protected link operands taint
// their own created name. Literal ordinary links still run.
describe('No limits symbolic link writes', () => {
  it.each(['ln -s /usr/bin/x ./y', 'ln -sf /etc/hosts ./hosts', 'ln -s /etc ./etc-link', 'ln --symbolic /etc ./etc-link'])(
    'protected source-only link taints its created name: %s', command => denied(command, fixture()));
  it.each(['ln -s ./plain ./y', 'ln -sf ./plain ./hosts', 'ln -s ./data ./etc-link', 'ln --symbolic ./data ./etc-link'])(
    'ordinary source-only twin runs: %s', command => {
      expect(autoVerdict(bot, 'Bash', command, { ...owner, commandCwd: fixture(), commandText: command }).approve).toBeTruthy();
    });
  it.each(['ln -s ./a /usr/y', 'ln -s -t /usr/bin ./x', 'ln -sf /tmp/blob /etc/x', 'ln /usr/bin/x ./y'])(
    'protected link or hard-link stays denied: %s', command => denied(command, fixture()));
  it.each([
    'ln -sf /etc/hosts ./h && echo x > ./h',
    'ln -sf /etc/hosts ./h; tee ./h',
    'ln -s /etc ./etc-link; tee ./etc-link/murage-fixture-absent',
  ])('same-command write-through stays denied: %s', command => denied(command, fixture()));
  it.each(['echo x > ./h', 'tee ./h', 'cp ./blob ./h'])(
    'later-command write-through stays denied: %s', command => {
      const cwd = fixture();
      // Only this fixture link is created. The protected target is never written.
      symlinkSync('/etc/hosts', join(cwd, 'h'));
      denied(command, cwd);
    });
  it('resolves a linked parent even when the write target does not exist', () => {
    const cwd = fixture();
    symlinkSync('/etc', join(cwd, 'etc-link'));
    denied('tee ./etc-link/murage-fixture-absent', cwd);
  });
  it('resolves a dangling link to a new protected file', () => {
    const cwd = fixture();
    symlinkSync('/etc/murage-fixture-absent', join(cwd, 'h'));
    denied('tee ./h', cwd);
  });
  it('ordinary writes through an unprotected link run', () => {
    const cwd = fixture();
    symlinkSync(join(cwd, 'output'), join(cwd, 'h'));
    const command = 'tee ./h';
    expect(noLimitsProtectedWrite(command, { ...owner, commandCwd: cwd })).toBeNull();
    expect(autoVerdict(bot, 'Bash', command, { ...owner, commandCwd: cwd, commandText: command }).approve).toBeTruthy();
  });
  it('resolves links before parent traversal', () => {
    const cwd = fixture();
    symlinkSync('/etc/cron.d', join(cwd, 'cron-link'));
    denied('tee ./cron-link/../hosts', cwd);
  });
  it('protected operands retain conservative taint on link replacement', () => {
    const cwd = fixture();
    symlinkSync('/etc/hosts', join(cwd, 'h'));
    const command = 'ln -sf /etc/hosts ./h';
    denied(command, cwd);
  });
});
