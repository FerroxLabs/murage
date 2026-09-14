import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "discord-settings.human.spec.ts", workers: 1, retries: 0, timeout: 90000,
  expect: { timeout: 5000 }, reporter: "list", outputDir: evidenceDir("discord-settings"), use: { headless: true, trace: "retain-on-failure" } });
