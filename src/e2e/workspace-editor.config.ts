import { defineConfig } from "@playwright/test";
import { laneEvidenceDir } from "./lane-data-dir";
// MURAGE_E2E_DATA_DIR is required; evidence lands inside it (lane-data-dir.ts).
const out = laneEvidenceDir("workspace-editor-results");
export default defineConfig({
  testDir: ".", testMatch: "workspace-editor.human.spec.ts", workers: 1, retries: 0,
  // One real harness, restarted once mid-run, drives every test in order.
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: "list", outputDir: out,
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
