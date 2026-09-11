import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
// IMGSET1: Settings → Tools & Connections → Image generation against a real
// isolated harness. MURAGE_E2E_DATA_DIR is required (the spec refuses ~/.murage),
// and the config refuses too: its old fallback wrote results under .planning/
// inside the repository (CLAC2).
export default defineConfig({ testDir: ".", testMatch: "image-settings-capability.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: "list",
  outputDir: evidenceDir("image-settings-capability"), use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
