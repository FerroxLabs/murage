// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What shapes <bot>" in a real browser against the REAL harness: the page's
// /api calls are proxied to a verification server with the desktop proof and
// the fake Claude engine, so the last turn, the House Rules switch and the
// per-bot team brief switch all run for real. The store's dispatch is
// recorded on window so the Edit links can be checked without the whole app.
// The app's stylesheet pins the page itself, so the fixture's <main> scrolls,
// and it carries the bot window's own h1 and section h2 around the panel.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { axeScriptPath } from "./axe";

const BRIEF = "SHAPES_UI_BRIEF the Ops team ships on Thursdays.";
let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, headers: Record<string, string>;
let moss: { id: string; name: string; threadId: string };

const call = async (method: string, path: string, body?: unknown) =>
  (await (await fetch(harness.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json()) as any;
const shapes = () => call("GET", `/api/bots/${moss.id}/shapes`);
const idle = async () => { const state = await call("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy); };

test.beforeAll(async () => {
  harness = await launchVerificationServer(process.env);
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  const model = (await call("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  moss = (await call("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot;
  await call("PATCH", `/api/bots/${moss.id}`, { computer: "off", browser: false, composio: false, section: "Ops", description: "Keeps the garden notes." });
  await call("PUT", "/api/section-context?section=Ops", { text: BRIEF });

  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-bot-shapes-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/shapes-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [tailwindcss(), {
      name: "bot-shapes-fixture",
      resolveId(id) { if (id === "/__shapes.js") return "\0bot-shapes"; if (id === "/shapes-fixture-store") return "\0shapes-store"; },
      load(id) {
        // The real api() contract, and a dispatch that only records what it was asked.
        if (id === "\0shapes-store") return "export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}window.__dispatched=[];export function useStore(){return {state:{config:{},botSettingsIntent:null},dispatch(action){window.__dispatched.push(action);}};}";
        if (id !== "\0bot-shapes") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {BotShapesPanel} from '/src/components/BotShapesPanel.tsx';import '/src/styles.css';const q=new URLSearchParams(location.search);document.documentElement.dataset.skin=q.get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(BotShapesPanel,{bot:{id:q.get('id'),name:q.get('name')}}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__shapes?")) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>What shapes Moss</title><body style="margin:0;background:var(--color-app)"><main style="box-sizing:border-box;height:100dvh;overflow:auto;padding:16px;max-width:760px;margin:0 auto"><h1 style="font-size:18px">Bot settings</h1><h2 style="font-size:17px">What shapes Moss</h2><div id="root"></div></main><script type="module" src="/__shapes.js"></script></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); await harness?.close(); safeWipeSync(cache); });
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.log("page error:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("console error:", message.text()); });
  page.on("dialog", (dialog) => { throw new Error(`a native ${dialog.type()} dialog opened`); });
});
const open = async (page: import("@playwright/test").Page, skin = "dark") => {
  await page.goto(`${origin}/__shapes?id=${moss.id}&name=Moss&skin=${skin}`);
  await expect(page.getByRole("heading", { name: "Your rules" })).toBeVisible();
};
const rowOf = (page: import("@playwright/test").Page, id: string) => page.locator(`[data-shape-row="${id}"]`);

test("before its first reply: grouped rows, locks, and the turn's parts left to the first message", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 2400 });
  await open(page);
  for (const heading of ["Your rules", "Who it is", "What it can use", "This turn"]) await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Use House rules" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Use Team brief" })).toHaveAttribute("aria-checked", "true");
  await expect(rowOf(page, "credential")).toContainText("Always on");
  await expect(rowOf(page, "credential").getByRole("switch")).toHaveCount(0);
  await rowOf(page, "capabilities").getByRole("button", { name: "View What it can do right now" }).click();
  await expect(rowOf(page, "capabilities")).toContainText("Decided when a message arrives.");
  await rowOf(page, "team-brief").getByRole("button", { name: "View Team brief" }).click();
  await expect(rowOf(page, "team-brief")).toContainText(BRIEF);
  await page.getByRole("button", { name: "Show exactly what it read" }).click();
  await expect(page.getByText("Moss hasn't replied yet. Send it a message, then look here.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("shapes-before-turn-dark.png"), fullPage: true });
  await page.addScriptTag({ content: readFileSync(axeScriptPath, "utf8") });
  const report = await page.evaluate(async () => (window as any).axe.run(document));
  writeFileSync(info.outputPath("shapes-axe.json"), JSON.stringify(report, null, 2));
  expect(report.violations).toEqual([]);
});

test("after a reply: shows exactly what it read, and the switches reach the next turn", async ({ page }, info) => {
  await call("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: "Please answer briefly." });
  await expect.poll(async () => (await shapes()).lastTurn !== null, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  const sent = (await shapes()).lastTurn.text as string;
  expect(sent).toContain(BRIEF);

  await page.setViewportSize({ width: 900, height: 2400 });
  await open(page);
  await page.getByRole("button", { name: "Show exactly what it read" }).click();
  const all = page.getByLabel("Everything Moss read on its last reply");
  await expect(all).toBeVisible();
  expect(await all.textContent()).toBe(sent);
  await rowOf(page, "capabilities").getByRole("button", { name: "View What it can do right now" }).click();
  await expect(rowOf(page, "capabilities")).not.toContainText("Decided when a message arrives.");
  await page.screenshot({ path: info.outputPath("shapes-after-turn-dark.png"), fullPage: true });

  // The team brief, off for Moss only.
  const brief = page.getByRole("switch", { name: "Use Team brief" });
  await brief.click();
  await expect(brief).toHaveAttribute("aria-checked", "false");
  await expect(rowOf(page, "team-brief")).toContainText("Off. Moss doesn't read this now.");
  expect((await shapes()).rows.find((row: any) => row.id === "team-brief").on).toBe(false);
  await call("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: "And again, briefly." });
  await expect.poll(async () => (await shapes()).lastTurn.text !== sent, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  expect((await shapes()).lastTurn.text).not.toContain(BRIEF);
  await brief.click();
  await expect(brief).toHaveAttribute("aria-checked", "true");

  // House Rules, the same switch as Settings.
  const rules = page.getByRole("switch", { name: "Use House rules" });
  await rules.click();
  await expect(rules).toHaveAttribute("aria-checked", "false");
  expect((await call("GET", "/api/house-rules")).enabled).toBe(false);
  await rules.click();
  await expect(rules).toHaveAttribute("aria-checked", "true");
  expect((await call("GET", "/api/house-rules")).enabled).toBe(true);

  // Edit links go where the text is edited.
  await rowOf(page, "house-rules").getByRole("button", { name: "Edit in Settings House rules" }).click();
  await rowOf(page, "persona").getByRole("button", { name: "Edit Description and personality" }).click();
  expect(await page.evaluate(() => (window as any).__dispatched)).toEqual([
    { type: "toggleAppSettings", open: true, section: "houseRules" },
    { type: "toggleSettings", open: true, intent: { section: "identity" } },
  ]);
});

test("light skin and a phone width", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 2400 });
  await open(page, "light");
  await rowOf(page, "persona").getByRole("button", { name: "View Description and personality" }).click();
  await expect(rowOf(page, "persona")).toContainText("About: Keeps the garden notes.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("shapes-phone-light.png"), fullPage: true });
});
