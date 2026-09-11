import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

// Evidence goes where the lane was told to put it.
const out = evidenceDir("workspace-pane", process.env.MURAGE_E2E_EVIDENCE_DIR);

export default defineConfig({
  testDir: ".", testMatch: "workspace-pane.human.spec.ts", workers: 1, retries: 0, timeout: 60_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: out,
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
