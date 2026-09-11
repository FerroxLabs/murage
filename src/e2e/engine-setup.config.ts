import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "engine-setup.human.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 5_000 }, reporter: "list",
  outputDir: evidenceDir("engine-setup"),
  use: { headless: true, trace: "retain-on-failure" },
});
