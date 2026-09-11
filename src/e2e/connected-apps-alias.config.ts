import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "connected-apps-alias.human.spec.ts", workers: 1, retries: 0, timeout: 60000, expect: { timeout: 8000 }, reporter: "list",
  outputDir: evidenceDir("connected-apps-alias"), use: { headless: true, trace: "retain-on-failure" } });
