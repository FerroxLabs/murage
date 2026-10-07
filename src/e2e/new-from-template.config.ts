import { defineConfig, devices } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "new-from-template.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 8000 }, reporter: "list",
  outputDir: evidenceDir("new-from-template"),
  use: { headless: true, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 440, height: 956 }, hasTouch: true, deviceScaleFactor: 3 } },
  ],
});
