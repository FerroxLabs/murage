// UX L5B: the routine sheet, All routines, and New routine from one sentence,
// used the way a person uses them.
//
// A routine opens as a sheet that says who runs it, when, at what level and
// where it reports, with Run now, Pause and Delete on it. All routines lists
// every routine in one place. New routine (C, or the header button) takes one
// sentence and either hands it to a bot in chat or opens the full editor with
// the words already in it.
//
// The real harness, the real routes, the real UI: nothing is stubbed, and every
// change is read back from the server, never from the screen that made it.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";
import { openSidebarPlace } from "./sidebar-nav";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;
test.describe.configure({ mode: "serial" });

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string>;
const botId = "routine-sheet-bot";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = await response.json();
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return value as any;
}
const routineNamed = async (name: string) => (await api("/api/routines")).routines.find((routine: any) => routine.name === name);

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    const at=Date.now();
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'routine-sheet-task',name:'Sheet bot',title:'Briefings',description:'Fixture only',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'routine-sheet-task',title:'Routine task',createdAt:at,resumeCursors:{}}],composio:false,browser:false,computer:'off'}]));
  ` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "routine-sheet-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Routine sheet fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
    // A daily routine a week ahead, so nothing runs while the spec looks at it.
    await api("/api/routines", "POST", { botId, name: "Weekly numbers", prompt: "Summarise the numbers.", enabled: true, schedule: { type: "daily", time: "07:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30 });
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function openRoutines(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await openSidebarPlace(sidebar, "routines");
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
}

test("All routines lists the routine, and its sheet runs, pauses and asks before deleting", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await openRoutines(page);

  await page.getByRole("button", { name: "All routines", exact: true }).click();
  const list = page.getByRole("dialog", { name: "All routines", exact: true });
  await expect(list).toBeVisible();
  const row = list.locator("[data-routine-row]").filter({ hasText: "Weekly numbers" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Sheet bot");
  await page.screenshot({ path: testInfo.outputPath("all-routines.png") });
  await row.click();
  await expect(list).toHaveCount(0);

  const sheet = page.getByRole("dialog", { name: "Weekly numbers", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Sheet bot");
  await expect(sheet).toContainText("Every weekday at");
  // L5B-SHEET-DETAILS: the instructions and the run limit are on the sheet.
  await expect(sheet.locator("[data-routine-instructions]")).toHaveText("Summarise the numbers.");
  await expect(sheet).toContainText("Run limit");
  await expect(sheet.getByRole("button", { name: "Run now", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("routine-sheet.png") });

  // Pause: the server holds it, and the sheet says how to undo it.
  await sheet.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(sheet.getByRole("status")).toContainText("Weekly numbers is paused");
  await expect.poll(async () => (await routineNamed("Weekly numbers")).enabled, { timeout: 10_000 }).toBe(false);
  await sheet.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(sheet.getByRole("status")).toContainText("Weekly numbers is back on");
  await expect.poll(async () => (await routineNamed("Weekly numbers")).enabled, { timeout: 10_000 }).toBe(true);

  // Delete asks first; Keep it keeps it.
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  const ask = sheet.getByRole("alertdialog", { name: "Delete" });
  await expect(ask).toContainText("Delete Weekly numbers?");
  await expect(ask.getByRole("button", { name: "Keep it", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("routine-sheet-delete-ask.png") });
  await ask.getByRole("button", { name: "Keep it", exact: true }).click();
  await expect(ask).toHaveCount(0);
  expect(await routineNamed("Weekly numbers")).toBeTruthy();

  // The head and the buttons stay in view: only the middle of the sheet scrolls.
  await expect(sheet.locator("[data-box-head]")).toBeInViewport();
  await expect(sheet.locator("[data-box-foot]")).toBeInViewport();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("New routine takes one sentence and opens the editor with the words in it", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await openRoutines(page);

  await page.keyboard.press("c");
  const sheet = page.getByRole("dialog", { name: "New routine", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Sheet bot");
  const words = sheet.getByRole("textbox");
  await expect(words).toBeFocused();
  const pickTime = sheet.getByRole("button", { name: "Pick a time", exact: true });
  await expect(pickTime).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Ask Sheet bot to set it up", exact: true })).toBeDisabled();
  await words.fill("Send me the overnight sales numbers");
  await expect(pickTime).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("new-routine-sentence.png") });
  await pickTime.click();

  // The full editor, named from the sentence, the sentence as its instructions.
  const editor = page.getByRole("dialog", { name: "New routine", exact: true });
  await expect(editor.getByRole("textbox", { name: "Instructions" })).toHaveValue("Send me the overnight sales numbers");
  await expect(editor.getByPlaceholder("Add title")).toHaveValue("Send me the overnight sales numbers");
  await expect(editor.getByRole("textbox", { name: "Instructions" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("new-routine-editor.png") });
});
