import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: ["inbox.human.spec.ts", "inbox-integration.human.spec.ts"], workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 7_000 }, reporter: "list", outputDir: evidenceDir("inbox"),
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
