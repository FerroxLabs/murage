import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { evidenceDir, evidenceRoot } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "routine-watch-picker.human.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: [["list"], ["json", { outputFile: process.env.MURAGE_WATCH_UI_REPORT || join(evidenceRoot("routine-watch-picker"), "routine-watch-picker-report.json") }]],
  outputDir: evidenceDir("routine-watch-picker", process.env.MURAGE_WATCH_UI_OUTPUT), use: { headless: true, trace: "retain-on-failure" } });
