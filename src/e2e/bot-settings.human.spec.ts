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
// Never chose an approval level: like every new bot, its record has no
// autoApprove or fullAccess field at all (the harness omits unset fields).
const levelBotId = "level-proof-bot";
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `import {writeFileSync} from 'node:fs';import {join} from 'node:path';const at=Date.now();writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'settings-proof-task',name:'Settings proof bot',title:'Research helper',description:'Use supplied evidence.',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'settings-proof-task',title:'Research task',createdAt:at,resumeCursors:{}}],chiefOfStaff:false,autoApprove:false,composio:false,computer:'off',browser:false,installedPackage:{id:'fixture-profile',name:'Fixture profile',release:'1.0.0',requiredApps:[],sourceRole:'leader',sourceTeam:'Studio'}},{id:'${levelBotId}',threadId:'level-proof-task',name:'Level proof bot',title:'',description:'',color:'blue',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'level-proof-task',title:'Level task',createdAt:at,resumeCursors:{}}],composio:false,computer:'off',browser:false}]));` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "settings-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "bot-settings-fixture", resolveId(id) { if (id === "/__bot-settings.js") return "\0bot-settings-fixture"; },
        load(id) { if (id !== "\0bot-settings-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {DesktopCapabilitiesProvider} from '/src/components/DesktopCapabilities.tsx';import {BotSettingsDialog} from '/src/components/BotSettingsDialog.tsx';import {ComputerPanel} from '/src/components/ComputerPanel.tsx';import '/src/styles.css';function Surface(){const {state,dispatch}=useStore();const [open,setOpen]=React.useState(false);const shown=new URLSearchParams(location.search).get('bot')||'${botId}';const bot=state.bots.find(bot=>bot.id===shown);return React.createElement(React.Fragment,null,React.createElement('button',{disabled:!bot,onClick:()=>setOpen(true)},'Open bot settings'),React.createElement('button',{disabled:!bot,onClick:()=>dispatch({type:'toggleComputer',open:true})},'Open computer'),bot&&(open||state.settingsOpen)&&React.createElement(BotSettingsDialog,{bot,onClose:()=>{setOpen(false);dispatch({type:'toggleSettings',open:false});}}),bot&&state.computerOpen&&React.createElement(ComputerPanel,{bot}));}createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(DesktopCapabilitiesProvider,null,React.createElement(Surface))));`; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url?.split("?")[0] !== "/__bot-settings") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__bot-settings.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Settings fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

test("Computer gear opens the same bot settings exclusively and allows reopening", async ({ page }, testInfo) => {
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/__bot-settings`);
    const computer = page.locator('aside').filter({ has: page.getByTitle('Bot settings', { exact: true }) });
    const settings = page.getByRole('dialog', { name: 'Bot settings', exact: true });
    for (const close of width < 640 ? ['button', 'escape'] : ['button', 'escape', 'backdrop']) {
      await page.getByRole('button', { name: 'Open computer', exact: true }).click();
      await expect(computer).toBeVisible();
      await computer.getByTitle('Bot settings', { exact: true }).click();
      await expect(computer).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(settings.locator('header').getByText('Settings proof bot', { exact: true })).toBeVisible();
      if (close === 'button') {
        await page.screenshot({ path: testInfo.outputPath(`computer-settings-${width}.png`), fullPage: true });
        await settings.getByRole('button', { name: 'Close bot settings', exact: true }).click();
      } else if (close === 'escape') await page.keyboard.press('Escape');
      else await page.mouse.click(1, 1);
      await expect(settings).toHaveCount(0);
      await expect(computer).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Open computer', exact: true }).click();
    await expect(computer).toBeVisible();
  }
});

test("Appearance is folded in Overview and remains user-expandable", async ({ page }, testInfo) => {
  await page.goto(`${origin}/__bot-settings`);
  await page.getByRole("button", { name: "Open bot settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true });
  await expect(dialog).toBeVisible();
  // 0.1.57: the panel opens on what the bot is FOR, not on the avatar studio.
  await expect(dialog.getByText("What is this bot for?", { exact: true })).toBeVisible();
  const summary = dialog.locator("summary").filter({ hasText: /^Appearance$/ });
  const disclosure = summary.locator("..");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await summary.click();
  await expect(disclosure).toHaveAttribute("open", "");
  await summary.click();
  await expect(disclosure).not.toHaveAttribute("open", "");
  await summary.click();
  await expect(dialog.getByRole("button", { name: "Upload image", exact: true })).toBeVisible();
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`appearance-folded-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await dialog.getByRole("button", { name: "Close bot settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const stored = await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: owner })).json() as { bots: { id: string; chiefOfStaff?: boolean; autoApprove?: boolean; composio?: boolean }[] };
  expect(stored.bots.find(bot => bot.id === botId)).toMatchObject({ chiefOfStaff: false, autoApprove: false, composio: false });
});

for (const skin of ["light", "dark"]) for (const width of [390, 1440]) test(`sectioned settings preserve drafts and authority at ${width}px ${skin}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(skin => { localStorage.setItem("murage-skin", skin); localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); }, skin);
  await page.goto(origin); await page.evaluate(skin => document.documentElement.dataset.skin = skin, skin);
  const opener = page.getByRole("button", { name: "Open Settings proof bot's profile", exact: true }).first(); await opener.click();
  const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Imported role: Team leader", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Imported team: Studio", { exact: true })).toBeVisible();
  await expect(dialog.getByText("The imported role is not active. Use the role control below to assign a role explicitly.", { exact: true })).toBeVisible();
  if (width < 640) expect(await dialog.getByRole("combobox", { name: "Section", exact: true }).locator("option").count()).toBe(11);
  else expect(await dialog.getByRole("navigation", { name: "Bot settings sections" }).getByRole("button").count()).toBe(11);
  await page.screenshot({ path: testInfo.outputPath(`settings-overview-${width}-${skin}.png`), fullPage: true });
  if (width === 1440 && skin === "dark") {
    // Delay an actual fixture upload response. Closing must not pretend it
    // cancels an operation that has already reached the server.
    let finishUpload: (() => void) | undefined;
    await page.route("**/api/attachments", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); await new Promise<void>(resolve => { finishUpload = resolve; }); await route.fulfill({ response });
    });
    // Appearance is folded on Overview since 0.1.57, so the avatar editor
    // has to be opened before its file input exists.
    await dialog.locator("summary").filter({ hasText: /^Appearance$/ }).click();
    await expect(dialog.locator("summary").filter({ hasText: /^Appearance$/ }).locator("..")).toHaveAttribute("open", "");
    const png = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2; canvas.getContext("2d")!.fillRect(0, 0, 2, 2); return canvas.toDataURL("image/png").split(",")[1]; });
    await dialog.locator('input[type="file"]').setInputFiles({ name: "fixture-avatar.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect.poll(() => Boolean(finishUpload)).toBe(true);
    await dialog.getByRole("button", { name: "Close bot settings", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Wait for the current operation to finish before closing.");
    finishUpload!(); await expect(dialog.getByRole("button", { name: "Upload image", exact: true })).toBeEnabled();
    // Was (closed the disclosure this block used to open):
    //   await dialog.getByText("Appearance", { exact: true }).click();
  }
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  await search.fill("working folder"); await expect(dialog.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  const folder = dialog.getByRole("textbox", { name: "Working folder path", exact: true }); const original = await folder.inputValue();
  await folder.fill("/fixture-unsaved-folder");
  await search.fill("personality"); await expect(dialog.getByRole("textbox", { name: /^Personality/ })).toBeVisible();
  await search.fill("folder"); await expect(folder).toHaveValue("/fixture-unsaved-folder");
  await search.fill("model"); await dialog.locator('[data-settings-section="model"] button[aria-haspopup="dialog"]').click();
  page.once("dialog", confirm => confirm.dismiss()); await dialog.getByRole("button", { name: "Manage models and providers", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-settings-section="model"] button[aria-haspopup="dialog"]').click();
  await search.fill("folder"); await expect(folder).toHaveValue("/fixture-unsaved-folder");
  await folder.focus(); page.once("dialog", confirm => confirm.dismiss()); await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await expect(folder).toHaveValue("/fixture-unsaved-folder"); await folder.fill(original);
  await search.fill("notebook"); await dialog.getByRole("button", { name: /^Legacy notebook/ }).click();
  const notebook = dialog.getByRole("textbox", { name: "Legacy bot notebook", exact: true }); await expect(notebook).toBeVisible();
  const note = `Draft retained ${width} ${skin}`; await notebook.fill(note);
  await search.fill("permissions"); await expect(dialog.getByRole("radio", { name: "Auto", exact: true })).not.toBeChecked();
  await search.fill("notebook"); await expect(notebook).toHaveValue(note);
  let release: (() => void) | undefined;
  await page.route(`**/api/bots/${botId}/memory`, async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch(); await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect.poll(() => Boolean(release)).toBe(true);
  await dialog.getByRole("button", { name: "Close bot settings", exact: true }).click(); await expect(dialog.getByRole("status")).toHaveText("Wait for the current operation to finish before closing.");
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

test("a refused Full access snaps back to the saved level and says why; away from the desktop it is not offered", async ({ page, browser }) => {
  const FULL_ACCESS_DESKTOP_ONLY = "Full access can only be turned on in the Murage desktop app.";
  await page.setViewportSize({ width: 1440, height: 900 });
  // The desktop renderer, but a harness that does not accept this request as
  // the desktop's: it answers Full access with its bare desktop-only 404.
  await page.route(`**/api/bots/${levelBotId}`, route => route.request().method() === "PATCH" && route.request().postData()?.includes('"fullAccess":true')
    ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) })
    : route.continue());
  await page.goto(`${origin}/__bot-settings?bot=${levelBotId}`);
  await page.getByRole("button", { name: "Open bot settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true });
  await dialog.getByRole("searchbox", { name: "Search settings" }).fill("permissions");
  const full = dialog.getByRole("radio", { name: "Full access", exact: true });
  await full.click();
  await page.getByRole("button", { name: "Turn on full access", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(FULL_ACCESS_DESKTOP_ONLY);
  await expect(dialog.getByRole("radio", { name: "Ask", exact: true })).toBeChecked();
  await expect(full).not.toBeChecked();
  await expect(dialog.getByRole("switch", { name: /^Also approve setup requests/ })).toBeDisabled();
  await expect(dialog.getByRole("switch", { name: /^Also skip approvals/ })).toBeDisabled();
  const stored = await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: owner })).json() as { bots: { id: string; fullAccess?: boolean }[] };
  expect(stored.bots.find(bot => bot.id === levelBotId)?.fullAccess).not.toBe(true);

  // A renderer the harness answers as remote (a phone, the browser door).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const phone = await context.newPage();
    await phone.route("**/api/desktop-secret", route => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await phone.goto(`${origin}/__bot-settings?bot=${levelBotId}`);
    await phone.getByRole("button", { name: "Open bot settings", exact: true }).click();
    const remote = phone.getByRole("dialog", { name: "Bot settings", exact: true });
    await remote.getByRole("searchbox", { name: "Search settings" }).fill("permissions");
    await expect(remote.getByRole("radio", { name: "Full access", exact: true })).toBeDisabled();
    await expect(remote.getByRole("radio", { name: "Auto", exact: true })).toBeEnabled();
    await expect(remote.getByText(FULL_ACCESS_DESKTOP_ONLY, { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
