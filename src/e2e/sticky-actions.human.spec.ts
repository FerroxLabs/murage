// STICKY-ACTIONS (Sean 11-01): real boxes in a real browser. Scroll the body to the end and the
// title and buttons have not moved, only the body scrolled, a field near the end is focused clear of
// the head, the on-screen keyboard keeps the head on screen, and Esc still closes.
import { test, expect } from "./page-error-guard";
import type { Locator, Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

interface Fixture { info: { url: string; dataDir: string }; close(): Promise<void> }
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string; env?: { MURAGE_COMPANION_TOKEN?: string } }) => Promise<Fixture>;
const doorToken = randomBytes(32).toString("hex");
let fixture: Fixture, vite: ViteDevServer, origin: string;
const botId = "sticky-proof-bot";
const page_ = `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {DesktopCapabilitiesProvider} from '/src/components/DesktopCapabilities.tsx';import {BotSettingsDialog} from '/src/components/BotSettingsDialog.tsx';import {SettingsModal} from '/src/components/SettingsModal.tsx';import {InboxDialog} from '/src/components/InboxDialog.tsx';import {ProjectBoardDialog} from '/src/components/ProjectBoardDialog.tsx';import {RoutineEditor} from '/src/components/RoutineCalendarPage.tsx';import {RoutineWatchPicker} from '/src/components/RoutineWatchPicker.tsx';import {applyPreference,readPreference} from '/src/lib/skins.ts';import '/src/styles.css';applyPreference(readPreference());const h=React.createElement;function Surface(){const {state,dispatch}=useStore();const [open,setOpen]=React.useState(null);const bot=state.bots[0];const close=()=>setOpen(null);return h(React.Fragment,null,h('button',{disabled:!bot,onClick:()=>setOpen('inbox')},'Open inbox'),h('button',{disabled:!bot,onClick:()=>setOpen('bot')},'Open bot'),h('button',{disabled:!bot,onClick:()=>dispatch({type:'toggleAppSettings',open:true})},'Open settings'),h('button',{disabled:!bot,onClick:()=>setOpen('card')},'Open card'),h('button',{disabled:!bot,onClick:()=>setOpen('form')},'Open form'),h('button',{disabled:!bot,onClick:()=>setOpen('routine')},'Open routine'),h('button',{disabled:!bot,onClick:()=>setOpen('watch')},'Open watch'),open==='inbox'&&h(InboxDialog,{onClose:close}),open==='bot'&&bot&&h(BotSettingsDialog,{bot,onClose:close}),state.appSettingsOpen&&h(SettingsModal),open==='card'&&h(ProjectBoardDialog,{side:true,title:'Card details',onClose:close,actions:h('button',null,'Move')},h('p',null,'Card')),open==='form'&&h(ProjectBoardDialog,{bottom:true,title:'New card',onClose:close,actions:h('button',null,'Save')},h('p',null,'Form')),open==='routine'&&h(RoutineEditor,{bots:state.bots,onClose:close}),open==='watch'&&h(RoutineWatchPicker,{bots:state.bots,onClose:close}));}createRoot(document.getElementById('root')).render(h(StoreProvider,null,h(DesktopCapabilitiesProvider,null,h(Surface))));`;
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `import {writeFileSync} from 'node:fs';import {join} from 'node:path';const at=Date.now();writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'sticky-task',name:'Sticky proof bot',title:'',description:'',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'sticky-task',title:'Task',createdAt:at,resumeCursors:{}}],composio:false,computer:'off',browser:false}]));`, env: { MURAGE_COMPANION_TOKEN: doorToken } });
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "sticky-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "sticky-fixture", resolveId(id) { if (id === "/__sticky.js") return "\0sticky-fixture"; },
        load(id) { if (id === "\0sticky-fixture") return page_; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url?.split("?")[0] !== "/__sticky") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__sticky.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Sticky fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });
test.beforeEach(async ({ page }) => { await page.route("**/api/whats-new?*", route => route.fulfill({ json: { show: false } })); });

const SIZES = [{ width: 1100, height: 800 }, { width: 1100, height: 420 }, { width: 390, height: 844 }, { width: 390, height: 500 }];
const SURFACES: Array<{ name: string; open: string; root: string }> = [
  { name: "inbox", open: "Open inbox", root: "dialog[open]" },
  { name: "bot-settings", open: "Open bot", root: "dialog[open]" },
  { name: "settings", open: "Open settings", root: '[role="dialog"][aria-modal="true"]' },
  { name: "card", open: "Open card", root: "dialog[open]" },
  { name: "form", open: "Open form", root: "dialog[open]" },
  { name: "routine", open: "Open routine", root: '[role="dialog"][aria-label="New routine"]' },
  { name: "routine-watch", open: "Open watch", root: "dialog[open]" },
];

/** Fill the scroller, so even a short page in a tall window has to scroll. */
async function fill(body: Locator) {
  await body.evaluate(node => {
    if (node.querySelector('[data-proof="tall"]')) return;
    const tall = document.createElement("div"); tall.style.height = "3000px"; tall.style.flexShrink = "0"; tall.dataset.proof = "tall";
    const field = document.createElement("input"); field.setAttribute("aria-label", "last field"); field.dataset.proof = "field";
    node.append(tall, field);
  });
}
const rect = (node: Locator) => node.evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });

async function prove(page: Page, surface: typeof SURFACES[number], size: { width: number; height: number }, label: string) {
  const root = page.locator(surface.root).last(), head = root.locator("[data-box-head]").first(), foot = root.locator("[data-box-foot]").first();
  const body = root.locator(surface.name === "bot-settings" ? "[data-settings-scroll]" : "[data-box-body]").first();
  await expect(head).toBeVisible();
  // A page that is still loading can swap its body once, so fill until the fill holds.
  await expect(async () => { await fill(body); await body.evaluate(node => { node.scrollTop = node.scrollHeight; }); expect(await body.evaluate(node => node.scrollTop)).toBeGreaterThan(100); await body.evaluate(node => { node.scrollTop = 0; }); }).toPass();
  const before = await rect(head);
  expect(before.top, `${label}: head on screen`).toBeGreaterThanOrEqual(0);
  expect(before.bottom, `${label}: head on screen`).toBeLessThanOrEqual(size.height);
  await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
  expect(await body.evaluate(node => node.scrollTop), `${label}: the body scrolled`).toBeGreaterThan(100);
  expect(await rect(head), `${label}: head did not move`).toEqual(before);
  // One scrollbar: the box itself and the page never scroll.
  expect(await root.evaluate(node => node.scrollTop), `${label}: box stayed`).toBe(0);
  expect(await root.evaluate(node => getComputedStyle(node).overflowY), `${label}: box cannot scroll`).toBe("clip");
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0), `${label}: page stayed`).toBe(0);
  // Bot settings folds its standing note away on a short screen.
  if (await foot.isVisible()) {
    const r = await rect(foot);
    expect(r.bottom, `${label}: foot on screen`).toBeLessThanOrEqual(size.height + 0.5);
    expect(r.top, `${label}: foot below the body`).toBeGreaterThanOrEqual((await rect(body)).bottom - 0.5);
  }
  // Focus lands inside the body's own view, clear of the head and the foot.
  await body.evaluate(node => { node.scrollTop = 0; });
  await root.locator('[data-proof="field"]').focus();
  const field = await rect(root.locator('[data-proof="field"]')), view = await rect(body);
  expect(field.top, `${label}: focus clear of the head`).toBeGreaterThanOrEqual(view.top - 0.5);
  expect(field.bottom, `${label}: focus clear of the foot`).toBeLessThanOrEqual(view.bottom + 0.5);
  expect(await rect(head), `${label}: focus did not move the head`).toEqual(before);
}

/** What the phone does with the keyboard up: publish the shorter visual viewport (lib/visual-viewport.ts). */
async function keyboardUp(page: Page, height: number) {
  await page.evaluate(next => { const html = document.documentElement; html.style.setProperty("--vvh", `${next}px`); html.dataset.keyboard = "open"; }, height);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
}

for (const skin of ["light", "dark"] as const) for (const surface of SURFACES) test(`${surface.name} keeps its head in view, ${skin}`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: skin });
  for (const size of SIZES) {
    const label = `${surface.name} ${size.width}x${size.height} ${skin}`;
    await page.setViewportSize(size);
    await page.goto(`${origin}/__sticky`);
    expect(await page.evaluate(() => document.documentElement.dataset.skin), `${label}: skin`).toBe(skin);
    await page.getByRole("button", { name: surface.open, exact: true }).click();
    await prove(page, surface, size, label);
    await page.screenshot({ path: testInfo.outputPath(`${label.replaceAll(" ", "-")}.png`) });
    if (size.width === 390 && size.height === 844) {
      await keyboardUp(page, 480);
      const root = page.locator(surface.root).last();
      const head = await rect(root.locator("[data-box-head]").first()), box = await rect(root);
      expect(head.top, `${label}: keyboard keeps the head`).toBeGreaterThanOrEqual(0);
      expect(box.bottom, `${label}: box ends above the keyboard`).toBeLessThanOrEqual(480.5);
      await keyboardUp(page, 844);
    }
    const closer = page.locator(surface.root).last().locator("[data-box-head] button").last();
    if (await closer.count()) await closer.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(surface.root)).toHaveCount(0);
  }
});

// A Save row inside a long Settings page: no box foot, so it holds to the bottom of the page's own scroller.
for (const skin of ["light", "dark"] as const) test(`notifications Save stays in reach, ${skin}`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: skin });
  for (const size of SIZES) {
    const label = `notifications-save ${size.width}x${size.height} ${skin}`;
    await page.setViewportSize(size);
    await page.goto(`${origin}/__sticky`);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const root = page.locator('[role="dialog"][aria-modal="true"]').last(), body = root.locator("[data-box-body]").first();
    const form = root.locator('section[aria-labelledby="notification-settings-title"]'), row = form.locator(".sticky").last(), save = row.getByRole("button");
    await expect(save).toBeVisible();
    // Bring the top of the form to the top of the page: the row must already be on screen, at the bottom edge.
    await body.evaluate((node, name) => { const top = document.querySelector(name)!.getBoundingClientRect().top; node.scrollTop += top - node.getBoundingClientRect().top; }, 'section[aria-labelledby="notification-settings-title"]');
    await page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
    const view = await rect(body), place = await rect(row), button = await rect(save);
    expect(button.top, `${label}: Save below the head`).toBeGreaterThanOrEqual(view.top);
    expect(button.bottom, `${label}: Save above the bottom edge`).toBeLessThanOrEqual(view.bottom + 0.5);
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? "", { x: (button.left + button.right) / 2, y: (button.top + button.bottom) / 2 }), `${label}: nothing covers Save`).toBe(await save.textContent());
    const formBox = await rect(form);
    // A form taller than the view pins the row to the very edge, so nothing shows beneath it.
    if (formBox.bottom > view.bottom + 1) expect(view.bottom - place.bottom, `${label}: row sits on the edge`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`${label.replaceAll(" ", "-")}.png`) });
  }
});
