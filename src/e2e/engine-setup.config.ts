import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "engine-setup.human.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 5_000 }, reporter: "list",
  outputDir: "../../.planning/next-programme/engine-setup-browser-results",
  use: { headless: true, trace: "retain-on-failure" },
});
