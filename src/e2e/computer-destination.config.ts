import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "computer-destination.human.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 5_000 }, reporter: "list",
  outputDir: "../../.planning/next-programme/computer-destination-browser-results",
  use: { headless: true, trace: "retain-on-failure" },
});
