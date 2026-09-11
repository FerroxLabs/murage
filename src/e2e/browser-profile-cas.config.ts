import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "browser-profile-cas.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 10000 }, reporter: "list", outputDir: evidenceDir("browser-profile-cas"),
  use: { headless: true, trace: "retain-on-failure" } });
