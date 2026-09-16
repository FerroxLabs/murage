import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "b35-delegation.human.spec.ts", workers: 1, retries: 0, timeout: 180000, reporter: "list", outputDir: evidenceDir("b35-delegation"), use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" } });
