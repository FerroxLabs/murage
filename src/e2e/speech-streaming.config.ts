import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "speech-streaming.human.spec.ts", workers: 1, retries: 0, timeout: 60000, reporter: "list", outputDir: evidenceDir("speech-streaming"), use: { trace: "retain-on-failure" }, projects: [{ name: "desktop" }] });
