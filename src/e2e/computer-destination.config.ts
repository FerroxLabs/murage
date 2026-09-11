import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "computer-destination.human.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 5_000 }, reporter: "list",
  outputDir: evidenceDir("computer-destination"),
  use: { headless: true, trace: "retain-on-failure" },
});
