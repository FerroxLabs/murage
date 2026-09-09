import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

interface Fixture { info: { url: string; dataDir: string }; close(): Promise<void> }
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;
let fixture: Fixture, vite: ViteDevServer, origin: string, owner: Record<string, string>;
const botId = "settings-proof-bot";
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `import {writeFileSync} from 'node:fs';import {join} from 'node:path';const at=Date.now();writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'settings-proof-task',name:'Settings proof bot',title:'Research helper',description:'Use supplied evidence.',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'settings-proof-task',title:'Research task',createdAt:at,resumeCursors:{}}],chiefOfStaff:false,autoApprove:false,composio:false,computer:'off',browser:false,installedPackage:{id:'fixture-profile',name:'Fixture profile',release:'1.0.0',requiredApps:[],sourceRole:'leader',sourceTeam:'Studio'}}]));` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "settings-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "bot-settings-fixture", resolveId(id) { if (id === "/__bot-settings.js") return "\0bot-settings-fixture"; },
        load(id) { if (id !== "\0bot-settings-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {DesktopCapabilitiesProvider} from '/src/components/DesktopCapabilities.tsx';import {BotSettingsDialog} from '/src/components/BotSettingsDialog.tsx';import '/src/styles.css';function Surface(){const {state}=useStore();const [open,setOpen]=React.useState(false);const bot=state.bots.find(bot=>bot.id==='${botId}');return React.createElement(React.Fragment,null,React.createElement('button',{disabled:!bot,onClick:()=>setOpen(true)},'Open bot settings'),open&&bot&&React.createElement(BotSettingsDialog,{bot,onClose:()=>setOpen(false)}));}createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(DesktopCapabilitiesProvider,null,React.createElement(Surface))));`; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__bot-settings") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__bot-settings.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Settings fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

for (const skin of ["light", "dark"]) for (const width of [390, 1440]) test(`sectioned settings preserve drafts and authority at ${width}px ${skin}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(skin => { localStorage.setItem("murage-skin", skin); localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); }, skin);
  await page.goto(origin + "/__bot-settings"); await page.evaluate(skin => document.documentElement.dataset.skin = skin, skin);
  const opener = page.getByRole("button", { name: "Open bot settings", exact: true }); await opener.click();
  const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Imported role: Team leader", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Imported team: Studio", { exact: true })).toBeVisible();
  await expect(dialog.getByText("The imported role is not active. Use the role control below to assign a role explicitly.", { exact: true })).toBeVisible();
  if (width < 640) expect(await dialog.getByRole("combobox", { name: "Section", exact: true }).locator("option").count()).toBe(11);
  else expect(await dialog.getByRole("navigation", { name: "Bot settings sections" }).getByRole("button").count()).toBe(11);
  await page.screenshot({ path: testInfo.outputPath(`settings-overview-${width}-${skin}.png`), fullPage: true });
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  await search.fill("working folder"); await expect(dialog.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  const folder = dialog.getByRole("textbox", { name: "Working folder path", exact: true }); const original = await folder.inputValue();
  await folder.fill("/fixture-unsaved-folder");
  await search.fill("personality"); await expect(dialog.getByRole("textbox", { name: /^Personality/ })).toBeVisible();
  await search.fill("folder"); await expect(folder).toHaveValue("/fixture-unsaved-folder");
  await folder.focus(); page.once("dialog", confirm => confirm.dismiss()); await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await expect(folder).toHaveValue("/fixture-unsaved-folder"); await folder.fill(original);
  await search.fill("notebook"); await dialog.getByRole("button", { name: /^Legacy notebook/ }).click();
  const notebook = dialog.getByRole("textbox", { name: "Legacy bot notebook", exact: true }); await expect(notebook).toBeVisible();
  const note = `Draft retained ${width} ${skin}`; await notebook.fill(note);
  await search.fill("permissions"); await expect(dialog.getByRole("switch", { name: "Auto mode", exact: true })).not.toBeChecked();
  await search.fill("notebook"); await expect(notebook).toHaveValue(note);
  let release: (() => void) | undefined;
  await page.route(`**/api/bots/${botId}/memory`, async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch(); await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect.poll(() => Boolean(release)).toBe(true);
  await dialog.getByRole("button", { name: "Close bot settings", exact: true }).click(); await expect(dialog.getByRole("status")).toHaveText("Wait for the current save to finish before closing.");
  release!(); await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await search.fill("never-matching-section"); await expect(dialog.getByText("No matching settings sections.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Clear search", exact: true }).click();
  if (width < 640) await dialog.getByRole("combobox", { name: "Section", exact: true }).selectOption("identity"); else await dialog.getByRole("button", { name: "Identity & instructions", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: /^Instructions/ })).toHaveValue("Use supplied evidence.");
  await page.screenshot({ path: testInfo.outputPath(`settings-identity-${width}-${skin}.png`), fullPage: true });
  await dialog.getByRole("button", { name: "Close bot settings", exact: true }).focus(); await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]')))).toBe(true);
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  const stored = await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: owner })).json() as { bots: { id: string; chiefOfStaff?: boolean; autoApprove?: boolean; composio?: boolean }[] };
  expect(stored.bots.find(bot => bot.id === botId)).toMatchObject({ chiefOfStaff: false, autoApprove: false, composio: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
