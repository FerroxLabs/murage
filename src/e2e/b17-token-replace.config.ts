import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".",
  testMatch: "b17-token-replace.human.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: evidenceDir("b17-token-replace", process.env.B17_TOKEN_REPLACE_EVIDENCE_DIR),
  use: { headless: true, trace: "retain-on-failure" },
});
