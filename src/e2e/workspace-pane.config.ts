import { defineConfig } from "@playwright/test";
import { join } from "node:path";

// Evidence goes where the lane was told to put it; MURAGE_E2E_DATA_DIR keeps
// a lane's screenshots and traces out of the shared tree.
const out = process.env.MURAGE_E2E_EVIDENCE_DIR
  ?? (process.env.MURAGE_E2E_DATA_DIR ? join(process.env.MURAGE_E2E_DATA_DIR, "workspace-pane-results") : "../../.planning/workspace-pane-results");

export default defineConfig({
  testDir: ".", testMatch: "workspace-pane.human.spec.ts", workers: 1, retries: 0, timeout: 60_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: out,
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
