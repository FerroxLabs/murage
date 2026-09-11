import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "candidate-report-integration.human.spec.ts", workers: 1, retries: 0,
  timeout: 90000, reporter: "list", outputDir: evidenceDir("candidate-report-integration"),
  use: { headless: true, trace: "retain-on-failure" } });
