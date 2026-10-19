import { defineConfig, devices } from "@playwright/test";
import { evidenceDir } from "./evidence";
const out = evidenceDir("cloud-trusted-types");
export default defineConfig({ testDir: ".", testMatch: "cloud-trusted-types.human.spec.ts", workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: out, use: { ...devices["Desktop Chrome"], headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
