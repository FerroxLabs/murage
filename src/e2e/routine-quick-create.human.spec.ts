// A routine that repeats, created the way a person creates one.
//
// The sweep's item 5: the quick create form could only say "Does not repeat".
// "Daily" lived under "More options", which is a second form, and after
// saving, the grid stayed wherever it was — a 7 AM daily routine landed off
// screen with nothing said about it.
//
// The real harness, the real `POST /api/routines`, and the real UI: nothing
// here is stubbed, and the schedule is read back from the server rather than
// from the screen that wrote it.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;
test.describe.configure({ mode: "serial" });

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

test("the quick form repeats, and saving says what it saved and goes there", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A fresh install now offers the first-run checklist over everything else.
  // This spec is about naming a routine, so it starts from a machine that has
  // already been offered it.
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); });
  await page.goto(origin);

  // One name for it, in the sidebar and on the page it opens.
  const sidebar = await openSidebar(page);
  await sidebar.locator("[data-sidebar-more-trigger]").click();
  await sidebar.getByRole("menuitem", { name: "Routines", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("menuitem", { name: "Calendar", exact: true })).toHaveCount(0);

  // The quick form, with Repeat on it — not two clicks away under "More
  // options".
  await page.keyboard.press("c");
  const quick = page.getByRole("dialog", { name: "Quick create" });
  await expect(quick).toBeVisible();
  await expect(quick.getByText("New routine", { exact: true })).toBeVisible();
  const repeat = quick.getByRole("combobox", { name: "Repeat", exact: true });
  await expect(repeat).toBeVisible();
  await expect(repeat).toHaveValue("none");
  await quick.getByPlaceholder("Add title").fill("Morning briefing");
  await quick.getByPlaceholder("What should the bot do?").fill("Summarise what changed overnight.");
  await repeat.selectOption("daily");
  await page.screenshot({ path: testInfo.outputPath("quick-create-daily.png"), fullPage: true });
  await quick.getByRole("button", { name: "Save", exact: true }).click();
  await expect(quick).toHaveCount(0);

  // The server holds a repeating schedule, not a one-off. Read back from the
  // API, never from the screen that wrote it.
  await expect.poll(async () => (await api("/api/routines")).routines.map((routine: any) => routine.name), { timeout: 15_000 }).toContain("Morning briefing");
  const saved = (await api("/api/routines")).routines.find((routine: any) => routine.name === "Morning briefing");
  expect(saved.schedule.type).toBe("daily");
  expect([...saved.schedule.weekdays].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);

  // And the page says so, in the routine's own words.
  const notice = page.locator("[data-routine-saved]");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Morning briefing scheduled");
  await expect(notice).toContainText("Every day at");
  await page.screenshot({ path: testInfo.outputPath("quick-create-saved.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The new routine is on screen rather than scrolled past.
  const card = page.locator("[data-event-card]").filter({ hasText: "Morning briefing" }).first();
  await expect(card).toBeInViewport();
});
