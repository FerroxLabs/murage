import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixPowerShellWipeGuard } from '../prefix.ts';
test('prefix quotes a path and preserves command bytes', () => {
  const command = '$x = "keep"; Get-ChildItem -Force | Remove-Item -Recurse -Force\n';
  assert.equal(prefixPowerShellWipeGuard(command, "C:\\fixture's files\\guard.ps1"),
    ". 'C:\\fixture''s files\\guard.ps1'; " + command);
});
