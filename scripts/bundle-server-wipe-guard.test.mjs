// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const source = readFileSync(new URL('./bundle-server.mjs', import.meta.url), 'utf8');
test('the package ships the executable shim tree, standalone callback and unchanged Node client', () => {
  expect(source).toContain('"wipe-guard/server.ts"');
  expect(source).toContain('const WIPE_GUARD_RUNTIME = ["wipe-guard/shim", "wipe-guard/client.mjs"]');
  // MAIN RULING 2026-11-14 SEAN 1114-WIPE-GATE-FOUR item 2: runtime assets must execute after packaging and relocation.
  expect(source).toContain('copyWipeGuardRuntime(join(server, file), target)');
  expect(source).toContain('copyFileSync(source, target)');
  expect(source).toContain('checkRuntimeSibling(join(target, name), 0o755)');
  expect(source).toContain('"server/env-path.ts"');
  expect(source).toContain('"server/drivers/murage-exec-wipe.ts"');
  expect(source).toContain('if (callback !== target) copyFileSync(callback, target)');
});

test('wipe mutation preflight loads and rejects a nonzero status with an all-green report', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'wipe-preflight-load-'));
  try {
    writeFileSync(join(directory, 'baseline.json'), JSON.stringify({ testResults: [{ assertionResults: [{ status: 'passed' }] }] }));
    // Use the mutation runner's native ESM loader. Vite consolidates duplicate
    // import bindings and would hide the syntax error from an in-process test.
    const program = `import { verifyPreflight } from ${JSON.stringify(new URL('../server/wipe/preflight.mjs', import.meta.url).href)};
      import assert from 'node:assert/strict';
      verifyPreflight(process.argv[1], 0);
      assert.throws(() => verifyPreflight(process.argv[1], 1));
      console.log('preflight loaded');`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', program, directory],
      { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim()).toBe('preflight loaded');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
