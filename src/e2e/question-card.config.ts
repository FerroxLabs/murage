import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".",
  testMatch: ["question-card.human.spec.ts"],
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 5000 },
  reporter: "list",
  outputDir: evidenceDir("question-card"),
  use: { headless: true, trace: "retain-on-failure" },
});
