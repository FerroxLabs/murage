import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "routine-watch-picker.human.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: [["list"], ["json", { outputFile: process.env.MURAGE_WATCH_UI_REPORT ?? "../../.planning/watch-picker-r1.json" }]],
  outputDir: process.env.MURAGE_WATCH_UI_OUTPUT ?? "../../.planning/watch-picker-r1", use: { headless: true, trace: "retain-on-failure" } });
