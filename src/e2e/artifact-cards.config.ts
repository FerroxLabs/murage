import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
const out = evidenceDir("artifact-cards");
export default defineConfig({ testDir: ".", testMatch: "artifact-cards.human.spec.ts", workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 7_000 }, reporter: "list",
  outputDir: out, use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
