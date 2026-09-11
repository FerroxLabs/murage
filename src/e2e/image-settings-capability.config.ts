import { defineConfig } from "@playwright/test";
import { join } from "node:path";
// IMGSET1: Settings → Tools & Connections → Image generation against a real
// isolated harness. MURAGE_E2E_DATA_DIR is required (the spec refuses ~/.murage).
const out = process.env.MURAGE_E2E_DATA_DIR ? join(process.env.MURAGE_E2E_DATA_DIR, "image-settings-capability-results") : "../../.planning/image-settings-capability-results";
export default defineConfig({ testDir: ".", testMatch: "image-settings-capability.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: "list",
  outputDir: out, use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
