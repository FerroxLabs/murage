// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 0.1.62 navigation (NAV-OVERHAUL.md, Option B) against the REAL app and
// a real harness with its own temp data dir: the sidebar's place strip and You
// menu, and grouped Settings, at 1440x900, 1280x720, a short 1280x560, the
// 900x600 Electron minimum and a 390x844 phone.
//
// What Sean asked for is checked, not just photographed: everything scrolls
// (the Settings list and the page each on their own, the dialog never), the
// phone gets a full-bleed sheet with a grouped strip and nothing clipped
// sideways, and Settings search still finds pages across the groups.
// Screenshots land in NAV_SHOTS_DIR when set, else the test's output dir.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures.ts";
import { accountMenuTrigger, sidebarPlace } from "./sidebar-nav";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> }, vite: ViteDevServer, origin: string, headers: Record<string, string>;

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env);
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const model = { instanceId: "verification", model: "sonnet" };
    const ids: string[] = [];
    for (const [name, section] of [["Iris", "Growth"], ["Marlow", "Growth"], ["Olin", "Growth"], ["Pixel", ""], ["Vesper", ""], ["Quill", "Research"], ["Ada", "Research"], ["Tamsin", ""], ["Rowan", "Research"], ["Juno", ""]] as const) {
      ids.push((await api("/api/bots", "POST", { name, title: `${name} fixture`, modelSelection: model, ...(section ? { section } : {}) })).bot.id);
    }
    await api("/api/groups", "POST", { name: "Launch room", memberIds: ids.slice(0, 3) });
    await api("/api/groups", "POST", { name: "Research desk", memberIds: ids.slice(5, 8) });
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "nav-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No nav fixture port"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

const shotDir = (fallback: string) => { const dir = process.env.NAV_SHOTS_DIR || fallback; mkdirSync(dir, { recursive: true }); return dir; };
const settings = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function start(page: Page, width: number, height: number, skin = "dark") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  // The email gate key makes this an install that has run before, which keeps
  // the density it showed (Roomy); the 0.1.62 default is Standard, set here.
  await page.addInitScript((value) => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", value); if (!localStorage.getItem("murage.sidebarDensity")) localStorage.setItem("murage.sidebarDensity", "compact"); }, skin);
  await page.goto(origin);
  await expect(page.getByRole("complementary", { name: "Bots and navigation" })).toBeAttached({ timeout: 60_000 });
  await expect(page.getByText("Iris", { exact: true }).first()).toBeAttached({ timeout: 30_000 });
}

/** The list and the page scroll on their own; the dialog itself never does. */
async function scrollShape(page: Page) {
  const dialog = settings(page);
  return dialog.evaluate((element) => {
    const nav = element.querySelector("nav")!;
    const page = element.querySelector(".overflow-y-auto:not(nav)") as HTMLElement;
    const style = getComputedStyle(element);
    return {
      dialogClips: style.overflowX === "clip" && style.overflowY === "clip",
      dialogFits: element.getBoundingClientRect().bottom <= innerHeight + 1 && element.getBoundingClientRect().top >= -1,
      navScrolls: nav.scrollHeight > nav.clientHeight + 1,
      navOverflowY: getComputedStyle(nav).overflowY,
      navOverflowX: getComputedStyle(nav).overflowX,
      pageOverflowY: getComputedStyle(page).overflowY,
    };
  });
}

for (const [width, height] of [[1440, 900], [1280, 720], [1280, 560]] as const) test(`desktop sidebar and grouped Settings at ${width}x${height}`, async ({ page }, info) => {
  const dir = shotDir(info.outputPath("shots"));
  await start(page, width, height);
  const sidebar = await openSidebar(page);
  // the places are on screen, labelled, in one row of four
  for (const [place, label] of [["routines", "Routines"], ["files", "Files"], ["apps", "Apps"], ["map", "Map"]] as const) {
    await expect(sidebarPlace(sidebar, place)).toBeVisible();
    await expect(sidebarPlace(sidebar, place)).toContainText(label);
  }
  const tops = await sidebar.locator("[data-sidebar-place]").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(sidebar).toHaveCSS("width", "280px");
  await expect(sidebar.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(dir, `sidebar-${width}x${height}.png`) });

  // the You menu: a real menu, arrow keys, Escape gives focus back
  await accountMenuTrigger(sidebar).click();
  const menu = page.getByRole("menu", { name: "Your menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([/About me/, /Phone/, /What's new/, /Keyboard shortcuts/, /Get set up/, /Settings/]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.screenshot({ path: join(dir, `you-menu-${width}x${height}.png`) });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(accountMenuTrigger(sidebar)).toBeFocused();

  // Settings: grouped, the list and the page scroll apart, the dialog never
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings(page)).toBeVisible();
  const nav = settings(page).getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("group")).toHaveCount(6);
  await expect(nav.getByRole("group", { name: "Tools" }).getByRole("button")).toHaveText(["Images", "Web search", "Voice", "Connected apps", "Computer & browser"]);
  const shape = await scrollShape(page);
  expect(shape).toMatchObject({ dialogClips: true, dialogFits: true, navOverflowY: "auto", pageOverflowY: "auto" });
  if (width === 1440) expect(shape.navScrolls).toBe(false);
  // no label is cut off: every section name and every place label fits
  const clipped = await page.evaluate(() => [...document.querySelectorAll('[data-settings-section] span, [data-sidebar-place] span:last-child')]
    .filter((el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1).map((el) => el.textContent));
  expect(clipped, JSON.stringify(clipped)).toEqual([]);
  await page.screenshot({ path: join(dir, `settings-${width}x${height}.png`) });

  // Up/Down move between sections; headings are not stops
  await nav.getByRole("button", { name: "About me", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("button", { name: "Bot defaults", exact: true })).toBeFocused();

  // the last section is reachable at every height, the header stays put
  const experimental = nav.getByRole("button", { name: "Experimental", exact: true });
  await experimental.scrollIntoViewIfNeeded();
  await experimental.click();
  await expect(experimental).toHaveAttribute("aria-current", "page");
  await expect(settings(page).getByRole("button", { name: "Close settings" })).toBeInViewport();
  await page.screenshot({ path: join(dir, `settings-bottom-${width}x${height}.png`) });

  // Images: two levels deep, Setup and Library tabs; its page scrolls alone
  await nav.getByRole("button", { name: "Images", exact: true }).click();
  await expect(settings(page).getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
  await expect(settings(page).locator('section[aria-labelledby="image-settings-heading"]')).toBeVisible();
  await page.screenshot({ path: join(dir, `settings-images-${width}x${height}.png`) });
  await settings(page).getByRole("tab", { name: "Library" }).click();
  await expect(settings(page).getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");

  // search still finds pages across the groups
  const search = settings(page).getByRole("textbox", { name: "Search settings" });
  await search.fill("tavily");
  await expect(nav.getByRole("button")).toHaveText(["Web search"]);
  await search.fill("vps");
  await expect(nav.getByRole("button")).toHaveText(["Computer & browser"]);
  await search.fill("");
  expect(await noSideScroll(page)).toBe(true);
});

test("Settings > General > Appearance picks the sidebar density", async ({ page }, info) => {
  const dir = shotDir(info.outputPath("shots"));
  await start(page, 1440, 900);
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: "App settings", exact: true }).click();
  await settings(page).getByRole("navigation").getByRole("button", { name: "General", exact: true }).click();
  const density = settings(page).getByRole("radiogroup", { name: "Sidebar" });
  await expect(density.getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
  await density.getByRole("radio", { name: "Roomy" }).click();
  await expect(sidebar).toHaveCSS("width", "320px");
  await page.screenshot({ path: join(dir, "settings-appearance-1440x900.png") });
  await density.getByRole("radio", { name: "Standard" }).click();
  await expect(sidebar).toHaveCSS("width", "280px");
});

test("a narrow desktop window folds the sidebar to the rail, and one click opens it back out", async ({ page }, info) => {
  const dir = shotDir(info.outputPath("shots"));
  await start(page, 900, 600);
  const sidebar = page.getByRole("complementary", { name: "Bots and navigation" });
  await expect(sidebar).toHaveCSS("width", "64px");
  await expect(sidebarPlace(sidebar, "routines")).toBeVisible();
  await expect(sidebarPlace(sidebar, "apps")).toHaveAttribute("title", "Connected apps: Gmail, Slack and other apps your bots can use");
  await expect(sidebarPlace(sidebar, "apps")).toHaveAccessibleName("Connected apps");
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: join(dir, "sidebar-rail-900x600.png") });
  await sidebar.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(sidebar).toHaveCSS("width", "280px");
  // and it stays open on the next launch
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Bots and navigation" })).toHaveCSS("width", "280px");
  await expect(page.getByText("Iris", { exact: true }).first()).toBeAttached({ timeout: 30_000 });
  // Settings at the Electron minimum: the list scrolls, the dialog fits
  await sidebar.getByRole("button", { name: "App settings", exact: true }).click();
  expect(await scrollShape(page)).toMatchObject({ dialogClips: true, dialogFits: true, navScrolls: true, navOverflowY: "auto" });
  await page.screenshot({ path: join(dir, "settings-900x600.png") });
});

for (const skin of ["dark", "light"]) test(`phone: drawer, strip and Settings sheet at 390x844 (${skin})`, async ({ page }, info) => {
  const dir = shotDir(info.outputPath("shots"));
  await start(page, 390, 844, skin);
  const sidebar = await openSidebar(page);
  const box = (await sidebar.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(Math.min(300, 390 * 0.86) + 1);
  // one row of four places, all inside the drawer
  const places = await sidebar.locator("[data-sidebar-place]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), left: r.left, right: r.right, height: r.height })));
  expect(places).toHaveLength(4);
  expect(new Set(places.map((p) => p.top)).size).toBe(1);
  for (const place of places) { expect(place.left).toBeGreaterThanOrEqual(box.x); expect(place.right).toBeLessThanOrEqual(box.x + box.width + 1); expect(place.height).toBeGreaterThanOrEqual(44); }
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: join(dir, `sidebar-390x844-${skin}.png`) });
  await accountMenuTrigger(sidebar).click();
  const menu = page.getByRole("menu", { name: "Your menu" });
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(dir, `you-menu-390x844-${skin}.png`) });
  await menu.getByRole("menuitem", { name: /^Settings/ }).click();

  const dialog = settings(page);
  await expect(dialog).toBeVisible();
  const sheet = (await dialog.boundingBox())!;
  expect(sheet.width).toBe(390);
  const shape = await scrollShape(page);
  expect(shape).toMatchObject({ dialogClips: true, dialogFits: true, navOverflowX: "auto", pageOverflowY: "auto" });
  // the strip is grouped: a heading before each group's chips
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("group")).toHaveCount(6);
  await expect(nav.getByText("Tools", { exact: true })).toBeAttached();
  await page.screenshot({ path: join(dir, `settings-390x844-${skin}.png`) });
  // a chip at the far end is one swipe away, then the page shows it
  const usage = nav.getByRole("button", { name: "Usage", exact: true });
  await usage.scrollIntoViewIfNeeded();
  await usage.click();
  await expect(usage).toHaveAttribute("aria-current", "page");
  await expect(usage).toBeInViewport();
  const chip = (await usage.boundingBox())!;
  expect(chip.height).toBeGreaterThanOrEqual(44);
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: join(dir, `settings-usage-390x844-${skin}.png`) });
  await nav.getByRole("button", { name: "Images", exact: true }).click();
  await page.screenshot({ path: join(dir, `settings-images-390x844-${skin}.png`) });
  expect(await noSideScroll(page)).toBe(true);
});
