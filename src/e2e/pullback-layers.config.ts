// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceDir } from "./evidence";
// Touch input prevents pointer/hover idle prefetch from warming cold chunk cases.
// No shared ports, environment data directory, or reuseExistingServer.
export default defineConfig({
  testDir: '.', testMatch: 'pullback-layers.human.spec.ts', workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 }, reporter: 'list',
  // A lane's MURAGE_E2E_DATA_DIR when set; otherwise a fresh OS temp evidence dir (no shared output).
  outputDir: evidenceDir('pullback-layers', process.env.MURAGE_E2E_DATA_DIR ? undefined : join(mkdtempSync(join(tmpdir(), 'murage-pullback-evidence-')), 'results')),
  use: { browserName: 'chromium', headless: true, hasTouch: true, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
});
