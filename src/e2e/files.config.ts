import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "files.human.spec.ts", workers: 1, retries: 0, timeout: 45_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: "../../.planning/0149-files-browser-results", use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
