import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const TEST_AUTH_SECRET = "test-only-better-auth-secret-with-more-than-32-characters";
const TEST_CLOUDFLARE_TOKEN = "test-only-cloudflare-api-token-with-no-real-access";
// Obviously not credentials. Shaped like one and nothing more: no test may
// reach api.sendlane.com, so these only ever appear in an injected fetch.
const TEST_SENDLANE_API_KEY = "test-only-sendlane-api-key-not-a-real-key";
const TEST_SENDLANE_HASH_KEY = "test-only-sendlane-hash-key-not-a-real-key";
// The checkout disclosure-token HMAC key (WP4 r2-3); test only.
const TEST_DISCLOSURE_TOKEN_SECRET = "test-only-checkout-disclosure-token-secret-not-real";
const TEST_CANCELLATION_MAIL_KEY = "test-only-cancellation-mail-key-with-more-than-32-characters";
const TEST_NOTICE_MAIL_KEY = "test-only-notice-mail-key-not-a-real-key";
process.env.BETTER_AUTH_SECRET ??= TEST_AUTH_SECRET;
process.env.CLOUDFLARE_API_TOKEN ??= TEST_CLOUDFLARE_TOKEN;
process.env.SENDLANE_API_KEY ??= TEST_SENDLANE_API_KEY;
process.env.SENDLANE_HASH_KEY ??= TEST_SENDLANE_HASH_KEY;
process.env.CHECKOUT_DISCLOSURE_TOKEN_SECRET ??= TEST_DISCLOSURE_TOKEN_SECRET;
process.env.CANCELLATION_MAIL_KEY ??= TEST_CANCELLATION_MAIL_KEY;
process.env.NOTICE_MAIL_KEY ??= TEST_NOTICE_MAIL_KEY;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: {
        // The service binding IDENTITY_READER needs a Worker of that name to start the runtime. This stand-in fails closed on every call;
        // tests that need an identity inject a fake reader (cloudflare/identity-reader itself is tested through its pure read.ts).
        workers: [{
          name: "murage-identity-reader",
          compatibilityDate: "2026-08-25",
          modules: true,
          script: `import { WorkerEntrypoint } from "cloudflare:workers";
            export class IdentityReader extends WorkerEntrypoint { async emailGen() { throw new Error("identity_unavailable"); } }
            export default { fetch() { return new Response(null, { status: 404 }); } };`,
        }],
        bindings: {
          BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
          CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_TOKEN,
          SENDLANE_API_KEY: TEST_SENDLANE_API_KEY,
          SENDLANE_HASH_KEY: TEST_SENDLANE_HASH_KEY,
          CHECKOUT_DISCLOSURE_TOKEN_SECRET: TEST_DISCLOSURE_TOKEN_SECRET,
          CANCELLATION_MAIL_KEY: TEST_CANCELLATION_MAIL_KEY,
          NOTICE_MAIL_KEY: TEST_NOTICE_MAIL_KEY,
          ALLOWED_ORIGINS: "https://app.murage.test",
          TEST_MIGRATIONS: await readD1Migrations(`${root}migrations`),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // Many tests here drive whole billing sweeps against workerd D1 (real work, no wall-clock waits). Measured on a 16 vCPU runner under
    // full CPU load: every test completes, the slowest one without its own timeout in 9.3 s (idle 0.5 to 4.5 s). The 5 s default failed
    // 3 to 7 of them per loaded run (CI 40193051242). 30 s matches the per-test timeout the heavy tests already use.
    testTimeout: 30_000,
  },
});
