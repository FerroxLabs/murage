import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

// This spec owns an ephemeral Vite fixture. No shared harness, global seeding,
// provider fleet, container runtime or user application is started.
export default defineConfig({
  testDir: ".",
  testMatch: "operator-authority.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: evidenceDir("operator-authority"),
  use: { browserName: "chromium", viewport: { width: 1200, height: 900 }, trace: "retain-on-failure" },
});
