// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".",
  testMatch: ["project-board.human.spec.ts"],
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  outputDir: evidenceDir("project-board"),
  reporter: [["list"]],
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
