import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../src/e2e",
  testMatch: ["http-send.human.spec.ts", "onboarding-save.human.spec.ts", "surface-recovery.human.spec.ts", "desktop-capabilities.human.spec.ts"],
  workers: 2,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: "isolated-browser-results",
  use: { headless: true, trace: "retain-on-failure" },
});
