import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { evidenceDir } from "./evidence";
import { APP_URL, HARNESS_PORT, HARNESS_URL, REPO_ROOT, SCRATCH_DATA_DIR, UI_PORT } from "./rig";

// The harness data dir is a SUBDIRECTORY of the lane dir, never the lane dir
// itself. setup-prepare.mjs wipes whatever MURAGE_DATA_DIR names, and the
// lane dir is also where this config's screenshots, traces and axe reports
// land — so pointing the harness at the lane root deletes the evidence of
// the very run that is producing it, mid-run.
const DATA_DIR = join(SCRATCH_DATA_DIR, "setup-first-run-data");

// The first-run rig, with its own harness.
//
// It cannot ride the shared human config: that one boots the fixture engine
// in its happy mode, and this spec is ABOUT an engine that never answers, so
// the mode has to be set before the server binds (setup-start-server.mjs).
//
// One project, not two. The spec walks the checklist and leaves real answers
// on a real server, so a second project would replay it against a workspace
// that is already half-answered and assert the wrong state. Both widths are
// covered inside the spec instead, which is also how its axe run reaches
// 390 and 1440 on the same drawn flow.
export default defineConfig({
  testDir: ".",
  testMatch: "setup-first-run.human.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: evidenceDir("setup-first-run", process.env.SETUP_E2E_EVIDENCE_DIR),
  use: { ...devices["Desktop Chrome"], baseURL: APP_URL, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: [
    {
      command: "node src/e2e/setup-prepare.mjs && node src/e2e/setup-start-server.mjs harness",
      url: `${HARNESS_URL}/api/health`,
      cwd: REPO_ROOT,
      env: {
        MURAGE_DATA_DIR: DATA_DIR,
        MURAGE_PORT: String(HARNESS_PORT),
        MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
        // The turn fails at the engine. Not a hang: a hung turn leaves the
        // bot busy for ever, and "never answers" has to be a state the
        // checklist can be read in.
        MURAGE_SETUP_FIXTURE_MODE: "engine-error-message:plain",
      },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
    {
      command: "node src/e2e/setup-start-server.mjs ui",
      url: APP_URL,
      cwd: REPO_ROOT,
      env: {
        MURAGE_DATA_DIR: DATA_DIR,
        MURAGE_UI_PORT: String(UI_PORT),
        MURAGE_PORT: String(HARNESS_PORT),
        MURAGE_SETUP_FIXTURE_MODE: "engine-error-message:plain",
      },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
