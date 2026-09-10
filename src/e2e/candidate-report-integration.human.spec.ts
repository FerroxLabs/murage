import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact } from "../../shared/artifacts.ts";
import { openSidebar } from "./fixtures.ts";

interface VerificationServer {
  info: { url: string; pid: number; dataDir: string; logPath: string };
  fixtureDumpPath: string;
  restart(): Promise<void>;
  close(): Promise<void>;
}

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string> = {};
let botId: string, first: string, second: string, modelId: string, modelLabel: string;
let proxy: ChildProcess | undefined;
const html = "<!doctype html><h1>Joined report</h1><p>JOINED_REPORT_BYTES_0150</p>";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function api(path: string, method = "GET", body?: unknown, status = 200) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  expect(response.status, `${method} ${path}`).toBe(status);
  return await response.json() as any;
}
async function proof() {
  const value = await api("/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": value.secret };
}
const state = async () => (await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId);
async function stopProxy() {
  if (!proxy || proxy.exitCode !== null || proxy.signalCode !== null) return;
  const child = proxy, closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await closed; } finally { clearTimeout(timer); proxy = undefined; }
}
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env);
  try {
    await proof();
    const models = (await api("/api/instances")).instances.find((item: any) => item.instanceId === "verification").models.options;
    modelId = models[0].id; modelLabel = models[0].label;
    botId = (await api("/api/bots", "POST", { name: "Joined proof bot", modelSelection: { instanceId: "verification", model: modelId } }, 201)).bot.id;
    await api(`/api/bots/${botId}`, "PATCH", { computer: "off", browser: false, composio: false });
    first = (await api(`/api/bots/${botId}/tasks`, "POST", { title: "Report A" }, 201)).task.threadId;
    second = (await api(`/api/bots/${botId}/tasks`, "POST", { title: "Sibling B" }, 201)).task.threadId;
    for (const id of [first, second]) expect((await api(`/api/threads/${id}/messages?limit=10`)).messages).toEqual([]);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "joined-vite"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No joined UI port"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await stopProxy(); await vite?.close(); } finally { await fixture?.close(); } });
async function choose(page: Page, title: string, id: string) {
  await page.getByRole("button", { name: "All threads", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await expect.poll(async () => (await state()).threadId).toBe(id);
}
test("selected report survives Inbox historical navigation, download and same-profile restart", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await (await openSidebar(page)).getByRole("button", { name: /^Joined proof bot/ }).first().click();
  await choose(page, "Report A", first);
  await expect(page.getByRole("button", { name: /^Thread model:/ })).toHaveAttribute("aria-label", `Thread model: ${modelLabel}`);
  expect((await state()).tasks.find((task: any) => task.threadId === first).modelSelection).toMatchObject({ instanceId: "verification", model: modelId });
  const sent = page.waitForResponse(response => response.url().endsWith(`/api/bots/${botId}/messages`) && response.request().method() === "POST");
  const composer = page.getByRole("textbox", { name: "Message Joined proof bot", exact: true });
  await composer.fill("__fixture_hold_authority__ joined report"); await composer.press("Enter");
  const response = await sent; expect(response.status()).toBe(202); expect(response.request().postDataJSON().threadId).toBe(first);
  let mount: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await expect.poll(() => { try { mount = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents; return Boolean(mount?.env.MURAGE_COMMS_TOKEN); } catch { return false; } }, { timeout: 15000 }).toBe(true);
  expect(mount!.env.MURAGE_BOT_ID).toBe(botId);
  const current = await state(), task = current.tasks.find((task: any) => task.threadId === first);
  const workspace = realpathSync(resolve(task.cwd ?? current.cwd ?? join(fixture.info.dataDir, "workspaces", botId)));
  const within = relative(realpathSync(fixture.info.dataDir), workspace);
  expect(within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)).toBe(false);
  mkdirSync(join(workspace, "reports"), { recursive: true }); writeFileSync(join(workspace, "reports/joined.html"), html);
  proxy = spawn(mount!.command, mount!.args, { env: { PATH: dirname(process.execPath), HOME: fixture.info.dataDir, ...mount!.env }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map<number, any>(); let buffer = "";
  proxy.stdout!.on("data", chunk => { buffer += String(chunk); for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { const value = JSON.parse(line); if (typeof value.id === "number") replies.set(value.id, value); } catch {} } }); proxy.stderr!.resume();
  const rpc = async (id: number, method: string, params: unknown) => { proxy!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); await expect.poll(() => replies.has(id), { timeout: 15000 }).toBe(true); return replies.get(id); };
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "joined-proof", version: "1" } });
  const saved = await rpc(2, "tools/call", { name: "register_artifact", arguments: { relative_path: "reports/joined.html", name: "Joined report" } });
  expect(saved.result.isError).not.toBe(true); const artifact = JSON.parse(saved.result.content[0].text).artifact as Artifact;
  expect(artifact.threadId).toBe(first); expect(artifact.sha256).toBe(hash(html)); await stopProxy();
  await api(`/api/bots/${botId}/interrupt`, "POST", { threadId: first });
  await expect.poll(async () => Boolean((await state()).tasks.find((task: any) => task.threadId === first).busy)).toBe(false);
  const messages = (await api(`/api/threads/${first}/messages?limit=100`)).messages;
  const sourceMessages = messages.filter((message: any) => message.artifactIds?.includes(artifact.id)); expect(sourceMessages).toHaveLength(1);
  const messageId = sourceMessages[0].id;
  const sibling = (await state()).tasks.find((task: any) => task.threadId === second).modelSelection;
  const logs = [fixture.info.logPath], pids = [fixture.info.pid];
  for (const phase of ["before", "after"]) {
    if (phase === "after") { await fixture.restart(); logs.push(fixture.info.logPath); pids.push(fixture.info.pid); expect(pids[1]).not.toBe(pids[0]); await proof(); await page.reload({ waitUntil: "domcontentloaded" }); await (await openSidebar(page)).getByRole("button", { name: /^Joined proof bot/ }).first().click(); }
    await choose(page, "Sibling B", second);
    const results = await api("/api/inbox?view=results");
    expect(results.items.filter((item: any) => item.link.artifactId === artifact.id)).toHaveLength(1);
    const sidebar = await openSidebar(page); await sidebar.getByRole("button", { name: /^Tools/ }).click(); await sidebar.getByRole("menuitem", { name: "Inbox", exact: true }).click();
    await page.getByRole("button", { name: "Results", exact: true }).click(); await page.getByRole("button", { name: "Open file", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Files", exact: true }); await expect(dialog).toBeVisible();
    const card = dialog.locator(`[data-artifact-id="${artifact.id}"]`); await expect(card).toHaveCount(1);
    const download = page.waitForEvent("download"); await card.getByRole("button", { name: "Download", exact: true }).click();
    expect(hash(readFileSync((await (await download).path())!))).toBe(artifact.sha256);
    await card.getByRole("button", { name: "Source conversation", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect.poll(async () => (await state()).threadId).toBe(first);
    await expect(page.locator(`[data-mid="${messageId}"]`)).toBeVisible(); await expect(page.locator(`[data-artifact-id="${artifact.id}"]`)).toHaveCount(1);
    expect((await state()).tasks.find((task: any) => task.threadId === second).modelSelection).toEqual(sibling);
    expect((await api(`/api/threads/${second}/messages?limit=10`)).messages).toEqual([]);
    expect((await api(`/api/artifacts/${artifact.id}`)).artifact).toMatchObject({ threadId: first, sha256: artifact.sha256, sourceConversationAvailable: true });
    await page.screenshot({ path: info.outputPath(`${phase}-source-report.png`), fullPage: true });
  }
  const receiptPath = info.outputPath("joined-receipt.json");
  writeFileSync(receiptPath, JSON.stringify({ source: "51ec7ecdd6181b45115fde076c974297edf2d232", node: process.version, botId, first, second, messageId, artifactId: artifact.id, sha256: artifact.sha256, pids, logs }, null, 2));
  await info.attach("joined-receipt", { path: receiptPath, contentType: "application/json" });
});
