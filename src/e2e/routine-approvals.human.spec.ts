// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A routine's approval level, where the owner sees it:
//
//   - in the routine's own conversation the composer chip shows the level the
//     routine's runs actually get (the owner's case: the chip said No limits
//     while the run was judged as Auto), and choosing a level there sets the
//     routine's level, not the conversation's copy;
//   - the routine editor shows the level (Same as the bot, or one picked for
//     the routine) and the approvals always allowed for this routine, each
//     removable.
//
// Real harness, real UI, no model call. Data lives under MURAGE_E2E_DATA_DIR.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
const botId = "routine-level-bot";
const COMMAND = "curl -s https://example.com/rwa";
const exactKey = `exact:${JSON.stringify(["verification", "/tmp/rwa", COMMAND])}`;

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
    const at=Date.now();
    // two earlier runs in the routine's conversation, each begun by the
    // server's run marker, as the one-conversation-per-routine runs leave them
    const db=new DatabaseSync(join(process.env.MURAGE_DATA_DIR,'messages.db'));
    db.exec('CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT)');
    const rows=[
      {id:'mk1',role:'bot',kind:'activity',at:at-9000,tool:{name:'Scheduled run: RWA watch',ok:true}},
      {id:'u1',role:'user',kind:'text',at:at-8900,text:'Sweep the RWA feeds.'},
      {id:'b1',role:'bot',kind:'text',at:at-8800,text:'Swept: nothing new.'},
      {id:'mk2',role:'bot',kind:'activity',at:at-5000,tool:{name:'Run now: RWA watch',ok:true}},
      {id:'u2',role:'user',kind:'text',at:at-4900,text:'Sweep the RWA feeds.'},
      {id:'b2',role:'bot',kind:'text',at:at-4800,text:'Swept: one new filing.'},
      {id:'late',role:'bot',kind:'activity',at:at-4700,routineRunAgain:{routineId:'rwa-watch'},tool:{name:'This run of RWA watch ended before you answered, so nothing was run.',ok:false}},
    ];
    let parent=null;
    for(const row of rows){const message={...row,parentId:parent};parent=row.id;db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('rwa-conversation',message.id,message.at,message.role,message.kind,message.text??null,JSON.stringify(message));}
    db.prepare('INSERT INTO thread_state VALUES(?,?)').run('rwa-conversation',parent);db.close();
    const level={autoApprove:true,fullAccess:true,noLimits:true};
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'rwa-conversation',name:'Dax',title:'Research',description:'Fixture only',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},...level,fullAccessAcknowledgedAt:at,noLimitsAcknowledgedAt:at,alwaysAllow:[],tasks:[{threadId:'rwa-conversation',title:'RWA watch',createdAt:at,resumeCursors:{},...level,alwaysAllow:[]},{threadId:'dax-chat',title:'Chat',createdAt:at,resumeCursors:{},...level,alwaysAllow:[]}],composio:false,browser:false,computer:'off'}]));
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'routines.json'),JSON.stringify({version:1,runs:[],routines:[{id:'rwa-watch',name:'RWA watch',prompt:'Sweep the RWA feeds.',target:'bot',botId:'${botId}',runOn:'ember',enabled:false,schedule:{type:'interval',everyMinutes:30,anchorAt:at},durationMinutes:30,timeoutMinutes:20,attachments:[],alwaysAllow:[${JSON.stringify(exactKey)}],threadId:'rwa-conversation',nextRunAt:null,createdAt:at,updatedAt:at}]}));
  ` });
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "routine-approvals-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Routine approvals fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function start(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  // the release notes dialog is another surface's; keep it out of the way
  await page.route("**/api/whats-new?*", (route) => route.fulfill({ json: { show: false } }));
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); });
  await page.goto(origin);
}

const routine = async (page: import("@playwright/test").Page) =>
  (await (await page.request.get(`${fixture.info.url}/api/routines`)).json()).routines.find((item: { id: string }) => item.id === "rwa-watch");

test("the chip in a routine's conversation shows and sets the routine's level", async ({ page }, info) => {
  await start(page);
  const sidebar = await openSidebar(page);
  await sidebar.getByText("Dax", { exact: true }).first().click();
  // the routine inherits Dax's No limits, so that is what its runs get
  const chip = page.getByRole("button", { name: "No limits for the routine RWA watch" });
  await expect(chip).toBeVisible();
  await page.screenshot({ path: info.outputPath("routine-conversation-chip.png") });
  await chip.click();
  // the menu itself says it sets the routine, not this conversation
  await expect(page.getByRole("menu").getByText("Changes the level of the routine RWA watch. Every run of it works here.")).toBeVisible();
  await page.getByRole("menuitemradio", { name: /^Auto mode/ }).click();
  await expect(page.getByRole("button", { name: "Auto mode for the routine RWA watch" })).toBeVisible();
  await expect.poll(async () => (await routine(page))?.permissionMode).toBe("auto");
});

test("the routine editor shows its level and the approvals always allowed for it", async ({ page }, info) => {
  await start(page);
  const sidebar = await openSidebar(page);
  await sidebar.locator("[data-sidebar-more-trigger]").click();
  await sidebar.getByRole("menuitem", { name: "Routines", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Paused routines (1)" }).click();
  await page.getByRole("dialog", { name: "Paused routines" }).getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit routine" });
  await expect(editor).toBeVisible();
  await editor.getByText(/^Advanced/).click();

  const level = editor.getByLabel("Approvals for this routine");
  await expect(level).toHaveValue("auto");
  await expect(level.locator("option[value=inherit]")).toHaveText("Same as Dax (No limits)");
  const grants = editor.getByRole("region", { name: "Always allowed for this routine" });
  await expect(grants.getByText(COMMAND, { exact: true })).toBeVisible();
  await expect(grants.getByText("/tmp/rwa")).toBeVisible();
  // what a grant covers across runs is said where the grants are listed
  await expect(grants.getByText("A command still matches when only the dates and times in it change.", { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath("routine-editor-approvals.png"), fullPage: true });

  await grants.getByRole("button", { name: `Remove always allow for ${COMMAND}` }).click();
  await expect(grants.getByText(/^Nothing yet/)).toBeVisible();
  await expect.poll(async () => (await routine(page))?.alwaysAllow).toBeUndefined();

  await level.selectOption("inherit");
  await expect(editor.getByText("Runs use Dax's level when they start, now No limits.", { exact: false })).toBeVisible();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await routine(page))?.permissionMode ?? "inherit").toBe("inherit");
});

test("each run in a routine's conversation begins with a visible divider", async ({ page }, info) => {
  await start(page);
  const sidebar = await openSidebar(page);
  await sidebar.getByText("Dax", { exact: true }).first().click();
  await expect(page.getByText("Swept: one new filing.").first()).toBeVisible();
  // Tool calls are off by default: the dividers show anyway
  await expect(page.getByRole("separator", { name: /^Scheduled run of RWA watch/ })).toBeVisible();
  await expect(page.getByRole("separator", { name: /^Run now of RWA watch/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("routine-run-dividers.png") });
});

test("the chip in any other conversation says it changes that conversation only", async ({ page }) => {
  // open Dax on an ordinary conversation, not the routine's
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  const switched = await fetch(`${fixture.info.url}/api/bots/${botId}/tasks/dax-chat`, { method: "POST", headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } });
  expect(switched.ok).toBe(true);
  await start(page);
  const sidebar = await openSidebar(page);
  await sidebar.getByText("Dax", { exact: true }).first().click();
  const chip = page.getByRole("button", { name: /^No limits$/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole("menu").getByText("Changes this conversation only. Routines use the level in Bot settings, Permissions, unless a routine has its own.")).toBeVisible();
});

test("a card answered after its run ended offers Run again, which starts the routine", async ({ page }) => {
  // open Dax on the routine's own conversation (an earlier test moved it)
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  expect((await fetch(`${fixture.info.url}/api/bots/${botId}/tasks/rwa-conversation`, { method: "POST", headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } })).ok).toBe(true);
  await start(page);
  const sidebar = await openSidebar(page);
  await sidebar.getByText("Dax", { exact: true }).first().click();
  const row = page.getByTestId("routine-run-again");
  await expect(row).toContainText("This run of RWA watch ended before you answered, so nothing was run.");
  const runs = async () => ((await (await page.request.get(`${fixture.info.url}/api/routines`)).json()).runs as Array<{ routineId: string }>).filter((run) => run.routineId === "rwa-watch").length;
  const before = await runs();
  await row.getByRole("button", { name: "Run again" }).click();
  await expect(row.getByRole("button", { name: "Started" })).toBeDisabled();
  await expect.poll(runs).toBe(before + 1);
});
