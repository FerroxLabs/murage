// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".",
  testMatch: "engine-commands.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: evidenceDir("engine-commands"),
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
