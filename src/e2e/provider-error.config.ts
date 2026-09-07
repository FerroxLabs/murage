import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "provider-error.human.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: "list",
  outputDir: "../../.planning/next-programme/provider-error-browser-results",
  use: { headless: true, trace: "retain-on-failure" },
});
