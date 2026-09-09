import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "../src/e2e", testMatch: "team-export.human.spec.ts", workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 }, reporter: "list", outputDir: "./0149-export-ui-results",
  use: { browserName: "chromium", screenshot: "only-on-failure", trace: "retain-on-failure" },
});
