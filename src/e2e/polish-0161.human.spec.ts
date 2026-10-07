// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 polish lane (L12), in a real browser against a fixture backend:
// G3, every Settings section reachable at 1280x720 with a visible scrollbar
// when the list does not fit; G4, the archive note with Restore that stays;
// G11, the picture-left-out note and the plain error sentence naming the bot.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;
let pageErrors: string[] = [];
const proof = "cd".repeat(32);
const SHOTS = process.env.MURAGE_POLISH_SHOTS;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-polish-vite-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "polish-fixture",
      resolveId(id) { if (id === "/__settings.js") return "\0settings"; if (id === "/__notes.js") return "\0notes"; },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id === "\0settings") return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {SettingsModal} from '/src/components/SettingsModal.tsx';import '/src/styles.css';
          document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';
          function Fixture(){const store=useStore();React.useEffect(()=>{store.dispatch({type:'toggleAppSettings',open:true});},[]);return store.state.appSettingsOpen?React.createElement(SettingsModal):null;}
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Fixture)));`;
        if (id === "\0notes") return `import React from 'react';import {createRoot} from 'react-dom/client';import {ImagesLeftOutRow} from '/src/components/ImagesLeftOutRow.tsx';import {RuntimeErrorCard} from '/src/components/RuntimeErrorCard.tsx';import {TeamFeedbackToast,archiveFeedback} from '/src/components/Sidebar.tsx';import '/src/styles.css';
          document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';
          const raw='API error (status 400): {"error":{"message":"flux-pinned-deepseek-v4-pro does not accept image input","type":"invalid_request_error"}}';
          function Notes(){return React.createElement('div',{style:{padding:16,display:'grid',gap:12,maxWidth:760}},
            React.createElement(ImagesLeftOutRow,{botName:'Dax',count:1}),
            React.createElement(RuntimeErrorCard,{message:raw,botName:'Dax',onOpenProviderSettings:()=>{},onRetry:()=>{}}),
            React.createElement(TeamFeedbackToast,{feedback:archiveFeedback({id:'b1',name:'Dax'},true),onUndoTeam:()=>{},onUndoBot:()=>{},onDismiss:()=>{}}));}
          createRoot(document.getElementById('root')).render(React.createElement(Notes));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://fixture").pathname;
        const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
        const page = (script: string) => { res.setHeader("content-type", "text/html"); res.end(`<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polish fixture</title></head><body style="margin:0;background:var(--color-app)"><div id="root"></div><script type="module" src="${script}"></script></body></html>`); };
        if (path === "/__settings") page("/__settings.js");
        else if (path === "/__notes") page("/__notes.js");
        else if (path === "/api/desktop-secret") json({ secret: proof });
        else if (path === "/api/config" && req.method === "GET") json({ composio: { configured: false, mode: "unavailable" }, box: { configured: false }, vps: { configured: false, sshAlias: "" }, rooms: { turnTimeoutMinutes: 15 }, localVm: { mode: "shared", maxInstances: 1 }, flux: { configured: false }, profile: { name: "Sam", email: "" }, surface: req.headers["x-murage-surface-secret"] === proof ? "desktop" : "remote" });
        else if (path === "/api/instances") json({ instances: [] });
        else if (path === "/api/bots") json({ bots: [], groups: [] });
        else if (path.startsWith("/api/") && !["GET", "HEAD"].includes(req.method ?? "GET")) json({ error: "Unexpected fixture write" }, 409);
        else if (path.startsWith("/api/")) json({ error: "Unused fixture read" }, 404);
        else next();
      }); },
    }],
  });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(async ({ page }) => { pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message)); await page.route("https://**/*", (route) => route.abort()); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });
test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

const shot = async (page: Page, name: string, info: { outputPath: (name: string) => string }) => {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

for (const [width, height] of [[1280, 720], [1280, 560], [390, 844], [820, 1180], [1440, 900]] as const) test(`G3: every Settings section is reachable (${width}x${height})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height });
  await page.goto(`${origin}/__settings`, { waitUntil: "domcontentloaded" });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const usage = dialog.getByRole("button", { name: "Usage", exact: true });
  await expect(dialog.getByRole("button", { name: "About me", exact: true })).toHaveCount(1);
  const nav = dialog.locator("nav");
  const fits = await nav.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
  if (width >= 768) {
    // Either the whole list fits, or it scrolls with a scrollbar the eye can see.
    if (!fits) expect(await nav.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    // 0.1.62: six group headings over nineteen rows fit a 1440x900 window;
    // a 1280x720 one scrolls the list a little (NAV-OVERHAUL.md 3.2).
    if (width === 1440 && height === 900) expect(fits).toBe(true);
  }
  await shot(page, `settings-${width}x${height}`, info);
  await usage.scrollIntoViewIfNeeded();
  await usage.click();
  await expect(dialog.getByText("Usage", { exact: true }).first()).toBeVisible();
  await shot(page, `settings-usage-${width}x${height}`, info);
});

for (const width of [390, 820, 1440]) test(`G4 + G11 notes read plainly (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}/__notes`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Dax can't see images, so I left the picture out.", { exact: true })).toBeVisible();
  await expect(page.getByText("Dax's model can't read images, so it couldn't answer.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, `notes-${width}`, info);
});
