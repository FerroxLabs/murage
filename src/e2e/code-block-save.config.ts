import { defineConfig } from "@playwright/test";
import { join } from "node:path";
// MURAGE_E2E_DATA_DIR keeps a lane's artifacts out of the shared tree.
const out = process.env.MURAGE_E2E_DATA_DIR ? join(process.env.MURAGE_E2E_DATA_DIR, "code-block-save-results") : "../../.planning/code-block-save-results";
export default defineConfig({ testDir: ".", testMatch: "code-block-save.human.spec.ts", workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 7_000 }, reporter: "list",
  outputDir: out, use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
