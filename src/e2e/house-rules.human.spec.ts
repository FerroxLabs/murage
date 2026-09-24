// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → House rules in a real browser against the REAL harness: the
// page's /api calls are proxied to a verification server with the desktop
// proof, so the stored file, the on/off switch and reset run for real.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, headers: Record<string, string>;
type Rules = { text: string; enabled: boolean; isDefault: boolean };
const rules = async (): Promise<Rules> => (await (await fetch(harness.info.url + "/api/house-rules", { headers })).json()) as Rules;

test.beforeAll(async () => {
  harness = await launchVerificationServer(process.env);
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-house-rules-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/house-rules-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [tailwindcss(), {
      name: "house-rules-fixture",
      resolveId(id) { if (id === "/__rules.js") return "\0house-rules"; if (id === "/house-rules-fixture-store") return "\0house-rules-store"; },
      load(id) {
        // The real api() contract: JSON in and out, a refusal carries its message.
        if (id === "\0house-rules-store") return "export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}";
        if (id !== "\0house-rules") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {HouseRulesSettings} from '/src/components/HouseRulesSettings.tsx';import '/src/styles.css';const q=new URLSearchParams(location.search);document.documentElement.dataset.skin=q.get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(HouseRulesSettings));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__rules" || req.url?.startsWith("/__rules?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main id="root" style="padding:16px;max-width:720px;margin:16px auto"></main><script type="module" src="/__rules.js"></script>');
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

test("edit and save the house rules, switch them off, and reset to the default", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.goto(origin + "/__rules?skin=dark");
  await expect(page.getByRole("heading", { name: "House rules", exact: true })).toBeVisible();
  await expect(page.getByText("Every bot follows these. Write them once, in your own words.")).toBeVisible();
  const box = page.getByRole("textbox", { name: "House rules" });
  await expect(box.getByRole("heading", { name: "Who you work for" })).toBeVisible();
  await expect(page.getByTestId("house-rules-length")).toContainText("words. Every bot reads these on every reply");
  await expect(page.getByText("Always on, even with house rules off")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset to default" })).toHaveCount(0);
  expect((await rules()).isDefault).toBe(true);
  await page.screenshot({ path: info.outputPath("house-rules-dark.png"), fullPage: true });

  // Add a section at the top with the "/" menu.
  await box.locator("h1").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.getByRole("listbox", { name: "Insert a block" }).getByRole("option", { name: /^Heading 2/ }).click();
  await page.keyboard.type("Our business");
  await page.keyboard.press("Enter");
  await page.keyboard.type("We sell handmade candles. Prices are on the website.");
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Saved. Bots use the new rules from their next reply.");
  const saved = await rules();
  expect(saved.isDefault).toBe(false);
  expect(saved.text).toContain("# House Rules\n\n## Our business\n\nWe sell handmade candles. Prices are on the website.\n\n");
  expect(saved.text).toContain("## Who you work for");

  // The switch applies at once.
  const onOff = page.getByRole("switch", { name: "Use house rules" });
  await expect(onOff).toHaveAttribute("aria-checked", "true");
  await onOff.click();
  await expect(onOff).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("House rules are off, so bots don't read them.")).toBeVisible();
  expect((await rules()).enabled).toBe(false);
  await onOff.click();
  await expect(onOff).toHaveAttribute("aria-checked", "true");
  expect((await rules()).enabled).toBe(true);

  // Reset asks inline first, then puts the shipped text back.
  await page.getByRole("button", { name: "Reset to default" }).click();
  const confirm = page.getByRole("group", { name: "Reset to default" });
  await expect(confirm).toContainText("Put back the default house rules?");
  await page.screenshot({ path: info.outputPath("house-rules-reset.png"), fullPage: true });
  await confirm.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByRole("status")).toHaveText("The default house rules are back.");
  await expect(box.getByRole("heading", { name: "Our business" })).toHaveCount(0);
  const reset = await rules();
  expect(reset.isDefault).toBe(true);
  expect(reset.text).not.toContain("Our business");
});

test("a text over the size bound is refused in plain words", async ({ page }) => {
  await page.goto(origin + "/__rules?skin=light");
  const box = page.getByRole("textbox", { name: "House rules" });
  await expect(box).toBeVisible();
  await box.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" long".repeat(4500));
  await expect(page.getByTestId("house-rules-length")).toContainText("slower and costlier");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("House rules can be up to 20 KB.");
  expect((await rules()).isDefault).toBe(true);
});

test("light skin", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.goto(origin + "/__rules?skin=light");
  await expect(page.getByRole("textbox", { name: "House rules" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("house-rules-light.png"), fullPage: true });
});
