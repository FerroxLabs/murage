import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
import { randomUUID } from "node:crypto";

// B10 specialist packs: five solo anchors and the Back-Office Crew room, six
// frozen cases each, against one named real engine in an owned isolated
// harness. Without live inputs every case fails as NOT RUN; nothing is skipped
// or scripted. Playwright artefacts land under MURAGE_E2E_DATA_DIR, never in
// the checkout; case receipts go to MURAGE_B10_EVIDENCE_DIR (or beside the
// artefacts). One stamp per run, inherited by every worker Playwright starts.
if (process.env.TEST_WORKER_INDEX === undefined) process.env.MURAGE_B10_RUN_STAMP = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;

export default defineConfig({
  testDir: ".",
  testMatch: "b10-specialist-packs.human.spec.ts",
  workers: 1,
  retries: 0,
  // Real model turns (room turns dispatch per mentioned member), owner approvals, six same-data restarts and bounded interrupts.
  timeout: 1_800_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: evidenceDir("b10-specialist-packs"),
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
