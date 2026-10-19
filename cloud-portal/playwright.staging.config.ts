// Launch rehearsal: the portal (local) against the deployed STAGING control plane and real Stripe TEST mode.
import { defineConfig } from "@playwright/test";

const ORIGIN = "https://cloud.murage.test:3443";
export default defineConfig({
  testDir: "./e2e-staging",
  testMatch: /.*\.spec\.ts/,
  timeout: 15 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env.STAGING_EVIDENCE_DIR ?? "test-results-staging",
  use: {
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,
    screenshot: "on",
    headless: process.env.STAGING_HEADED !== "1",
    launchOptions: { args: ["--host-resolver-rules=MAP cloud.murage.test 127.0.0.1", "--disable-blink-features=AutomationControlled"] },
  },
  webServer: [
    {
      command: "npx next start -p 3000", port: 3000, reuseExistingServer: false, timeout: 120_000,
      env: { CP_URL: process.env.STAGING_CP_URL ?? "", PORTAL_ORIGIN: ORIGIN },
    },
    { command: "node e2e/tls-proxy.mjs", port: 3443, reuseExistingServer: false },
  ],
});
