import { defineConfig } from "@playwright/test";
import { join } from "node:path";

// MEMJSON1 real-app proof: the built renderer + the harness, the bundled
// Fuigo on Flux Auto through FluxRouter, ten text turns. MURAGE_E2E_DATA_DIR
// is required (never ~/.murage); evidence lands in MURAGE_SMOKE_EVIDENCE_DIR.
const out = process.env.MURAGE_E2E_DATA_DIR
  ? join(process.env.MURAGE_E2E_DATA_DIR, "..", "memory-provenance-results")
  : "../../.planning/memory-provenance-results";

export default defineConfig({
  testDir: ".",
  testMatch: "memory-provenance-fuigo.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 1_200_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: out,
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
