import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";

// Runtime URL import keeps the Node-only control tool out of app compilation.
interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;
test.describe.configure({ mode: "serial" });

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string>;
const botId = "inbox-proof-bot", oldThread = "inbox-old-task", currentThread = "inbox-current-task", messageId = "inbox-report-message";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = await response.json(); expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true); return value as any;
}
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
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


test("B35 canonical offscreen approval survives reload and outage, opens exact task, reconciles resolution", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await api(`/api/bots/${botId}/messages`, "POST", { threadId: oldThread, text: "Ask me first. __fixture_ask_user_question__" });
  await expect.poll(async () => (await api("/api/inbox?view=approvals")).total, { timeout: 25000 }).toBe(1);
  const pending = (await api("/api/inbox?view=approvals")).items[0];
  expect(pending.link.threadId).toBe(oldThread);
  expect(pending.sourceLabel).toContain("Previous report");
  await api("/api/inbox/state", "POST", { id: pending.id, version: pending.version, read: true, snoozedUntil: Date.now()+60000 });
  expect((await api("/api/inbox?view=approvals")).total).toBe(1);
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  for (const width of [390,820,1440]) {
    await page.setViewportSize({ width, height: 900 });
    const sidebar = await openSidebar(page);
    const tools = sidebar.locator("[data-sidebar-more-trigger]");
    await expect(tools).toContainText("1");
    await tools.focus(); await page.keyboard.press("Enter");
    await sidebar.getByRole("menuitem", { name: /Pending approvals/ }).click();
    await expect(page.getByRole("heading", { name: "Question needs an answer", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pending approvals", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/Waiting \d+ min for your answer/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Show snoozed items" })).toHaveCount(0);
    if (process.env.MURAGE_B35_AXE_SOURCE) {
      await page.addScriptTag({ path: process.env.MURAGE_B35_AXE_SOURCE });
      const audit = await page.evaluate(async () => (window as any).axe.run(document.querySelector('dialog[open]')));
      await testInfo.attach(`axe-${width}.json`, { body: JSON.stringify(audit), contentType: "application/json" });
      expect(audit.violations.filter((issue: any) => ["critical", "serious"].includes(issue.impact))).toEqual([]);
    }
    await page.screenshot({ path: testInfo.outputPath(`b35-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Close Inbox", exact: true }).click();
  }
  await page.reload();
  let sidebar = await openSidebar(page);
  await expect(sidebar.locator("[data-sidebar-more-trigger]")).toContainText("1");
  await page.route("**/api/inbox?**", route => route.abort());
  await expect(sidebar.locator("[data-sidebar-more-trigger]")).toHaveAttribute("aria-label", /approvals may be stale/, { timeout: 12000 });
  await expect(sidebar.locator("[data-pending-approval-count]")).toContainText("1");
  await page.unroute("**/api/inbox?**");
  await expect(sidebar.locator("[data-sidebar-more-trigger]")).not.toHaveAttribute("aria-label", /stale/, { timeout: 12000 });
  await sidebar.locator("[data-sidebar-more-trigger]").click();
  await sidebar.getByRole("menuitem", { name: /Pending approvals/ }).click();
  await page.getByRole("button", { name: "Open request", exact: true }).click();
  await expect(page.locator(`[data-mid="${pending.link.messageId}"]`)).toBeVisible();
  expect((await api("/api/inbox?view=approvals")).total).toBe(1);
  const thread = await api(`/api/threads/${oldThread}/messages`);
  const card = thread.messages.find((message: any) => message.id === pending.link.messageId).card;
  await api(`/api/threads/${oldThread}/respond`, "POST", { requestId: card.requestId, behavior: "skip" });
  await expect.poll(async () => (await api("/api/inbox?view=approvals")).total).toBe(0);
  sidebar = await openSidebar(page);
  await expect(sidebar.locator("[data-pending-approval-count]")).toHaveText("0", { timeout: 12000 });
});
