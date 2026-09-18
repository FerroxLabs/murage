import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { axeScriptPath } from "./axe";
let server: ViteDevServer, origin: string, cache: string;
const empty = { state: "idle", configured: false, appConfigured: false, botConfigured: false, enabled: false, paired: false, requiresRevoke: false, busy: false,
  pending: 0, uncertain: 0, rejected: 0, needsReview: 0, error: null, nextRetryAt: null };
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-slack-ui-cache-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false, resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
      name: "slack-settings-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__slack.js") return "\0slack-fixture"; if (id === "@/state/store" || /\/src\/state\/store(?:\.ts)?$/.test(id)) return "\0slack-fixture-api"; },
      load(id) {
        if (id === "\0slack-fixture-api") return `export async function api(path,init){const r=await fetch(path,init);if(!r.ok)throw new Error('fixture request failed');return r.json();}`;
        if (id !== "\0slack-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {SlackSettings} from '/src/components/SlackSettings.tsx';import '/src/styles.css';
          window.muragebox={setCredential:async(name,value)=>{window.__credentialCalls??=[];window.__credentialCalls.push({name});return {};}};
          createRoot(document.getElementById('root')).render(React.createElement(SlackSettings));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url === "/api/slack/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(empty)); return; }
        if (req.url !== "/__slack") return next();
        res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="en" data-slack-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slack settings fixture</title><style>html[data-slack-fixture],html[data-slack-fixture] body{height:auto;min-height:100%;position:static;overflow:auto}html[data-slack-fixture] #root{height:auto;overflow:visible}</style></head><body><main style="max-width:720px;margin:0 auto;padding:16px"><h1 class="text-ink text-lg">Settings</h1><h2 class="text-ink text-base mb-4">Channels</h2><div id="root"></div></main><script type="module" src="/__slack.js"></script></body></html>');
      }); },
    }] }); await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
test("secure save, explicit pairing, lock, copy, retry and revoke are visible and recoverable", async ({ page }, testInfo) => {
  let state: Record<string, unknown> = { ...empty }, pairs = 0, revokes = 0, retries = 0, fail = false;
  const pageErrors: string[] = []; page.on("pageerror", e => pageErrors.push(e.message));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/slack/status", route => route.fulfill({ json: state }));
  await page.route("**/api/config", route => { const b = route.request().postDataJSON(); expect(b.slack.appToken).toBeUndefined(); expect(b.slack.botToken).toBeUndefined(); state = { ...state, ...b.slack }; return route.fulfill({ json: {} }); });
  await page.route("**/api/slack/pair", route => { pairs++; state = { ...state, requiresRevoke: true, enabled: true, state: "pairing" }; return route.fulfill({ json: { code: "a".repeat(64), expiresAt: Date.now() + 60000 } }); });
  await page.route("**/api/slack/revoke", route => { revokes++; state = { ...state, requiresRevoke: false, enabled: false, paired: false, state: "idle", error: null }; return route.fulfill({ json: {} }); });
  await page.route("**/api/slack/resume", route => { retries++; if (fail) return route.fulfill({ status: 503, json: { error: "private-secret-canary" } }); state = { ...state, state: "connected", paired: true, enabled: true }; return route.fulfill({ json: state }); });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${origin}/__slack`); await page.waitForLoadState("networkidle");
  await expect(page.getByText("Save your Slack credentials", { exact: true })).toBeVisible();
  await page.getByLabel("App-level token", { exact: true }).fill("fake-app-private"); await page.getByLabel("Bot token", { exact: true }).fill("fake-bot-private");
  state = { ...state, configured: true, appConfigured: true, botConfigured: true };
  await page.getByRole("button", { name: "Save credentials", exact: true }).click(); await expect(page.getByText("Credentials saved. Pairing has not started.")).toBeVisible(); expect(pairs).toBe(0);
  await expect(page.getByLabel("App-level token (saved)", { exact: true })).toHaveValue(""); await expect(page.getByLabel("Bot token (saved)", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => (window as any).__credentialCalls)).toEqual([{ name: "slackAppToken" }, { name: "slackBotToken" }]);
  await page.getByLabel("Workspace ID", { exact: true }).fill("TEAM"); await page.getByLabel("App ID", { exact: true }).fill("APP"); await page.getByLabel("Owner member ID", { exact: true }).fill("UOWNER");
  await page.getByRole("button", { name: "Save workspace details" }).click(); await expect(page.getByText("Workspace details saved. Pairing has not started.")).toBeVisible(); expect(pairs).toBe(0);
  await page.getByRole("button", { name: "Pair with Chief" }).click(); await expect(page.getByText("pair " + "a".repeat(64), { exact: true })).toBeVisible();
  await expect(page.getByLabel("Workspace ID", { exact: true })).toBeDisabled(); await expect(page.getByLabel("Bot token (saved)", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Copy pairing message" }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("pair " + "a".repeat(64));
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("a".repeat(64));
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`slack-pairing-${width}.png`), fullPage: true });
  }
  state = { ...state, state: "retry", paired: true, enabled: false, error: "transport-error" };
  await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByText("Connection saved · reconnecting", { exact: true })).toBeVisible();
  await expect(page.getByText("pair " + "a".repeat(64), { exact: true })).toHaveCount(0);
  fail = true; await page.getByRole("button", { name: "Retry connection" }).click(); await expect(page.getByText("Reconnect could not complete.", { exact: false })).toBeVisible(); await expect(page.getByText("private-secret-canary")).toHaveCount(0);
  fail = false; await page.getByRole("button", { name: "Retry connection" }).click(); await expect(page.getByText("Connected to Chief", { exact: true })).toBeVisible(); expect(retries).toBe(2);
  await page.getByRole("button", { name: "Revoke connection" }).click(); expect(revokes).toBe(1); await expect(page.getByLabel("Workspace ID", { exact: true })).toBeEnabled();
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
// The self-review pass, run in-repo: three widths without horizontal scroll,
// axe (the pinned devDependency) with no critical or serious finding, and a
// visible focus ring on every enabled control. It used to shell out to a
// review tool outside the repository, which CI does not have; that tool's
// mobile Lighthouse score was gathered but never asserted, so it is not
// reproduced here.
test("self-review gathers three widths, axe and keyboard focus on the isolated component", async ({ page }, testInfo) => {
  const axe = readFileSync(axeScriptPath, "utf8");
  const report: { viewports: Record<string, { horizontalOverflow: boolean }>; axe: { bySeverity: Record<string, number> }; focus: { missingVisibleFocus: string[] } } =
    { viewports: {}, axe: { bySeverity: {} }, focus: { missingVisibleFocus: [] } };
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`${origin}/__slack`); await page.waitForLoadState("networkidle");
    await expect(page.getByText("Save your Slack credentials", { exact: true })).toBeVisible();
    // The page root may clip (overflow: hidden), so a too-wide box is found by its own edges, not by page scroll.
    report.viewports[width] = { horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
      || [...document.querySelectorAll("#root *")].some(el => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); })) };
    await page.evaluate(axe);
    const result = await page.evaluate(async () => (window as any).axe.run(document)) as { violations: Array<{ id: string; impact: string | null }> };
    for (const violation of result.violations) report.axe.bySeverity[violation.impact ?? "unknown"] = (report.axe.bySeverity[violation.impact ?? "unknown"] ?? 0) + 1;
  }
  const total = await page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],summary')].filter(el => el.getBoundingClientRect().height > 0);
    all.forEach((el, i) => el.dataset.focusAudit = el.getAttribute("aria-label") || el.textContent?.trim() || `#${i}`); return all.length;
  });
  const seen = new Set<string>();
  for (let i = 0; i < total + 2; i++) {
    await page.keyboard.press("Tab");
    const item = await page.evaluate(() => { const el = document.activeElement as HTMLElement; const style = getComputedStyle(el); return { id: el.dataset.focusAudit, focus: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== "none" }; });
    if (item.id === undefined || seen.has(item.id)) continue;
    seen.add(item.id); if (!item.focus) report.focus.missingVisibleFocus.push(item.id);
  }
  await testInfo.attach("self-review-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  expect(Object.keys(report.viewports)).toEqual(["390", "820", "1440"]);
  for (const value of Object.values(report.viewports)) expect(value.horizontalOverflow).toBe(false);
  expect(report.axe.bySeverity.critical ?? 0).toBe(0); expect(report.axe.bySeverity.serious ?? 0).toBe(0);
  expect(seen.size).toBeGreaterThan(0);
  expect(report.focus.missingVisibleFocus).toEqual([]);
});
test("expired challenges and missing secure storage have a visible next action", async ({ page }) => {
  let state: Record<string, unknown> = { ...empty, configured: true, appConfigured: true, botConfigured: true, teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER" };
  await page.route("**/api/slack/status", route => route.fulfill({ json: state }));
  await page.route("**/api/slack/pair", route => { state = { ...state, state: "pairing", requiresRevoke: true, enabled: true }; return route.fulfill({ json: { code: "b".repeat(64), expiresAt: Date.now() + 1000 } }); });
  await page.goto(`${origin}/__slack`); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Pair with Chief" }).click(); await expect(page.getByText("Pairing code expired", { exact: true })).toBeVisible();
  await expect(page.getByText("/pair " + "b".repeat(64))).toHaveCount(0); await expect(page.getByText("The code expired.", { exact: false })).toBeVisible();
  state = { ...empty };
  await page.evaluate(() => { (window as any).muragebox = {}; }); await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Secure storage is unavailable", { exact: false })).toBeVisible(); await expect(page.getByRole("button", { name: "Save credentials", exact: true })).toBeDisabled();
});
