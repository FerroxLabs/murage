import { defineConfig } from "@playwright/test";
import { join } from "node:path";
// MURAGE_E2E_DATA_DIR keeps a lane's artifacts out of the shared tree.
const out = process.env.MURAGE_E2E_DATA_DIR ? join(process.env.MURAGE_E2E_DATA_DIR, "workspace-editor-results") : "../../.planning/workspace-editor-results";
export default defineConfig({
  testDir: ".", testMatch: "workspace-editor.human.spec.ts", workers: 1, retries: 0,
  // One real harness, restarted once mid-run, drives every test in order.
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: "list", outputDir: out,
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
