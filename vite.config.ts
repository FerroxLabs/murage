import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { murageRenderPlugins } from "./scripts/vite-render-plugin";
import { precompressPlugin } from "./scripts/compress-dist.mjs";

export default defineConfig({
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
      "companion/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
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
      },
    },
  },
});
