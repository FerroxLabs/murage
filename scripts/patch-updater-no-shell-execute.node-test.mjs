import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { patchUpdaterNoShellExecute } from './patch-updater-no-shell-execute.mjs';

test('the vendor patch is named in the bundle and wired after other build patches', () => {
  const vendor = readFileSync(new URL('../electron/vendor/electron-updater.cjs', import.meta.url), 'utf8');
  assert.match(vendor.split('\n')[0], /electron\/vendor\/patches\/electron-updater-no-shell-execute.patch/);
  assert.match(readFileSync(new URL('./bundle-updater.mjs', import.meta.url), 'utf8'), /patchUpdaterNoShellExecute\(patchUpdaterWindowsHide\(withQuitCauses\)\)/);
  assert.doesNotMatch(vendor, /shell\.openPath\(installerPath\)/);
  // Never silently accept an unrecognized bundle or apply the patch twice.
  assert.throws(() => patchUpdaterNoShellExecute('upstream changed'), /installer launch changed/);
  assert.throws(() => patchUpdaterNoShellExecute(vendor), /installer launch changed/);
});
