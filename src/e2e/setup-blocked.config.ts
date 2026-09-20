import { defineConfig, devices } from "@playwright/test";

import { evidenceDir } from "./evidence";
import { APP_URL, HARNESS_PORT, HARNESS_URL, REPO_ROOT, SCRATCH_DATA_DIR, UI_PORT } from "./rig";

// The capped-account rig, with its own harness.
//
// `credit-exhausted` is the shipped ACP fixture's genuine payment rejection:
// HTTP 402 with a provider message, handed back through the real driver. The
// store records it as a provider error and the real GET /api/setup derives
// the block from it, so the sentence this spec reads off the screen was
// computed by the server on live state — not planted by the spec.
//
// One project, and both widths inside the spec, for the same reason as the
// first-run rig: the spec leaves real state on a real server.
export default defineConfig({
  testDir: ".",
  testMatch: "setup-blocked.human.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: evidenceDir("setup-blocked", process.env.SETUP_E2E_EVIDENCE_DIR),
  use: { ...devices["Desktop Chrome"], baseURL: APP_URL, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: [
    {
      command: "node src/e2e/setup-prepare.mjs && node src/e2e/setup-start-server.mjs harness",
      url: `${HARNESS_URL}/api/health`,
      cwd: REPO_ROOT,
      env: {
        MURAGE_DATA_DIR: SCRATCH_DATA_DIR,
        MURAGE_PORT: String(HARNESS_PORT),
        MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
        MURAGE_SETUP_FIXTURE_MODE: "credit-exhausted",
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
        MURAGE_DATA_DIR: SCRATCH_DATA_DIR,
        MURAGE_UI_PORT: String(UI_PORT),
        MURAGE_PORT: String(HARNESS_PORT),
        MURAGE_SETUP_FIXTURE_MODE: "credit-exhausted",
      },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
