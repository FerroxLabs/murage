import { defineConfig } from "@playwright/test";
import { join } from "node:path";

// Screenshots and traces go where the lane was told to put its evidence;
// MURAGE_E2E_DATA_DIR keeps a lane's artifacts out of the shared tree.
const out =
  process.env.MURAGE_E2E_EVIDENCE_DIR ??
  (process.env.MURAGE_E2E_DATA_DIR
    ? join(process.env.MURAGE_E2E_DATA_DIR, "chat-header-results")
    : "../../.planning/chat-header-results");

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
