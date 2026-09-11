import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
// COMPOSER4MB: an over-limit composer message is refused with a visible,
// accessible reason and the text is kept; a message at the limit sends. Runs
// the real renderer against a real isolated harness. MURAGE_E2E_DATA_DIR is
// required (the spec refuses ~/.murage; evidence never lands in the repo).
export default defineConfig({ testDir: ".", testMatch: "composer-size-limit.human.spec.ts", workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 15_000 }, reporter: "list",
  outputDir: evidenceDir("composer-size-limit"), use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" } });
