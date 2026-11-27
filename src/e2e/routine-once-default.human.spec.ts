// A one-time routine created the way a person creates one: the form's own default time, and a time that passed a few minutes ago.
//
// The form's default is in the future, so a routine saved untouched is switched on with its next run ahead of it. A time that passed
// within the last 10 minutes is not refused cold: the form offers "Run now" (one click creates it as a one-time that fires now) or a
// new time. The real harness, the real POST /api/routines and the real UI; everything is read back from the server.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "./scoped-tailwind";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { dismissFirstRunWelcome, openSidebar } from "./fixtures.ts";
import { openSidebarPlace } from "./sidebar-nav";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;
test.describe.configure({ mode: "default" });

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string>;
const botId = "routine-proof-bot";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = await response.json();
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return value as any;
}

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    const at=Date.now();
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'routine-proof-task',name:'Routine proof bot',title:'Briefings',description:'Fixture only',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'routine-proof-task',title:'Routine task',createdAt:at,resumeCursors:{}}],composio:false,browser:false,computer:'off'}]));
  ` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "routine-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Routine fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

const setup = async (page: import("@playwright/test").Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); localStorage.setItem("help.seen.chat.level-chip", "1"); });
  await page.goto(origin);
  // A fresh data dir meets the first-run welcome; press its one button as a person would.
  if (await page.getByRole("dialog", { name: "Welcome to Murage", exact: true }).waitFor({ timeout: 10_000 }).then(() => true, () => false)) await dismissFirstRunWelcome(page);
  const sidebar = await openSidebar(page);
  await openSidebarPlace(sidebar, "routines");
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
};
const byName = async (name: string) => (await api("/api/routines")).routines.find((routine: any) => routine.name === name);
/** The desktop's New routine button: a sentence, then "Pick a time" opens the editor on the form's own default time. */
const newRoutineEditor = async (page: import("@playwright/test").Page, sentence: string) => {
  await page.getByRole("button", { name: "New routine", exact: true }).filter({ visible: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "New routine" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("textbox").fill(sentence);
  await sheet.getByRole("button", { name: "Pick a time", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New routine" });
  await expect(editor.getByLabel("Start time", { exact: true })).toBeVisible();
  return editor;
};

test("a one-time routine saved with the form's own default time is switched on with its next run in the future", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  const editor = await newRoutineEditor(page, "Say hello once");
  const shown = await editor.getByLabel("Start time", { exact: true }).inputValue();
  const [hours, minutes] = shown.split(":").map(Number);
  // The default is a 5-minute mark ahead of now, not the current instant.
  expect.soft(minutes % 5).toBe(0);
  const startedAt = Date.now();
  await editor.getByRole("button", { name: "Schedule routine", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => byName("Say hello once"), { timeout: 15_000 }).toBeTruthy();
  const saved = await byName("Say hello once");
  expect(saved.schedule.type).toBe("once");
  expect(saved.enabled).toBe(true);
  expect(saved.schedule.at).toBeGreaterThan(startedAt);
  expect(saved.nextRunAt ?? saved.schedule.at).toBeGreaterThan(Date.now());
  expect(new Date(saved.schedule.at).getHours()).toBe(hours);
});

test("a one-time moment that passed minutes ago is offered Run now, and one click creates it running now, not Paused", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  const editor = await newRoutineEditor(page, "Just passed once");
  const past = await page.evaluate(() => {
    const d = new Date(Date.now() - 4 * 60_000);
    const two = (n: number) => String(n).padStart(2, "0");
    return { date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, time: `${two(d.getHours())}:${two(d.getMinutes())}` };
  });
  await editor.getByLabel("Start date", { exact: true }).fill(past.date);
  await editor.getByLabel("Start time", { exact: true }).fill(past.time);
  await editor.getByRole("button", { name: "Schedule routine", exact: true }).click();
  const offer = editor.getByRole("alert").filter({ hasText: "That time just passed. Run it now instead?" });
  await expect(offer).toBeVisible();
  expect(await byName("Just passed once")).toBeUndefined();
  await offer.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => byName("Just passed once"), { timeout: 15_000 }).toBeTruthy();
  const saved = await byName("Just passed once");
  expect(saved.schedule.type).toBe("once");
  expect(saved.enabled).toBe(true);
  // The one-time moment is the moment of saving: the run starts (or queues) rather than waiting for a time.
  expect(Math.abs(saved.schedule.at - Date.now())).toBeLessThan(60_000);
  await expect.poll(async () => (await api("/api/routines")).runs.some((run: any) => run.routineId === saved.id), { timeout: 30_000 }).toBe(true);
});

test("a one-time moment that passed long ago keeps the refusal, with no offer", async () => {
  const response = await fetch(fixture.info.url + "/api/routines", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ botId, name: "Long past once", prompt: "x", enabled: true, runNow: true, runOn: "ember", schedule: { type: "once", at: Date.now() - 3 * 60 * 60_000 }, durationMinutes: 30, attachments: [] }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "once_in_past" });
  expect(await byName("Long past once")).toBeUndefined();
});
