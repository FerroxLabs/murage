// THE FIRST RUN NEEDS A WORKSPACE THAT HAS NEVER BEEN USED.
//
// `playwright.config.ts` runs `global-setup.ts`, which seeds three bots over
// HTTP before any project starts. That is right for every other human spec
// and wrong for this one: a first run is, by definition, the only session in
// which the workspace is empty. Seeding it first means the specs open on a
// populated sidebar and a bot's own intake card, which is what the first
// attempt at a first-run spec actually hit — the setup transcript was there,
// behind an affordance, because the app had something else to show.
//
// So this config keeps everything that makes the rig SAFE — the scratch data
// dir, prepare-scratch wiping it before the harness binds, the rig's own
// ports — and drops only the seeding. That is the whole difference.
import { defineConfig, devices } from "@playwright/test";

import { evidenceDir } from "./src/e2e/evidence";
import { APP_URL, HARNESS_PORT, HARNESS_URL, SCRATCH_DATA_DIR, UI_PORT } from "./src/e2e/rig";

const reuseExistingServer = process.env.MURAGE_E2E_REUSE_SERVER === "1" && !process.env.CI;

export default defineConfig({
  testDir: "./src/e2e",
  testMatch: /first-run-.*\.human\.spec\.ts$/,
  outputDir: evidenceDir("first-run"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One harness, one store, one empty workspace. Two workers would race to
  // answer the same checklist.
  workers: 1,
  reporter: [["list"]],
  timeout: 90_000,
  expect: { timeout: 10_000 },

  // DELIBERATELY NO globalSetup. See the header.

  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "first-run",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: [
    {
      command: "node src/e2e/prepare-scratch.mjs && node src/e2e/start-server.mjs harness",
      url: `${HARNESS_URL}/api/health`,
      env: {
        MURAGE_DATA_DIR: SCRATCH_DATA_DIR,
        MURAGE_PORT: String(HARNESS_PORT),
        MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
      },
      reuseExistingServer,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
    {
      command: "node src/e2e/start-server.mjs ui",
      url: APP_URL,
      env: {
        MURAGE_DATA_DIR: SCRATCH_DATA_DIR,
        MURAGE_UI_PORT: String(UI_PORT),
        MURAGE_PORT: String(HARNESS_PORT),
      },
      reuseExistingServer,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
