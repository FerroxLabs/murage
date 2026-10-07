// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "mcp-link.human.spec.ts", workers: 1, retries: 0,
  timeout: 120000, expect: { timeout: 10000 }, reporter: "list",
  outputDir: evidenceDir("mcp-link"),
  use: { headless: true, trace: "retain-on-failure" },
});
