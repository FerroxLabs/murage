import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "bot-settings.human.spec.ts", workers: 1, retries: 0, timeout: 45_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: evidenceDir("bot-settings"), use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
