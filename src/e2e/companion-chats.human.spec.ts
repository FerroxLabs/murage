import { test, expect } from "./page-error-guard";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures";
let fixture: any, vite: ViteDevServer, door: Server, origin: string, cookie: string;
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  const token = "c".repeat(64);
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: token }, instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Companion chats fixture'},{seedMessages:false});
    store.renameTask(bot.id,bot.threadId,'abc companion conversation');
    store.appendMessage(bot.threadId,{role:'user',kind:'text',text:'abc companion search evidence'});store.saveBots();
  ` });
  const { secret } = await (await fetch(fixture.info.url + "/api/desktop-secret")).json();
  await fetch(fixture.info.url + "/api/config", { method: "PUT", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret }, body: JSON.stringify({profile:{name:"Chats owner"}}) });
  // All registry data is inside the disposable fixture, before loading its module.
  process.env.MURAGE_COMPANION_DIR = join(fixture.info.dataDir, "companion");
  const { DeviceRegistry } = await import("../../companion/src/devices.ts");
  const { createBrowserHandler } = await import("../../companion/src/browser.ts");
  const registry = new DeviceRegistry();
  const paired = registry.redeem(registry.openPairing().code, "412px browser"); if ("error" in paired) throw new Error(paired.error);
  cookie = registry.openSession(paired.device.id, "Playwright")!.value;
  door = createHttpServer(createBrowserHandler({ harnessPort: Number(new URL(fixture.info.url).port), companionToken: token, devices: registry, identity: () => ({scheme:"http",hosts:new Set(["127.0.0.1"])}) }));
  await new Promise<void>(r => door.listen(0,"127.0.0.1",r));
  const target = `http://127.0.0.1:${(door.address() as {port:number}).port}`;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({configFile:false, root, envFile:false, cacheDir:join(fixture.info.dataDir,"vite"), resolve:{alias:{"@":join(root,"src")}}, plugins:[react(),tailwindcss()], server:{host:"127.0.0.1",port:0,watch:null,hmr:false,proxy:{"/api":{target},"/session":{target}}}});
  await vite.listen(0); origin = `http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
});
test.afterAll(async () => { await vite?.close(); if (door) {door.closeAllConnections(); await new Promise<void>(r => door.close(()=>r()));} await fixture?.close(); });
test("412x915 paired browser opens All chats and searches abc", async ({page, context}, info) => {
  await context.addCookies([{name:"murage_session",value:cookie,url:origin}]);
  await page.addInitScript(()=>{localStorage.setItem("help.seen.chat.level-chip","1");localStorage.setItem("murage-email-gate","skipped");localStorage.setItem("murage-flux-invite-dismissed","1");});
  await page.goto(origin); await openSidebar(page); await page.locator('[data-door="chats"]').first().click();
  await expect(page.locator('[data-chat-row]').filter({hasText:"abc companion conversation"})).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("textbox",{name:"Search all chats",exact:true}).fill("abc");
  await expect(page.getByText("abc companion search evidence",{exact:false}).first()).toBeVisible();
  await page.screenshot({path:info.outputPath("companion-chats-search.png")});
});
