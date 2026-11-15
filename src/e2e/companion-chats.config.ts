import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".",
  testMatch: "companion-chats.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: evidenceDir("companion-chats"),
  use: { headless: true, viewport: { width: 412, height: 915 }, screenshot: "only-on-failure" },
});
