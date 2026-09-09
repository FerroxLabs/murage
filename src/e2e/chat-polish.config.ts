import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: ["chat-polish.human.spec.ts", "chat-polish-integration.human.spec.ts"], workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 5000 }, reporter: "list", outputDir: "../../.planning/N6-polish-browser-round2",
  use: { headless: true, trace: "retain-on-failure" } });
