// Real hit testing for sidebar bot rows (adapted from OpenMausBot PR #762
// 03d9fb3f4942259ecac44d7d94571bb53260d894 and PR #767
// 2eb4c7c5d32c85d8e0ae3e43d7f7861e81c2977f, Apache-2.0). A static markup
// assertion cannot prove which element owns a pixel, so every claim below
// clicks or taps the actual coordinates in Chromium.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-sidebar-hit-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false, resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
    name: "sidebar-hit-fixture", enforce: "pre",
    resolveId(id) { if (id.endsWith("/src/state/store") || id === "@/state/store") return "\0hit-store"; if (id === "/__hit.js") return "\0hit-entry"; },
    load(id) {
      if (id === "\0hit-store") return `export * from '/src/state/store.tsx?original';import {useSyncExternalStore} from 'react';export function useStore(){return useSyncExternalStore(window.subscribeFixture,()=>window.fixtureStore);}`;
      if (id !== "\0hit-entry") return;
      return `import React from 'react';import {createRoot} from 'react-dom/client';import {initialState} from '/src/state/store.tsx?original';import {Sidebar} from '/src/components/Sidebar.tsx';import '/src/styles.css';
        const listeners=new Set();window.subscribeFixture=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
        const base={color:'blue',tasks:[],messages:[],modelSelection:{instanceId:'fixture',model:'test'},description:'',autoApprove:false};
        const rosters={
          team:[{...base,id:'chief',name:'Fixture Chief',threadId:'thread-chief',chiefOfStaff:true,chiefScope:'workspace'},
            {...base,id:'lead',name:'Research Director',threadId:'thread-lead',chiefOfStaff:true,section:'Research'},
            {...base,id:'analyst',name:'Market Analyst',threadId:'thread-analyst',section:'Research'},
            {...base,id:'writer',name:'Report Writer',threadId:'thread-writer'}],
          solo:[{...base,id:'solo',name:'Only Bot',threadId:'thread-solo'}],
        };
        const q=new URLSearchParams(location.search);window.actions=[];
        const state={...initialState,bots:rosters[q.get('roster')||'team'],selectedId:q.has('selected')?q.get('selected'):'writer',config:{features:{},box:{configured:false}},instances:[]};
        const dispatch=action=>{window.actions.push(action);
          if(action.type==='botPatched')state.bots=state.bots.map(bot=>bot.id===action.bot.id?action.bot:bot);
          if(action.type==='updateBot')state.bots=state.bots.map(bot=>bot.id===action.botId?{...bot,...action.patch}:bot);
          if(action.type==='select')state.selectedId=action.id;
          window.fixtureStore={state:{...state},dispatch};listeners.forEach(fn=>fn());};
        window.fixtureStore={state:{...state},dispatch};
        createRoot(document.getElementById('root')).render(React.createElement(Sidebar,{open:true,onClose:()=>{}}));`;
    },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/__hit" && !req.url?.startsWith("/__hit?")) return next(); res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh"></div><script type="module" src="/__hit.js"></script></body></html>'); }); },
  }] });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

async function open(page: Page, { density = "comfortable", query = "" } = {}) {
  await page.addInitScript(value => localStorage.setItem("murage.sidebarDensity", value), density);
  await page.route("**/api/config", route => route.fulfill({ json: { features: {} } }));
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture-secret" } }));
  await page.goto(`${origin}/__hit${query}`);
  await page.evaluate(() => document.fonts.ready);
}
const selectedId = (page: Page) => page.evaluate(() => (window as any).fixtureStore.state.selectedId as string);
const select = (page: Page, id: string) => page.evaluate(value => (window as any).fixtureStore.dispatch({ type: "select", id: value }), id);
const renames = (page: Page) => page.evaluate(() => (window as any).actions.filter((action: any) => action.type === "updateBot").map((action: any) => action.patch.name));
/** The innermost row wrapper holding this locator (rows nest no further). */
const rowOf = (page: Page, inner: Locator) => page.locator("div.group.relative").filter({ has: inner }).last();
/** Centre of the former inline Archive overlay: `right-1` (4px) and `size-10` (40px). */
async function formerArchivePoint(row: Locator) {
  const box = (await row.boundingBox())!;
  return { x: box.x + box.width - 4 - 20, y: box.y + box.height / 2 };
}
const ownerAt = (page: Page, point: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const element = document.elementFromPoint(x, y);
  return { button: element?.closest("button")?.getAttribute("aria-label") ?? null, input: Boolean(element?.closest("input")) };
}, point);

for (const density of ["comfortable", "compact"]) for (const width of [1280, 390]) test(`an unavailable Archive leaves the Chief and team lead right edge selectable (${density}, ${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await open(page, { density });
  for (const [name, id] of [["Fixture Chief", "chief"], ["Research Director", "lead"]] as const) {
    await expect(page.getByRole("button", { name: `Archive ${name}`, exact: true })).toHaveCount(0);
    await select(page, "writer");
    const row = rowOf(page, page.getByText(name, { exact: true }));
    await row.hover();
    const point = await formerArchivePoint(row);
    expect(await ownerAt(page, point)).toEqual({ button: null, input: false });
    await page.mouse.click(point.x, point.y);
    expect(await selectedId(page)).toBe(id);
  }
  // The row's other controls are unchanged: More actions still opens the menu.
  await page.getByRole("button", { name: "More actions for Research Director", exact: true }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath(`sidebar-hit-${density}-${width}.png`) });
});

test("the last active bot's right edge selects it instead of a hidden Archive button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { query: "?roster=solo&selected=" });
  await expect(page.getByRole("button", { name: "Archive Only Bot", exact: true })).toHaveCount(0);
  const row = rowOf(page, page.getByText("Only Bot", { exact: true }));
  await row.hover();
  const point = await formerArchivePoint(row);
  expect(await ownerAt(page, point)).toEqual({ button: null, input: false });
  await page.mouse.click(point.x, point.y);
  expect(await selectedId(page)).toBe("solo");
});

test("an archivable bot keeps its inline Archive shortcut and the existing undo feedback", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const patches: unknown[] = [];
  await page.route("**/api/bots/writer", async route => {
    const patch = route.request().postDataJSON(); patches.push(patch);
    const bot = await page.evaluate(() => (window as any).fixtureStore.state.bots.find((candidate: any) => candidate.id === "writer"));
    await route.fulfill({ json: { bot: { ...bot, ...patch } } });
  });
  await open(page, { query: "?selected=chief" });
  const row = rowOf(page, page.getByText("Report Writer", { exact: true }));
  await row.hover();
  const point = await formerArchivePoint(row);
  expect(await ownerAt(page, point)).toEqual({ button: "Archive Report Writer", input: false });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByText("Report Writer archived", { exact: true })).toBeVisible();
  expect(patches).toEqual([{ hidden: true }]);
  expect(await selectedId(page)).toBe("chief");
});

test("renaming keeps input clicks in the field while the avatar, body and right edge still select the row", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  let current = "Fixture Chief";
  for (const target of ["avatar", "body", "right edge"] as const) {
    await select(page, "writer");
    // Keyboard entry into rename: the row itself is not selected by it.
    await page.getByRole("button", { name: `Rename ${current}`, exact: true }).focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "Rename", exact: true });
    await expect(input).toBeFocused();
    const draft = `Chief ${target}`;
    await input.fill(draft);
    await input.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
    expect(await selectedId(page)).toBe("writer");
    const row = rowOf(page, input);
    const box = (await row.boundingBox())!;
    const point = target === "avatar" ? { x: box.x + 12 + 28, y: box.y + box.height / 2 }
      : target === "body" ? { x: box.x + box.width / 2, y: box.y + box.height * 0.75 }
        : await formerArchivePoint(row);
    if (target === "avatar") await page.screenshot({ path: info.outputPath("sidebar-renaming.png") });
    expect(await ownerAt(page, point)).toEqual({ button: null, input: false });
    await page.mouse.click(point.x, point.y);
    expect(await selectedId(page)).toBe("chief");
    await expect(input).toHaveCount(0);
    expect((await renames(page)).at(-1)).toBe(draft);
    current = draft;
  }
});

test("Escape cancels a rename, Enter commits one, and Enter on the row still selects it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await page.getByRole("button", { name: "Rename Market Analyst", exact: true }).focus();
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "Rename", exact: true });
  await input.fill("Discarded name");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(page.getByText("Market Analyst", { exact: true })).toBeVisible();
  expect(await renames(page)).toEqual([]);
  expect(await selectedId(page)).toBe("writer");
  await page.getByRole("button", { name: "Rename Market Analyst", exact: true }).focus();
  await page.keyboard.press("Enter");
  await input.fill("Pricing Analyst");
  await page.keyboard.press("Enter");
  expect(await renames(page)).toEqual(["Pricing Analyst"]);
  expect(await selectedId(page)).toBe("writer");
  const row = page.locator("div[role='button']").filter({ has: page.getByText("Pricing Analyst", { exact: true }) }).last();
  await row.focus();
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe("analyst");
});

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("a tap on the Chief's former Archive pixels selects the Chief", async ({ page }, info) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const row = rowOf(page, page.getByText("Fixture Chief", { exact: true }));
    const point = await formerArchivePoint(row);
    expect(await ownerAt(page, point)).toEqual({ button: null, input: false });
    await page.touchscreen.tap(point.x, point.y);
    expect(await selectedId(page)).toBe("chief");
    await expect(page.getByRole("button", { name: "More actions for Fixture Chief", exact: true })).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath("sidebar-hit-touch.png") });
  });
});
