import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "b35-approvals.human.spec.ts", workers: 1, retries: 0, timeout: 90000, reporter: "list", outputDir: evidenceDir("b35"), use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
