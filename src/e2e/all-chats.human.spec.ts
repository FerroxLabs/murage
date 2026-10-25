// All mutations in this spec belong to a disposable verification fixture.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> };
let vite: ViteDevServer;
let origin: string;
let ids: { bot: string; old: string; message: string };

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Chats fixture'},{seedMessages:false});
    const now=Date.now();
    store.renameTask(bot.id,bot.threadId,'Current fixture chat');
    for(let i=0;i<120;i++) {
      const task=store.createTask(bot.id,'History '+String(i).padStart(3,'0'),false);
      task.createdAt=now-(i+1)*86400e3;
      if(i<55)task.pinned=true;
    }
    const old=store.createTask(bot.id,'Old contract discussion',false);
    old.createdAt=now-200*86400e3;
    const message=store.appendMessage(old.threadId,{role:'user',kind:'text',text:'cerulean lease renewal clause',at:now-199*86400e3});
    store.appendMessage(old.threadId,{role:'bot',kind:'text',text:'cerulean forgotten clause',withheldFromBots:'forgotten',at:now-199*86400e3+1});
    store.saveBots();
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'chats-fixture.json'),JSON.stringify({bot:bot.id,old:old.threadId,message:message.id}));
  ` });
  try {
    ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "chats-fixture.json"), "utf8"));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "chats-vite-cache"),
      resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No fixture UI port");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function open(page: Page) {
  await page.goto(origin);
  await openSidebar(page);
  await page.getByTestId("all-chats-entry").click();
  await expect(page.getByRole("textbox", { name: "Search all chats", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Bot", exact: true }).selectOption(ids.bot);
  await expect(page.locator("[data-chat-row]")).toHaveCount(50);
}

for (const width of [1440, 390]) for (const skin of ["light", "dark"]) {
  test(`pages stay bounded at ${width}px in ${skin}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.evaluate(skin => { document.documentElement.dataset.skin = skin; }, skin);
    const first = await page.locator("[data-chat-row]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-chat-row")));
    await page.getByRole("button", { name: /^Show older chats/ }).click();
    await expect(page.getByRole("button", { name: "Show newer chats", exact: true })).toBeEnabled();
    await expect(page.locator("[data-chat-row]")).toHaveCount(50);
    const second = await page.locator("[data-chat-row]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-chat-row")));
    expect(second.some(id => first.includes(id))).toBe(false);
    await page.getByRole("button", { name: "Show newer chats", exact: true }).click();
    await expect.poll(() => page.locator("[data-chat-row]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-chat-row")))).toEqual(first);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`all-chats-${width}-${skin}.png`) });
  });
}

test("search opens an old chat at the hit and omits a forgotten reply", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Search all chats", exact: true }).fill("cerulean");
  const hit = page.locator(`[data-chat-hit="${ids.old}"]`);
  await expect(hit).toContainText("cerulean lease renewal clause");
  await expect(page.locator("[data-chat-hit]")).toHaveCount(1);
  await expect(page.getByText("cerulean forgotten clause", { exact: false })).toHaveCount(0);
  await hit.click();
  const message = page.locator(`[data-mid="${ids.message}"]`);
  await expect(message).toBeVisible();
  await expect(message.locator("[data-flash-target]")).toHaveCount(1);
});

test("shortcuts, Expand, and the header button use the current bot", async ({ page }) => {
  await open(page);
  await page.locator("[data-chat-row]").first().click();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("textbox", { name: "Search chats", exact: true })).toBeFocused();
  await expect(page.getByText("Chats with Chats fixture", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Expand to All chats", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Bot", exact: true })).toHaveValue(ids.bot);
  await page.keyboard.press("Control+Shift+K");
  await expect(page.getByRole("textbox", { name: "Search all chats", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  const created = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/bots/${ids.bot}/tasks`));
  await page.keyboard.press("Control+Shift+N");
  expect((await created).status()).toBe(201);
  await expect(page.getByRole("button", { name: "Chat list", exact: true })).toContainText("New chat");
  await expect(page.locator("[data-chat-header-secondary]").getByRole("button", { name: "New chat", exact: true })).toBeVisible();
});
