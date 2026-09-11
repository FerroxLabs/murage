import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: ["files.human.spec.ts", "files-integration.human.spec.ts"], workers: 1, retries: 0, timeout: 45_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: evidenceDir("files"), use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
