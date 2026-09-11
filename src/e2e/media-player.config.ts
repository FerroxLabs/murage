import { defineConfig } from "@playwright/test";
import { laneEvidenceDir } from "./lane-data-dir";
// MURAGE_E2E_DATA_DIR is required; evidence lands inside it (lane-data-dir.ts).
const out = laneEvidenceDir("media-player-results");
export default defineConfig({
  testDir: ".", testMatch: "media-player.human.spec.ts", workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 }, reporter: "list", outputDir: out,
  use: {
    headless: true, screenshot: "only-on-failure", trace: "retain-on-failure",
    // The autoplay policy is opened deliberately: "nothing plays on its own"
    // must be true because the cards never ask, not because the browser
    // refused them. Audio is muted so a test run makes no sound; muting does
    // not stop playback, so currentTime still advances.
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] },
  },
});
