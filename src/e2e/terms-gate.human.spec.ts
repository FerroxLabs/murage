// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The terms gate in a real browser: a short viewport (what 400% zoom leaves of
// a desktop window), keyboard-only use, initial focus, and the fail-closed
// "couldn't check, retrying" state with Retry. The page runs the real
// TermsGate; the only stand-in is the request function, scripted per test.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { axeScriptPath } from "./axe";

const root = fileURLToPath(new URL("../../", import.meta.url));
let server: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-terms-gate-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/terms-gate-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), {
      name: "terms-gate-fixture",
      resolveId(id) { if (id === "/terms-gate-fixture-store") return "\0terms-gate-store"; },
      load(id) {
        if (id === "\0terms-gate-store") return "export async function api(path,init){return window.__termsRequest(path,init);}export function useStoreIfAny(){return useStore();} export function useStore(){return {state:{bots:[],groups:[],selectedId:null},dispatch(){}};}";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__terms" || req.url?.startsWith("/__terms?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms</title><body style="margin:0"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/e2e/terms-gate-fixture.tsx"></script></body></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => {
  await server?.close();
  if (cache) safeWipeSync(cache);
});

declare global { interface Window { __termsRequest: (path: string, init?: RequestInit) => Promise<unknown>; __calls: string[]; __up: boolean } }

/** A scripted server: down until `window.__up` is set, then the first-run answer; Accept records. */
async function script(page: Page, up: boolean) {
  await page.addInitScript((startUp) => {
    let accepted = false;
    window.__up = startUp;
    window.__calls = [];
    window.__termsRequest = async (path, init) => {
      window.__calls.push(`${init?.method ?? "GET"} ${path}`);
      if (!window.__up) throw new Error("HTTP 404");
      if (path === "/api/terms/accept") { accepted = true; return { accepted: true, version: "2026-10-10" }; }
      return { accepted, version: "2026-10-10" };
    };
  }, up);
}

async function axe(page: Page, selector: string) {
  await page.addScriptTag({ path: axeScriptPath });
  const result = await page.evaluate(async (target) => {
    const run = (window as unknown as { axe: { run: (node: Element, options: object) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run;
    return run(document.querySelector(target)!, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
  }, selector);
  return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
}

const inViewport = (page: Page, selector: string) => page.evaluate((target) => {
  const box = document.querySelector(target)!.getBoundingClientRect();
  return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
}, selector);

test("a short viewport scrolls the card, focus starts on the checkbox, and the keyboard alone accepts", async ({ page }) => {
  await script(page, true);
  // 1280x1024 at 400% zoom leaves 320x256 CSS pixels
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto(origin + "/__terms");
  const dialog = page.getByRole("dialog", { name: "Before you start" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("[data-terms-checkbox]")).toBeFocused();
  await expect(page.locator("[data-app]")).toHaveCount(0);

  // the frame scrolls rather than clipping: the page itself is taller than the viewport, and the frame is the scroller
  const frame = await page.evaluate(() => {
    const el = document.querySelector("[data-terms-frame]") as HTMLElement;
    return { overflowY: getComputedStyle(el).overflowY, top: el.getBoundingClientRect().top };
  });
  expect(frame.overflowY).toBe("auto");
  expect(frame.top).toBe(0);

  // keyboard only: Space ticks, Tab through the two links to Accept, Enter accepts
  await page.keyboard.press("Space");
  await expect(page.locator("[data-terms-checkbox]")).toBeChecked();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-terms-accept]")).toBeFocused();
  // focus scrolled the button into reach
  expect(await inViewport(page, "[data-terms-accept]")).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-app]")).toBeVisible();
});

test("every control can be scrolled into a 320x256 viewport, and nothing overflows sideways", async ({ page }) => {
  await script(page, true);
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto(origin + "/__terms");
  await expect(page.locator("[data-terms-card]")).toBeVisible();
  for (const selector of ["[data-terms-checkbox]", "[data-terms-accept]"]) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    expect(await inViewport(page, selector), selector).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await axe(page, "[data-terms-frame]")).toEqual([]);
});

test("a failed check keeps the gate up with Retry, retries by itself, and behaves normally once the server answers", async ({ page }) => {
  await script(page, false);
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.goto(origin + "/__terms");
  const retry = page.getByRole("button", { name: "Retry now" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(page.getByRole("status")).toContainText("Retrying automatically");
  await expect(page.locator("[data-app]")).toHaveCount(0);
  expect(await axe(page, "[data-terms-frame]")).toEqual([]);

  // still down: Retry asks again and the gate stays up (never the app)
  const before = await page.evaluate(() => window.__calls.length);
  await retry.click();
  await expect.poll(() => page.evaluate(() => window.__calls.length)).toBeGreaterThan(before);
  await expect(page.locator("[data-app]")).toHaveCount(0);
  await expect(retry).toBeVisible();

  // the server answers: the real screen, then accept
  await page.evaluate(() => { window.__up = true; });
  await retry.click();
  await expect(page.getByRole("dialog", { name: "Before you start" })).toBeVisible();
  await expect(page.locator("[data-terms-checkbox]")).toBeFocused();
  await expect(page.locator("[data-app]")).toHaveCount(0);
  await page.locator("[data-terms-checkbox]").check();
  await page.locator("[data-terms-accept]").click();
  await expect(page.locator("[data-app]")).toBeVisible();
});

test("the automatic retry fires on its own with backoff", async ({ page }) => {
  await script(page, false);
  await page.goto(origin + "/__terms");
  await expect(page.getByRole("button", { name: "Retry now" })).toBeVisible();
  await page.evaluate(() => { window.__up = true; });
  // no click: the 2s timer asks again and the gate becomes the real screen
  await expect(page.getByRole("dialog", { name: "Before you start" })).toBeVisible({ timeout: 10000 });
  await expect(page.locator("[data-terms-checkbox]")).toBeVisible();
});
