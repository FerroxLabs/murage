import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "sidebar-hit-areas.human.spec.ts", workers: 1, retries: 0, timeout: 60000, expect: { timeout: 5000 }, reporter: "list",
  outputDir: "../../.planning/0152-L15/sidebar-hit-areas-results", use: { headless: true, trace: "retain-on-failure" } });
