import { defineConfig } from "@playwright/test";
import { join } from "node:path";
// MURAGE_E2E_DATA_DIR keeps a lane's artifacts out of the shared tree.
const out = process.env.MURAGE_E2E_DATA_DIR ? join(process.env.MURAGE_E2E_DATA_DIR, "artifact-cards-results") : "../../.planning/artifact-cards-results";
export default defineConfig({ testDir: ".", testMatch: "artifact-cards.human.spec.ts", workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 7_000 }, reporter: "list",
  outputDir: out, use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
