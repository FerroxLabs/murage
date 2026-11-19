import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

// SETTINGS-P-LAZY-FAILURE-1019 section 4 "Mounted": the spec boots its own Vite fixture server, routes every /api call
// and aborts the lazy chunks itself, so no harness or seeded data dir is needed.
const out = evidenceDir("lazy-close", process.env.MURAGE_E2E_OUTPUT);

export default defineConfig({
  testDir: ".",
  testMatch: "lazy-close.human.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  reporter: "list",
  outputDir: out,
  use: { headless: true, viewport: { width: 1280, height: 800 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
