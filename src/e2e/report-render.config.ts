import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "report-render.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, reporter: "list", outputDir: "../../.planning/report-render-evidence",
  use: { headless: true, trace: "retain-on-failure" } });
