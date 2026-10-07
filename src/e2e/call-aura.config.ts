import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "call-aura.human.spec.ts", workers: 1, retries: 0, timeout: 180000, reporter: "list", outputDir: evidenceDir("call-aura-shots"), use: { trace: "retain-on-failure" }, projects: [{ name: "desktop", use: { viewport: { width: 1440, height: 900 } } }, { name: "mobile", use: { viewport: { width: 390, height: 844 }, hasTouch: true } }] });
