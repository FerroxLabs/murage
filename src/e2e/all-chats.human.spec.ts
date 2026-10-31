// All mutations in this spec belong to a disposable verification fixture.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures";
import { phoneLayout } from "./chat-controls";

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
    // A workspace past its first run, before the app opens. On an unnamed one this bot is elected Chief and every setup read (a 3 s
    // poll) moves the setup conversation into the open thread and titles a new chat "Getting you set up", so the New chat
    // check below only passed when it looked first (ledger HUMAN-SETUP-FLAKE). This spec is about chats, not setup.
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json();
    const named = await fetch(`${fixture.info.url}/api/config`, { method: "PUT", body: JSON.stringify({ profile: { name: "Chats owner" } }),
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" } });
    if (!named.ok) throw new Error(`Could not name the fixture owner: ${named.status}`);
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
  if (await phoneLayout(page)) {
    // The phone header is one row, so the + beside the chip folds away
    // (chip-trim); the chat list's own New chat row is the way in there.
    await page.getByRole("button", { name: "Chat list", exact: true }).click();
    await expect(page.getByRole("button", { name: /^New chat$/ })).toBeVisible();
    await page.keyboard.press("Escape");
  } else {
    await expect(page.locator("[data-chat-header-secondary]").getByRole("button", { name: "New chat", exact: true })).toBeVisible();
  }
});

test("with a phone keyboard up the chat pop-up scrolls above it: every row and every footer button stays reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // a phone keyboard shrinks only the visual viewport; stand one in that the test can shrink and grow again
  await page.addInitScript(() => {
    const state = window as unknown as { __keyboard: number };
    state.__keyboard = 0;
    const view = new EventTarget();
    const metrics: Record<string, () => number> = {
      height: () => innerHeight - state.__keyboard, width: () => innerWidth, offsetTop: () => 0, offsetLeft: () => 0,
      pageTop: () => scrollY, pageLeft: () => scrollX, scale: () => 1,
    };
    for (const [key, get] of Object.entries(metrics)) Object.defineProperty(view, key, { get });
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => view });
  });
  const keyboard = (px: number) => page.evaluate(value => {
    (window as unknown as { __keyboard: number }).__keyboard = value;
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, px);
  await open(page);
  await page.locator("[data-chat-row]").first().click();
  await page.getByRole("button", { name: "Chat list", exact: true }).click();
  const menu = page.locator("[data-chat-list-menu]");
  const list = menu.getByRole("group", { name: "Chats", exact: true });
  await expect(page.getByRole("textbox", { name: "Search chats", exact: true })).toBeFocused();
  const bottomOf = async (locator: typeof menu) => { const box = (await locator.boundingBox())!; return box.y + box.height; };

  // the focused search box raises the keyboard: 844 - 336 leaves 508 px, as on an iPhone
  await keyboard(336);
  const visible = 508;
  await expect.poll(() => bottomOf(menu)).toBeLessThanOrEqual(visible);
  // the list keeps about two rows, and scrolls on its own
  expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(88);
  expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  // every footer button can be scrolled into the space above the keyboard and takes a tap there
  for (const name of [/^Export conversation/, /^New chat$/]) {
    const button = menu.getByRole("button", { name });
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(visible);
    await button.click({ trial: true });
  }
  // and so can the last row and the button below it
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  for (const target of [list.locator("[data-task-nav]").last(), list.getByRole("button", { name: "Show older chats", exact: true })]) {
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(visible);
    await target.click({ trial: true });
  }

  // the keyboard goes down: the pop-up takes the full space again, the list is the part that grows
  await keyboard(0);
  await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(200);
  expect(await bottomOf(menu)).toBeLessThanOrEqual(844 - 8);
  expect(await menu.evaluate(node => getComputedStyle(node).overflowY)).toBe("hidden");
  await expect(menu.getByRole("button", { name: /^New chat$/ })).toBeInViewport();
});
