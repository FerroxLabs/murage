import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

// Screenshots and traces go where the lane was told to put its evidence.
const out = evidenceDir("chat-header", process.env.MURAGE_E2E_EVIDENCE_DIR);

export default defineConfig({
  testDir: ".",
  testMatch: "chat-header.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 7_000 },
  reporter: "list",
  outputDir: out,
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
