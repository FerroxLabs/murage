import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "connected-apps-alias.human.spec.ts", workers: 1, retries: 0, timeout: 60000, expect: { timeout: 8000 }, reporter: "list",
  outputDir: "../../.planning/0152-L15/connected-apps-alias-results", use: { headless: true, trace: "retain-on-failure" } });
