import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: ["chat-polish.human.spec.ts", "chat-polish-integration.human.spec.ts"], workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 5000 }, reporter: "list", outputDir: evidenceDir("chat-polish"),
  use: { headless: true, trace: "retain-on-failure" } });
