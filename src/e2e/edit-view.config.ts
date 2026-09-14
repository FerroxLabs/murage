import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "edit-view.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 10000 }, reporter: "list",
  outputDir: evidenceDir("edit-view"),
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
