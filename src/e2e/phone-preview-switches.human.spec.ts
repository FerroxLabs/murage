// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.12 phone preview switches (src/components/PhonePreviewSwitches.tsx, Settings > Phone and other devices > Preview) in a real browser
// against the REAL harness and the REAL companion door. The page's /api calls go to a verification server with the desktop proof.
// Switch on: the door's /healthz (what the phone reads) shows phoneJobs and phoneAsk. Switch off: they go, and every /api/phones/* route
// the phone uses is absent. /healthz always carries phoneFlags: 1. Defaults are off.
import { test, expect } from "./page-error-guard";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { createBrowserHandler, type BrowserDeviceStore } from "../../companion/src/browser.ts";

const DOOR_TOKEN = "ab".repeat(32);
let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, headers: Record<string, string>;
const call = async (path: string, method = "GET", body?: unknown, extra: Record<string, string> = headers): Promise<{ status: number; body: any }> => {
  const response = await fetch(harness.info.url + path, { method, headers: extra, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const noDevices = (): BrowserDeviceStore => ({
  redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
  issuePushTokens: () => null, pushBinding: () => null, authenticatePush: () => null, approvalIdentity: () => null,
  resolveSession: () => null, sessionDeadline: () => null,
});
/** GET /healthz from a fresh companion door in front of the harness (a fresh door, so its 5 s offer cache never answers for the last state). */
const healthz = async (): Promise<Record<string, unknown>> => {
  const door: Server = createHttpServer(createBrowserHandler({
    harnessPort: Number(new URL(harness.info.url).port), companionToken: DOOR_TOKEN, serverName: () => "Preview fixture",
    identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices: noDevices(),
  }));
  await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(door.address() as AddressInfo).port}/healthz`);
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
  } finally {
    door.closeAllConnections();
    await new Promise<void>((resolve) => door.close(() => resolve()));
  }
};
/** The routes the phone's own runners call, with the door's phone envelopes, and the desktop's phone list: present only while their flag is on. */
const DEVICE = "22222222-2222-4222-8222-222222222222";
const phoneRoutes = async () => {
  const jobs = { "x-murage-door-token": DOOR_TOKEN, "x-murage-phone-device": DEVICE, "x-murage-phone-scope": "jobs" };
  const ask = { "x-murage-door-token": DOOR_TOKEN, "x-murage-phone-device": DEVICE, "x-murage-phone-scope": "ask", "x-murage-phone-ask-gen": "1" };
  return {
    jobs: (await call("/api/phones/self/jobs", "GET", undefined, jobs)).status,
    targets: (await call("/api/phones/self/targets", "GET", undefined, ask)).status,
    list: (await call("/api/phones")).status,
  };
};
/** The saved feature flags, read from the harness's own config.json (GET /api/config lists only the flags the app reads). */
const savedFeatures = (): Record<string, unknown> => JSON.parse(readFileSync(join(harness.info.dataDir, "config.json"), "utf8")).features ?? {};

test.beforeAll(async () => {
  // Phone features are offered only to a host with the desktop launch proof; a verification server gets its stand-in from this variable.
  harness = await launchVerificationServer({ ...process.env, MURAGE_TEST_DOOR_TOKEN: DOOR_TOKEN });
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  // another flag, to prove each switch's write keeps it
  expect((await call("/api/config", "PATCH", { features: { showToolCalls: false } })).status).toBe(200);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-phone-preview-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/phone-preview-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [tailwindcss(), {
      name: "phone-preview-fixture",
      resolveId(id) { if (id === "/__preview.js") return "\0phone-preview"; if (id === "/phone-preview-fixture-store") return "\0phone-preview-store"; },
      load(id) {
        // The real api() contract: JSON in and out, a refusal carries its message.
        if (id === "\0phone-preview-store") return "export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}";
        if (id !== "\0phone-preview") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {PhonePreviewSwitches} from '/src/components/PhonePreviewSwitches.tsx';import '/src/styles.css';"
          + "createRoot(document.getElementById('root')).render(React.createElement(PhonePreviewSwitches,{}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/__preview") return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone preview</title><body style="margin:0;background:var(--color-app)"><main style="padding:16px;max-width:720px;margin:16px auto"><div id="root"></div></main><script type="module" src="/__preview.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); await harness?.close(); if (cache) safeWipeSync(cache); });
test.beforeEach(({ page }) => {
  page.on("dialog", (dialog) => { throw new Error(`a native ${dialog.type()} dialog opened`); });
});

test("switch on: /healthz shows phoneJobs and phoneAsk; switch off: they go and /api/phones/* is absent", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`${origin}/__preview`);
  const card = page.getByTestId("phone-preview-switches");
  await expect(card).toBeVisible();
  const tools = page.getByRole("switch", { name: "Phone tools (preview)" });
  const share = page.getByRole("switch", { name: "Share and ask (preview)" });
  await expect(tools).toBeEnabled();

  // defaults off; the door already says it has the switches
  await expect(tools).toHaveAttribute("aria-checked", "false");
  await expect(share).toHaveAttribute("aria-checked", "false");
  let hello = await healthz();
  expect(hello.phoneFlags).toBe(1);
  expect(hello).not.toHaveProperty("phoneJobs");
  expect(hello).not.toHaveProperty("phoneAsk");
  expect(await phoneRoutes()).toEqual({ jobs: 404, targets: 404, list: 404 });

  // phone tools on: exactly its own body, and the door shows phoneJobs only
  let patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/api/config"));
  await tools.click();
  expect((await patch).postDataJSON()).toEqual({ features: { phoneTools: true } });
  await expect(tools).toHaveAttribute("aria-checked", "true");
  await expect(tools).toBeEnabled();
  hello = await healthz();
  expect(hello).toMatchObject({ phoneFlags: 1, phoneJobs: 1 });
  expect(hello).not.toHaveProperty("phoneAsk");

  // share and ask on: its own body, and the door shows both
  patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/api/config"));
  await share.click();
  expect((await patch).postDataJSON()).toEqual({ features: { phoneShareAsk: true } });
  await expect(share).toHaveAttribute("aria-checked", "true");
  await expect(share).toBeEnabled();
  expect(await healthz()).toMatchObject({ phoneFlags: 1, phoneJobs: 1, phoneAsk: 1 });
  // offered on this host: no reason line under either switch
  await expect(page.locator("[data-preview-reason]")).toHaveCount(0);
  const routesOn = await phoneRoutes();
  expect(routesOn.list).toBe(200);
  expect(routesOn.jobs).not.toBe(404);
  expect(routesOn.targets).not.toBe(404);

  // both writes kept the other flags, and the switches read back the same after a reload
  expect(savedFeatures()).toMatchObject({ phoneTools: true, phoneShareAsk: true, showToolCalls: false });
  await page.reload();
  await expect(page.getByRole("switch", { name: "Phone tools (preview)" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Share and ask (preview)" })).toHaveAttribute("aria-checked", "true");

  // both off: the door drops both, and the phone's routes are absent again
  patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/api/config"));
  await page.getByRole("switch", { name: "Phone tools (preview)" }).click();
  expect((await patch).postDataJSON()).toEqual({ features: { phoneTools: false } });
  await expect(page.getByRole("switch", { name: "Phone tools (preview)" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Phone tools (preview)" })).toBeEnabled();
  hello = await healthz();
  expect(hello).toMatchObject({ phoneFlags: 1, phoneAsk: 1 });
  expect(hello).not.toHaveProperty("phoneJobs");
  patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/api/config"));
  await page.getByRole("switch", { name: "Share and ask (preview)" }).click();
  expect((await patch).postDataJSON()).toEqual({ features: { phoneShareAsk: false } });
  await expect(page.getByRole("switch", { name: "Share and ask (preview)" })).toHaveAttribute("aria-checked", "false");
  hello = await healthz();
  expect(hello.phoneFlags).toBe(1);
  expect(hello).not.toHaveProperty("phoneJobs");
  expect(hello).not.toHaveProperty("phoneAsk");
  expect(await phoneRoutes()).toEqual({ jobs: 404, targets: 404, list: 404 });
  expect(savedFeatures()).toMatchObject({ phoneTools: false, phoneShareAsk: false, showToolCalls: false });
});

test("settings that could not be read hold the switches and offer Try again", async ({ page }) => {
  let refuse = true;
  await page.route("**/api/phones/offered", (route) => refuse ? route.fulfill({ status: 500, json: { error: "no" } }) : route.fallback());
  await page.goto(`${origin}/__preview`);
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(page.getByText("Could not check these settings.")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Phone tools (preview)" })).toBeDisabled();
  refuse = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Phone tools (preview)" })).toBeEnabled();
});
