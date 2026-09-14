import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "approval-alerts.human.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: "list", outputDir: evidenceDir("approval-alerts"),
  use: { headless: true, trace: "retain-on-failure" } });
