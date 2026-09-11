import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "connected-apps-lock.human.spec.ts", workers: 1, retries: 0, timeout: 60000, expect: { timeout: 8000 }, reporter: "list",
  outputDir: process.env.MURAGE_E2E_EVIDENCE_DIR ?? "../../.planning/0152-CTA1/connected-apps-lock-results", use: { headless: true, trace: "retain-on-failure" } });
