import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { murageRenderPlugins } from "./scripts/vite-render-plugin";
import { precompressPlugin } from "./scripts/compress-dist.mjs";
import { buildCommitPlugin } from "./scripts/build-commit-plugin.mjs";
import { resolveBuildCommit } from "./scripts/build-commit.mjs";
import { LINUX_HOME_TESTS } from "./server/testing/linux-home-tests";

// WIN-BACKUP-RT-1018: the real Windows backup round trip runs only as a standard user. No Vitest process collects it
// (full shards, scoped dispatches, a directory such as `server` or `.`, other workflows, local runs) unless it was
// started by scripts/ci-windows-standard-user.ps1, the only place that sets MURAGE_TEST_STANDARD_USER_RT=1. The variable
// only allows collection; the file's own first assertion (a token that is not elevated) still has to pass. This list
// sits outside the test.exclude literal on purpose, so scripts/ci-test-tiers.mjs still classifies the file as a gate test.
const STANDARD_USER_ONLY_TESTS = ["server/installation-windows-backup-roundtrip.test.ts"];
const standardUserRun = process.env.MURAGE_TEST_STANDARD_USER_RT === "1";

const buildCommit = resolveBuildCommit();
export default defineConfig({
  // The commit behind this build, for the About source link (null without git).
  define: { __MURAGE_COMMIT__: JSON.stringify(buildCommit) },
  // murageRenderPlugins: the sandboxed diagram frame page, and the lazy
  // katex/mermaid/dompurify imports that fall back to source when missing.
  // precompressPlugin: `.br`/`.gz` copies of hashed assets for the browser
  // door, written after the bundle (build only; inert under vitest and dev).
  plugins: [buildCommitPlugin(buildCommit), react(), tailwindcss(), murageRenderPlugins(), precompressPlugin()],
  experimental: {
    // The attention entry also loads from a packaged file URL. Resolve its
    // HTML assets and chunk dependencies relative to their emitted files;
    // the app's HTML keeps its existing root-relative asset paths.
    renderBuiltUrl(_filename, { hostType, hostId, type }) {
      if (type === "asset" && (hostType === "js" || hostType === "css" || hostId === "src/tray-panel/index.html" || hostId === "src/float/bubble.html" || hostId === "src/float/dock.html")) return { relative: true };
    },
  },
  build: {
    // dist/.vite/manifest.json: which files the first paint loads, read by
    // scripts/check-bundle-budget.mjs after every CI build (spec §6)
    manifest: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        trayPanel: fileURLToPath(new URL("./src/tray-panel/index.html", import.meta.url)),
        bubble: fileURLToPath(new URL("./src/float/bubble.html", import.meta.url)),
        dock: fileURLToPath(new URL("./src/float/dock.html", import.meta.url)),
        pill: fileURLToPath(new URL("./src/pill/index.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "src/components/BotSettingsLazy.test.tsx",
      "src/components/PhoneAccessCard.test.tsx",
      "src/components/PhoneForBotsRow.test.tsx",
      "src/components/RoomShareCard.test.tsx",
      "src/components/BotReviewSheet.test.tsx",
      "src/attention-ui/AttentionPanel.test.tsx",
      "src/float/*.test.tsx",
      "src/components/PinToEdgeMenuItem.test.tsx",
      "src/pill/Pill.test.tsx",
      "src/components/DataFolderSettings.test.tsx",
      "shared/**/*.test.ts",
      "tools/**/*.test.ts",
      "companion/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    // electron/signed-fetch.test.mjs is test support (imported by the node:test files), not a test: vitest finds no suite in it.
    // On Windows the Cloud home tests that drive its Linux-only pieces are left out (the reason and the list are in
    // server/testing/linux-home-tests.ts); every other OS runs them.
    exclude: [...configDefaults.exclude, "electron/signed-fetch.test.mjs", "scripts/probes/native-deny/tests/fixture.test.mjs", "scripts/probes/native-deny/tests/helpers.test.mjs", "scripts/probes/native-deny/tests/results.test.mjs", "scripts/probes/native-deny/tests/review-regressions.test.mjs", "scripts/probes/native-deny/tests/runner.test.mjs", ...(process.platform === "win32" ? LINUX_HOME_TESTS : []), ...(standardUserRun ? [] : STANDARD_USER_ONLY_TESTS)],
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
