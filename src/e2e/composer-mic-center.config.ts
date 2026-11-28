import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "composer-mic-center.human.spec.ts", workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 5_000 }, reporter: "list",
  outputDir: evidenceDir("composer-mic-center"),
  use: { headless: true, trace: "retain-on-failure" },
});
