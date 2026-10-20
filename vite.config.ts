import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { murageRenderPlugins } from "./scripts/vite-render-plugin";
import { precompressPlugin } from "./scripts/compress-dist.mjs";
import { resolveBuildCommit } from "./scripts/build-commit.mjs";
import { LINUX_HOME_TESTS } from "./server/testing/linux-home-tests";

export default defineConfig({
  // The commit behind this build, for the About source link (null without git).
  define: { __MURAGE_COMMIT__: JSON.stringify(resolveBuildCommit()) },
  // murageRenderPlugins: the sandboxed diagram frame page, and the lazy
  // katex/mermaid/dompurify imports that fall back to source when missing.
  // precompressPlugin: `.br`/`.gz` copies of hashed assets for the browser
  // door, written after the bundle (build only; inert under vitest and dev).
  plugins: [react(), tailwindcss(), murageRenderPlugins(), precompressPlugin()],
  build: {
    // dist/.vite/manifest.json: which files the first paint loads, read by
    // scripts/check-bundle-budget.mjs after every CI build (spec §6)
    manifest: true,
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "shared/**/*.test.ts",
      "tools/**/*.test.ts",
      "companion/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    // electron/signed-fetch.test.mjs is test support (imported by the node:test files), not a test: vitest finds no suite in it.
    // On Windows the Cloud home tests that drive its Linux-only pieces are left out (the reason and the list are in
    // server/testing/linux-home-tests.ts); every other OS runs them.
    exclude: [...configDefaults.exclude, "electron/signed-fetch.test.mjs", ...(process.platform === "win32" ? LINUX_HOME_TESTS : [])],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    // A ceiling for a loaded runner (Windows and macOS CI take several times
    // longer than a developer machine); a passing test never waits on it.
    testTimeout: 45_000,
    hookTimeout: 30_000,
    // Where a test runs when it cannot run on every pull request. Neither tag
    // skips a test: CI's Vitest shards leave both out (ci.yml), nightly.yml
    // runs them, and a release needs the latest nightly green
    // (scripts/release-ci-gate.mjs). The rule is in .github/workflows/nightly.yml.
    tags: [
      { name: "nightly", description: "Over 60 s on a hosted runner: runs in nightly.yml on all three OSes, not in the per-push shards (memory-timing-nightly.yml also runs the WebAssembly parity test with the pinned model prepared)." },
      { name: "perf-budget", description: "Asserts a wall-clock budget measured on dedicated hardware: runs on the build host perf job in nightly.yml, not on hosted runners." },
    ],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(process.env.MURAGE_UI_PORT) || 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.MURAGE_PORT || process.env.MURAGEBOX_PORT || 8799}`,
        // the streaming voice websocket rides /api in dev
        ws: true,
      },
    },
  },
});
