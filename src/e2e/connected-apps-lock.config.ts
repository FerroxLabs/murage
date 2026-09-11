import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "connected-apps-lock.human.spec.ts", workers: 1, retries: 0, timeout: 60000, expect: { timeout: 8000 }, reporter: "list",
  outputDir: evidenceDir("connected-apps-lock", process.env.MURAGE_E2E_EVIDENCE_DIR), use: { headless: true, trace: "retain-on-failure" } });
