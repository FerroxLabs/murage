// STOP1 real-renderer check: pressing Stop on a running Claude turn shows the
// normal stopped state. Before the fix the chat kept a red "This request hit a
// problem — claude exited null before result" card with Retry. The server is
// the isolated verification fixture (claudeAgent driver + fake Claude CLI);
// the renderer is the real app served by Vite against it.
//
// STOP2: a turn the HOST stops (the bot's computer switched off, its model
// connection changed) says why, as a neutral stopped row a 1:1 thread shows
// with Settings → Tool calls off — before, the notice was a plain activity
// chip that setting hides, so the turn just ended with no reason on screen.
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

const BOT = "STOP1 chat fixture";
const TASK = "STOP1 stop thread";
const HOST_TASK = "STOP2 host stop thread";
const ROOM = "STOP1 room fixture";
let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string> = {};
let botId: string, botThreadId: string, hostThreadId: string, roomId: string, roomThreadId: string;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  expect(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`).toBe(true);
  return result as any;
};
const errorActivities = async (threadId: string) =>
  ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[])
    .filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("error:"));
const engineHolds = async (text: string) => {
  await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes(text), { timeout: 15_000 }).toBe(true);
};
const evidencePath = (info: TestInfo, name: string) => {
  const dir = process.env.STOP1_EVIDENCE_DIR;
  if (!dir) return info.outputPath(`${name}-${info.project.name}.png`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${info.project.name}.png`);
};
const createBot = async (name: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: (await api("GET", "/api/instances")).instances.find((e: any) => e.instanceId === "verification").models.options[0].id } })).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};

test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const bot = await createBot(BOT);
  botId = bot.id;
  // A new bot's first thread is its greeting/intake conversation, which
  // answers the composer itself. Provider turns begin in a separate task
  // (the same setup threads.human.spec.ts uses).
  botThreadId = (await api("POST", `/api/bots/${botId}/tasks`, { title: TASK })).task.threadId;
  hostThreadId = (await api("POST", `/api/bots/${botId}/tasks`, { title: HOST_TASK })).task.threadId;
  const member = await createBot("STOP1 room member");
  const room = (await api("POST", "/api/groups", { name: ROOM, memberIds: [bot.id, member.id], setup: { bulletin: "Synthetic stop fixture", defaultResponder: { kind: "member", botId: bot.id } } })).group;
  roomId = room.id; roomThreadId = room.threadId;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("No fixture UI port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function open(page: Page, name: string) {
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.getByText(name, { exact: true }).click();
  const invitation = page.getByRole("complementary", { name: "Let your bots pick the right model", exact: true });
  if (await invitation.count()) await invitation.getByRole("button", { name: "Not now", exact: true }).last().click();
}
/** Pick a task thread and wait until the renderer has switched to it. The
 * composer is keyed on the bot's current thread, so text typed before the
 * switch lands is discarded with the old composer and Enter sends nothing;
 * the picker's label reads the same thread id, so once it shows the title
 * the composer on screen is the new thread's. */
async function selectThread(page: Page, title: string) {
  const picker = page.getByRole("button", { name: "All threads", exact: true });
  await picker.click();
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await expect(picker).toContainText(title);
}
async function expectNormalStoppedState(page: Page, composer: string, threadId: string) {
  await expect(page.getByRole("button", { name: "Stop this turn", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: composer, exact: true })).toBeEnabled();
  await expect(page.getByText("This request hit a problem")).toHaveCount(0);
  await expect(page.getByText(/exited .* before result/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(await errorActivities(threadId)).toEqual([]);
}

test("Stop on a running Claude chat turn shows the normal stopped state, not an error card", async ({ page }, info) => {
  await open(page, BOT);
  await selectThread(page, TASK);
  const composer = `Message ${BOT}`;
  const text = "__fixture_hold_authority__ STOP1 chat request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  const sent = page.waitForResponse((r) => r.url().endsWith(`/api/bots/${botId}/messages`) && r.request().method() === "POST");
  await page.getByRole("textbox", { name: composer, exact: true }).fill(text);
  await page.getByRole("textbox", { name: composer, exact: true }).press("Enter");
  const response = await sent;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON().threadId).toBe(botThreadId);
  await engineHolds(text);
  // A running chat shows Stop twice: the header chip and the composer button
  // (both labelled "Stop this turn"). Press the composer's, as in the smoke.
  await expect(page.getByTitle("Stop this turn", { exact: true })).toBeVisible();
  const stop = page.getByTitle("Stop", { exact: true });
  await expect(stop).toHaveAccessibleName("Stop this turn");
  await page.screenshot({ path: evidencePath(info, "chat-running") });
  const interrupted = page.waitForResponse((r) => r.url().endsWith(`/api/bots/${botId}/interrupt`));
  await stop.click();
  expect((await interrupted).status()).toBe(200);
  const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === botId).tasks.find((t: any) => t.threadId === botThreadId).busy;
  await expect.poll(busy, { timeout: 10_000 }).toBe(false);
  // the user's own message stays in the conversation (it also appears in a
  // second place, e.g. the thread preview, so take the first match)
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  await expectNormalStoppedState(page, composer, botThreadId);
  await page.screenshot({ path: evidencePath(info, "chat-stopped") });
});

test("Stop on a running Claude room turn leaves the room idle with no error chip", async ({ page }, info) => {
  await open(page, ROOM);
  const composer = `Message ${ROOM}`;
  const text = "__fixture_hold_authority__ STOP1 room request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  await page.getByRole("textbox", { name: composer, exact: true }).fill(text);
  await page.getByRole("textbox", { name: composer, exact: true }).press("Enter");
  await engineHolds(text);
  const stop = page.getByRole("button", { name: "Stop this turn", exact: true });
  await expect(stop).toBeVisible();
  const interrupted = page.waitForResponse((r) => r.url().endsWith(`/api/groups/${roomId}/interrupt`));
  await stop.click();
  expect((await interrupted).status()).toBe(200);
  const busyBot = async () => (await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.id === roomId).busyBotId ?? null;
  await expect.poll(busyBot, { timeout: 10_000 }).toBe(null);
  await expectNormalStoppedState(page, composer, roomThreadId);
  await page.screenshot({ path: evidencePath(info, "room-stopped") });
});

test("a host stop shows why the turn ended in a 1:1 thread with Tool calls off", async ({ page }, info) => {
  // Tool calls stays at its default (off): the row must not depend on it.
  expect((await api("GET", "/api/config")).features?.showToolCalls).not.toBe(true);
  await open(page, BOT);
  await selectThread(page, HOST_TASK);
  const composer = `Message ${BOT}`;
  const text = "__fixture_hold_authority__ STOP2 host stop request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  const sent = page.waitForResponse((r) => r.url().endsWith(`/api/bots/${botId}/messages`) && r.request().method() === "POST");
  await page.getByRole("textbox", { name: composer, exact: true }).fill(text);
  await page.getByRole("textbox", { name: composer, exact: true }).press("Enter");
  const response = await sent;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON().threadId).toBe(hostThreadId);
  await engineHolds(text);
  await expect(page.getByTitle("Stop this turn", { exact: true })).toBeVisible();
  // The host stop: the person points the bot at this computer and switches
  // it off again while the turn runs. Nobody presses Stop.
  await api("PATCH", `/api/bots/${botId}`, { computer: "local" });
  await api("PATCH", `/api/bots/${botId}`, { computer: "off" });
  const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === botId).tasks.find((t: any) => t.threadId === hostThreadId).busy;
  await expect.poll(busy, { timeout: 10_000 }).toBe(false);
  const reason = page.getByTestId("stopped-row");
  await expect(reason).toBeVisible();
  await expect(reason).toHaveText("Stopped — this computer was switched off for the bot");
  await expect(reason).toHaveRole("status");
  // the neutral family, not the error card, and no tool chips
  await expect(reason).toHaveClass(/text-ink-secondary/);
  await expect(reason).not.toHaveClass(/text-danger/);
  await expect(page.getByTestId("tool-chip")).toHaveCount(0);
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  await expectNormalStoppedState(page, composer, hostThreadId);
  await page.screenshot({ path: evidencePath(info, "chat-host-stopped") });
  // the bot list's one-line preview reads the same, not the raw notice name
  const sidebar = await openSidebar(page);
  await expect(sidebar.getByText("Stopped — this computer was switched off for the bot", { exact: true })).toBeVisible();
});
