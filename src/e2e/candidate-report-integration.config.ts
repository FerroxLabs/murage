import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "candidate-report-integration.human.spec.ts", workers: 1, retries: 0,
  timeout: 90000, reporter: "list", outputDir: "../../.planning/candidate-report-integration-evidence",
  use: { headless: true, trace: "retain-on-failure" } });
