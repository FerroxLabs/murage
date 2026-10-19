import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "page-error-guard.fixture.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: "list", outputDir: evidenceDir("page-error-guard"),
  use: { headless: true } });
