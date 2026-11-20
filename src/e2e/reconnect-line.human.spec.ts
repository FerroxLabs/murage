// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reconnect line in a real browser (1.0.20, owner report on 1.0.19: the
// box covered the rail and the composer and could not be closed). The real
// band and the real rail doors, in the app's own stack: bands, then the row
// with the rail and the main view, the composer at its foot. The band must sit
// above both, never over them, at 1024 and 390 px, light and dark; Later puts
// it away and leaves a dot on Needs you. Screenshots land in the lane's
// evidence directory.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "./scoped-tailwind";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { evidenceDir } from "./evidence";

let server: ViteDevServer, origin: string, cache: string;
const shots = evidenceDir("reconnect-line-shots");
const APPS = [
  { slug: "freshdesk", label: "Freshdesk", incidentId: "inc-fd-a", incidentIds: ["inc-fd-a", "inc-fd-b"], accounts: [{ id: "fd-a" }, { id: "fd-b" }] },
  { slug: "gmail", label: "Gmail", incidentId: "inc-gm", incidentIds: ["inc-gm"], accounts: [{ id: "gm" }] },
  { slug: "highlevel", label: "Highlevel", incidentId: "inc-hl", incidentIds: ["inc-hl"], accounts: [{ id: "hl" }] },
  { slug: "mcp-stripe", label: "Stripe Mcp", incidentId: "inc-st", incidentIds: ["inc-st"], accounts: [] },
];

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-reconnect-line-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [
      { find: "@/state/store", replacement: "/reconnect-fixture-store" },
      { find: "@/lib/use-surface", replacement: "/reconnect-fixture-surface" },
      { find: "@", replacement: root + "/src" },
    ] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "reconnect-line-fixture",
      resolveId(id) {
        if (id === "/__reconnect.js") return "\0reconnect";
        if (id === "/reconnect-fixture-store") return "\0reconnect-store";
        if (id === "/reconnect-fixture-surface") return "\0reconnect-surface";
      },
      load(id) {
        // The poll answers the grouped rows the server now sends; a write would be a disconnect, so it is recorded.
        // One store object, as the real useReducer store: a new dispatch per render would re-run the band's poll on every render.
        if (id === "\0reconnect-store") return `const apps=${JSON.stringify(APPS)};window.__calls=[];export async function api(path,init){window.__calls.push(((init&&init.method)||"GET")+" "+path);return {apps,notifications:[]};}const store={state:{},dispatch:(a)=>{(window.__dispatched??=[]).push(a);}};export function useStore(){return store;}export function openNotificationTarget(){}`;
        if (id === "\0reconnect-surface") return "export function useDesktopSurface(){return true;}";
        if (id !== "\0reconnect") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
import {ReconnectAppsBanner,useReconnectLine,reconnectNotice} from '/src/components/ReconnectAppsBanner.tsx';
import {RailDoors} from '/src/components/shell/RailDoors.tsx';import '/src/styles.css';
const q=new URLSearchParams(location.search);document.documentElement.dataset.skin=q.get('skin')||'dark';
const h=React.createElement;
function Doors(){const line=useReconnectLine();return h(RailDoors,{lit:'chats',needs:{count:0,stale:false},reconnect:reconnectNotice(line.apps),onOpen:()=>{}});}
function Shell(){return h('div',{className:'flex h-screen flex-col bg-app text-ink'},
  h(ReconnectAppsBanner,{enabled:true}),
  h('div',{className:'relative flex min-h-0 flex-1'},
    h('aside',{'data-rail':'',className:'hidden w-72 shrink-0 flex-col border-r border-hairline/40 bg-panel p-3 md:flex'},h(Doors),
      h('div',{className:'mt-auto'},h('p',{'data-rail-foot':'',className:'text-[13px]'},'Sentry (Counsel)'))),
    h('main',{className:'flex min-w-0 flex-1 flex-col'},h('div',{className:'flex-1 p-4 text-[13px]'},'Chat'),
      h('div',{'data-composer':'',className:'m-3 min-h-16 rounded-xl border border-hairline/40 bg-raised p-3 text-[13px]'},'Message Susan'))));}
createRoot(document.getElementById('root')).render(h(Shell));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__reconnect" || req.url?.startsWith("/__reconnect?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reconnect line</title><body style="margin:0"><div id="root"></div><script type="module" src="/__reconnect.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const width of [1024, 390]) for (const skin of ["light", "dark"]) {
  test(`the band sits above the rail and the composer at ${width} px (${skin}), and Later puts it away`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`${origin}/__reconnect?skin=${skin}`);
    const band = page.locator("[data-reconnect-line]");
    await expect(band).toBeVisible();
    await expect(band.locator("[data-reconnect-app]")).toHaveCount(4);
    await expect(band.getByText("Freshdesk needs you to sign in again")).toHaveCount(1);
    await expect(band.getByRole("button", { name: "Reconnect Freshdesk" })).toHaveCount(1);
    const box = (await band.boundingBox())!;
    expect(await band.evaluate(node => getComputedStyle(node).position)).toBe("static");
    const composer = (await page.locator("[data-composer]").boundingBox())!;
    expect(overlaps(box, composer)).toBe(false);
    expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
    if (width >= 768) {
      const rail = (await page.locator("[data-rail]").boundingBox())!;
      expect(overlaps(box, rail)).toBe(false);
      expect(box.y + box.height).toBeLessThanOrEqual(rail.y);
      await expect(page.locator("[data-rail-foot]")).toBeInViewport();
    }
    // The X is reachable by keyboard: Tab from the Later button.
    await page.getByRole("button", { name: "Later" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Dismiss" })).toBeFocused();
    await page.screenshot({ path: join(shots, `band-${width}-${skin}.png`) });
    await page.getByRole("button", { name: "Later" }).click();
    await expect(band).toHaveCount(0);
    if (width >= 768) await expect(page.locator("[data-needs-you-reconnect]")).toBeVisible();
    await page.screenshot({ path: join(shots, `later-${width}-${skin}.png`) });
    expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls.every(call => call.startsWith("GET ")))).toBe(true);
  });
}
