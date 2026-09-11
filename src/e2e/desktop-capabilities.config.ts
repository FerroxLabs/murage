import { defineConfig } from "@playwright/test";
import { laneEvidenceDir } from "./lane-data-dir";
// The spec boots its own Vite fixture server (on MURAGE_E2E_UI_PORT when a lane
// sets one) and routes every /api call, so no harness or seeded data dir is
// needed. MURAGE_E2E_DATA_DIR keeps a lane's artifacts out of the shared tree.
// Timeouts are Playwright's own defaults: the spec already passed on them.
const out = process.env.MURAGE_E2E_OUTPUT || laneEvidenceDir("desktop-capabilities-results");
export default defineConfig({
  testDir: ".", testMatch: "desktop-capabilities.human.spec.ts", workers: 1, fullyParallel: false, retries: 0,
  timeout: 30_000, expect: { timeout: 5_000 }, reporter: "list", outputDir: out,
  use: { headless: true, viewport: { width: 1280, height: 800 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
