import { defineConfig } from "@playwright/test";

const ORIGIN = "https://cloud.murage.test:3443";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--host-resolver-rules=MAP cloud.murage.test 127.0.0.1"] },
  },
  webServer: [
    // Default: the REAL merged control-plane Worker under `wrangler dev` (fixtures only for email and Stripe's HTTPS API).
    // JOURNEY_CP=fake keeps the old in-memory stand-in for quick UI work.
    process.env.JOURNEY_CP === "fake"
      ? { command: "npx tsx e2e/fake-cp.ts", port: 8788, reuseExistingServer: false, env: { PORTAL_ORIGIN: ORIGIN } }
      : { command: "bash ../cloudflare/control-plane/e2e/start.sh", port: 8788, reuseExistingServer: false, timeout: 240_000 },
    {
      command: "npx next start -p 3000", port: 3000, reuseExistingServer: false, timeout: 120_000,
      env: {
        CP_URL: "http://127.0.0.1:8788", PORTAL_ORIGIN: ORIGIN,
        CHECKOUT_REDIRECT_HOSTS: "checkout.stripe.test,billing.stripe.test",
      },
    },
    { command: "node e2e/tls-proxy.mjs", port: 3443, reuseExistingServer: false },
  ],
});
