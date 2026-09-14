import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".",
  testMatch: "b17-health.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: evidenceDir("b17-health", process.env.B17_HEALTH_EVIDENCE_DIR),
  use: { headless: true, trace: "retain-on-failure" },
});
