import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "onboarding-engine-step.human.spec.ts", workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 8_000 }, reporter: "list",
  outputDir: evidenceDir("onboarding-engine-step"),
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
