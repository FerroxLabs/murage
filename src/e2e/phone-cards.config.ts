import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({
  testDir: ".", testMatch: "phone-cards.human.spec.ts", workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 5_000 }, reporter: "list",
  outputDir: evidenceDir("phone-cards"),
  use: { headless: true, trace: "retain-on-failure" },
});
