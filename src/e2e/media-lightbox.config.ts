import { defineConfig } from "@playwright/test";
import { laneEvidenceDir } from "./lane-data-dir";
// MURAGE_E2E_DATA_DIR is required; evidence lands inside it (lane-data-dir.ts).
const out = laneEvidenceDir("media-lightbox-results");
export default defineConfig({ testDir: ".", testMatch: "media-lightbox.human.spec.ts", workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 7_000 }, reporter: "list",
  outputDir: out, use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
