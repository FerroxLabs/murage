import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";

export default defineConfig({
  testDir: ".", testMatch: "scrollbars.human.spec.ts", workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 10_000 }, reporter: "list",
  outputDir: evidenceDir("scrollbars"),
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure",
    // Playwright hides scrollbars by default in headless Chromium. This
    // fixture checks painted thumbs, pointer feedback and dragging them.
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  },
});
