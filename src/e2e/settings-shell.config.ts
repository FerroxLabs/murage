import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

// SETTINGS-SHELL-CONTRACT-1019: the spec boots its own Vite fixture, mounts the real SettingsModal on the real store and
// routes every /api call, so no harness or seeded data dir is needed. Screenshots go to SHOTS_DIR when it is set.
const out = evidenceDir("settings-shell", process.env.MURAGE_E2E_OUTPUT);

export default defineConfig({
  testDir: ".",
  testMatch: "settings-shell.human.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  reporter: "list",
  outputDir: out,
  use: { headless: true, viewport: { width: 1280, height: 800 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
