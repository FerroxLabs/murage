// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "image-approval-setting.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: evidenceDir("image-approval-setting"),
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
