import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "audio-intake.human.spec.ts", workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 5000 }, reporter: "list", outputDir: evidenceDir("audio-intake"),
  use: { headless: true, trace: "retain-on-failure" } });
