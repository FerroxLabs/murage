// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader inputs only; no destructive command is executed.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noLimitsWipe } from './no-limits-wipe.ts';
import { physicalWipePath } from './wipe-path.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function scratch() { const root = mkdtempSync(join(tmpdir(), 'write-destination-')); roots.push(root); return root; }

it.each(['dd if=/dev/zero of=disk.img', 'truncate -s 0 output', 'shred -u output'])(
  'an absent ordinary write target is not a device: %s', command => {
    expect(noLimitsWipe(command, { cwd: scratch() })).toBeNull();
    expect(noLimitsWipe(command)).toBeNull();
  },
);
it('absence cannot cancel a later parent traversal or a followed device link', () => {
  const cwd = scratch();
  expect(() => physicalWipePath('missing/../disk.img', cwd, 'write')).toThrow();
  // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: missing traversal does not
  // turn this ordinary disk.img filename into a disk device.
  expect(noLimitsWipe('dd if=/dev/zero of=missing/../disk.img', { cwd })).toBeNull();
  symlinkSync('/dev/fixture-absent-disk', join(cwd, 'linked'));
  expect(() => physicalWipePath('linked', cwd, 'write')).toThrow();
  // MAIN RULING 1114-NOLIMITS-OLD-ORACLES point 1; SCOPE.md:36,43-46:
  // a dangling fictional /dev target is not established as a disk.
  expect(noLimitsWipe('dd if=/dev/zero of=linked', { cwd })).toBeNull();
});
it('an explicit device spelling still cards without a working directory', () => {
  expect(noLimitsWipe('dd if=/dev/zero of=/dev/sda')?.rule).toBe('disk-erase');
});
