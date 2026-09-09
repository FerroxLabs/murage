import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "sender-avatar.human.spec.ts", workers: 1, retries: 0, timeout: 60000, reporter: "list", outputDir: "../../.planning/sender-avatar-browser", use: { headless: true, trace: "retain-on-failure" } });
