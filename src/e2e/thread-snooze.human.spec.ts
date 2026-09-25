// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation snooze and the question badge, in the real renderer against
// an isolated verification server with the fake engine. A snooze hides a
// conversation's unread from the sidebar and brings it back at its time; a
// question arriving wakes it at once, and the question badge appears on the
// row and in the conversation list, then clears when it is answered.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;
test.describe.configure({ mode: "serial" });

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string>;
const botId = "snooze-proof-bot", frontId = "snooze-front-bot", quietThread = "snooze-quiet-task", otherThread = "snooze-other-task", frontThread = "snooze-front-task";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = await response.json(); expect(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`).toBe(true); return value as any;
}

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    const directory=process.env.MURAGE_DATA_DIR;
    const at=Date.now();
    const bot=(id,name,threadId,tasks,unread)=>({id,threadId,name,title:'Fixture',description:'Fixture only',color:'green',notifications:false,unread,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks,composio:false,browser:false,computer:'off'});
    writeFileSync(join(directory,'bots.json'),JSON.stringify([
      bot('${frontId}','Front desk','${frontThread}',[{threadId:'${frontThread}',title:'Front task',createdAt:at,resumeCursors:{},unread:false}],false),
      bot('${botId}','Snooze proof bot','${quietThread}',[
        {threadId:'${quietThread}',title:'Weekly numbers',createdAt:at,resumeCursors:{},unread:true},
        {threadId:'${otherThread}',title:'Older chat',createdAt:at-1000,resumeCursors:{},unread:false}],true),
    ]));
  ` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    // What's new opens by itself over the app; this walk is not about it.
    const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
    await fetch(fixture.info.url + "/api/whats-new/seen", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ version }) });
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "snooze-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Snooze fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function openApp(page: Page) {
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  return openSidebar(page);
}
const row = (page: Page) => page.locator(`[data-sidebar-select="${botId}"]`);
async function shot(page: Page, name: string, testInfo: { outputPath(name: string): string }) {
  // On a phone the sidebar is a drawer that slides in; photograph it settled.
  const drawer = page.getByRole("complementary", { name: "Bots and navigation" });
  if (await drawer.isVisible()) await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} has no sideways scroll`).toBe(true);
}

test("a snoozed conversation drops out of the sidebar's attention and comes back at its time", async ({ page }, testInfo) => {
  const sidebar = await openApp(page);
  await expect(row(page)).toHaveAttribute("aria-label", /Unread/);
  await shot(page, "01-before-snooze-1440", testInfo);

  // From the row's own menu: Snooze, 1 hour.
  await sidebar.getByRole("button", { name: "More actions for Snooze proof bot" }).click();
  await page.getByRole("menuitem", { name: "Snooze…" }).click();
  const choices = page.getByRole("dialog", { name: "Snooze Snooze proof bot" });
  await expect(choices).toBeVisible();
  await shot(page, "02-snooze-choices-1440", testInfo);
  await choices.getByRole("button", { name: /^Snooze for 1 hour/ }).click();
  await expect(choices).toHaveCount(0);
  await expect(row(page)).toHaveAttribute("aria-label", /Snoozed until/);
  await expect(row(page)).not.toHaveAttribute("aria-label", /Unread/);
  expect((await api("/api/thread-snoozes")).snoozes.map((entry: any) => entry.threadId)).toEqual([quietThread]);
  await shot(page, "03-snoozed-1440", testInfo);

  // Survives a reload: the server holds it.
  await page.reload();
  await openSidebar(page);
  await expect(row(page)).toHaveAttribute("aria-label", /Snoozed until/);

  // Phone width and dark, the same state.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSidebar(page);
  await expect(row(page)).toHaveAttribute("aria-label", /Snoozed until/);
  await shot(page, "04-snoozed-390", testInfo);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "05-snoozed-390-dark", testInfo);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Unsnooze from the same menu brings it straight back.
  await openSidebar(page);
  await page.getByRole("button", { name: "More actions for Snooze proof bot" }).click();
  await page.getByRole("menuitem", { name: "Snooze…" }).click();
  await page.getByRole("dialog", { name: "Snooze Snooze proof bot" }).getByRole("button", { name: "Unsnooze" }).click();
  await expect(row(page)).toHaveAttribute("aria-label", /Unread/);

  // A short snooze set through the route: quiet, then back on its own.
  await api(`/api/thread-snoozes/${quietThread}`, "PUT", { until: Date.now() + 9_000 });
  await expect(row(page)).toHaveAttribute("aria-label", /Snoozed until/, { timeout: 8_000 });
  await expect(row(page)).toHaveAttribute("aria-label", /Unread/, { timeout: 15_000 });
  await expect(row(page)).not.toHaveAttribute("aria-label", /Snoozed until/);
  await expect.poll(async () => (await api("/api/thread-snoozes")).snoozes.length, { timeout: 10_000 }).toBe(0);
  await shot(page, "06-woke-at-time-1440", testInfo);
});

test("a question wakes a snoozed conversation, badges it, and the badge clears once answered", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sidebar = await openApp(page);
  // Snooze from the bot's conversation list this time.
  await row(page).focus(); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "All threads" }).click();
  await page.getByRole("button", { name: "Snooze Older chat" }).click();
  await page.getByRole("group", { name: "Snooze Older chat" }).getByRole("button", { name: /^Snooze for 1 hour/ }).click();
  await expect(page.getByRole("button", { name: "Unsnooze Older chat" })).toBeVisible();
  await expect(page.locator("[data-task-snoozed]")).toContainText("Snoozed until");
  await shot(page, "07-list-snoozed-1440", testInfo);
  await page.keyboard.press("Escape");

  // The bot asks a question in the snoozed conversation.
  await api(`/api/bots/${botId}/messages`, "POST", { threadId: otherThread, text: "Ask me first. __fixture_ask_user_question__" });
  await expect.poll(async () => (await api("/api/inbox?view=decisions")).questionThreads, { timeout: 25_000 }).toEqual({ [otherThread]: 1 });
  await expect.poll(async () => (await api("/api/thread-snoozes")).snoozes.length, { timeout: 10_000 }).toBe(0);
  await openSidebar(page);
  await expect(row(page)).toHaveAttribute("aria-label", /1 question for you/, { timeout: 12_000 });
  await expect(sidebar.locator(`[data-sidebar-bot-row="${botId}"] [data-question-badge="1"]`)).toBeVisible();
  // Attributed, not added: Needs you still says one.
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("1");
  await shot(page, "08-question-badge-1440", testInfo);
  await page.getByRole("button", { name: "All threads" }).click();
  await expect(page.getByRole("img", { name: "1 question for you" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unsnooze Older chat" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Snooze Older chat" })).toHaveCount(0);
  await shot(page, "09-list-question-1440", testInfo);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await openSidebar(page);
  await expect(page.locator(`[data-sidebar-bot-row="${botId}"] [data-question-badge="1"]`)).toBeVisible();
  await shot(page, "10-question-badge-390", testInfo);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "11-question-badge-390-dark", testInfo);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Answer it from Needs you; the badge goes with it.
  await openSidebar(page);
  await page.locator("[data-sidebar-needs-you]").click();
  const card = page.locator("[data-inbox-id]").filter({ has: page.getByRole("heading", { name: "Which format should the report use?", exact: true }) });
  await card.getByRole("radio", { name: /Summary/ }).click();
  await card.getByRole("checkbox", { name: /Intro/ }).click();
  await card.getByRole("button", { name: "Send answer" }).click();
  await expect.poll(async () => (await api("/api/inbox?view=decisions")).questions, { timeout: 20_000 }).toBe(0);
  await page.getByRole("button", { name: "Close Inbox", exact: true }).click();
  await openSidebar(page);
  await expect(page.locator(`[data-sidebar-bot-row="${botId}"] [data-question-badge]`)).toHaveCount(0, { timeout: 12_000 });
  await expect(row(page)).not.toHaveAttribute("aria-label", /question/);
  await shot(page, "12-answered-1440", testInfo);
});
