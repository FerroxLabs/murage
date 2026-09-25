// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "routine-approvals.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: evidenceDir("routine-approvals"),
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
