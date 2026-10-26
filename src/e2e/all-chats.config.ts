import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "all-chats.human.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: "list", outputDir: evidenceDir("all-chats"),
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
