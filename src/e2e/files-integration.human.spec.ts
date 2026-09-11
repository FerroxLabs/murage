import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures.ts";
import type { Artifact } from "../../shared/artifacts.ts";

interface Fixture { info: { url: string; dataDir: string; logPath: string }; fixtureDumpPath: string; child: ChildProcess; close(): Promise<void> }
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;
let fixture: Fixture, vite: ViteDevServer, origin: string, headers: Record<string, string>, restartEnv: NodeJS.ProcessEnv;
let restarted: ChildProcess | undefined, proxy: ChildProcess | undefined, bot: { id: string; threadId: string }, artifact: Artifact, workspace: string;
const html = "<!doctype html><style>body{font:18px system-ui;padding:24px;color:#173047}</style><h1>Registered task report</h1><p>FILES_INTEGRATED_RESULT: three verified findings.</p>";
test.describe.configure({ mode: "serial" });
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
}
async function api(path: string, method = "GET", body?: unknown) {
  const response = await request(path, method, body); expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true); return await response.json() as any;
}
async function ownerProof() { const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string }; headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }; }
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000); try { await closed; } finally { clearTimeout(timer); }
}
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `import {writeFileSync} from 'node:fs';import {join} from 'node:path';writeFileSync(join(process.env.MURAGE_DATA_DIR,'files-fixture-environment.json'),JSON.stringify(process.env),{mode:0o600});` });
  try {
    await ownerProof(); restartEnv = JSON.parse(readFileSync(join(fixture.info.dataDir, "files-fixture-environment.json"), "utf8"));
    await api("/api/bots", "POST", { name: "Unrelated Files fixture bot" });
    bot = (await api("/api/bots", "POST", { name: "Files proof bot", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot;
    await api(`/api/bots/${bot.id}/messages`, "POST", { text: "__fixture_hold_authority__" });
    let mount: { command: string; args: string[]; env: Record<string, string> } | undefined;
    await expect.poll(() => { try { mount = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents; return Boolean(mount?.env.MURAGE_COMMS_TOKEN); } catch { return false; } }, { timeout: 15_000 }).toBe(true);
    expect(mount!.env.MURAGE_BOT_ID).toBe(bot.id);
    // Ask the server which folder this conversation actually resolved to
    // rather than assuming one: a task can own a folder of its own, and a
    // wrong guess here fails as "not found inside this task's workspace".
    workspace = (await api(`/api/artifacts/workspace?botId=${bot.id}&threadId=${bot.threadId}`)).path as string;
    mkdirSync(join(workspace, "reports"), { recursive: true });
    writeFileSync(join(workspace, "reports", "task.html"), html);
    // Exercise the real mounted MCP proxy with its active, fixture-only claim.
    // No bearer or environment is printed or passed through command arguments.
    proxy = spawn(mount!.command, mount!.args, { env: { ...restartEnv, ...mount!.env }, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map<number, any>(); let buffered = "";
    proxy.stdout!.on("data", chunk => { buffered += String(chunk); for (;;) { const end = buffered.indexOf("\n"); if (end < 0) break; const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); try { const value = JSON.parse(line); if (typeof value.id === "number") replies.set(value.id, value); } catch {} } });
    proxy.stderr!.resume();
    const rpc = async (id: number, method: string, params: Record<string, unknown>) => { proxy!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); await expect.poll(() => replies.has(id), { timeout: 15_000 }).toBe(true); return replies.get(id); };
    await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "files-fixture", version: "1" } });
    const saved = await rpc(2, "tools/call", { name: "register_artifact", arguments: { relative_path: "reports/task.html", name: "Registered task report" } });
    expect(saved.result.isError, JSON.stringify(saved.result)).not.toBe(true); artifact = JSON.parse(saved.result.content[0].text).artifact;
    expect(artifact.sha256).toBe(createHash("sha256").update(html).digest("hex"));
    const repeated = await rpc(3, "tools/call", { name: "register_artifact", arguments: { relative_path: "reports/task.html", name: "Registered task report" } });
    expect(JSON.parse(repeated.result.content[0].text).artifact.id).toBe(artifact.id);
    await stop(proxy); proxy = undefined;
    await api(`/api/bots/${bot.id}/interrupt`, "POST");
    await expect.poll(async () => Boolean((await api("/api/bots?messages=0")).bots.find((item: { id: string }) => item.id === bot.id).busy)).toBe(false);
    const state = (await api("/api/bots")).bots.find((item: { id: string }) => item.id === bot.id);
    expect(state.messages.filter((message: { artifactIds?: string[] }) => message.artifactIds?.includes(artifact.id))).toHaveLength(1);
    const inbox = await api("/api/inbox?view=results");
    expect(inbox.items.filter((item: { link: { artifactId?: string } }) => item.link.artifactId === artifact.id)).toHaveLength(1);
    expect((await fetch(`${fixture.info.url}/api/artifacts/${artifact.id}/download`)).status).toBe(404);
    expect((await fetch(`${fixture.info.url}/api/artifacts/${artifact.id}/native`)).status).toBe(404);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "files-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Files integration fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await stop(proxy); await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await stop(proxy); await stop(restarted); await fixture?.close(); } });

test("registered MCP task output appears once in Chat, Inbox and Files with a byte-exact download", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page); await sidebar.getByRole("button", { name: /^Files proof bot/ }).first().click();
  const card = page.locator(`[data-artifact-id="${artifact.id}"]`); await expect(card).toHaveCount(1); await expect(card).toBeVisible();
  // INLINE1: the report is rendered inside the chat card itself, in the same
  // protected frame Files uses; the card offers no Preview that leaves the chat.
  await expect(card.frameLocator('iframe[title="Preview Registered task report"]').getByText("FILES_INTEGRATED_RESULT: three verified findings.", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  await page.locator('[data-header-labelled="folder"]').click();
  const dialog = page.getByRole("dialog", { name: "Files", exact: true });
  await expect(dialog).toBeVisible();
  // The Files section's own preview is unchanged.
  await dialog.locator(`[data-artifact-id="${artifact.id}"]`).getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.frameLocator('iframe[title="Preview Registered task report"]').getByText("FILES_INTEGRATED_RESULT: three verified findings.", { exact: true })).toBeVisible();
  // R3-T2: the same report is reachable a second way — as the live workspace
  // file it still is, through the real server's own workspace resolver, and
  // labelled so it can never be mistaken for the saved copy beside it.
  const workspaceHalf = dialog.locator('[data-testid="files-workspace"]');
  await expect(dialog.locator('[data-testid="files-effective-root"]')).toContainText("Browsing Files proof bot");
  await workspaceHalf.getByRole("button", { name: "Open folder reports", exact: true }).click();
  const workspaceRow = workspaceHalf.locator('[data-workspace-path="reports/task.html"]');
  await expect(workspaceRow).toContainText("Workspace file ·");
  await expect(workspaceRow).not.toContainText("Saved copy");
  await page.screenshot({ path: testInfo.outputPath("files-focused-desktop-light.png"), fullPage: true });
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Download saved copy", exact: true }).click();
  expect(createHash("sha256").update(readFileSync((await (await download).path())!)).digest("hex")).toBe(artifact.sha256);
  await page.getByRole("button", { name: "Close Files", exact: true }).click();
  await sidebar.getByRole("button", { name: /^Tools/ }).click();
  const menu = sidebar.getByRole("menu", { name: "Tools" }); expect((await menu.getByRole("menuitem").allTextContents()).slice(0, 2)).toEqual(["Inbox", "Files"]);
  await menu.getByRole("menuitem", { name: "Inbox", exact: true }).click();
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Files", exact: true }).frameLocator('iframe[title="Preview Registered task report"]').getByRole("heading", { name: "Registered task report", exact: true })).toBeVisible();
});

test("saved copy survives a real fixture restart and task deletion; narrow Files remains scoped", async ({ page }, testInfo) => {
  const inbox = await api("/api/inbox?view=results"), item = inbox.items.find((item: { link: { artifactId?: string } }) => item.link.artifactId === artifact.id);
  await api("/api/inbox/state", "POST", { id: item.id, version: item.version, read: true });
  writeFileSync(join(workspace, "reports", "task.html"), "changed original after saved report");
  await stop(fixture.child);
  const log = openSync(fixture.info.logPath, "a");
  restarted = spawn(fixture.child.spawnargs[0], fixture.child.spawnargs.slice(1), { env: restartEnv, stdio: ["ignore", log, log] }); closeSync(log);
  await expect.poll(async () => { try { return (await fetch(fixture.info.url + "/api/health", { signal: AbortSignal.timeout(1000) })).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  await ownerProof();
  expect((await api(`/api/artifacts/${artifact.id}`)).artifact.sourceState).toBe("changed");
  const bytes = Buffer.from(await (await request(`/api/artifacts/${artifact.id}/download`)).arrayBuffer()); expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
  expect((await api("/api/inbox?view=results")).items.find((entry: { id: string }) => entry.id === item.id).read).toBe(true);
  await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "New task after report" }); await api(`/api/bots/${bot.id}/tasks/${artifact.threadId}`, "DELETE");
  expect((await api(`/api/artifacts/${artifact.id}`)).artifact.sourceConversationAvailable).toBe(false);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "dark"); });
  await page.goto(origin); const sidebar = await openSidebar(page); await sidebar.getByRole("button", { name: /^Tools/ }).click(); await sidebar.getByRole("menuitem", { name: "Files", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Files", exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByText("The source conversation is no longer available. The file remains saved.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Files", exact: true }).frameLocator('iframe[title="Preview Registered task report"]').getByRole("heading", { name: "Registered task report", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open in app", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("files-focused-narrow-dark.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await api(`/api/bots/${bot.id}`, "DELETE"); expect((await request(`/api/artifacts/${artifact.id}`)).status).toBe(404);
});
