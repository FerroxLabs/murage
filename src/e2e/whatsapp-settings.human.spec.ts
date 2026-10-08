// SPDX-License-Identifier: AGPL-3.0-or-later
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
const settings = { mode: "self-chat", allowFrom: [], groups: { policy: "disabled", allow: [], senders: "members" }, readReceipts: false, quoteReplies: "groups" };
const empty = { state: "idle", linked: false, enabled: false, busy: false, error: null, blockedReason: null, nextRetryAt: null, pending: 0, uncertain: 0, rejected: 0,
  needsReview: 0, ingressWriteFailed: false, catchUpTruncated: false, number: null, pairing: [], settings };
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-whatsapp-ui-cache-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false, resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
      name: "whatsapp-settings-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__whatsapp.js") return "\0whatsapp-fixture"; if (id === "@/state/store" || /\/src\/state\/store(?:\.ts)?$/.test(id)) return "\0whatsapp-fixture-api"; },
      load(id) {
        if (id === "\0whatsapp-fixture-api") return `export async function api(path,init){const r=await fetch(path,init);if(!r.ok)throw new Error('fixture request failed');return r.json();}`;
        if (id !== "\0whatsapp-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {WhatsAppSettings} from '/src/components/WhatsAppSettings.tsx';import '/src/styles.css';
          createRoot(document.getElementById('root')).render(React.createElement(WhatsAppSettings));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/__whatsapp") return next();
        res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="en" data-wa-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp settings fixture</title><style>html[data-wa-fixture],html[data-wa-fixture] body{height:auto;min-height:100%;position:static;overflow:auto}html[data-wa-fixture] #root{height:auto;overflow:visible}</style></head><body><main style="max-width:720px;margin:0 auto;padding:16px"><h1 class="text-ink text-lg">Settings</h1><h2 class="text-ink text-base mb-4">Channels</h2><div id="root"></div></main><script type="module" src="/__whatsapp.js"></script></body></html>');
      }); },
    }] }); await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
test("link by QR or code, choose who can message, approve a contact, enable a group and unlink", async ({ page }, testInfo) => {
  let state: Record<string, any> = JSON.parse(JSON.stringify(empty)); const calls: string[] = []; let failResume = false;
  const pageErrors: string[] = []; page.on("pageerror", e => pageErrors.push(e.message));
  await page.route("**/api/whatsapp/status", route => route.fulfill({ json: state }));
  await page.route("**/api/memory/action", route => route.fulfill({ json: { ownerPersonId: "owner", bindings: [{ active: true, personId: "p-ana", origin: { platform: "whatsapp", userId: "4915550000" } }] } }));
  await page.route("**/api/whatsapp/link", route => {
    const body = route.request().postDataJSON(); calls.push(`link:${body.method}:${body.phone ?? ""}`);
    state = { ...state, state: "linking", ...(body.method === "code" ? { pairingCode: { code: "ABCD2345", phone: body.phone } } : { qr: { text: "2@fixture-qr-text", version: 1 } }) };
    return route.fulfill({ json: state });
  });
  await page.route("**/api/config", route => {
    const patch = route.request().postDataJSON().whatsapp; calls.push(`config:${Object.keys(patch).join(",")}`);
    state = { ...state, settings: { ...state.settings, ...patch } }; return route.fulfill({ json: {} });
  });
  await page.route("**/api/whatsapp/groups", route => route.fulfill({ json: { groups: [{ jid: "123@g.us", name: "Family" }, { jid: "456@g.us", name: "Work" }] } }));
  await page.route("**/api/whatsapp/approve", route => { const b = route.request().postDataJSON(); calls.push(`approve:${b.code}:${b.personId ?? "new"}`); state = { ...state, pairing: [] }; return route.fulfill({ json: { userId: "u" } }); });
  await page.route("**/api/whatsapp/dismiss", route => { calls.push(`dismiss:${route.request().postDataJSON().code}`); state = { ...state, pairing: [] }; return route.fulfill({ json: state }); });
  await page.route("**/api/whatsapp/resume", route => { calls.push("resume"); if (failResume) return route.fulfill({ status: 503, json: { error: "private-secret-canary" } }); state = { ...state, state: "connected", linked: true }; return route.fulfill({ json: state }); });
  await page.route("**/api/whatsapp/unlink", route => { calls.push("unlink"); state = JSON.parse(JSON.stringify(empty)); return route.fulfill({ json: state }); });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${origin}/__whatsapp`); await page.waitForLoadState("networkidle");

  await expect(page.getByText("Link your own WhatsApp number", { exact: true })).toBeVisible();
  await expect(page.getByText("WhatsApp may restrict or remove a number", { exact: false })).toBeVisible();
  await expect(page.getByText("Not linked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Link WhatsApp", exact: true }).click();
  await expect(page.getByText("Scan this code with the phone that owns the number.", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "WhatsApp link code" }).locator("svg")).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("fixture-qr-text");
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`whatsapp-qr-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Unlink", exact: true }).click(); await page.getByRole("button", { name: "Yes, unlink" }).click();
  await expect(page.getByText("Not linked", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Link with a code instead" }).click();
  await page.getByLabel("Phone number with country code").fill("+1 555 123 4567");
  await page.getByRole("button", { name: "Link WhatsApp", exact: true }).click();
  await expect(page.getByLabel("Pairing code")).toHaveText("ABCD2345"); await expect(page.getByText("Code issued for +15551234567")).toBeVisible();
  expect(calls).toContain("link:code:15551234567");

  state = { ...state, state: "connected", linked: true, enabled: true, number: "+•••• 4567", pairingCode: undefined, qr: undefined };
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Linked to +•••• 4567 as Murage Desktop.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Contact number with country code")).toHaveCount(0);
  await page.getByLabel("Me and chosen contacts").click(); await expect(page.getByLabel("Me and chosen contacts")).toBeChecked(); await expect(page.getByText("WhatsApp settings saved.")).toBeVisible();
  await page.getByLabel("Contact number with country code").fill("not a number"); await page.getByRole("button", { name: "Add number" }).click();
  await expect(page.getByText("Enter the number with its country code, digits only.")).toBeVisible();
  await page.getByLabel("Contact number with country code").fill("+49 155 5000 0001"); await page.getByRole("button", { name: "Add number" }).click();
  await expect(page.getByText("+4915550000001", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove +4915550000001" }).click(); await expect(page.getByText("No contacts are allowed yet.")).toBeVisible();

  state = { ...state, pairing: [{ id: "abc123abc123", name: "Ana", number: "+•••• 0001", expiresAt: Date.now() + 3600000 }] };
  await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByText("Ana sent a message from +•••• 0001")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve this contact" })).toBeDisabled();
  await page.getByLabel("Code they were given").fill("k7m2q9"); await expect(page.getByLabel("Approve as").locator("option")).toHaveText(["A new person", "whatsapp 4915550000"]);
  await page.getByLabel("Approve as").selectOption("p-ana"); await page.getByRole("button", { name: "Approve this contact" }).click();
  await expect(page.getByText("Contact approved.")).toBeVisible(); expect(calls).toContain("approve:K7M2Q9:p-ana");

  await page.getByLabel("Allow chosen groups").click(); await expect(page.getByLabel("Allow chosen groups")).toBeChecked(); await page.getByRole("button", { name: "Load my groups" }).click();
  await page.getByLabel("Use Family in Murage").click(); await expect(page.getByLabel("Use Family in Murage")).toBeChecked(); await expect(page.getByLabel("Activation for Family")).toHaveValue("mention");
  await page.getByLabel("Activation for Family").selectOption("always");
  await expect.poll(() => state.settings.groups.allow as any[]).toEqual([{ jid: "123@g.us", name: "Family", activation: "always" }]);
  await page.getByLabel("Send read receipts").click(); await expect(page.getByLabel("Send read receipts")).toBeChecked(); await expect.poll(() => state.settings.readReceipts).toBe(true);
  await page.getByLabel("Quote the message being answered").selectOption("off"); await expect.poll(() => state.settings.quoteReplies).toBe("off");

  state = { ...state, state: "retry" }; await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("WhatsApp is reconnecting.", { exact: true })).toBeVisible();
  state = { ...state, state: "blocked", blockedReason: "retry-limit" }; await page.getByRole("button", { name: "Refresh status" }).click();
  failResume = true; await page.getByRole("button", { name: "Resume" }).click(); await expect(page.getByText("Reconnect could not complete.", { exact: false })).toBeVisible(); await expect(page.getByText("private-secret-canary")).toHaveCount(0);
  failResume = false; await page.getByRole("button", { name: "Resume" }).click(); await expect(page.getByText("Linked to +•••• 4567 as Murage Desktop.", { exact: true })).toBeVisible();
  state = { ...state, state: "conflict" }; await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Another WhatsApp Web session took over this link. Relink to continue here.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Relink", exact: true })).toBeVisible();
  state = { ...state, state: "connected" }; await page.getByRole("button", { name: "Refresh status" }).click();
  await page.getByRole("button", { name: "Unlink", exact: true }).click(); await page.getByRole("button", { name: "Yes, unlink" }).click();
  await expect(page.getByText("Not linked", { exact: true })).toBeVisible(); expect(calls.filter(c => c === "unlink")).toHaveLength(2);
  expect(pageErrors).toEqual([]);
});
test("self-review gathers three widths, axe and keyboard focus on the isolated component", async ({ page }, testInfo) => {
  const axe = readFileSync(axeScriptPath, "utf8");
  await page.route("**/api/whatsapp/status", route => route.fulfill({ json: { ...empty, state: "connected", linked: true, enabled: true, number: "+•••• 4567", settings: { ...settings, mode: "contacts", allowFrom: ["15551230000"], groups: { policy: "allowlist", allow: [{ jid: "1@g.us", name: "Family", activation: "mention" }], senders: "members" } },
    pairing: [{ id: "abc", name: null, number: "+•••• 1111", expiresAt: Date.now() + 3600000 }] } }));
  await page.route("**/api/memory/action", route => route.fulfill({ json: { ownerPersonId: "owner", bindings: [] } }));
  const report: { viewports: Record<string, { horizontalOverflow: boolean }>; axe: { bySeverity: Record<string, number> }; focus: { missingVisibleFocus: string[] } } =
    { viewports: {}, axe: { bySeverity: {} }, focus: { missingVisibleFocus: [] } };
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`${origin}/__whatsapp`); await page.waitForLoadState("networkidle");
    await expect(page.getByText("Linked to +•••• 4567 as Murage Desktop.", { exact: true })).toBeVisible();
    report.viewports[width] = { horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
      || [...document.querySelectorAll("#root *")].some(el => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); })) };
    await page.evaluate(axe);
    const result = await page.evaluate(async () => (window as any).axe.run(document)) as { violations: Array<{ id: string; impact: string | null }> };
    for (const violation of result.violations) report.axe.bySeverity[violation.impact ?? "unknown"] = (report.axe.bySeverity[violation.impact ?? "unknown"] ?? 0) + 1;
  }
  const total = await page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')].filter(el => el.getBoundingClientRect().height > 0);
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
  expect(seen.size).toBeGreaterThan(0); expect(report.focus.missingVisibleFocus).toEqual([]);
});
