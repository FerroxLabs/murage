import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
const out = evidenceDir("media-publication");
export default defineConfig({
  testDir: ".", testMatch: "media-publication.human.spec.ts", workers: 1, retries: 0,
  // One real harness, restarted once mid-run, drives every test in order.
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: "list", outputDir: out,
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure", launchOptions: { args: ["--mute-audio"] } },
});
