import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "help-ask-fixture.human.spec.ts", workers: 1,
  retries: 0, timeout: 120_000, expect: { timeout: 10_000 }, outputDir: "../../.help-fixture-evidence" });
