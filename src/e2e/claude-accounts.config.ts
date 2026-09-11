import { defineConfig, devices } from "@playwright/test";
import { laneEvidenceDir } from "./lane-data-dir";
// Evidence never lands in the checkout: the old default wrote screenshots and
// traces under .planning/ inside the repository (CLAC2). Lane runs set this.
const out = laneEvidenceDir("claude-accounts-results", "claude-accounts browser evidence is never written inside the repository");
export default defineConfig({ testDir: ".", testMatch: "claude-accounts.human.spec.ts", workers: 1, retries: 0, timeout: 60000, reporter: "list", outputDir: out, use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" }, projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }, { name: "narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }] });
