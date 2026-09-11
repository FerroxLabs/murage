import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "auto-consent.human.spec.ts", workers: 1, retries: 0, timeout: 45_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: "../../.planning/0152-auto-consent-browser-results", use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
