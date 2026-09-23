import { defineConfig, devices } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "thread-paging.human.spec.ts", workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: evidenceDir("thread-paging"),
  use: { ...devices["Desktop Chrome"], headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
