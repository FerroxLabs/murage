import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "conversation-export.human.spec.ts", workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 10000 }, reporter: "list", outputDir: evidenceDir("conversation-export"),
  use: { headless: true, trace: "retain-on-failure" } });
