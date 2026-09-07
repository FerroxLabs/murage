import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "search-settings.human.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: "list",
  outputDir: "../../.planning/next-programme/search-settings-browser-results",
  use: { headless: true, trace: "retain-on-failure" },
});
