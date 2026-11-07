import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: ["needs-inline-approve.human.spec.ts"], workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 7_000 }, reporter: "list", outputDir: evidenceDir("needs-inline-approve"),
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
