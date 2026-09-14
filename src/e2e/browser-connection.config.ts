import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "browser-connection.human.spec.ts", workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 }, reporter: "list", outputDir: evidenceDir("browser-connection"),
  use: { headless: true, trace: "retain-on-failure" } });
