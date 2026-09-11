import { defineConfig } from "@playwright/test";
import { evidenceRoot } from "./evidence";
import { join } from "node:path";

// Murage 0.1.52 user smoke test ROUND 2 (docs/plans/0152-USER-SMOKE-2.md).
// Same rig as round 1: one isolated harness + the real Vite app.
// Results sit beside the data dir (docs/plans/0152-USER-SMOKE-2.md), never in the repo.
const out = join(evidenceRoot("user-smoke-2"), "..", "results");

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
