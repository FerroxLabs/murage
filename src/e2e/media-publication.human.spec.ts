// F5-T5 (M5) joined proof: one fake generation, one asset, one saved result.
//
// Everything below runs against the real harness (server/index.ts) launched
// the way docs/verification/README.md describes, with the suite's own image
// provider fixture (server/testing/search-fetch-preload.mjs) intercepting
// every image origin and writing a receipt per call. The real mounted agents
// MCP proxy asks for the image; the real approval card is answered over the
// real route; the real Vite app renders the result. Nothing here touches a
// real app, ~/.murage, a provider or the network.
//
// Proves, end to end:
//   1. One approved generate_image call bills once and leaves exactly one
//      conversation attachment, one retained receipt, one saved Files
//      version — and the transcript, the lightbox, Download, the native
//      "Open" identity, the media byte route, "Use as reference" and the MCP
//      reference resolver all name the same bytes. Files keeps the saved
//      copy apart from the conversation attachment and the retained
//      original. Walking to another bot and back changes nothing.
//   2. When the conversation attachment cannot be written, the image is
//      received, retained and receipted `failed`, nothing is shown as
//      published, and a harness restart finishes the publication from the
//      retained bytes with zero provider calls.
//   3. A file a bot turn leaves in the managed outputs/ namespace becomes one
//      saved version and one host card; a WAV among them plays in chat
//      through the capability byte route, and the player, its Save a copy
//      link and the saved copy's Download all hand out the same bytes.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openSidebar } from "./fixtures.ts";
import type { Artifact } from "../../shared/artifacts.ts";
import type { MediaResolveResponse } from "../../shared/media-assets.ts";

interface Fixture {
  info: { url: string; dataDir: string; logPath: string }; fixtureDumpPath: string; child: ChildProcess;
  restart(): Promise<void>; close(): Promise<void>;
}
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;
interface Mount { command: string; args: string[]; env: Record<string, string> }
interface Bot { id: string; threadId: string; name: string }
interface Receipt { calls: number; url: string; model: string }

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The provider fixture's one-pixel PNG: every "generated" image is these bytes. */
const FIXTURE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const FIXTURE_SHA = sha256(FIXTURE_PNG);

/** 16-bit mono PCM at 8 kHz: a real, decodable WAV the sniffer recognises. */
function wav(seconds: number, hz: number): Buffer {
  const rate = 8000, samples = rate * seconds, data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * index) / rate) * 8000), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const NARRATION = wav(2, 440), NARRATION_SHA = sha256(NARRATION);

test.describe.configure({ mode: "serial" });

let fixture: Fixture, vite: ViteDevServer, origin: string, headers: Record<string, string>, serverEnv: NodeJS.ProcessEnv;
/** The harness data directory as the server itself resolves it (realpath). */
let dataRoot: string;
let imageBot: Bot, otherBot: Bot, echoBot: Bot;
const proxies: ChildProcess[] = [];
/** What the first test established; the later tests build on it. */
let first: { referenceId: string; artifactId: string };

// ── The real harness, driven over HTTP ───────────────────────────────────

async function ownerProof() {
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
}
async function api(path: string, method = "GET", body?: unknown) {
  const response = await request(path, method, body);
  expect(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text().catch(() => "")}`).toBe(true);
  return await response.json() as any;
}
async function bytesOf(path: string, withProof = true): Promise<Buffer> {
  const response = await fetch(fixture.info.url + path, { headers: withProof ? headers : {}, signal: AbortSignal.timeout(10_000) });
  expect(response.status, `GET ${path}`).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}
const messagesOf = async (bot: Bot) => (await api("/api/bots?messages=200")).bots.find((item: Bot) => item.id === bot.id).messages as any[];
const imageArtifactsOf = async (bot: Bot) => (await api(`/api/artifacts?botId=${bot.id}&kind=image`)).items as Artifact[];
const busy = async (bot: Bot) => Boolean((await api("/api/bots?messages=0")).bots.find((item: Bot) => item.id === bot.id)?.busy);
const imageReceipt = () => readFileSync(join(fixture.info.dataDir, "image-fixture-calls.json"), "utf8");
const attachmentsDir = () => join(fixture.info.dataDir, "attachments");
const pngsOnDisk = (directory: string) => existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".png")).sort() : [];

/** The receipt rows the harness wrote, read straight from its database. */
function receiptRows(botId: string, producer: string) {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, run_id, path_token, sha256, stage, artifact_id, attachment_id, message_id, error_category FROM output_publications WHERE bot_id=? AND producer=? ORDER BY created_at, id").all(botId, producer) as Array<Record<string, string | null>>;
  } finally { db.close(); }
}

/** The harness's own dispatch-preparation error: the memory bundle prepared
 * for a turn was invalidated before the engine started, so the turn ended
 * with no engine process. Reproduced outside Playwright as well: a memory
 * data write lands between bundle build and dispatch (memory_meta
 * data_revision advances by more than the turn's own writes) while the
 * roster policy stays granted, a few seconds after bots are created. It is
 * the memory owner's incident, not part of this proof, so a turn that ends
 * this way is sent again after a pause, at most TURN_ATTEMPTS times, and
 * every retry is annotated rather than hidden. */
const MEMORY_REVOKED = "error: MEMORY_CONTEXT_REVOKED";
const TURN_ATTEMPTS = 3, TURN_RETRY_PAUSE_MS = 1_500;
async function turnRevokedBeforeEngine(bot: Bot): Promise<boolean> {
  if (await busy(bot)) return false;
  const last = (await messagesOf(bot)).at(-1);
  return last?.kind === "activity" && last?.tool?.name === MEMORY_REVOKED;
}
/** Records the incident and pauses, or throws once the attempts are spent. */
async function retryAfterRevocation(what: string, attempt: number): Promise<void> {
  if (attempt >= TURN_ATTEMPTS) throw new Error(`${what} ended with ${MEMORY_REVOKED} ${TURN_ATTEMPTS} times; log ${fixture.info.logPath}`);
  const description = `${what} ended with ${MEMORY_REVOKED} before the engine started (attempt ${attempt}); sent again after ${TURN_RETRY_PAUSE_MS} ms`;
  test.info().annotations.push({ type: "harness-incident", description });
  console.warn(`[media-publication] ${description}`);
  await new Promise(resolve => setTimeout(resolve, TURN_RETRY_PAUSE_MS));
}

/** Holds a real fake-provider turn open and returns the agents MCP mount the
 * driver wrote for it, with this turn's own bearer. The dump is written once
 * per CLI process, so it is removed first and read back when it names this
 * bot with a fresh token. */
async function holdTurn(bot: Bot, previousToken?: string, text = "__fixture_hold_authority__", readyMs = 15_000, attempt = 1): Promise<Mount> {
  await expect.poll(() => busy(bot), { timeout: 10_000 }).toBe(false);
  rmSync(fixture.fixtureDumpPath, { force: true });
  const started = await request(`/api/bots/${bot.id}/messages`, "POST", { text });
  expect(started.status).toBe(202);
  let mount: Mount | undefined, seen = "no dump yet";
  const deadline = Date.now() + readyMs;
  while (!mount) {
    try {
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
      const candidate = dump.mcpConfig?.mcpServers?.agents as Mount | undefined;
      seen = `dump pid ${dump.pid}, mount for ${candidate?.env?.MURAGE_BOT_ID ?? "nobody"}, mcpConfig ${dump.mcpConfig ? "present" : "absent"}`;
      if (candidate?.env?.MURAGE_COMMS_TOKEN && candidate.env.MURAGE_BOT_ID === bot.id && candidate.env.MURAGE_COMMS_TOKEN !== previousToken) { mount = candidate; break; }
    } catch { /* not written yet */ }
    if (await turnRevokedBeforeEngine(bot)) {
      await retryAfterRevocation(`${bot.name}'s held turn`, attempt);
      return holdTurn(bot, previousToken, text, readyMs, attempt + 1);
    }
    if (Date.now() > deadline) {
      const state = (await api("/api/bots?messages=5")).bots.find((item: Bot) => item.id === bot.id);
      throw new Error(`the fake CLI never received ${bot.name}'s held turn: ${seen}; bot ${JSON.stringify({ busy: state?.busy, activity: state?.activity, last: state?.messages?.slice(-3) }).slice(0, 1500)}; log ${fixture.info.logPath}: ${readFileSync(fixture.info.logPath, "utf8").slice(-1500)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return mount;
}
async function endTurn(bot: Bot) {
  await api(`/api/bots/${bot.id}/interrupt`, "POST");
  await expect.poll(() => busy(bot), { timeout: 10_000 }).toBe(false);
}

async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}

/** The real mounted MCP proxy, exactly as the driver would start it. */
function connect(mount: Mount) {
  const proxy = spawn(mount.command, mount.args, { env: { ...serverEnv, ...mount.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, any>(); let buffered = "", stderr = "";
  proxy.stdout!.on("data", chunk => {
    buffered += String(chunk);
    for (;;) {
      const end = buffered.indexOf("\n"); if (end < 0) break;
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try { const value = JSON.parse(line); if (typeof value.id === "number") replies.set(value.id, value); } catch {}
    }
  });
  proxy.stderr!.on("data", chunk => { stderr += String(chunk); });
  let next = 1;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const id = next++;
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect.poll(() => replies.has(id), { timeout: 20_000, message: `MCP ${method} #${id} answered (stderr: ${stderr.slice(-400)})` }).toBe(true);
    return replies.get(id);
  };
  /** Sends a tool call and returns its pending result, so an approval can be answered meanwhile. */
  const call = (name: string, args: Record<string, unknown>) => {
    const id = next++;
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return (async () => {
      await expect.poll(() => replies.has(id), { timeout: 30_000, message: `MCP ${name} #${id} answered (stderr: ${stderr.slice(-400)})` }).toBe(true);
      return replies.get(id).result as { isError?: boolean; content: Array<{ text: string }> };
    })();
  };
  return { proxy, rpc, call, close: () => stop(proxy) };
}
async function session(mount: Mount) {
  const client = connect(mount);
  await client.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "media-publication-fixture", version: "1" } });
  return client;
}
async function approveNext(bot: Bot, title: string) {
  let card: any;
  await expect.poll(async () => { card = (await messagesOf(bot)).find(message => message.card?.tool === "generate_image" && !message.card.answered); return Boolean(card); }, { timeout: 15_000 }).toBe(true);
  expect(card.card.title).toBe(title);
  expect((await request(`/api/bots/${bot.id}/respond`, "POST", { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
}

// ── The real app ─────────────────────────────────────────────────────────

async function openApp(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
  await page.goto(origin);
}
async function selectBot(page: Page, bot: Bot) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: new RegExp(`^${bot.name}`) }).first().click();
  return sidebar;
}
const lightbox = (page: Page) => page.getByTestId("image-lightbox");
const lightboxImage = (page: Page) => page.getByTestId("image-lightbox-image");
async function downloadedSha(page: Page, trigger: () => Promise<void>): Promise<string> {
  const download = page.waitForEvent("download");
  await trigger();
  return sha256(readFileSync((await (await download).path())!));
}

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  // Fixture-owned observation and transport only, inside the launched child:
  // the server suite's image provider fixture (receipt per call, no
  // pass-through), a finish gate for held turns, one extra instance whose
  // fake CLI echoes the prompt after a gate, and the child's environment so
  // the MCP proxy can be started the way the driver starts it.
  const preload = pathToFileURL(join(ROOT, "server", "testing", "search-fetch-preload.mjs")).href;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: [
    "import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';",
    "import {join} from 'node:path';",
    `await import(${JSON.stringify(preload)});`,
    "const dataDir = process.env.MURAGE_DATA_DIR;",
    "const gateDir = join(dataDir, 'finish-fake'); mkdirSync(gateDir, {recursive: true});",
    "process.env.FAKE_CLAUDE_FINISH_GATE_DIR = gateDir;",
    "const configPath = join(dataDir, 'config.json'); const config = JSON.parse(readFileSync(configPath, 'utf8'));",
    "config.instances.echo = { driver: 'claudeAgent', displayName: 'Echo fixture', environment: { FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_REPLY_GATE: join(dataDir, 'echo-gate'), FAKE_CLAUDE_DUMP_EACH_TURN: '1' }, config: { cli: config.instances.verification.config.cli } };",
    "writeFileSync(configPath, JSON.stringify(config, null, 2));",
    "writeFileSync(join(dataDir, 'media-publication-environment.json'), JSON.stringify(process.env), {mode: 0o600});",
  ].join("\n") });
  try {
    await ownerProof();
    dataRoot = realpathSync.native(fixture.info.dataDir);
    serverEnv = JSON.parse(readFileSync(join(fixture.info.dataDir, "media-publication-environment.json"), "utf8"));
    otherBot = (await api("/api/bots", "POST", { name: "Unrelated media bot", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot;
    imageBot = (await api("/api/bots", "POST", { name: "Media publication bot", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot;
    echoBot = (await api("/api/bots", "POST", { name: "Media narration bot", modelSelection: { instanceId: "echo", model: "sonnet" } })).bot;
    // The fixture image key; the fixture origin accepts only it (exact-origin proof).
    expect((await request("/api/config?secretStorage=external", "PATCH", { imageGen: { key: "fixture-image-key" } })).status).toBe(200);
    const settings = await api("/api/images/settings", "POST", { enabled: true, connectionId: "openai", model: "gpt-image-2" });
    expect(settings.selected).toEqual({ connectionId: "openai", model: "gpt-image-2" });
    vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(fixture.info.dataDir, "media-publication-vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } },
      plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0);
    const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw new Error("media publication fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => {
  try { await vite?.close(); } finally {
    for (const proxy of proxies) await stop(proxy);
    await fixture?.close();
  }
});

test("one approved generation is one attachment, one receipt and one saved version, and every way of reaching it names the same bytes", async ({ page }, testInfo) => {
  // The first CLI launch of a fresh harness also warms its indexes; on a
  // loaded machine that is the slowest step of the whole run.
  const mount = await holdTurn(imageBot, undefined, undefined, 30_000);
  const client = await session(mount);
  expect(existsSync(join(fixture.info.dataDir, "image-fixture-calls.json"))).toBe(false);
  const pending = client.call("generate_image", { request_id: "joined-one", prompt: "Synthetic joined fixture", connection_id: "openai", model: "gpt-image-2" });
  await approveNext(imageBot, "Approve image generation");
  const result = await pending;
  expect(result.isError, result.content?.[0]?.text).not.toBe(true);
  const payload = JSON.parse(result.content[0].text) as { artifact: { id: string; path: string; url: string; referenceId: string; artifactId?: string; filesError?: string }; metadata: { model: string; provider: string } };
  const { referenceId, path: retainedPath } = payload.artifact;
  expect(payload.artifact.artifactId, "the saved version is named in the tool result").toEqual(expect.any(String));
  const artifactId = payload.artifact.artifactId as string;
  expect(payload.artifact.filesError).toBeUndefined();
  expect(payload.artifact.url).toBe(`/api/attachments/${referenceId}`);
  // exactly one billed call, to the fixture origin, for the approved model
  const receipt = JSON.parse(imageReceipt()) as Receipt;
  expect(receipt).toMatchObject({ calls: 1, url: "https://api.openai.com/v1/images/generations", model: "gpt-image-2" });

  // One asset: one transcript attachment, one committed attachment file, one
  // retained original under the managed image root, one receipt row.
  const attached = (await messagesOf(imageBot)).filter(message => message.attachments?.length);
  expect(attached).toHaveLength(1);
  expect(attached[0].attachments).toHaveLength(1);
  const attachmentPath = attached[0].attachments[0].path as string;
  expect(attachmentPath.split(/[\\/]/).at(-1)).toBe(referenceId);
  expect(attached[0].text).toBe("Image created with gpt-image-2 through openai.");
  expect(pngsOnDisk(attachmentsDir())).toEqual([referenceId]);
  expect(sha256(readFileSync(attachmentPath))).toBe(FIXTURE_SHA);
  const managedRoot = join(dataRoot, "workspaces", imageBot.id, "generated-images", imageBot.threadId);
  expect(retainedPath.startsWith(managedRoot + "/")).toBe(true);
  expect(pngsOnDisk(managedRoot)).toEqual([retainedPath.split("/").at(-1)]);
  expect(sha256(readFileSync(retainedPath))).toBe(FIXTURE_SHA);
  expect(receiptRows(imageBot.id, "image-operation")).toEqual([expect.objectContaining({
    id: payload.artifact.id, path_token: retainedPath.split("/").at(-1), sha256: FIXTURE_SHA, stage: "registered", artifact_id: artifactId, attachment_id: referenceId, message_id: attached[0].id, error_category: null,
  })]);

  // One saved result, apart from the conversation attachment and the retained original.
  const saved = await imageArtifactsOf(imageBot);
  expect(saved.map(item => item.id)).toEqual([artifactId]);
  expect(saved[0]).toMatchObject({ kind: "image", mime: "image/png", sha256: FIXTURE_SHA, producer: "image-operation", botId: imageBot.id, threadId: imageBot.threadId, sourceConversationAvailable: true, savedState: "available", name: "Generated image (gpt-image-2)" });
  expect(await imageArtifactsOf(otherBot)).toEqual([]);

  // Download, open, preview and the media byte route: the same bytes every way.
  expect(sha256(await bytesOf(`/api/attachments/${referenceId}`, false))).toBe(FIXTURE_SHA);
  expect(sha256(await bytesOf(`/api/artifacts/${artifactId}/download`))).toBe(FIXTURE_SHA);
  const native = await api(`/api/artifacts/${artifactId}/native`) as { path: string; sha256: string; kind: string };
  expect(native).toMatchObject({ sha256: FIXTURE_SHA, kind: "image" });
  expect(sha256(readFileSync(native.path))).toBe(FIXTURE_SHA);
  // the copy Open would hand to the OS is Files' verified saved copy, not the attachment or the retained original
  expect(realpathSync.native(native.path).startsWith(join(dataRoot, "artifact-files") + "/")).toBe(true);
  expect(new Set([native.path, attachmentPath, retainedPath].map(path => realpathSync.native(path))).size).toBe(3);
  expect((await api(`/api/artifacts/${artifactId}/preview`)).content).toBe(`data:image/png;base64,${FIXTURE_PNG.toString("base64")}`);
  const viaAttachment = await api("/api/media/resolve", "POST", { ref: { source: "attachment", threadId: imageBot.threadId, attachmentId: referenceId } }) as MediaResolveResponse;
  const viaArtifact = await api("/api/media/resolve", "POST", { ref: { source: "artifact", artifactId } }) as MediaResolveResponse;
  for (const resolved of [viaAttachment, viaArtifact]) {
    expect(resolved.asset).toMatchObject({ kind: "image", mime: "image/png", bytes: FIXTURE_PNG.length, availability: "ready", scope: { botId: imageBot.id, threadId: imageBot.threadId } });
    expect(resolved.url).toMatch(/^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}\?cap=mc1\./);
    expect(sha256(await bytesOf(resolved.url!, false))).toBe(FIXTURE_SHA);
  }
  expect(viaArtifact.asset.revision).toBe(FIXTURE_SHA);

  // Reference: the MCP resolver and the desktop route both pin the same bytes
  // by attachment id and by saved version, with no further provider call.
  const references = await client.call("resolve_image_reference", { sources: [{ attachment_id: referenceId }, { artifact_id: artifactId, sha256: FIXTURE_SHA }] });
  expect(references.isError, references.content?.[0]?.text).not.toBe(true);
  const prepared = JSON.parse(references.content[0].text).references as Array<{ id: string; sha256: string; source: string }>;
  expect(prepared.map(item => item.sha256)).toEqual([FIXTURE_SHA, FIXTURE_SHA]);
  expect(prepared[0]).toMatchObject({ id: referenceId, source: "attachment" });
  expect(prepared[1].source).toBe("artifact");
  const useAsReference = await api("/api/media/reference", "POST", { threadId: imageBot.threadId, source: { kind: "attachment", attachmentId: referenceId } });
  expect(useAsReference.reference).toMatchObject({ id: referenceId, sha256: FIXTURE_SHA, mime: "image/png", bytes: FIXTURE_PNG.length });
  expect(useAsReference.attachment.path).toBe(attachmentPath);
  expect(JSON.parse(imageReceipt()).calls).toBe(1);
  expect(pngsOnDisk(attachmentsDir())).toEqual([referenceId]);
  await client.close();
  await endTurn(imageBot);
  first = { referenceId, artifactId };

  // The app: the one thumbnail, the one lightbox over the same URL, Download,
  // Use as reference into this conversation's composer, and the saved copy in
  // Files over the same bytes.
  await openApp(page);
  await selectBot(page, imageBot);
  const thumbs = page.getByRole("button", { name: `Preview attached image ${referenceId}` });
  await expect(thumbs).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Preview attached image/ })).toHaveCount(1);
  await expect(page.getByText("Image created with gpt-image-2 through openai.")).toBeVisible();
  await thumbs.click();
  await expect(lightbox(page)).toBeVisible();
  await expect(lightbox(page)).toHaveAccessibleName(`Preview ${referenceId}`);
  await expect(lightboxImage(page)).toHaveAttribute("src", `/api/attachments/${referenceId}`);
  await expect.poll(() => lightboxImage(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await expect(page.getByRole("button", { name: "Next image" })).toHaveCount(0);
  const downloadLink = lightbox(page).getByRole("link", { name: `Download ${referenceId}` });
  await expect(downloadLink).toHaveAttribute("href", `/api/attachments/${referenceId}`);
  expect(await downloadedSha(page, () => downloadLink.click())).toBe(FIXTURE_SHA);
  await page.screenshot({ path: testInfo.outputPath("lightbox-generated-image.png") });
  await lightbox(page).getByRole("button", { name: `Use ${referenceId} as a reference image in your next message` }).click();
  await expect(lightbox(page).getByRole("button", { name: `${referenceId} was added to your next message as a reference image` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).toHaveCount(0);
  const chip = page.getByRole("button", { name: `Preview ${referenceId}` });
  await expect(chip).toHaveCount(1);
  await expect(chip.locator("img")).toHaveAttribute("src", `/api/attachments/${referenceId}`);
  expect(pngsOnDisk(attachmentsDir()), "a reference pins the existing attachment; it copies nothing").toEqual([referenceId]);
  expect(JSON.parse(imageReceipt()).calls).toBe(1);
  await page.getByRole("button", { name: "Remove file" }).click();
  await expect(chip).toHaveCount(0);

  // Same-window navigation does not change the audience: the other bot shows
  // no image and owns no saved version; coming back shows the same one thumbnail.
  const sidebar = await selectBot(page, otherBot);
  await expect(page.getByRole("button", { name: /^Preview attached image/ })).toHaveCount(0);
  await selectBot(page, imageBot);
  await expect(thumbs).toHaveCount(1);

  await sidebar.getByRole("button", { name: /^Tools/ }).click();
  await sidebar.getByRole("menu", { name: "Tools" }).getByRole("menuitem", { name: "Files", exact: true }).click();
  const files = page.getByRole("dialog", { name: "Files", exact: true });
  await expect(files).toBeVisible();
  const card = files.locator(`[data-artifact-id="${artifactId}"]`);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Saved copy");
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  const savedThumb = files.getByRole("button", { name: "Enlarge image Generated image (gpt-image-2)" });
  await expect(savedThumb).toBeVisible();
  await savedThumb.click();
  await expect(lightboxImage(page)).toHaveAttribute("src", `data:image/png;base64,${FIXTURE_PNG.toString("base64")}`);
  await expect(lightbox(page).getByRole("link", { name: "Download Generated image (gpt-image-2)" })).toHaveAttribute("href", `data:image/png;base64,${FIXTURE_PNG.toString("base64")}`);
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).toHaveCount(0);
  expect(await downloadedSha(page, () => files.getByRole("button", { name: "Download saved copy", exact: true }).click())).toBe(FIXTURE_SHA);
  await page.screenshot({ path: testInfo.outputPath("files-saved-generated-image.png"), fullPage: true });
  await files.getByRole("button", { name: "Close Files", exact: true }).click();
});

test("a received image whose attachment cannot be written is retained, shown as unpublished, and finished after a restart with zero provider calls", async ({ page }, testInfo) => {
  const mount = await holdTurn(imageBot);
  const client = await session(mount);
  // The conversation attachment step fails at the filesystem: the directory
  // stops accepting new files, after the provider has already answered.
  chmodSync(attachmentsDir(), 0o500);
  let refused: { isError?: boolean; content: Array<{ text: string }> };
  try {
    const pending = client.call("generate_image", { request_id: "joined-two", prompt: "Synthetic joined fixture, second", connection_id: "openai", model: "gpt-image-2" });
    await approveNext(imageBot, "Approve image generation");
    refused = await pending;
  } finally { chmodSync(attachmentsDir(), 0o700); }
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Image received and kept locally");
  expect(refused.content[0].text).toContain("(filesystem)");
  expect(refused.content[0].text).toContain("no new provider request will be sent");
  // billed once more — and only once — for the image that was received
  expect(JSON.parse(imageReceipt()).calls).toBe(2);
  const receiptText = imageReceipt();
  // Retained and receipted, not published: no second attachment, no second
  // saved version, nothing new in the transcript, the receipt says failed.
  const managedRoot = join(dataRoot, "workspaces", imageBot.id, "generated-images", imageBot.threadId);
  expect(pngsOnDisk(managedRoot)).toHaveLength(2);
  const retained = receiptRows(imageBot.id, "image-operation");
  expect(retained).toHaveLength(2);
  const failed = retained.find(row => row.stage === "failed")!;
  expect(failed).toMatchObject({ stage: "failed", error_category: "filesystem", sha256: FIXTURE_SHA, artifact_id: null, attachment_id: null, message_id: null });
  expect(sha256(readFileSync(join(managedRoot, failed.path_token!)))).toBe(FIXTURE_SHA);
  expect(pngsOnDisk(attachmentsDir())).toEqual([first.referenceId]);
  expect((await messagesOf(imageBot)).filter(message => message.attachments?.length)).toHaveLength(1);
  expect((await imageArtifactsOf(imageBot)).map(item => item.id)).toEqual([first.artifactId]);
  await client.close();
  await endTurn(imageBot);

  // A real restart of the same harness over the same data: startup finishes
  // the publication from the retained bytes. The provider receipt does not
  // change by a byte.
  await fixture.restart();
  await ownerProof();
  await expect.poll(async () => (await imageArtifactsOf(imageBot)).length, { timeout: 20_000 }).toBe(2);
  expect(imageReceipt()).toBe(receiptText);
  expect(JSON.parse(imageReceipt()).calls).toBe(2);
  const rows = receiptRows(imageBot.id, "image-operation");
  expect(rows.map(row => row.stage)).toEqual(["registered", "registered"]);
  const recovered = rows.find(row => row.id === failed.id)!;
  expect(recovered).toMatchObject({ error_category: null, artifact_id: expect.any(String), attachment_id: expect.stringMatching(/^[a-f0-9-]{36}\.png$/), message_id: expect.any(String) });
  const attached = (await messagesOf(imageBot)).filter(message => message.attachments?.length);
  expect(attached).toHaveLength(2);
  expect(attached.map(message => message.id)).toContain(recovered.message_id);
  expect(attached.every(message => message.text === "Image created with gpt-image-2 through openai.")).toBe(true);
  expect(pngsOnDisk(attachmentsDir()).sort()).toEqual([first.referenceId, recovered.attachment_id].sort());
  const artifacts = await imageArtifactsOf(imageBot);
  expect(artifacts.map(item => item.id).sort()).toEqual([first.artifactId, recovered.artifact_id].sort());
  expect(artifacts.every(item => item.sha256 === FIXTURE_SHA && item.producer === "image-operation")).toBe(true);
  expect(sha256(await bytesOf(`/api/artifacts/${recovered.artifact_id}/download`))).toBe(FIXTURE_SHA);
  expect(sha256(await bytesOf(`/api/attachments/${recovered.attachment_id}`, false))).toBe(FIXTURE_SHA);
  // the first image is untouched by the recovery
  expect(rows.find(row => row.id !== failed.id)).toMatchObject({ artifact_id: first.artifactId, attachment_id: first.referenceId });

  // The app after the restart: both images, the recovered one in the same
  // lightbox over its own attachment, and two saved versions in Files.
  await openApp(page);
  await selectBot(page, imageBot);
  await expect(page.getByRole("button", { name: /^Preview attached image/ })).toHaveCount(2);
  const recoveredThumb = page.getByRole("button", { name: `Preview attached image ${recovered.attachment_id}` });
  await recoveredThumb.click();
  await expect(lightboxImage(page)).toHaveAttribute("src", `/api/attachments/${recovered.attachment_id}`);
  await expect.poll(() => lightboxImage(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("lightbox-recovered-image.png") });
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).toHaveCount(0);
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: /^Tools/ }).click();
  await sidebar.getByRole("menu", { name: "Tools" }).getByRole("menuitem", { name: "Files", exact: true }).click();
  const files = page.getByRole("dialog", { name: "Files", exact: true });
  await expect(files.locator("[data-artifact-id]")).toHaveCount(2);
  await expect(files.locator(`[data-artifact-id="${recovered.artifact_id}"]`)).toContainText("Saved copy");
  await files.getByRole("button", { name: "Close Files", exact: true }).click();
});

test("a WAV a bot turn leaves in outputs/ is one saved version and one host card, and its player, Save a copy and Download hand out the same bytes", async ({ page }, testInfo) => {
  // A first ordinary turn (its gate already open) pins the managed workspace
  // so its path is known; the echo turn then carries that path as a link.
  const gate = join(fixture.info.dataDir, "echo-gate");
  writeFileSync(gate, "go");
  for (let attempt = 1; ; attempt++) {
    expect((await request(`/api/bots/${echoBot.id}/messages`, "POST", { text: "Warm up." })).status).toBe(202);
    await expect.poll(() => busy(echoBot), { timeout: 20_000 }).toBe(false);
    if (!(await turnRevokedBeforeEngine(echoBot))) break;
    await retryAfterRevocation(`${echoBot.name}'s warm-up turn`, attempt);
  }
  rmSync(gate, { force: true });
  const workspace = (await api(`/api/artifacts/workspace?botId=${echoBot.id}&threadId=${echoBot.threadId}`)).path as string;
  const narrationPath = join(workspace, "outputs", "narration.wav");
  const before = (await messagesOf(echoBot)).length;
  // The snapshot of outputs/ is taken at dispatch, before the CLI sees the
  // prompt; the file is written only once the CLI has the prompt and is
  // waiting on its gate, and then the gate releases the turn.
  // (The driver may reuse the warm-up CLI process for this turn or spawn a
  // fresh one; either way this instance dumps every turn, and the dump that
  // carries this prompt is the signal that the CLI holds it at its gate.)
  const cliHoldsPrompt = () => { try { return String(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt?.message?.content ?? "").includes(narrationPath); } catch { return false; } };
  for (let attempt = 1; ; attempt++) {
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await request(`/api/bots/${echoBot.id}/messages`, "POST", { text: `Listen to [narration](${narrationPath}) when it is ready.` })).status).toBe(202);
    const deadline = Date.now() + 15_000;
    let revoked = false;
    while (!cliHoldsPrompt()) {
      if (await turnRevokedBeforeEngine(echoBot)) { revoked = true; break; }
      if (Date.now() > deadline) throw new Error(`the echo CLI never received the narration prompt; log ${fixture.info.logPath}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!revoked) break;
    await retryAfterRevocation(`${echoBot.name}'s narration turn`, attempt);
  }
  expect(existsSync(join(workspace, "outputs"))).toBe(true);
  writeFileSync(narrationPath, NARRATION, { mode: 0o600 });
  writeFileSync(gate, "go");
  await expect.poll(() => busy(echoBot), { timeout: 20_000 }).toBe(false);
  let hostCard: any;
  await expect.poll(async () => { hostCard = (await messagesOf(echoBot)).find(message => message.artifactIds?.length); return Boolean(hostCard); }, { timeout: 15_000 }).toBe(true);
  expect(hostCard.text).toBe("Saved file: narration.wav");
  expect(hostCard.artifactIds).toHaveLength(1);
  const artifactId = hostCard.artifactIds[0] as string;
  const messages = await messagesOf(echoBot);
  const reply = messages.find(message => message.role === "bot" && typeof message.text === "string" && message.text.includes(narrationPath) && !message.artifactIds);
  expect(reply, "the bot's reply carries the path as a link").toBeTruthy();
  expect(messages.filter(message => message.artifactIds?.length)).toHaveLength(1);
  expect(messages.length).toBeGreaterThan(before);
  const artifact = (await api(`/api/artifacts/${artifactId}`)).artifact as Artifact;
  expect(artifact).toMatchObject({ kind: "other", sha256: NARRATION_SHA, bytes: NARRATION.length, producer: "shell-output", botId: echoBot.id, threadId: echoBot.threadId, relativePath: "outputs/narration.wav", name: "narration.wav", sourceState: "current" });
  expect(receiptRows(echoBot.id, "shell-output")).toEqual([expect.objectContaining({ path_token: "outputs/narration.wav", sha256: NARRATION_SHA, stage: "registered", artifact_id: artifactId, message_id: hostCard.id })]);
  expect(sha256(await bytesOf(`/api/artifacts/${artifactId}/download`))).toBe(NARRATION_SHA);
  expect((await api(`/api/artifacts?botId=${echoBot.id}`)).items.map((item: Artifact) => item.id)).toEqual([artifactId]);
  expect(JSON.parse(imageReceipt()).calls, "no image provider call is involved").toBe(2);

  await openApp(page);
  await selectBot(page, echoBot);
  // The echo reply may carry the link more than once (a fresh CLI process
  // gets the replayed prompt); each mention is a player over the same asset.
  // INLINE1: the saved-file card below carries its own player over the saved
  // copy (a different asset, checked further down); these are the link players.
  const players = page.locator('[data-testid="media-player-audio"]:not([data-artifact-id] *)');
  await expect(players.first()).toBeVisible();
  const player = players.first();
  await expect(player).toHaveAccessibleName("Audio player for narration.wav");
  const src = (await player.getAttribute("src"))!;
  expect(src).toMatch(/^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}\?cap=mc1\./);
  for (const each of await players.all()) {
    expect(await each.getAttribute("src")).toBe(src);
    expect(await each.evaluate((element: HTMLMediaElement) => element.paused && !element.autoplay)).toBe(true);
  }
  expect(sha256(await bytesOf(src, false))).toBe(NARRATION_SHA);
  const range = await fetch(fixture.info.url + src, { headers: { range: "bytes=44-" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe(`bytes 44-${NARRATION.length - 1}/${NARRATION.length}`);
  expect(sha256(Buffer.concat([NARRATION.subarray(0, 44), Buffer.from(await range.arrayBuffer())]))).toBe(NARRATION_SHA);
  const bubble = page.locator("[data-media-player=audio]").first();
  const saveCopy = bubble.getByRole("link", { name: "Save a copy" });
  await expect(saveCopy).toHaveAttribute("href", src);
  expect(await downloadedSha(page, () => saveCopy.click())).toBe(NARRATION_SHA);
  const card = page.locator(`[data-artifact-id="${artifactId}"]`);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("narration.wav");
  await expect(card).toContainText("Saved copy");
  // INLINE1: the card plays the saved copy in place through its own capability
  // URL — the same bytes, silent until asked — and offers no Preview.
  const cardPlayer = card.getByTestId("media-player-audio");
  await expect(cardPlayer).toBeVisible();
  const cardSrc = (await cardPlayer.getAttribute("src"))!;
  expect(cardSrc).toMatch(/^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}\?cap=mc1\./);
  expect(cardSrc).not.toBe(src);
  expect(await cardPlayer.evaluate((element: HTMLMediaElement) => element.paused && !element.autoplay)).toBe(true);
  expect(sha256(await bytesOf(cardSrc, false))).toBe(NARRATION_SHA);
  await expect(card.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  expect(await downloadedSha(page, () => card.getByRole("button", { name: "Download", exact: true }).click())).toBe(NARRATION_SHA);
  await page.screenshot({ path: testInfo.outputPath("player-and-saved-copy.png"), fullPage: true });
  // The other bot sees neither the player nor the saved copy.
  await selectBot(page, otherBot);
  await expect(page.getByTestId("media-player-audio")).toHaveCount(0);
  expect((await api(`/api/artifacts?botId=${otherBot.id}`)).items).toEqual([]);
  // The retained copy stays byte-exact even when the workspace file moves on.
  writeFileSync(narrationPath, "not audio any more");
  expect(sha256(await bytesOf(`/api/artifacts/${artifactId}/download`))).toBe(NARRATION_SHA);
  expect((await api(`/api/artifacts/${artifactId}`)).artifact.sourceState).toBe("changed");
  expect(statSync(narrationPath).size).toBeLessThan(NARRATION.length);
});
