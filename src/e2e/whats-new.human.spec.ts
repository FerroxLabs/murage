// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new in a real browser against the REAL harness: the page's /api
// calls are proxied to a verification server with the desktop proof, so the
// seen record in its data dir decides, across reloads, whether the page opens.
//
// The install is made a 0.1.59 install that has seen its own page first:
// asking as 0.1.59 on a fresh server is the brand-new-install path (skipped,
// recorded), which leaves 0.1.59 behind as the last version, exactly what a
// real 0.1.59 install that asked would. A second, untouched server is the
// brand-new 0.1.60 install, which by design never opens the page.
//
// Screenshots of all three cards at 1280x860 and 420x860, dark and light
// skin, land in WHATS_NEW_SHOTS_DIR when it is set, else in the test's output
// directory.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { axeScriptPath } from "./axe";

let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, headers: Record<string, string>;
const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
// A version with no page (WHATS_NEW_BY_VERSION says "none") shows nothing:
// the page tests run for the newest version that has one.
const HAS_PAGE = new RegExp(`"${VERSION.replace(/\./g, "\\.")}": \\{ kind: "page"`).test(readFileSync(new URL("../lib/whats-new.ts", import.meta.url), "utf8"));
const seen = async () => (await (await fetch(`${harness.info.url}/api/whats-new?version=${VERSION}`, { headers })).json()) as { show: boolean };

test.beforeAll(async () => {
  harness = await launchVerificationServer(process.env);
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  // a 0.1.59 install: started fresh on 0.1.59 (skipped and recorded) and
  // closed that page, so 0.1.60 is an update
  expect(await (await fetch(`${harness.info.url}/api/whats-new?version=0.1.59`, { headers })).json()).toEqual({ version: "0.1.59", show: false });
  expect(await (await fetch(`${harness.info.url}/api/whats-new/seen`, { method: "POST", headers, body: JSON.stringify({ version: "0.1.59" }) })).json()).toEqual({ version: "0.1.59", show: false });
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-whats-new-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/whats-new-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [react(), tailwindcss(), {
      name: "whats-new-fixture",
      resolveId(id) { if (id === "/whats-new-fixture-store") return "\0whats-new-store"; },
      load(id) {
        // Ada and the Chief; dispatch only records.
        if (id === "\0whats-new-store") return "window.__dispatched=[];export function useStore(){return {state:{bots:[{id:'ada',name:'Ada'},{id:'chief',name:'Chief',chiefOfStaff:true,chiefScope:'workspace'}],groups:[],selectedId:null},dispatch(action){window.__dispatched.push(action);}};}";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__whats-new" || req.url?.startsWith("/__whats-new?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>What\'s new</title><body style="margin:0"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/e2e/whats-new-fixture.tsx"></script></body></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); await harness?.close(); if (cache) safeWipeSync(cache); });
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.log("page error:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("console error:", message.text()); });
  page.on("dialog", (dialog) => { throw new Error(`a native ${dialog.type()} dialog opened`); });
});

const shotsDir = (fallback: string) => {
  const dir = process.env.WHATS_NEW_SHOTS_DIR || fallback;
  mkdirSync(dir, { recursive: true });
  return dir;
};
const dialog = (page: Page) => page.locator("dialog[data-whats-new]");
const card = (page: Page, name: string) => dialog(page).locator(`[data-whats-new-card="${name}"]`);
const CARDS = ["backups", "highlights", "more"] as const;
const LAST = CARDS.length - 1;

async function axe(page: Page) {
  await page.addScriptTag({ path: axeScriptPath });
  const result = await page.evaluate(async () => {
    const run = (window as unknown as { axe: { run: (node: Element, options: object) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run;
    return run(document.querySelector("dialog[data-whats-new]")!, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
  });
  return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
}

async function walkCards(page: Page, skin: string, dir: string, width = "") {
  for (const [index, name] of CARDS.entries()) {
    await expect(card(page, name)).toBeVisible();
    const box = (await card(page, name).boundingBox())!;
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(page.viewportSize()!.width);
    // every image decoded and the display font in use, before the picture
    await page.waitForFunction(() => [...document.querySelectorAll("dialog[data-whats-new] img")].every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0));
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('42px "Instrument Serif"'))).toBe(true);
    await expect(dialog(page).getByRole("img", { name: `Card ${index + 1} of ${CARDS.length}` })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(dir, `whats-new-${index + 1}-${name}-${skin}${width}.png`) });
    if (index < LAST) { const next = dialog(page).getByRole("button", { name: "Next", exact: true }); await next.scrollIntoViewIfNeeded(); await next.click(); }
  }
}

test("a 0.1.59 install updating sees the page once, walks all three cards, and a dismissal survives a reload", async ({ page }, info) => {
  test.skip(!HAS_PAGE, `${VERSION} has no What's new page`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  const dir = shotsDir(info.outputPath("shots"));
  expect((await seen()).show).toBe(true);

  await page.goto(origin + "/__whats-new?skin=dark");
  await expect(card(page, "backups")).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Your work, kept." })).toBeFocused();
  // focus stays inside: Tab from the last control comes back round
  await dialog(page).getByRole("button", { name: "Next" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog(page).getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog(page).getByRole("button", { name: "Next" })).toBeFocused();
  // back to the title (no ring) so the pictures show the resting state
  await dialog(page).getByRole("heading", { name: "Your work, kept." }).focus();

  await walkCards(page, "dark", dir);
  await expect(dialog(page).getByRole("link", { name: "Read the full release notes" })).toHaveAttribute("href", `https://github.com/FerroxLabs/murage-releases/releases/tag/v${VERSION}`);
  await dialog(page).getByRole("button", { name: "Let's go" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => (await seen()).show).toBe(false);

  await page.reload();
  await expect(page.getByText("The app behind the page.")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(dialog(page)).toHaveCount(0);
});

test("reopens from Tools in the light skin, closes on Escape, and each highlight goes somewhere", async ({ page }, info) => {
  test.skip(!HAS_PAGE, `${VERSION} has no What's new page`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 860 });
  const dir = shotsDir(info.outputPath("shots"));
  await page.goto(origin + "/__whats-new?skin=light");
  await expect(page.getByText("The app behind the page.")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(dialog(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByRole("menuitem", { name: "What's new" }).click();
  await walkCards(page, "light", dir);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // the hero's shortcut opens Settings at Backups
  await page.evaluate(() => { (window as unknown as { __dispatched: unknown[] }).__dispatched.length = 0; });
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByRole("menuitem", { name: "What's new" }).click();
  await dialog(page).getByRole("button", { name: "Open Backups" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __dispatched: unknown[] }).__dispatched)).toEqual([{ type: "toggleAppSettings", open: true, section: "backups" }]);

  // the six highlights, each through the real host; Delete means gone only closes
  const expected: Record<string, unknown[]> = {
    backups: [{ type: "toggleAppSettings", open: true, section: "backups" }],
    offsite: [{ type: "toggleAppSettings", open: true, section: "backups" }],
    routines: [{ type: "showRoutines" }],
    delete: [],
    help: [{ type: "select", id: "chief" }],
    aboutMe: [{ type: "toggleAppSettings", open: true, section: "aboutMe" }],
  };
  for (const [tile, dispatched] of Object.entries(expected)) {
    await page.evaluate(() => { (window as unknown as { __dispatched: unknown[] }).__dispatched.length = 0; (window as unknown as { __navigated: number }).__navigated = 0; });
    await page.getByRole("button", { name: "Tools" }).click();
    await page.getByRole("menuitem", { name: "What's new" }).click();
    await dialog(page).getByRole("button", { name: "Next" }).click();
    await dialog(page).locator(`[data-whats-new-tile="${tile}"]`).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __dispatched: unknown[] }).__dispatched), tile).toEqual(dispatched);
    expect(await page.evaluate(() => (window as unknown as { __navigated: number }).__navigated), tile).toBe(dispatched.length ? 1 : 0);
  }
  expect((await seen()).show).toBe(false);
});

test("fits the smallest main window without clipping a card", async ({ page }, info) => {
  test.skip(!HAS_PAGE, `${VERSION} has no What's new page`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 900, height: 600 });
  const dir = shotsDir(info.outputPath("shots"));
  await page.goto(origin + "/__whats-new?skin=dark");
  await expect(page.getByText("The app behind the page.")).toBeVisible();
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByRole("menuitem", { name: "What's new" }).click();
  for (const [index, name] of CARDS.entries()) {
    const box = await card(page, name).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(900);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await page.screenshot({ path: join(dir, `whats-new-${index + 1}-${name}-small.png`) });
    const next = dialog(page).getByRole("button", { name: "Next", exact: true });
    if (index < LAST) { await next.scrollIntoViewIfNeeded(); await next.click(); }
  }
});

for (const skin of ["dark", "light"]) {
  test(`fits a narrow window in the ${skin} skin`, async ({ page }, info) => {
    test.skip(!HAS_PAGE, `${VERSION} has no What's new page`);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 420, height: 860 });
    const dir = shotsDir(info.outputPath("shots"));
    await page.goto(origin + `/__whats-new?skin=${skin}`);
    await expect(page.getByText("The app behind the page.")).toBeVisible();
    await page.getByRole("button", { name: "Tools" }).click();
    await page.getByRole("menuitem", { name: "What's new" }).click();
    await walkCards(page, skin, dir, "-narrow");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
  });
}

test("a brand-new 0.1.60 install is never shown the page, and it stays shut", async () => {
  test.skip(!HAS_PAGE, `${VERSION} has no What's new page`);
  const fresh = await launchVerificationServer(process.env);
  try {
    const secret = ((await (await fetch(fresh.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
    const freshHeaders = { ...headers, "x-murage-surface-secret": secret };
    const ask = async () => (await (await fetch(`${fresh.info.url}/api/whats-new?version=${VERSION}`, { headers: freshHeaders })).json()) as { show: boolean };
    expect(await ask()).toEqual({ version: VERSION, show: false });
    expect(await ask()).toEqual({ version: VERSION, show: false });
  } finally {
    await fresh.close();
  }
});

test("a version with no page opens nothing and hides the Tools entry", async ({ page }) => {
  test.skip(HAS_PAGE, `${VERSION} has a What's new page`);
  await page.goto(origin + "/__whats-new?skin=dark");
  await expect(page.getByText("The app behind the page.")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Tools" }).click();
  await expect(page.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "What's new" })).toHaveCount(0);
});
