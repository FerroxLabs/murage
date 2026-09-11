import { defineConfig } from "@playwright/test";
import { laneEvidenceDir } from "./lane-data-dir";

// MEMJSON1 real-app proof: the built renderer + the harness, the bundled
// Fuigo on Flux Auto through FluxRouter, ten text turns. MURAGE_E2E_DATA_DIR
// is required (never ~/.murage); evidence lands in MURAGE_SMOKE_EVIDENCE_DIR.
const out = laneEvidenceDir("memory-provenance-results", "this proof never uses ~/.murage");

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
