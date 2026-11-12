// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoVerdict, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const owner: AutoContext = { fullAccessOrigin: 'owner', ownerStarted: true, commandCwd: '/w', outsideRead: null };
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directoryLink() {
  const cwd = mkdtempSync(join(tmpdir(), 'murage-review-link-'));
  fixtures.push(cwd);
  // Only an isolated link is created; no command or protected write is executed.
  symlinkSync('/etc', join(cwd, 'h'));
  return cwd;
}

describe('BLOCK 1: symbolic links into existing directories', () => {
  // G-NL SYMLINK RULING (MAIN 2026-11-11 10:45Z): writes THROUGH a
  // directory link are protected; -n/-T replace only the unprotected link.
  it.each(['ln -sf /tmp/blob ./h', 'ln --symbolic --force /tmp/blob ./h', 'ln -sf /tmp/blob ./h/',
    'ln -s /etc ./d; ln -sf /tmp/blob ./d'])('denies a directory write-through: %s', command => {
    const context = { ...owner, commandCwd: directoryLink(), commandText: command };
    expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path' });
    expect(autoVerdict(bot, 'Bash', command, context)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
  });
  it.each(['ln -sfn /tmp/blob ./h', 'ln -sfT /tmp/blob ./h',
    'ln -sf --no-dereference /tmp/blob ./h', 'ln -sf --no-target-directory /tmp/blob ./h'])(
    'allows replacement of the local link: %s', command => {
      const context = { ...owner, commandCwd: directoryLink(), commandText: command };
      expect(noLimitsProtectedWrite(command, context)).toBeNull();
      expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
    });
});
