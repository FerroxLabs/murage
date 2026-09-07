import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { freePortBlock } from "../../server/testing/ports";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This fixture mounts the real hook and transport modules in Chromium. Its
// own ephemeral Vite server has no harness, proxy, workspace or live data.
let server: ViteDevServer;
let origin: string;
let cache: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-surface-vite-"));
  server = await createServer({
    configFile: false,
    root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [{
      name: "surface-recovery-fixture",
      resolveId(id) { if (id === "/__surface-fixture.js") return "\0surface-fixture"; },
      load(id) {
        if (id !== "\0surface-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { useDesktopSurface } from '/src/lib/use-surface.ts';
          function Probe() {
            const desktop = useDesktopSurface();
            return React.createElement('output', {}, desktop === undefined ? 'unknown' : desktop ? 'desktop' : 'remote');
          }
          const root = createRoot(document.getElementById('root'));
          window.unmountProbe = () => root.unmount();
          root.render(React.createElement(Probe));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/__surface-fixture") return next();
          res.setHeader("content-type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/__surface-fixture.js"></script>');
        });
      },
    }],
  });
  await server.listen(await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); if (cache) rmSync(cache, { recursive: true, force: true }); });

test("mounted surface recovers after a transient config failure", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/desktop-secret", (route) => route.fulfill({ json: { secret: "fixture-proof" } }));
  await page.route("**/api/config", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503, body: "starting" })
      : route.fulfill({ json: { surface: "desktop" } });
  });
  await page.goto(`${origin}/__surface-fixture`);
  await expect(page.locator("output")).toHaveText("remote");
  await expect(page.locator("output")).toHaveText("desktop");
  expect(attempts).toBe(2);
});

test("mounted surface retries transient secret discovery", async ({ page }) => {
  let secretAttempts = 0;
  await page.route("**/api/desktop-secret", (route) => {
    secretAttempts++;
    return secretAttempts === 1
      ? route.fulfill({ status: 503, body: "starting" })
      : route.fulfill({ json: { secret: "fixture-proof" } });
  });
  await page.route("**/api/config", (route) => route.fulfill({
    json: { surface: route.request().headers()["x-murage-surface-secret"] ? "desktop" : "remote" },
  }));
  await page.goto(`${origin}/__surface-fixture`);
  await expect(page.locator("output")).toHaveText("remote");
  await expect(page.locator("output")).toHaveText("desktop");
  expect(secretAttempts).toBe(2);
});

test("confirmed remote does not repeatedly request its forbidden secret endpoint", async ({ page }) => {
  let secrets = 0;
  let configs = 0;
  await page.clock.install();
  await page.route("**/api/desktop-secret", (route) => { secrets++; return route.fulfill({ status: 404 }); });
  await page.route("**/api/config", (route) => { configs++; return route.fulfill({ json: { surface: "remote" } }); });
  await page.goto(`${origin}/__surface-fixture`);
  await expect(page.locator("output")).toHaveText("remote");
  await page.clock.runFor(60_000);
  expect({ secrets, configs }).toEqual({ secrets: 1, configs: 1 });
});

test("unmount cancels transient recovery", async ({ page }) => {
  let attempts = 0;
  await page.clock.install();
  await page.route("**/api/desktop-secret", (route) => route.fulfill({ json: { secret: "fixture-proof" } }));
  await page.route("**/api/config", (route) => { attempts++; return route.fulfill({ status: 503 }); });
  await page.goto(`${origin}/__surface-fixture`);
  await expect(page.locator("output")).toHaveText("remote");
  await page.evaluate("window.unmountProbe()");
  await page.clock.runFor(60_000);
  expect(attempts).toBe(1);
});
