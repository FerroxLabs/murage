import { defineConfig } from "@playwright/test";

import { laneEvidenceDir } from "./lane-data-dir";

// Murage 0.1.52 user smoke test ROUND 2 (docs/plans/0152-USER-SMOKE-2.md).
// Same rig as round 1: one isolated harness + the real Vite app.
// MURAGE_E2E_DATA_DIR is required; evidence lands inside it (lane-data-dir.ts).
const out = laneEvidenceDir("user-smoke-2-results", "the smoke test never uses ~/.murage");

export default defineConfig({
  testDir: ".",
  testMatch: "user-smoke-0152-r2.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: out,
  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] },
  },
});
