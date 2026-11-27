// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture producer and native-preflight consumer owner: c4-misc-b.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { removeTempDir } from '../../server/testing/cleanup.ts';
import { copyLoaderModules } from './loader-fixture.test-helper.mjs';

it('loader fixture preserves direct and transitive runtime modules before native setup', async () => {
  const work=mkdtempSync(join(tmpdir(),'smooth-loader-closure-'));
  try {
    copyLoaderModules(work,'server/engine-exclusion.ts');
    for(const name of ['server/engine-exclusion.ts','server/windows-code-integrity.ts','server/meter-copy-cleanup.ts','server/data-dir-lease.ts','electron/data-dir-lease.mjs']) {
      expect(existsSync(join(work,name)),name).toBe(true);
      expect(readFileSync(join(work,name))).toEqual(readFileSync(resolve(name)));
    }
    expect(existsSync(join(work,'server/engine-plan-core.ts'))).toBe(false);
  } finally { await removeTempDir(work); }
});
