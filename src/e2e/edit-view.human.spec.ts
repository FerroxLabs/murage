import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let headers: Record<string, string> = {}, botId: string, threadId: string;
const BOT = "EDIT-VIEW fixture", TASK = "Completed edit";
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return result as any;
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
  if (!address || typeof address === "string") throw Error("Missing isolated UI port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

test("Edit then Enter shows the edited message and new answer without switching versions", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.goto(origin);
  await (await openSidebar(page)).getByText(BOT, { exact: true }).click();
  const invitation = page.getByRole("complementary", { name: "Let your bots pick the right model", exact: true });
  if (await invitation.count()) await invitation.getByRole("button", { name: "Not now", exact: true }).last().click();
  const picker = page.getByRole("button", { name: "All threads", exact: true });
  await picker.click();
  await page.getByRole("button", { name: new RegExp(`^${TASK}`) }).click();
  await expect(picker).toContainText(TASK);
  const composer = page.getByRole("textbox", { name: `Message ${BOT}`, exact: true });
  await composer.fill("P1 original question");
  await composer.press("Enter");
  const idle = async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === botId).tasks.find((task: any) => task.threadId === threadId).busy;
  await expect(page.getByText("hello from fake claude", { exact: true }).first()).toBeVisible();
  await expect.poll(idle).toBe(false);
  const before = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
  const original = before.find((message: any) => message.text === "P1 original question");
  const oldReplyIds = new Set(before.filter((message: any) => message.role === "bot").map((message: any) => message.id));
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  const editBox = page.locator("textarea:not([aria-label])");
  await expect(editBox).toHaveValue("P1 original question");
  await editBox.fill("P1 edited question");
  const submitted = page.waitForResponse((response) => response.url().endsWith(`/messages/${original.id}/edit`));
  await editBox.press("Enter");
  expect((await submitted).status()).toBe(202);
  await expect.poll(idle).toBe(false);
  const after = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
  expect(after.some((message: any) => message.role === "bot" && message.text === "hello from fake claude" && !oldReplyIds.has(message.id))).toBe(true);
  await expect(page.getByText("P1 edited question", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("P1 original question", { exact: true })).toHaveCount(0);
  await expect(page.getByText("hello from fake claude", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("edited-answer.png") });
});
