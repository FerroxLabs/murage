import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
// Evidence never lands in the checkout (CLAC3): lane runs set MURAGE_E2E_DATA_DIR.
export default defineConfig({ testDir: ".", testMatch: "auto-consent.human.spec.ts", workers: 1, retries: 0, timeout: 45_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: evidenceDir("auto-consent"), use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
