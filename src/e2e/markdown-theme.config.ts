import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "markdown-theme.human.spec.ts", workers: 1, retries: 0,
  timeout: 45000, expect: { timeout: 10000 }, reporter: "list",
  outputDir: "../../.planning/markdown-theme-results", use: { headless: true, trace: "retain-on-failure" } });
