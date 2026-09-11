import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
const out = evidenceDir("media-lightbox");
export default defineConfig({ testDir: ".", testMatch: "media-lightbox.human.spec.ts", workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 7_000 }, reporter: "list",
  outputDir: out, use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
