import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import type { TelegramStatus } from "../lib/telegram-status";

let server: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-b17-health-vite-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false, resolve: { alias: { "@": `${root}/src` }, }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "b17-health-fixture",
      resolveId(id) { if (id === "/__b17-health.js") return "\0b17-health"; },
      load(id) { if (id === "\0b17-health") return `import React from 'react';import {createRoot} from 'react-dom/client';import {TelegramSettings} from '/src/components/TelegramSettings.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(TelegramSettings));`; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => { if (request.url !== "/__b17-health") return next(); response.setHeader("content-type", "text/html"); response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="padding:16px"></div><script type="module" src="/__b17-health.js"></script>'); }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing B17 health fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

test("B17 health status retries safely and retains confirmed state", async ({ page }, info) => {
  let status: TelegramStatus = { configured: true, enabled: true, paired: true, pending: 0, uncertain: 0, rejected: 0, connecting: false, requiresRevoke: true, resumeState: "active" };
  let statusCalls = 0;
  let holdOldStatus: (() => void) | undefined;
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture" } }));
  await page.route("**/api/telegram/status", async route => {
    statusCalls++;
    const response = { ...status };
    if (statusCalls === 2) await new Promise<void>(resolve => { holdOldStatus = resolve; });
    await route.fulfill({ json: response });
  });
  await page.route("**/api/telegram/revoke", async route => {
    status = { ...status, enabled: false, paired: false, requiresRevoke: false, resumeState: "idle" };
    await route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/__b17-health`);
  await expect(page.getByText("Paired", { exact: true })).toBeVisible();

  await page.waitForTimeout(2100);
  await expect.poll(() => statusCalls).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("Token saved · not paired", { exact: true })).toBeVisible();
  holdOldStatus?.();
  await page.waitForTimeout(100);
  await expect(page.getByText("Paired", { exact: true })).toHaveCount(0);

  await page.route("**/api/telegram/status", route => route.fulfill({ json: { invalid: true } }));
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be completed");
  await expect(page.getByText("Token saved · not paired", { exact: true })).toBeVisible();

  status = { ...status, enabled: true, requiresRevoke: true, resumeState: "retry" };
  await page.unroute("**/api/telegram/status");
  await page.route("**/api/telegram/status", route => route.fulfill({ json: status }));
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("Connection saved · retrying automatically", { exact: true })).toBeVisible();

  status = { ...status, resumeState: "blocked", resumeMessage: "The paired Chief changed or is unavailable. Revoke this connection, then pair the current workspace Chief.", uncertain: 1, rejected: 1 };
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("Chief unavailable · revoke and re-pair", { exact: true })).toBeVisible();
  await expect(page.getByText("A message delivery is uncertain. Check Telegram before sending it again.")).toBeVisible();
  await expect(page.getByText("A message could not be delivered. It will not be retried automatically.")).toBeVisible();
  await expect(page.getByLabel("Bot token", { exact: true })).toHaveValue("");
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: info.outputPath(`b17-health-${width}.png`), fullPage: true });
  }
  await page.goto("about:blank");
  const readsBeforeUnmountWait = statusCalls;
  await page.waitForTimeout(2100);
  expect(statusCalls).toBe(readsBeforeUnmountWait);
});
