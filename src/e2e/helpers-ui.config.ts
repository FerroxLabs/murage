// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "helpers-ui.human.spec.ts", workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 15_000 }, reporter: "list",
  outputDir: evidenceDir("helpers-ui"),
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
