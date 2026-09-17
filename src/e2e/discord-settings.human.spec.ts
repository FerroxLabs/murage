import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { axeScriptPath } from "./axe";
let server: ViteDevServer, origin: string, cache: string;
const empty = { state: "idle", configured: false, botConfigured: false, enabled: false, paired: false, requiresRevoke: false, busy: false,
  pending: 0, uncertain: 0, rejected: 0, needsReview: 0, error: null, nextRetryAt: null };
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-discord-ui-cache-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false, resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
      name: "discord-settings-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__discord.js") return "\0discord-fixture"; if (id === "@/state/store" || /\/src\/state\/store(?:\.ts)?$/.test(id)) return "\0discord-fixture-api"; },
      load(id) {
        if (id === "\0discord-fixture-api") return `export async function api(path,init){const r=await fetch(path,init);if(!r.ok)throw new Error('fixture request failed');return r.json();}`;
        if (id !== "\0discord-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {DiscordSettings} from '/src/components/DiscordSettings.tsx';import '/src/styles.css';
          window.muragebox={setCredential:async(name,value)=>{window.__credentialCalls??=[];window.__credentialCalls.push({name});return {};}};
          createRoot(document.getElementById('root')).render(React.createElement(DiscordSettings));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url === "/api/discord/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(empty)); return; }
        if (req.url !== "/__discord") return next();
        res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="en" data-discord-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord settings fixture</title><style>html[data-discord-fixture],html[data-discord-fixture] body{height:auto;min-height:100%;position:static;overflow:auto}html[data-discord-fixture] #root{height:auto;overflow:visible}</style></head><body><main style="max-width:720px;margin:0 auto;padding:16px"><h1 class="text-ink text-lg">Settings</h1><h2 class="text-ink text-base mb-4">Channels</h2><div id="root"></div></main><script type="module" src="/__discord.js"></script></body></html>');
      }); },
    }] }); await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
test("secure save, explicit pairing, lock, copy, retry and revoke are visible and recoverable", async ({ page }, testInfo) => {
  let state: Record<string, unknown> = { ...empty }, pairs = 0, revokes = 0, retries = 0, fail = false, failStatus = false;
  const pageErrors: string[] = []; page.on("pageerror", e => pageErrors.push(e.message));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/discord/status", route => failStatus ? route.fulfill({ status: 503, json: { error: "private-status-canary" } }) : route.fulfill({ json: state }));
  await page.route("**/api/config", route => { const b = route.request().postDataJSON(); expect(b.discord.appToken).toBeUndefined(); expect(b.discord.botToken).toBeUndefined(); state = { ...state, ...b.discord }; return route.fulfill({ json: {} }); });
  await page.route("**/api/discord/pair", route => { pairs++; state = { ...state, requiresRevoke: true, enabled: true, state: "pairing" }; return route.fulfill({ json: { code: "a".repeat(64), expiresAt: Date.now() + 60000 } }); });
  await page.route("**/api/discord/revoke", route => { revokes++; state = { ...state, requiresRevoke: false, enabled: false, paired: false, state: "idle", error: null }; return route.fulfill({ json: {} }); });
  await page.route("**/api/discord/resume", route => { retries++; if (fail) return route.fulfill({ status: 503, json: { error: "private-secret-canary" } }); state = { ...state, state: "connected", paired: true, enabled: true }; return route.fulfill({ json: state }); });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${origin}/__discord`); await page.waitForLoadState("networkidle");
  await expect(page.getByText("Save your Discord credentials", { exact: true })).toBeVisible();
  await page.getByLabel("Bot token", { exact: true }).fill("fake-bot-private");
  state = { ...state, configured: true, botConfigured: true };
  await page.getByRole("button", { name: "Save credentials", exact: true }).click(); await expect(page.getByText("Credentials saved. Pairing has not started.")).toBeVisible(); expect(pairs).toBe(0);
  await expect(page.getByLabel("Bot token (saved)", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => (window as any).__credentialCalls)).toEqual([{ name: "discordBotToken" }]);
  await page.getByLabel("Application ID", { exact: true }).fill("11"); await page.getByLabel("Owner user ID", { exact: true }).fill("13");
  await page.getByRole("button", { name: "Save application details" }).click(); await expect(page.getByText("Application details saved. Pairing has not started.")).toBeVisible(); expect(pairs).toBe(0);
  await page.getByRole("button", { name: "Pair with Chief" }).focus(); await page.keyboard.press("Enter"); await expect(page.getByText("/pair " + "a".repeat(64))).toBeVisible();
  await expect(page.getByLabel("Application ID", { exact: true })).toBeDisabled(); await expect(page.getByLabel("Bot token (saved)", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Copy pairing command" }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/pair " + "a".repeat(64));
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("a".repeat(64));
  await page.addScriptTag({ content: readFileSync(axeScriptPath, "utf8") });
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`discord-pairing-${width}.png`), fullPage: true });
    const report = await page.evaluate(async () => (window as any).axe.run(document));
    writeFileSync(testInfo.outputPath(`discord-axe-${width}.json`), JSON.stringify(report, null, 2));
    expect(report.violations).toEqual([]);
  }
  state = { ...state, state: "retry", paired: true, enabled: false, error: "transport-error" };
  await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByText("Connection saved · reconnecting", { exact: true })).toBeVisible();
  await expect(page.getByText("/pair " + "a".repeat(64))).toHaveCount(0);
  fail = true; await page.getByRole("button", { name: "Retry connection" }).click(); await expect(page.getByText("Reconnect could not complete.", { exact: false })).toBeVisible(); await expect(page.getByText("private-secret-canary")).toHaveCount(0);
  fail = false; await page.getByRole("button", { name: "Retry connection" }).click(); await expect(page.getByText("Connected to Chief", { exact: true })).toBeVisible(); expect(retries).toBe(2);
  failStatus = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Status could not be refreshed.", { exact: false })).toBeVisible();
  await expect(page.getByText("Connected to Chief", { exact: true })).toBeVisible();
  await expect(page.getByText("private-status-canary")).toHaveCount(0);
  failStatus = false;
  state = { ...state, uncertain: 1 };
  await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByText("A reply delivery is uncertain.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Revoke connection" }).click(); expect(revokes).toBe(1); await expect(page.getByLabel("Application ID", { exact: true })).toBeEnabled();
  // Audit enabled, visible controls. Disabled controls are intentionally not tab stops.
  await page.locator("summary").click(); await page.locator("body").click({ position: { x: 1, y: 1 } });
  const total = await page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],summary')].filter(el => el.getBoundingClientRect().height > 0);
    all.forEach((el, i) => el.dataset.tabAudit = String(i)); return all.length;
  });
  const seen = new Set<string>();
  for (let i = 0; i < total + 2; i++) {
    await page.keyboard.press("Tab"); const item = await page.evaluate(() => { const el = document.activeElement as HTMLElement; const style = getComputedStyle(el); return { id: el.dataset.tabAudit, focus: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== "none" }; });
    if (item.id !== undefined) { expect(item.focus).toBe(true); seen.add(item.id); }
  }
  expect(seen.size).toBe(total); expect(pageErrors).toEqual([]);
});
test("expired challenges and missing secure storage have a visible next action", async ({ page }) => {
  let state: Record<string, unknown> = { ...empty, configured: true, botConfigured: true, applicationId: "11", ownerUserId: "13" };
  await page.route("**/api/discord/status", route => route.fulfill({ json: state }));
  await page.route("**/api/discord/pair", route => { state = { ...state, state: "pairing", requiresRevoke: true, enabled: true }; return route.fulfill({ json: { code: "b".repeat(64), expiresAt: Date.now() + 1000 } }); });
  await page.goto(`${origin}/__discord`); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Pair with Chief" }).click(); await expect(page.getByText("Pairing code expired", { exact: true })).toBeVisible();
  await expect(page.getByText("/pair " + "b".repeat(64))).toHaveCount(0); await expect(page.getByText("The code expired.", { exact: false })).toBeVisible();
  state = { ...empty };
  await page.evaluate(() => { (window as any).muragebox = {}; }); await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Secure storage is unavailable", { exact: false })).toBeVisible(); await expect(page.getByRole("button", { name: "Save credentials", exact: true })).toBeDisabled();
});
