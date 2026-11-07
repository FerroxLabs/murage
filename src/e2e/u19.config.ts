import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "u19.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 10000 }, reporter: "list",
  outputDir: evidenceDir("u19"),
  use: { headless: true, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
});
