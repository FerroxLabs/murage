import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".",
  testMatch: "b14-recovery.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: evidenceDir("b14-recovery"),
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
