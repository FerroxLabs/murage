import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "report-render.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, reporter: "list", outputDir: evidenceDir("report-render"),
  use: { headless: true, trace: "retain-on-failure" } });
