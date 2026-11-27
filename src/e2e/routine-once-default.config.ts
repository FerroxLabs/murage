import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "routine-once-default.human.spec.ts", workers: 1, retries: 0, timeout: 90_000, reporter: "list", outputDir: evidenceDir("routine-once-default"), use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
