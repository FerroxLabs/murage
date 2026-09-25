// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → About me in a real browser against the REAL harness: the
// page's /api calls are proxied to a verification server with the desktop
// proof, so the starting text, the stored file and the cap run for real.
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

let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, headers: Record<string, string>;
type About = { text: string; saved: boolean; suggestion: string };
const about = async (): Promise<About> => (await (await fetch(harness.info.url + "/api/about-me", { headers })).json()) as About;

test.beforeAll(async () => {
  harness = await launchVerificationServer(process.env);
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-about-me-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/about-me-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [tailwindcss(), {
      name: "about-me-fixture",
      resolveId(id) { if (id === "/__about.js") return "\0about-me"; if (id === "/about-me-fixture-store") return "\0about-me-store"; },
      load(id) {
        // The real api() contract: JSON in and out, a refusal carries its message.
        if (id === "\0about-me-store") return "export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}";
        if (id !== "\0about-me") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {AboutMeSettings} from '/src/components/AboutMeSettings.tsx';import '/src/styles.css';const q=new URLSearchParams(location.search);document.documentElement.dataset.skin=q.get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(AboutMeSettings));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__about" || req.url?.startsWith("/__about?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About me</title><body style="margin:0;background:var(--color-app)"><main style="padding:16px;max-width:720px;margin:16px auto"><h1 style="font-size:18px">Settings</h1><h2 style="font-size:16px">Your profile</h2><div id="root"></div></main><script type="module" src="/__about.js"></script>');
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

test("opens on a starting text of what Murage knows, and saves the owner's own words", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(origin + "/__about?skin=dark");
  await expect(page.getByRole("heading", { name: "About me", exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("People who message your bots on Telegram, Slack or Discord never see it.");
  expect((await about()).saved).toBe(false);
  const box = page.getByRole("textbox", { name: "About me" });
  await expect(box).toContainText("My time zone is");
  await expect(page.getByText("We started this with what Murage already knows.")).toBeVisible();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();
  await expect(page.getByTestId("about-me-length")).toContainText("of 4,000 characters");
  await page.screenshot({ path: info.outputPath("about-me-dark.png"), fullPage: true });

  await box.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("I run a small candle shop. Keep answers short.");
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Saved. Bots use it from their next reply.");
  const saved = await about();
  expect(saved.saved).toBe(true);
  expect(saved.text).toContain("My time zone is");
  expect(saved.text).toContain("I run a small candle shop. Keep answers short.");
  await expect(save).toBeDisabled();

  await page.addScriptTag({ content: readFileSync(axeScriptPath, "utf8") });
  const report = await page.evaluate(async () => (window as any).axe.run(document));
  writeFileSync(info.outputPath("about-me-axe.json"), JSON.stringify(report, null, 2));
  expect(report.violations.map((violation: { id: string }) => violation.id)).toEqual([]);

  // Reopened, it shows what was saved and offers no starting text again.
  await page.reload();
  await expect(box).toContainText("I run a small candle shop.");
  await expect(page.getByText("We started this with what Murage already knows.")).toHaveCount(0);
});

test("over the cap, the counter says so and Save waits", async ({ page }) => {
  await page.goto(origin + "/__about?skin=light");
  const box = page.getByRole("textbox", { name: "About me" });
  await expect(box).toBeVisible();
  await box.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" long".repeat(900));
  await expect(page.getByTestId("about-me-length")).toContainText("to save.");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  expect((await about()).text).not.toContain("long long");
});

test("light skin on a phone-width window", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__about?skin=light");
  await expect(page.getByRole("textbox", { name: "About me" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("about-me-light-phone.png"), fullPage: true });
});
