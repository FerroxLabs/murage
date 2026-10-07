// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "approval-card-long.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: evidenceDir("approval-card-long"),
  use: { browserName: (process.env.AC_BROWSER === "webkit" ? "webkit" : "chromium"), headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
