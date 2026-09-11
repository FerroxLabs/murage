import { defineConfig } from "@playwright/test";
import { laneEvidenceDir } from "./lane-data-dir";
// IMGSET1: Settings → Tools & Connections → Image generation against a real
// isolated harness. MURAGE_E2E_DATA_DIR is required (the spec refuses ~/.murage),
// and the config refuses too: its old fallback wrote results under .planning/
// inside the repository (CLAC2).
const out = laneEvidenceDir("image-settings-capability-results", "image settings browser evidence is never written inside the repository");
export default defineConfig({ testDir: ".", testMatch: "image-settings-capability.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: "list",
  outputDir: out, use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
