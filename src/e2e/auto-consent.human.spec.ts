// AUTOOP2 finding 1, renderer half: the bot-settings Auto switch on a bot that
// never chose a computer (the "Auto" destination, which is THIS Mac on macOS)
// must open the local-computer warning and send the acknowledgement, not fire
// a bare PATCH the harness now refuses. Real BotSettingsDialog, real harness.
//
// FOLLOW5: the harness decides from ITS process.platform, and this renderer
// runs in a plain browser (no desktop shell), which used to mean the UA
// decided — the browser's machine, not the harness's. The second test drives
// the same dialog from a browser whose UA names the OTHER platform and proves
// the warning follows the harness's announcement (`/api/config` `harness`),
// on either host: a Linux tab on this Mac harness still gets the dialog; a
// Mac tab on a Linux harness gets none and the PATCH lands.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

interface Fixture { info: { url: string; dataDir: string }; close(): Promise<void> }
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;
let fixture: Fixture, vite: ViteDevServer, origin: string, owner: Record<string, string>;
const botId = "auto-consent-bot";
// The harness and the renderer agree on the host: a default destination
// mounts this computer on macOS only. Elsewhere Auto needs no warning.
const mountsThisComputer = process.platform === "darwin";
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  // No `computer` key: the bot never chose a destination.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `import {writeFileSync} from 'node:fs';import {join} from 'node:path';const at=Date.now();writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'auto-consent-task',name:'Consent proof bot',title:'Research helper',description:'Use supplied evidence.',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'auto-consent-task',title:'Research task',createdAt:at,resumeCursors:{}}],chiefOfStaff:false,autoApprove:false,composio:false,browser:false}]));` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "consent-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "auto-consent-fixture", resolveId(id) { if (id === "/__auto-consent.js") return "\0auto-consent-fixture"; },
        load(id) { if (id !== "\0auto-consent-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {DesktopCapabilitiesProvider} from '/src/components/DesktopCapabilities.tsx';import {BotSettingsDialog} from '/src/components/BotSettingsDialog.tsx';import '/src/styles.css';function Surface(){const {state}=useStore();const [open,setOpen]=React.useState(false);const bot=state.bots.find(bot=>bot.id==='${botId}');return React.createElement(React.Fragment,null,React.createElement('button',{disabled:!bot,onClick:()=>setOpen(true)},'Open bot settings'),state.error&&React.createElement('p',{role:'alert'},state.error),open&&bot&&React.createElement(BotSettingsDialog,{bot,onClose:()=>setOpen(false)}));}createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(DesktopCapabilitiesProvider,null,React.createElement(Surface))));`; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__auto-consent") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__auto-consent.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Consent fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

const storedBot = async () => {
  const state = await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: owner })).json() as { bots: { id: string; autoApprove?: boolean; computer?: string }[] };
  return state.bots.find(bot => bot.id === botId)!;
};
const resetBot = async () => {
  const reset = await fetch(fixture.info.url + `/api/bots/${botId}`, { method: "PATCH", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ autoApprove: false }) });
  expect(reset.status).toBe(200);
  expect((await storedBot()).autoApprove).toBe(false);
};

test("the settings Auto switch on a bot with no chosen computer asks before the harness is asked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  // Every PATCH the switch fires, with its status: a refused one is the bug.
  const patches: Array<{ status: number; body: unknown }> = [];
  page.on("response", async response => {
    const request = response.request();
    if (request.method() === "PATCH" && new URL(response.url()).pathname === `/api/bots/${botId}`) patches.push({ status: response.status(), body: request.postDataJSON() });
  });
  await page.goto(origin + "/__auto-consent");
  await page.getByRole("button", { name: "Open bot settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Search settings" }).fill("permissions");
  const auto = dialog.getByRole("switch", { name: "Auto mode", exact: true });
  await expect(auto).not.toBeChecked();
  expect((await storedBot()).computer).toBeUndefined();
  const warning = page.getByRole("dialog", { name: "Allow Auto mode on this computer?", exact: true });

  await auto.click();
  if (mountsThisComputer) {
    // The warning comes first; nothing has reached the harness yet.
    await expect(warning).toBeVisible();
    expect(patches).toEqual([]);
    expect((await storedBot()).autoApprove).toBe(false);
    // Cancel keeps Ask, on screen and on disk.
    await warning.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(warning).toHaveCount(0);
    await expect(auto).not.toBeChecked();
    expect(patches).toEqual([]);
    expect((await storedBot()).autoApprove).toBe(false);
    // Confirming sends the acknowledgement with the grant.
    await auto.click();
    await expect(warning).toBeVisible();
    await warning.getByRole("button", { name: "OK", exact: true }).click();
    await expect(warning).toHaveCount(0);
  } else {
    await expect(warning).toHaveCount(0);
  }
  await expect(auto).toBeChecked();
  await expect.poll(async () => (await storedBot()).autoApprove).toBe(true);
  expect(patches).toHaveLength(1);
  expect(patches[0].status).toBe(200);
  expect(patches[0].body).toMatchObject(mountsThisComputer ? { autoApprove: true, acknowledgeLocalAuto: true } : { autoApprove: true });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// The UA of the OTHER platform: what a remote tab through the browser door
// looks like when the person's laptop is not the harness's machine.
const foreignUserAgent = mountsThisComputer
  ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
  : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

test.describe("a browser whose UA names another platform (FOLLOW5)", () => {
  test.use({ userAgent: foreignUserAgent });
  test("the Auto switch follows the platform the harness announced, not the browser's UA", async ({ page }) => {
    await resetBot();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
    const patches: Array<{ status: number; body: unknown }> = [];
    page.on("response", async response => {
      const request = response.request();
      if (request.method() === "PATCH" && new URL(response.url()).pathname === `/api/bots/${botId}`) patches.push({ status: response.status(), body: request.postDataJSON() });
    });
    await page.goto(origin + "/__auto-consent");
    // The browser really is the other platform, and the harness really announced its own.
    expect(await page.evaluate(() => navigator.userAgent)).toBe(foreignUserAgent);
    expect(((await (await fetch(fixture.info.url + "/api/config", { headers: owner })).json()) as { harness?: { platform?: string } }).harness).toEqual({ platform: process.platform });
    await page.getByRole("button", { name: "Open bot settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true }); await expect(dialog).toBeVisible();
    await dialog.getByRole("searchbox", { name: "Search settings" }).fill("permissions");
    const auto = dialog.getByRole("switch", { name: "Auto mode", exact: true });
    await expect(auto).not.toBeChecked();
    expect((await storedBot()).computer).toBeUndefined();
    const warning = page.getByRole("dialog", { name: "Allow Auto mode on this computer?", exact: true });

    await auto.click();
    if (mountsThisComputer) {
      // A Linux tab on this Mac harness: the harness would refuse a blind
      // PATCH, so the dialog must come first — the UA used to skip it and
      // the person saw a red banner.
      await expect(warning).toBeVisible();
      expect(patches).toEqual([]);
      expect((await storedBot()).autoApprove).toBe(false);
      await warning.getByRole("button", { name: "OK", exact: true }).click();
      await expect(warning).toHaveCount(0);
    } else {
      // A Mac tab on a Linux (or Windows) harness: the harness requires no
      // acknowledgement for a default destination, so no dialog — the UA
      // used to show one the server never asked for.
      await expect(warning).toHaveCount(0);
    }
    await expect(auto).toBeChecked();
    await expect.poll(async () => (await storedBot()).autoApprove).toBe(true);
    expect(patches).toHaveLength(1);
    expect(patches[0].status).toBe(200);
    expect(patches[0].body).toMatchObject(mountsThisComputer ? { autoApprove: true, acknowledgeLocalAuto: true } : { autoApprove: true });
    if (!mountsThisComputer) expect(patches[0].body).not.toHaveProperty("acknowledgeLocalAuto");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
