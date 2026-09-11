import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
// The spec boots its own Vite fixture server (on MURAGE_E2E_UI_PORT when a lane
// sets one) and routes every /api call, so no harness or seeded data dir is
// needed. Evidence lands under MURAGE_E2E_DATA_DIR (or MURAGE_E2E_OUTPUT).
// Timeouts are Playwright's own defaults: the spec already passed on them.
const out = evidenceDir("desktop-capabilities", process.env.MURAGE_E2E_OUTPUT);
export default defineConfig({
  testDir: ".", testMatch: "desktop-capabilities.human.spec.ts", workers: 1, fullyParallel: false, retries: 0,
  timeout: 30_000, expect: { timeout: 5_000 }, reporter: "list", outputDir: out,
  use: { headless: true, viewport: { width: 1280, height: 800 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
