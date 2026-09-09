import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string>;
const botId = "inbox-proof-bot", oldThread = "inbox-old-task", currentThread = "inbox-current-task", messageId = "inbox-report-message";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = await response.json(); expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true); return value as any;
}
test.beforeAll(async () => {
  // Seed the fixture BEFORE Store opens: it is a restart-shaped database,
  // not an out-of-band write into a cached live transcript.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
    const directory=process.env.MURAGE_DATA_DIR;
    const at=Date.now();
    const tasks=[{threadId:'${currentThread}',title:'Current task',createdAt:at,resumeCursors:{}},{threadId:'${oldThread}',title:'Previous report',createdAt:at-1000,resumeCursors:{}}];
    writeFileSync(join(directory,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'${currentThread}',name:'Inbox proof bot',title:'Research',description:'Fixture only',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks,composio:false,browser:false,computer:'off'}]));
    const db=new DatabaseSync(join(directory,'messages.db'));
    db.exec('CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT)');
    const message={id:'${messageId}',role:'bot',kind:'routine.run',at:at-500,text:'Inbox exact historical report',routineRun:{runId:'inbox-proof-run',routineId:'inbox-proof-routine',routineName:'Inbox historical report',status:'completed',summary:'INBOX_EXACT_HISTORICAL_RESULT'}};
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('${oldThread}',message.id,message.at,message.role,message.kind,message.text,JSON.stringify(message));
    db.prepare('INSERT INTO thread_state VALUES(?,?)').run('${oldThread}',message.id);db.close();
  ` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "inbox-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Integrated Inbox fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

for (const scenario of [{ width: 1440, skin: "light" }, { width: 390, skin: "dark" }]) {
  test(`integrated Tools, Inbox and historical task navigation at ${scenario.width}px`, async ({ page }, testInfo) => {
    const denied = await fetch(fixture.info.url + "/api/inbox"); expect(denied.status).toBe(404);
    const inbox = await api("/api/inbox?view=results");
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].link).toEqual({ threadId: oldThread, messageId, runId: "inbox-proof-run" });
    await api(`/api/bots/${botId}/tasks/${currentThread}`, "POST");
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.addInitScript(skin => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-skin", skin); }, scenario.skin);
    await page.goto(origin);
    const invitation = page.getByRole("complementary", { name: "Let your bots pick the right model", exact: true });
    if (await invitation.isVisible()) await invitation.getByRole("button", { name: "Not now", exact: true }).last().click();
    const sidebar = await openSidebar(page);
    const tools = sidebar.getByRole("button", { name: /^Tools(?:, items need attention)?$/ });
    await expect(tools).toBeVisible(); await tools.focus(); await page.keyboard.press("Enter");
    await expect(sidebar.getByRole("menuitem", { name: "Inbox", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`inbox-tools-${scenario.width}-${scenario.skin}.png`), fullPage: true });
    await sidebar.getByRole("menuitem", { name: "Inbox", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Results", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Inbox historical report", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`inbox-integrated-${scenario.width}-${scenario.skin}.png`), fullPage: true });
    await page.getByRole("button", { name: "Open report", exact: true }).click();
    await expect(page.locator(`[data-mid="${messageId}"]`)).toBeVisible();
    await expect(page.getByText("INBOX_EXACT_HISTORICAL_RESULT", { exact: true })).toBeVisible();
    expect((await api("/api/bots?messages=0")).bots.find((bot: { id: string }) => bot.id === botId).threadId).toBe(oldThread);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
