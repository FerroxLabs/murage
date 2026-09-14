// B24 visual confirmation uses only the task-owned verification server and
// its fake engine. It never reads a normal profile or calls a provider.
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

const ROOM = "B24 mention fixture";
const NAMES = Array.from({ length: 7 }, (_, index) => `B24 bot ${index + 1}`);
let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let headers: Record<string, string> = {};

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
  const base = process.env.B24_EVIDENCE_DIR;
  if (!base) return info.outputPath(`${name}.png`);
  mkdirSync(base, { recursive: true });
  return join(base, `${name}.png`);
}

test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).secret };
  const instance = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "verification");
  const bots = [];
  for (const name of NAMES) {
    const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: instance.models.options[0].id } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    bots.push(bot);
  }
  await api("POST", "/api/groups", {
    name: ROOM,
    memberIds: bots.map((bot) => bot.id),
    setup: { bulletin: "Synthetic B24 mention roster", defaultResponder: { kind: "member", botId: bots[0].id } },
  });
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({
    configFile: false,
    envFile: false,
    root,
    cacheDir: join(fixture.info.dataDir, "vite-cache"),
    resolve: { alias: { "@": join(root, "src") } },
    plugins: [react(), tailwindcss()],
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } },
  });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Missing isolated B24 UI port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function openRoom(page: Page) {
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.goto(origin);
  await (await openSidebar(page)).getByText(ROOM, { exact: true }).click();
  const invitation = page.getByRole("complementary", { name: "Let your bots pick the right model", exact: true });
  if (await invitation.count()) await invitation.getByRole("button", { name: "Not now", exact: true }).last().click();
}

test("B24 keeps all authorised room mentions reachable and keyboard-selectable", async ({ page }, info) => {
  await openRoom(page);
  const composer = page.getByRole("textbox", { name: `Message ${ROOM}`, exact: true });
  await composer.fill("@");
  const picker = page.getByRole("listbox", { name: "Tag a bot", exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option")).toHaveCount(8);
  await expect(picker.getByRole("option").first()).toContainText("everyone");
  for (let index = 0; index < 7; index += 1) await composer.press("ArrowDown");
  const seventh = picker.getByRole("option", { name: /B24 bot 7/ });
  await expect(seventh).toHaveAttribute("aria-selected", "true");
  await expect(seventh).toBeInViewport();
  await expect.poll(() => picker.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // The desktop selection happened before this loop. At a mobile viewport,
    // dismiss the responsive drawer if the breakpoint transition retained it.
    if (width < 768) await page.mouse.click(width - 5, 100);
    await page.screenshot({ path: evidencePath(info, `seventh-active-${width}`), fullPage: true });
  }
  await composer.press("Enter");
  await expect(composer).toHaveValue("@B24 bot 7 ");
});

async function settleMobileSidebar(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open bot list", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.getByRole("complementary", { name: "Bots and navigation", exact: true })
    .evaluate((node) => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
}

test("B26 room header keeps controls reachable at responsive widths", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openRoom(page);
  await settleMobileSidebar(page);
  const title = page.getByRole("main").getByText(ROOM, { exact: true }).first();
  const header = title.locator("../..");
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect.poll(() => title.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(80);
    await expect.poll(() => header.evaluate((node) => {
      const targets = [...node.querySelectorAll("button, select")];
      const boxes = targets.map((target) => target.getBoundingClientRect()).filter((box) => box.width && box.height);
      return boxes.every((box) => box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight) &&
        boxes.every((box, index) => boxes.slice(index + 1).every((other) =>
          box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top));
    })).toBe(true);
    const members = header.getByRole("button", { name: /^Manage members/ });
    for (const name of NAMES) await expect(members.locator(`[title="${name}"]`)).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: evidencePath(info, `b26-room-header-${width}`), fullPage: true });
    const tasks = header.getByRole("button", { name: "All threads", exact: true });
    await tasks.focus(); await tasks.press("Enter");
    const searchTasks = page.getByRole("textbox", { name: "Search tasks", exact: true });
    await expect(searchTasks).toBeVisible();
    await searchTasks.press("Escape");
    await expect(searchTasks).toBeHidden();
    const find = header.getByRole("button", { name: "Find in conversation", exact: true });
    await find.focus(); await find.press("Enter");
    const findInput = page.getByRole("textbox", { name: "Find in this conversation", exact: true });
    await expect(findInput).toBeFocused();
    await findInput.press("Escape");
    await expect(findInput).toBeHidden();
    const folder = header.getByTitle("Channel working folder", { exact: true });
    await folder.focus(); await folder.press("Enter");
    await expect(page.getByText("Working folder", { exact: true })).toBeVisible();
    await folder.press("Enter");
    await expect(page.getByText("Working folder", { exact: true })).toBeHidden();
    const responder = header.getByRole("combobox", { name: "Default responder", exact: true });
    const original = await responder.inputValue();
    await responder.focus();
    await expect(responder).toBeFocused();
    const room = (await api("GET", "/api/bots")).groups.find((group: any) => group.name === ROOM);
    expect(room).toBeTruthy();
    const alternate = await responder.locator("option").nth(1).getAttribute("value");
    expect(alternate).toBeTruthy();
    for (const value of [alternate!, original]) {
      const expected = { kind: "member", botId: value.slice("member:".length) };
      const patched = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/groups/${room.id}` && response.request().method() === "PATCH");
      await responder.selectOption(value);
      const response = await patched;
      expect(response.status()).toBe(200);
      expect((await response.json()).group.defaultResponder).toEqual(expected);
      await expect(responder).toHaveValue(value);
      expect((await api("GET", "/api/bots")).groups.find((group: any) => group.id === room.id).defaultResponder).toEqual(expected);
    }
    await expect(responder).toHaveValue(original);
    await responder.focus(); await responder.press("Tab");
    await expect(members).toBeFocused();
    await members.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Manage members of ${ROOM}`, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(members).toBeFocused();
  }
});

test("B24 mobile confirmation keeps seventh mention visible and everyone room-only", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openRoom(page);
  await settleMobileSidebar(page);
  const composer = page.getByRole("textbox", { name: `Message ${ROOM}`, exact: true });
  await composer.fill("@");
  const picker = page.getByRole("listbox", { name: "Tag a bot", exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option")).toHaveCount(8);
  await expect(picker.getByRole("option").first()).toContainText("everyone");
  for (let index = 0; index < 7; index += 1) await composer.press("ArrowDown");
  const seventh = picker.getByRole("option", { name: /B24 bot 7/ });
  await expect(seventh).toHaveAttribute("aria-selected", "true");
  await expect(seventh).toBeInViewport({ ratio: 1 });
  await expect.poll(() => picker.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => seventh.evaluate((node) => {
    const row = node.getBoundingClientRect();
    const list = node.closest('[role="listbox"]')!.getBoundingClientRect();
    return row.top >= list.top && row.bottom <= list.bottom &&
      node.contains(document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2));
  })).toBe(true);
  await page.screenshot({ path: evidencePath(info, "seventh-active-390"), fullPage: true });
  await composer.press("Enter");
  await expect(composer).toHaveValue("@B24 bot 7 ");
  await (await openSidebar(page)).getByText(NAMES[0], { exact: true }).click();
  await settleMobileSidebar(page);
  await page.getByRole("textbox", { name: `Message ${NAMES[0]}`, exact: true }).fill("@");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option", { name: /everyone/ })).toHaveCount(0);
});
