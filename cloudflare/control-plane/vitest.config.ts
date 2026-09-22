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
process.env.BETTER_AUTH_SECRET ??= TEST_AUTH_SECRET;
process.env.CLOUDFLARE_API_TOKEN ??= TEST_CLOUDFLARE_TOKEN;
process.env.SENDLANE_API_KEY ??= TEST_SENDLANE_API_KEY;
process.env.SENDLANE_HASH_KEY ??= TEST_SENDLANE_HASH_KEY;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
          CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_TOKEN,
          SENDLANE_API_KEY: TEST_SENDLANE_API_KEY,
          SENDLANE_HASH_KEY: TEST_SENDLANE_HASH_KEY,
          ALLOWED_ORIGINS: "https://app.murage.test",
          TEST_MIGRATIONS: await readD1Migrations(`${root}migrations`),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
