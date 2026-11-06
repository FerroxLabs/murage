// HEALTH-DOCTOR batch 2 (1.0.18): the real Health page (StoreProvider + HealthPageBody) on fixture answers, at 1440 px
// and 390 px. All fine: nothing to fix. Flux used up: the finding leads. The Fuigo card names the version from the install receipt. No app profile, network or provider calls.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let vite: ViteDevServer, cache: string, origin: string;
const NOW = Date.now();

test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-health-doctor-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, envFile: false, root, cacheDir: cache, resolve: { alias: { "@": join(root, "src") } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [react(), tailwindcss(), {
    name: "health-doctor-fixture",
    resolveId(id) { if (id === "/__health.js") return "\0health-fixture"; },
    load(id) {
      if (id !== "\0health-fixture") return;
      return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider} from '/src/state/store.tsx';import {HealthPageBody} from '/src/components/health/HealthPageBody.tsx';import '/src/styles.css';
createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(HealthPageBody,{onLeave:()=>{},onOpenNeedsYou:()=>{}})));`;
    },
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__health") return next(); res.setHeader("content-type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" class="h-screen"></div><script type="module" src="/__health.js"></script>'); }); },
  }] });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); safeWipeSync(cache); });

const engines = [
  { id: "fuigo", label: "Fuigo", state: "ready", line: "Signed in and ready.", usedBy: 2, fuigo: true },
  { id: "claude", label: "Claude", state: "ready", line: "Signed in and ready.", usedBy: 1 },
  { id: "gemini", label: "Gemini", state: "missing", line: "Not found on this computer.", usedBy: 0 },
];
const summary = { status: "ready", digest: null, view: { schemaVersion: 1, storeRevision: 1, publishedAt: NOW, rows: [],
  summary: { openCount: 0, highestSeverity: null, topTitleKey: null, lastCheckedAt: NOW - 60_000, lastCompleteCheckAt: NOW - 60_000, coverage: "complete", scanner: "running", recoveredCount: 0, moreCount: 0 } } };
const FIXTURES = {
  "all-fine": { engines, primary: engines[0], defaultId: "fuigo", flux: "ok", fluxInfo: { spendPct: 12, expires: null }, fuigoVersion: "1.0.39", checkedAt: NOW },
  "flux-used-up": { engines, primary: engines[0], defaultId: "fuigo", flux: "allowance-used-up", fluxInfo: { spendPct: 100, expires: null }, fuigoVersion: "1.0.39", checkedAt: NOW },
} as const;

async function open(page: import("@playwright/test").Page, answer: unknown) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "muragebox", { configurable: true, value: { platform: "darwin", desktopSurfaceSecret: "fake-proof" } });
    Object.defineProperty(window, "EventSource", { configurable: true, value: class { onopen: unknown; onerror: unknown; onmessage: unknown; close() {} } });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/engine-health" ? answer
      : path === "/api/sentinel/summary" ? summary
        : path === "/api/sentinel/issues" ? { ok: true, items: [], next: null }
          : path === "/api/bots" ? { bots: [], groups: [], computerControl: {} } : path === "/api/instances" ? { instances: [] } : {};
    return route.fulfill({ json });
  });
  await page.goto(`${origin}/__health`);
}

async function shots(page: import("@playwright/test").Page, name: string, info: import("@playwright/test").TestInfo) {
  const dir = process.env.HEALTH_DOCTOR_SHOTS;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) {
      const toggle = page.getByRole("button", { name: "What was checked" });
      if (await toggle.isVisible()) await toggle.click();
    }
    await page.screenshot({ path: dir ? join(dir, `health-${name}-${width}.png`) : info.outputPath(`health-${name}-${width}.png`), fullPage: true });
  }
}

test("all fine: nothing to fix, nothing red, and the receipt's Fuigo version on the card", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, FIXTURES["all-fine"]);
  const headline = page.locator('p[role="status"]').first();
  await expect(page.getByText("Fuigo 1.0.39 · Flux Router")).toBeVisible();
  await expect(headline).not.toContainText("to fix");
  await shots(page, "all-fine", info);
});

test("Flux used up: the finding leads and nothing says all clear", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, FIXTURES["flux-used-up"]);
  const headline = page.locator('p[role="status"]').first();
  await expect(headline).toContainText("1 thing to fix");
  await shots(page, "flux-used-up", info);
});
