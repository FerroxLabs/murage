import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Node, not miniflare: D1 is SQLite, so test/d1.ts runs the real migration on
// node:sqlite. No test reaches Apple, Google or Cloudflare.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
