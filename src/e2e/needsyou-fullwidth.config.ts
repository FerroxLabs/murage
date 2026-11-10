import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
// Runs only needsyou-fullwidth.human.spec.ts: it launches its own verification server and Vite, so it needs no rig webServers.
export default defineConfig({ testDir: ".", testMatch: "needsyou-fullwidth.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: "list", outputDir: evidenceDir("needsyou-fullwidth"),
  use: { headless: true } });
