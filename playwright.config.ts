import { defineConfig, devices } from "@playwright/test";

import { APP_URL, HARNESS_PORT, HARNESS_URL, SCRATCH_DATA_DIR, UI_PORT } from "./src/e2e/rig";

// Human specs: the pass a person would do by hand, done by a browser. See
// src/e2e/rig.ts for why this rig owns its own ports and its own data dir
// rather than borrowing the developer's 8799/5199.
export default defineConfig({
  testDir: "./src/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // The harness is one process with one store; two workers would seed and
  // mutate the same workspace.
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Runs after the webServers below are up (webServer is a runner plugin, and
  // plugin setup precedes global setup) and before any project, so every
  // project sees the same seeded workspace.
  globalSetup: "./src/e2e/global-setup.ts",

  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      // Not a test — `vite build`, as a dependency. See vite-build.setup.ts.
      name: "build",
      testMatch: /vite-build\.setup\.ts$/,
    },
    {
      name: "desktop",
      testMatch: /\.human\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /\.human\.spec\.ts$/,
      dependencies: ["build"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        // A phone, not a narrow desktop: taps instead of clicks, and no
        // hover — which is the whole point of Wave 1's M3 (the `⋯` affordance
        // that only exists under a pointer).
        hasTouch: true,
        isMobile: false,
        deviceScaleFactor: 3,
      },
    },
  ],

  webServer: [
    {
      // prepare-scratch.mjs wipes and re-seeds the scratch data dir *before*
      // the server binds, so the harness always boots from a known state. It
      // runs only when Playwright actually starts this server.
      command: "node src/e2e/prepare-scratch.mjs && pnpm dev:server",
      url: `${HARNESS_URL}/api/health`,
      // Never the default ~/.murage. server/config.ts:445 reads this.
      env: {
        MURAGE_DATA_DIR: SCRATCH_DATA_DIR,
        MURAGE_PORT: String(HARNESS_PORT),
        MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
      },
      reuseExistingServer: true,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
    {
      // vite.config.ts proxies /api to MURAGE_PORT, so this hands the dev
      // server the scratch harness rather than whatever is on 8799.
      command: "pnpm dev",
      url: APP_URL,
      env: {
        MURAGE_UI_PORT: String(UI_PORT),
        MURAGE_PORT: String(HARNESS_PORT),
      },
      reuseExistingServer: true,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
