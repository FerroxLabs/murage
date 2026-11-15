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
