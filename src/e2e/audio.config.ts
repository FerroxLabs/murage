import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "audio-intake.human.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: "list", outputDir: "../../.planning/N6-audio-browser",
  use: { headless: true, trace: "retain-on-failure" } });
