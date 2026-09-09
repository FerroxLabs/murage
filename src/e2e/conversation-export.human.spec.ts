import { expect, test, type Download, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> }, vite: ViteDevServer, origin: string;
let ids: { bot: string; first: string; second: string; group: string; groupThread: string };
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Export fixture'},{seedMessages:false});
    const first=bot.threadId;store.renameTask(bot.id,first,'Alpha notes');
    const inactive=store.appendMessage(first,{role:'user',kind:'text',text:'INACTIVE_BRANCH_CANARY'});
    store.branchMessage(first,inactive.id,'ALPHA_VISIBLE_CANARY');
    store.appendMessage(first,{role:'bot',kind:'text',text:'Alpha response'});
    const second=store.createTask(bot.id,'Beta notes').threadId;
    store.appendMessage(second,{role:'user',kind:'text',text:'BETA_PRIVATE_CANARY'});store.switchTask(bot.id,first);
    const group=store.createGroup('Export room',[bot.id],false,undefined,{completed:true});
    store.appendMessage(group.threadId,{role:'bot',kind:'text',text:'GROUP_VISIBLE_CANARY',from:{botId:bot.id,name:'Export fixture'}});
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'export-fixture.json'),JSON.stringify({bot:bot.id,first,second,group:group.id,groupThread:group.threadId}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "export-fixture.json"), "utf8"));
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "export-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "conversation-export-fixture", resolveId(id) { if (id === "/__export.js") return "\0conversation-export"; },
        load(id) { if (id !== "\0conversation-export") return; return `
          import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {TaskPicker,GroupTaskPicker} from '/src/components/TaskPicker.tsx';import '/src/styles.css';
          function Surface(){const {state}=useStore();const bot=state.bots.find(b=>b.id==='${ids.bot}');const group=state.groups.find(g=>g.id==='${ids.group}');return React.createElement(React.Fragment,null,
            React.createElement('section',{'aria-label':'Bot conversation',style:{marginBottom:450}},React.createElement('h1',null,'Export fixture'),bot&&React.createElement(TaskPicker,{bot})),
            React.createElement('section',{'aria-label':'Group conversation'},React.createElement('h2',null,'Export room'),group&&React.createElement(GroupTaskPicker,{group})));}
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Surface)));`; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__export") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:560px;margin:24px auto;padding:16px"></main><script type="module" src="/__export.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No export fixture port"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });
const markdown = async (download: Download) => { expect(await download.failure()).toBeNull(); return readFileSync((await download.path())!, "utf8"); };
async function openFirst(page: Page) {
  await page.goto(origin + "/__export");
  const bot = page.getByRole("region", { name: "Bot conversation", exact: true });
  await bot.getByRole("button", { name: "All threads", exact: true }).click();
  await bot.getByRole("button", { name: /^Alpha notes/ }).click();
  await expect(bot.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveCount(0);
  await bot.getByRole("button", { name: "All threads", exact: true }).click();
  return bot;
}

for (const width of [390, 1440]) for (const skin of ["light", "dark"]) test(`current bot/group Markdown export at ${width}px ${skin}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const bot = await openFirst(page); await page.evaluate(skin => document.documentElement.dataset.skin = skin, skin);
  const action = bot.getByRole("button", { name: "Export conversation (Markdown)", exact: true });
  await expect(bot.getByText("Current conversation only. Not an importable bot package.", { exact: true })).toBeVisible();
  await action.focus(); const receipt = page.waitForEvent("download"); const request = page.waitForRequest(req => req.url().includes(`/threads/${ids.first}/export`));
  await page.keyboard.press("Enter"); const exported = await receipt;
  expect(exported.suggestedFilename()).toBe("conversation-alpha-notes.md");
  const contents = await markdown(exported); expect(contents).toContain("# Alpha notes"); expect(contents).toContain("ALPHA_VISIBLE_CANARY"); expect(contents).not.toMatch(/BETA_PRIVATE_CANARY|INACTIVE_BRANCH_CANARY|GROUP_VISIBLE_CANARY/);
  const sent = await request; expect(sent.headers()["x-murage-surface"]).toBe("desktop"); expect(Boolean(sent.headers()["x-murage-surface-secret"])).toBe(true);
  await expect(bot.getByRole("status")).toContainText("Download started: conversation-alpha-notes.md");
  expect(await action.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })).toBe(true);
  await page.screenshot({ path: info.outputPath(`conversation-export-${width}-${skin}.png`) });
  await bot.getByRole("textbox", { name: "Search tasks", exact: true }).press("Escape"); await expect(bot.getByRole("button", { name: "All threads", exact: true })).toBeFocused();
  const group = page.getByRole("region", { name: "Group conversation", exact: true }); await group.getByRole("button", { name: "All threads", exact: true }).click();
  const groupReceipt = page.waitForEvent("download"); await group.getByRole("button", { name: "Export conversation (Markdown)", exact: true }).click();
  const groupText = await markdown(await groupReceipt); expect(groupText).toContain("GROUP_VISIBLE_CANARY"); expect(groupText).toContain("**Export fixture:**"); expect(groupText).not.toMatch(/ALPHA_VISIBLE_CANARY|BETA_PRIVATE_CANARY/);
});

test("pending export keeps original task identity and failure is visible without a download", async ({ page }) => {
  const bot = await openFirst(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/threads/${ids.first}/export?format=markdown`, async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
  const requested = page.waitForRequest(req => req.url().includes(`/threads/${ids.first}/export`));
  await bot.getByRole("button", { name: "Export conversation (Markdown)", exact: true }).click(); await requested;
  await expect(bot.getByRole("button", { name: "Exporting conversation…", exact: true })).toBeDisabled();
  await bot.getByRole("button", { name: /^Beta notes/ }).click();
  await expect(bot.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveCount(0);
  const receipt = page.waitForEvent("download"); release(); const exported = await receipt;
  expect(exported.suggestedFilename()).toBe("conversation-alpha-notes.md"); expect(await markdown(exported)).toContain("ALPHA_VISIBLE_CANARY");
  await bot.getByRole("button", { name: "All threads", exact: true }).click();
  let unexpectedDownload = false; page.on("download", () => { unexpectedDownload = true; });
  await page.route(`**/api/threads/${ids.second}/export?format=markdown`, route => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' }));
  await bot.getByRole("button", { name: "Export conversation (Markdown)", exact: true }).click();
  await expect(bot.getByRole("alert")).toHaveText("This conversation is unavailable or you no longer have access.");
  await expect(bot.getByRole("status")).toHaveCount(0); expect(unexpectedDownload).toBe(false);
});
