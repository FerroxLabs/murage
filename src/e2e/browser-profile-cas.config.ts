import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "browser-profile-cas.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 10000 }, reporter: "list", outputDir: "../../.planning/browser-profile-cas-browser",
  use: { headless: true, trace: "retain-on-failure" } });
