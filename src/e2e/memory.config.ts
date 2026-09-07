import { defineConfig, devices } from "@playwright/test";

// Each project starts its own fake-provider server and actual UI in the spec.
// No port reuse, shared scratch reset, production URL or retry is permitted.
export default defineConfig({
  testDir: ".",
  testMatch: "memory.human.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: "list",
  outputDir: "../../.planning/memory-evidence/p08-browser-results",
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 1 } },
  ],
});
