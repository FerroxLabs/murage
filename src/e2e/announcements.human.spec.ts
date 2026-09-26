// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Announcements in a real browser against the REAL harness, which reads a
// loopback stub feed through the MURAGE_ANNOUNCEMENTS_URL seam. The stub is
// signed by a key made for this run; its pictures are the What's new art.
// The page's /api calls are proxied to the harness with the desktop proof, so
// dismissals and the Settings switch live in the harness's data dir and are
// tested across reloads.
//
// Screenshots (card, banner, and the gallery of every layout) land in
// ANNOUNCEMENTS_SHOTS_DIR when it is set, else in the test's output directory.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { axeScriptPath } from "./axe";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const TEST_KEY = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, stub: Server, headers: Record<string, string>;

function feed(stubOrigin: string) {
  return Buffer.from(JSON.stringify({
    version: 1,
    issuedAt: "2026-09-25T10:00:00Z",
    items: [
      {
        id: "security-0161", kind: "security", layout: "hero", accent: "orange",
        title: "Install 0.1.61 today",
        body: "It closes a gap in how shared files are opened. **Your bots and chats are not affected.**\n\nRead [what changed](https://ferroxlabs.com/murage/0.1.61).",
        image: `${stubOrigin}/murage/images/voice-hero.webp`, imageAlt: "An orange waveform flowing into a glowing orb",
        action: { label: "Check for updates", target: "check-for-updates" },
      },
      {
        id: "search-mid-call", kind: "info", layout: "split", accent: "blue",
        title: "Search while you talk",
        body: "Bots now look things up **mid-call**, from the live web.",
        image: `${stubOrigin}/murage/images/tile-search.webp`, imageAlt: "A glass globe with a pulse of light",
        link: { label: "See how", url: "https://ferroxlabs.com/murage/search" },
      },
    ],
  }));
}

test.beforeAll(async () => {
  stub = createHttpServer((req, res) => {
    const stubOrigin = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    const bytes = feed(stubOrigin);
    if (req.url === "/murage/announcements.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(bytes); return; }
    if (req.url === "/murage/announcements.json.sig") { res.writeHead(200); res.end(sign(null, bytes, privateKey).toString("base64")); return; }
    const image = /^\/murage\/images\/([a-z-]+\.webp)$/.exec(req.url ?? "");
    if (image) { res.writeHead(200, { "content-type": "image/webp" }); res.end(readFileSync(join(root, "src/e2e/fixtures/announcements-art", image[1]!))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubOrigin = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  harness = await launchVerificationServer(process.env, undefined, {
    env: { MURAGE_ANNOUNCEMENTS_URL: `${stubOrigin}/murage/announcements.json`, MURAGE_ANNOUNCEMENTS_TEST_KEY: TEST_KEY },
  });
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  // the harness fetched the stub at launch, pictures included
  await expect.poll(async () => (await list()).items.map((item) => item.id), { timeout: 20000 }).toEqual(["security-0161", "search-mid-call"]);

  cache = mkdtempSync(join(tmpdir(), "murage-announcements-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/announcements-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [react(), tailwindcss(), {
      name: "announcements-fixture",
      resolveId(id) { if (id === "/announcements-fixture-store") return "\0announcements-store"; },
      load(id) {
        if (id === "\0announcements-store") return "window.__dispatched=[];export function useStore(){return {state:{bots:[],groups:[],selectedId:null},dispatch(action){window.__dispatched.push(action);}};}export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json'}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.statusText);return d;}";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__announcements" || req.url?.startsWith("/__announcements?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Announcements</title><body style="margin:0"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/e2e/announcements-fixture.tsx"></script></body></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => {
  await server?.close();
  await harness?.close();
  await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
  if (cache) safeWipeSync(cache);
});
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.log("page error:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("console error:", message.text()); });
  page.on("dialog", (dialog) => { throw new Error(`a native ${dialog.type()} dialog opened`); });
});

async function list() {
  return (await (await fetch(`${harness.info.url}/api/announcements?version=0.1.60`, { headers })).json()) as { show: boolean; items: Array<{ id: string }> };
}
const shotsDir = (fallback: string) => {
  const dir = process.env.ANNOUNCEMENTS_SHOTS_DIR || fallback;
  mkdirSync(dir, { recursive: true });
  return dir;
};
const card = (page: Page) => page.locator("dialog[data-announcement]");
const banner = (page: Page) => page.locator("[data-announcement-banner]");

async function settled(page: Page, scope: string) {
  await page.waitForFunction((selector) => [...document.querySelectorAll(`${selector} img`)].every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), scope);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('42px "Instrument Serif"'))).toBe(true);
}

async function axe(page: Page, selector: string) {
  await page.addScriptTag({ path: axeScriptPath });
  const result = await page.evaluate(async (target) => {
    const run = (window as unknown as { axe: { run: (node: Element, options: object) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run;
    return run(document.querySelector(target)!, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
  }, selector);
  return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
}

test("a security card survives the off switch, and a dismissed banner stays dismissed across a reload", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  const dir = shotsDir(info.outputPath("shots"));

  // security first: the card, over the app
  await page.goto(origin + "/__announcements");
  await expect(card(page).getByRole("heading", { name: "Install 0.1.61 today" })).toBeFocused();
  await expect(card(page).locator('[data-layout="hero"]')).toBeVisible();
  await settled(page, "dialog[data-announcement]");
  expect(await axe(page, "dialog[data-announcement]")).toEqual([]);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(dir, "announcement-card-security-hero.png") });

  // switched off: security still shows, after a reload too
  expect((await (await fetch(`${harness.info.url}/api/announcements/settings`, { method: "POST", headers, body: JSON.stringify({ show: false }) })).json())).toEqual({ show: false });
  await page.reload();
  await expect(card(page).getByRole("heading", { name: "Install 0.1.61 today" })).toBeVisible();
  await card(page).getByRole("button", { name: "Got it" }).click();
  await expect(card(page)).toHaveCount(0);
  // info is off, so nothing takes its place
  await page.waitForTimeout(500);
  await expect(banner(page)).toHaveCount(0);
  const toggle = page.getByRole("switch", { name: "Show announcements" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // back on from Settings: the banner arrives in the sidebar
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toHaveAttribute("data-layout", "split");
  await settled(page, "[data-announcement-banner]");
  expect(await axe(page, "[data-announcement-banner]")).toEqual([]);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(dir, "announcement-banner-info-split.png") });
  await banner(page).screenshot({ path: join(dir, "announcement-banner-info-split-closeup.png") });

  // dismissed, and still dismissed after a reload
  await banner(page).getByRole("button", { name: "Dismiss: Search while you talk" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await list()).items).toEqual([]);
  await page.reload();
  await expect(page.getByText("The app behind the page.")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(banner(page)).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
});

test("the gallery: every layout as a card and as a banner, readable and accessible", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // tall enough that every card is on screen at once
  await page.setViewportSize({ width: 1280, height: 1900 });
  const dir = shotsDir(info.outputPath("shots"));
  await page.goto(origin + "/__announcements?gallery=1");
  await expect(page.locator('[data-gallery="cards"] section')).toHaveCount(3);
  await expect(page.locator('[data-gallery="banners"] section')).toHaveCount(3);
  await settled(page, "body");
  expect(await axe(page, "body")).toEqual([]);
  await page.screenshot({ path: join(dir, "announcement-gallery.png"), fullPage: true });
  await page.locator('[data-gallery="banners"]').screenshot({ path: join(dir, "announcement-gallery-banners.png") });
  for (const layout of ["hero", "split", "spotlight"]) {
    await page.locator(`[data-gallery="cards"] [data-layout="${layout}"]`).screenshot({ path: join(dir, `announcement-gallery-card-${layout}.png`) });
  }
});
