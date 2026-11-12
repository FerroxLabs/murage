// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from '@playwright/test';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceDir } from "./evidence";
const workOutput = evidenceDir("pullback-layers", join(mkdtempSync(join(tmpdir(), "murage-pullback-evidence-")), "results"));
// Validate the explicitly named retained directory through the shared lane guard.
// The runner copies evidence there on exit; workers never copy.
const retained = evidenceDir("pullback-layers");
if (process.env.TEST_WORKER_INDEX === undefined) {
  process.on("exit", () => { try { if (existsSync(workOutput)) cpSync(workOutput, retained, { recursive: true }); } catch (error) { console.error("pullback-layers: evidence copy failed", error); } });
}
// Touch input prevents pointer/hover idle prefetch from warming cold chunk cases.
// No shared ports, environment data directory, or reuseExistingServer.
export default defineConfig({
  testDir: '.', testMatch: 'pullback-layers.human.spec.ts', workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 }, reporter: 'list',
  // A fresh OS temp evidence dir every run (no shared output); a human spec reads MURAGE_E2E_DATA_DIR only through lane-data-dir.ts, never here.
  outputDir: workOutput,
  use: { browserName: 'chromium', headless: true, hasTouch: true, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
});
