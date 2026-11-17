// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are inspection inputs only; gawk is never executed.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoVerdict } from './auto-approve.ts';
import { inspectNoLimits } from './no-limits-taint.ts';
import { commandRoles, writeSlots } from './shell/roles.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const options = (library: string) => [
  ['-i', library], [`-i${library}`], ['--include', library], [`--include=${library}`],
];
const writers = ['inplace', 'inplace.awk', './inplace', './inplace.awk', '/usr/share/awk/inplace', '/usr/share/awk/inplace.awk'];
const rows = writers.flatMap(library => options(library).flatMap(args => [false, true].map(protectedPath => ({ library, args, protectedPath }))));

it.each(rows)('A3 gawk library $library args=$args protected=$protectedPath', ({ args, protectedPath }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'nlsym-a3-gawk-'));
  roots.push(cwd);
  const path = protectedPath ? '/etc/passwd' : join(cwd, 'ordinary');
  if (!protectedPath) writeFileSync(path, 'fixture');
  const text = ['gawk', ...args, "'1'", path].join(' ');
  expect(writeSlots(commandRoles(['gawk', ...args, '1', path])).map(slot => slot.value)).toEqual([path]);
  expect(inspectNoLimits({ kind: 'exec', dialect: 'sh', text, cwd, cwdInvalid: false }).verdict).toBe(protectedPath ? 'hold' : 'run');
  const result = autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, 'Bash', text, {
    ownerStarted: true, fullAccessOrigin: 'owner', commandCwd: cwd, commandText: text, outsideRead: null,
  });
  // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: an in-place single-file write is not a wipe at authenticated No limits.
  if (protectedPath) expect(result).toEqual({approve:'auto-approved Bash (no limits)',source:'no-limits'});
  else expect(result.approve).toBeTruthy();
  // MAIN RULING NL-WIPE-ONLY-FIXTURES: keep the train's explicit source check for every non-wipe write.
  expect(result.source).toBe('no-limits');
});

it('A3 the same in-place write followed by a system-folder wipe still cards at No limits', () => {
  const text = "gawk -i inplace '1' /etc/passwd; rm -rf /etc";
  expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true}, 'Bash', text, {
    ownerStarted:true,fullAccessOrigin:'owner',commandCwd:'/tmp',commandText:text,outsideRead:null,
  })).toMatchObject({approve:null,source:'always-ask',rule:'delete-system-folder'});
});

it.each(['extension', 'extension.awk', './extension.awk', '/usr/share/awk/extension.awk', 'notinplace.awk', '/usr/share/inplace.awk/extension.awk'].flatMap(library => [options(library)[0]!, options(library)[3]!].map(args => ({ args }))))(
  'A3 other gawk library remains a protected read: $args', ({ args }) => {
    const path = '/etc/passwd';
    const text = ['gawk', ...args, "'1'", path].join(' ');
    expect(writeSlots(commandRoles(['gawk', ...args, '1', path]))).toEqual([]);
    expect(inspectNoLimits({ kind: 'exec', dialect: 'sh', text, cwd: '/tmp', cwdInvalid: false }).verdict).toBe('run');
    expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, 'Bash', text, {
      ownerStarted: true, fullAccessOrigin: 'owner', commandCwd: '/tmp', commandText: text, outsideRead: null,
    }).approve).toBeTruthy();
  },
);
