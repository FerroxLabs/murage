// B14 visual confirmation only. This launches the task-owned fake engine and
// an in-process Vite renderer; it never reads a normal Murage profile or calls
// a provider. Independent tests let a positioning-only correction reuse
// verified banner evidence; cleanup always owns the exact held fake turn.
import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

const BOT = "B14 visual fixture";
const TASK = "B14 error and busy picker";
let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let headers: Record<string, string> = {}, botId: string, threadId: string;

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  expect(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`).toBe(true);
  return result as any;
}
function evidencePath(info: TestInfo, name: string) {
  const base = process.env.B14_EVIDENCE_DIR;
  if (!base) return info.outputPath(`${name}.png`);
  mkdirSync(base, { recursive: true });
  return join(base, `${name}.png`);
}
async function openTask(page: Page) {
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.goto(origin);
  await (await openSidebar(page)).getByText(BOT, { exact: true }).click();
  const invitation = page.getByRole("complementary", { name: "Let your bots pick the right model", exact: true });
  if (await invitation.count()) await invitation.getByRole("button", { name: "Not now", exact: true }).last().click();
  const picker = page.getByRole("button", { name: "All threads", exact: true });
  await picker.click();
  await page.getByRole("button", { name: new RegExp(`^${TASK}`) }).click();
  await expect(picker).toContainText(TASK);
  // Selecting a task deliberately leaves time for a rename double-click.
  // Close the menu as a user would before testing the unrelated banner.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveCount(0);
}
async function prepareViewport(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const sidebarTrigger = page.getByRole("button", { name: "Open bot list", exact: true });
  if (await sidebarTrigger.isVisible()) {
    if (await sidebarTrigger.getAttribute("aria-expanded") === "true") await page.keyboard.press("Escape");
    await expect(sidebarTrigger).toHaveAttribute("aria-expanded", "false");
  }
}
async function expectOnScreen(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  await expect.poll(async () => target.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const inBounds = rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    const unobscured = [0.1, 0.5, 0.9].every(x => [0.1, 0.5, 0.9].every(y => {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      return hit !== null && node.contains(hit);
    }));
    return inBounds && unobscured;
  }), "Target must fit on screen without another overlay covering it").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function busy() {
  return (await api("GET", "/api/bots?messages=0")).bots
    .find((bot: any) => bot.id === botId).tasks.find((task: any) => task.threadId === threadId).busy;
}

test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).secret };
  const instance = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "verification");
  const bot = (await api("POST", "/api/bots", { name: BOT, modelSelection: { instanceId: "verification", model: instance.models.options[0].id } })).bot;
  botId = bot.id;
  await api("PATCH", `/api/bots/${botId}`, { computer: "off", browser: false, composio: false });
  threadId = (await api("POST", `/api/bots/${botId}/tasks`, { title: TASK })).task.threadId;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, envFile: false, root, cacheDir: join(fixture.info.dataDir, "vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Missing isolated B14 UI port");
  origin = `http://127.0.0.1:${address.port}`;
  console.info("B14 owned fixture", JSON.stringify({ ...fixture.info, viteOrigin: origin }));
});
test.afterAll(async () => {
  try { await vite?.close(); } finally { await fixture?.close(); }
  if (fixture) {
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
    expect(existsSync(fixture.info.dataDir)).toBe(false);
    expect(vite?.httpServer?.listening ?? false).toBe(false);
    console.info("B14 owned fixture closed", JSON.stringify({ pid: fixture.info.pid, exitCode: fixture.child.exitCode, signalCode: fixture.child.signalCode, dataDirRemoved: true, viteClosed: true }));
  }
});

test("B14 unsupported clipboard refusal can be dismissed without losing a draft", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openTask(page);
  const composer = page.getByRole("textbox", { name: `Message ${BOT}`, exact: true });
  await composer.fill("B14 draft survives upload refusal");
  const alert = page.getByRole("alert");
  for (const width of [390, 820, 1440]) {
    await prepareViewport(page, width);
    await composer.evaluate((node) => {
      const file = new File([new Uint8Array([0, 1, 2, 3])], "unsupported.tiff", { type: "image/tiff" });
      const data = new DataTransfer();
      data.items.add(file);
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expectOnScreen(page, alert);
    await expect(alert).toContainText("Clipboard image could not be read or uses an unsupported format");
    await expect(composer).toHaveValue("B14 draft survives upload refusal");
    await page.screenshot({ path: evidencePath(info, `clipboard-refusal-${width}`), fullPage: true });
    await alert.getByRole("button", { name: "Dismiss error", exact: true }).focus();
    await expect(alert.getByRole("button", { name: "Dismiss error", exact: true })).toBeFocused();
    await alert.getByRole("button", { name: "Dismiss error", exact: true }).press("Enter");
    await expect(alert).toHaveCount(0);
    await expect(composer).toHaveValue("B14 draft survives upload refusal");
  }
});

test("B14 busy picker stays on screen and inspect-only across viewport changes", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openTask(page);
  const composer = page.getByRole("textbox", { name: `Message ${BOT}`, exact: true });
  const hold = "__fixture_hold_authority__ B14 picker inspection";
  const sent = page.waitForResponse((response) => response.url().endsWith(`/api/bots/${botId}/messages`) && response.request().method() === "POST");
  await composer.fill(hold);
  await composer.press("Enter");
  expect((await sent).status()).toBe(202);
  await expect.poll(busy).toBe(true);
  const modelTrigger = page.getByRole("button", { name: /^Thread model:/ });
  const dialog = page.getByRole("dialog", { name: "Choose model", exact: true });
  for (const width of [390, 820, 1440]) {
    await prepareViewport(page, width);
    await modelTrigger.click();
    await expectOnScreen(page, dialog);
    await expect(dialog.getByRole("status")).toContainText("You can inspect models");
    const choices = dialog.locator("[data-model-choice][aria-pressed]");
    expect(await choices.count()).toBeGreaterThan(0);
    for (const choice of await choices.all()) await expect(choice).toBeDisabled();
    const effort = dialog.getByRole("combobox", { name: "Thread effort", exact: true });
    if (await effort.count()) await expect(effort).toBeDisabled();
    const favorite = dialog.getByRole("button", { name: /^Favorite / }).first();
    if (await favorite.count()) {
      const originalName = (await favorite.getAttribute("aria-label"))!;
      await favorite.click();
      const unfavorite = dialog.getByRole("button", { name: originalName.replace(/^Favorite /, "Unfavorite "), exact: true });
      await expect(unfavorite).toHaveAttribute("aria-pressed", "true");
      await unfavorite.click();
      await expect(dialog.getByRole("button", { name: originalName, exact: true })).toHaveAttribute("aria-pressed", "false");
    }
    expect(await busy()).toBe(true);
    await expectOnScreen(page, dialog);
    console.info("B14 picker bounds", JSON.stringify({ width, bounds: await dialog.boundingBox() }));
    await page.screenshot({ path: evidencePath(info, `busy-picker-${width}`), fullPage: true });
    const search = dialog.getByRole("textbox", { name: "Search models", exact: true });
    await search.focus();
    await page.setViewportSize({ width: width === 390 ? 1440 : 390, height: 900 });
    await expectOnScreen(page, dialog);
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(modelTrigger).toBeFocused();
  }
  const stopped = page.waitForResponse((response) => response.url().endsWith(`/api/bots/${botId}/interrupt`) && response.request().method() === "POST");
  await page.getByTitle("Stop", { exact: true }).click();
  expect((await stopped).status()).toBe(200);
  await expect.poll(busy).toBe(false);
});
