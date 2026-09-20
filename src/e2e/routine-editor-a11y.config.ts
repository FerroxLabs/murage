import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "routine-editor-a11y.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: evidenceDir("routine-editor-a11y"),
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
