// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S23: the Phone card in bot settings (src/components/PhoneAccessCard.tsx) in a real browser against the REAL harness.
// The page's /api calls are proxied to a verification server with the desktop proof, the flag is on, and the card is mounted for a real
// bot. Toggling Calendar to read sends exactly { phoneApps: { calendar: "read" } }, and the setting is still there after a reload.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, headers: Record<string, string>, botId: string;
const call = async (path: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await fetch(harness.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return response.json().catch(() => ({}));
};

test.beforeAll(async () => {
  // Phone tools are offered only to a host that carries the desktop launch proof; a verification server gets its stand-in from this variable.
  harness = await launchVerificationServer({ ...process.env, MURAGE_TEST_DOOR_TOKEN: "ab".repeat(32) });
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  await call("/api/config", "PATCH", { features: { phoneTools: true } });
  botId = ((await call("/api/bots", "POST", { name: "Phone card bot", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot as { id: string }).id;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-phone-card-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/phone-card-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [tailwindcss(), {
      name: "phone-card-fixture",
      resolveId(id) { if (id === "/__phone.js") return "\0phone-card"; if (id === "/phone-card-fixture-store") return "\0phone-card-store"; },
      load(id) {
        // The real api() contract: JSON in and out, a refusal carries its message. useStore answers the one instance the bot is on, as a Claude agent driver.
        if (id === "\0phone-card-store") return "export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}export function useStore(){return {state:{instances:globalThis.__phoneCardInstances||[]}};}";
        if (id !== "\0phone-card") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {PhoneAccessCard} from '/src/components/PhoneAccessCard.tsx';import '/src/styles.css';"
          + "const id=new URLSearchParams(location.search).get('bot');"
          + "const r=await fetch('/api/bots/'+id);const body=await r.json();const bot=body.bot||body;"
          + "globalThis.__phoneCardInstances=[{instanceId:bot.modelSelection.instanceId,driverKind:'claudeAgent'}];"
          + "createRoot(document.getElementById('root')).render(React.createElement(PhoneAccessCard,{bot}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__phone" || req.url?.startsWith("/__phone?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone card</title><body style="margin:0;background:var(--color-app)"><main style="padding:16px;max-width:720px;margin:16px auto"><div id="root"></div></main><script type="module" src="/__phone.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); await harness?.close(); safeWipeSync(cache); });
test.beforeEach(({ page }) => {
  page.on("dialog", (dialog) => { throw new Error(`a native ${dialog.type()} dialog opened`); });
});

test("toggling Calendar to read sends only the phoneApps grant, and it is still set after a reload", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`${origin}/__phone?bot=${encodeURIComponent(botId)}`);
  const card = page.getByTestId("phone-access-card");
  // Diagnostics for a card that never mounts: what the page sees for the two answers the card waits on.
  const seen = await card.waitFor({ timeout: 8000 }).then(() => "", async () => JSON.stringify(await page.evaluate(async () => {
    const out: Record<string, unknown> = { root: document.getElementById("root")?.innerHTML.slice(0, 300) };
    for (const path of ["/api/config", "/api/phones/offered", "/api/desktop-secret"]) {
      try { const r = await fetch(path); out[path] = r.status + " " + (await r.text()).slice(0, 200); } catch (e) { out[path] = String(e); }
    }
    return out;
  })));
  if (seen) console.log("PHONE CARD DIAG " + seen);
  await expect(card).toBeVisible();
  const calendar = card.locator("select").first();
  await expect(calendar).toHaveValue("off");
  const patch = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith(`/api/bots/${botId}`));
  await calendar.selectOption("read");
  expect((await patch).postDataJSON()).toEqual({ phoneApps: { calendar: "read" } });
  await expect(calendar).toBeEnabled();
  expect((await call(`/api/bots/${botId}`)).bot?.phoneApps ?? (await call(`/api/bots/${botId}`)).phoneApps).toEqual({ calendar: "read" });
  await page.reload();
  await expect(page.getByTestId("phone-access-card").locator("select").first()).toHaveValue("read");
});
