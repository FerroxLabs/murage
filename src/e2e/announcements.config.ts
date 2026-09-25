// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "announcements.human.spec.ts", workers: 1, retries: 0,
  timeout: 120000, expect: { timeout: 8000 }, reporter: "list",
  outputDir: evidenceDir("announcements"),
  use: { headless: true, trace: "retain-on-failure" },
});
