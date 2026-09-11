// Murage 0.1.52 — USER smoke test ROUND 2 (docs/plans/0152-USER-SMOKE-2.md).
// The harness below is round 1's (user-smoke-0152.human.spec.ts) with a gated
// fake pi added for the RED2C checkpoint-roll turn, and a revoked turn is a
// FAILURE here rather than a retried incident: RED2C/RED2E fixed that path.
//
// One real isolated harness (server/index.ts, its own data dir and HOME on
// the rig's ports) and the real Vite app, driven by a browser the way a
// person drives it: click, type, read the screen. Nothing here calls an
// internal API to make a check pass; the HTTP helpers below exist only to
// set fixtures up (a bot on a given engine, the owner proof the Vite proxy
// carries anyway) and to stand in for the *engine's own shell* where the
// suite's fake engine cannot write media itself.
//
// Engines: the suite's fake Claude CLI (server/testing/fake-claude-cli.ts)
// in several flavours, the real locally installed Claude CLI when
// MURAGE_SMOKE_CLAUDE_CLI names it, the bundled Fuigo when
// MURAGE_SMOKE_FUIGO_DIR names the staged directory, the pi CLI when
// MURAGE_SMOKE_PI_CLI names it, and a local OpenAI-compatible server — the
// real one when MURAGE_SMOKE_LOCAL_SERVER is set, else a fake llama-server
// in this process. Every absent live input runs against the fake and is
// recorded as "live proof pending" in the test annotations; nothing is
// skipped.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { openSidebar } from "./fixtures.ts";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { laneDataDir } from "./lane-data-dir";

// ── Inputs ───────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATA_DIR = laneDataDir("the smoke test never uses ~/.murage");
const HARNESS_PORT = Number(process.env.MURAGE_E2E_PORT || 9990);
const UI_PORT = Number(process.env.MURAGE_E2E_UI_PORT || 9992);
const EVIDENCE = process.env.MURAGE_SMOKE_EVIDENCE_DIR || join(DATA_DIR, "evidence");
const REAL_CLAUDE_CLI = process.env.MURAGE_SMOKE_CLAUDE_CLI || "";
const REAL_CLAUDE_HOME = process.env.MURAGE_SMOKE_CLAUDE_HOME || "";
const LOCAL_SERVER = process.env.MURAGE_SMOKE_LOCAL_SERVER || "";
const PI_CLI = process.env.MURAGE_SMOKE_PI_CLI || "";
const FUIGO_DIR = process.env.MURAGE_SMOKE_FUIGO_DIR || "";
const FLUX_KEY_FILE = process.env.MURAGE_SMOKE_FLUX_KEY_FILE || "";
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");
const FAKE_PI = join(ROOT, "server", "testing", "fake-pi-cli.ts");
const MP4_FIXTURE = process.env.MURAGE_SMOKE_MP4 || "";
/** The version scripts/prepare-fuigo.mjs pins (1.0.13 once FUIGO13 merged). */
const EXPECTED_FUIGO = /export const FUIGO_VERSION = "([\d.]+)"/.exec(readFileSync(join(ROOT, "scripts", "prepare-fuigo.mjs"), "utf8"))?.[1] ?? "unknown";
const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}`;

const pending = (what: string) => {
  test.info().annotations.push({ type: "live-proof-pending", description: what });
  console.warn(`[user-smoke] live proof pending: ${what}`);
};
const note = (what: string) => test.info().annotations.push({ type: "observed", description: what });

// ── The fake llama-server (fallback for the local-models feature) ─────────

const FAKE_TOOL_MODEL = "qwen3.8-27b";
const FAKE_PROSE_MODEL = "chatty-7b";
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => { let raw = ""; req.on("data", (chunk) => (raw += chunk)); req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})); });
}
function send(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
const toolCall = { id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } };
async function fakeLlamaServer(): Promise<{ server: Server; address: string }> {
  const server = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
    const prose = body.model === FAKE_PROSE_MODEL;
    switch (req.url) {
      case "/props": return send(res, 200, { default_generation_settings: { n_ctx: 65_536 }, model_path: "/models/qwen.gguf", total_slots: 1 });
      case "/health": return send(res, 200, { status: "ok" });
      case "/v1/models": return send(res, 200, { object: "list", data: [FAKE_TOOL_MODEL, FAKE_PROSE_MODEL].map((id) => ({ id, object: "model", owned_by: "llamacpp" })) });
      case "/v1/chat/completions":
        if (prose || messages.some((message) => message.role === "tool")) return send(res, 200, { choices: [{ message: { role: "assistant", content: "pong — from the fake local model" } }] });
        if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] })}\n\n`); return res.end("data: [DONE]\n\n"); }
        return send(res, 200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall] } }], usage: { prompt_tokens: 7_800 } });
      case "/v1/messages": return send(res, 200, { content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }] });
      case "/v1/responses": return send(res, 200, { output: [{ type: "function_call", name: "get_weather", arguments: '{"city":"Paris"}' }] });
      default: return send(res, 404, { error: "not found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, address: `127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// ── The real harness ─────────────────────────────────────────────────────

interface Bot { id: string; threadId: string; name: string }
let harness: ChildProcess | undefined, harnessEnv: NodeJS.ProcessEnv, logPath: string;
let vite: ViteDevServer, origin: string, headers: Record<string, string>;
let llama: Server | undefined;
const finishGateDir = () => join(DATA_DIR, "finish-gate");
const replyGate = () => join(DATA_DIR, "reply-gate");
const dumpPath = () => join(DATA_DIR, "fake-claude-dump.json");

function writeConfig() {
  const instances: Record<string, unknown> = {
    // The product fleet key: a `claude` entry makes the harness add fuigo,
    // pi, cursor and the rest the way an installed app would. It is the
    // real CLI when the smoke test was given one, else the fake.
    claude: REAL_CLAUDE_CLI
      ? { driver: "claudeAgent", displayName: "Claude (real CLI)", config: { cli: REAL_CLAUDE_CLI }, // The CLI keeps its login in the user's Keychain under the login name,
      // so the child gets the person's HOME and USER (read-only: nothing
      // here writes a credential).
      environment: REAL_CLAUDE_HOME ? { HOME: REAL_CLAUDE_HOME, USERPROFILE: REAL_CLAUDE_HOME, USER: userInfo().username, LOGNAME: userInfo().username } : {} }
      : { driver: "claudeAgent", displayName: "Claude (fake stand-in)", config: { cli: FAKE_CLI } },
    verification: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLI } },
    slow: { driver: "claudeAgent", displayName: "Slow fixture", config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_REPLY_GATE: replyGate(), FAKE_CLAUDE_DUMP_EACH_TURN: "1" } },
    expiring: { driver: "claudeAgent", displayName: "Expiring questions", config: { cli: FAKE_CLI, questionTimeoutMs: 1000 } },
    coder: { driver: "claudeAgent", displayName: "Coder fixture", config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_REPLIES: JSON.stringify(["Here is the script you asked for:\n\n```python\nprint(\"hello from the smoke test\")\n```\n\nSave it wherever you like."]) } },
    crasher: { driver: "claudeAgent", displayName: "Crashes after prompt", config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_MODE: "exit-early" } },
    // Dies once at startup WITHOUT reading stdin; the driver may relaunch
    // only because the prompt was never delivered (U-17).
    flaky: { driver: "claudeAgent", displayName: "Flaky launch", config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS: "1", FAKE_CLAUDE_STATE: join(DATA_DIR, "flaky-launches") } },
    // RED2C: the fake pi holds its session handshake until the gate file exists.
    piGate: { driver: "piAgent", displayName: "Gated pi fixture", config: { cli: FAKE_PI, fullAuto: true }, environment: { FAKE_PI_SESSION_GATE: join(DATA_DIR, "pi-session-gate"), FAKE_PI_DUMP: join(DATA_DIR, "pi-dump.jsonl") } },
    ...(PI_CLI ? { pi: { driver: "piAgent", displayName: "Pi", config: { cli: PI_CLI } } } : {}),
  };
  // No FluxRouter key at start: feature 10 proves the connected-apps lock a
  // keyless install shows, and feature 15 adds the key from that lock.
  const config: Record<string, unknown> = { instances };
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

async function startHarness() {
  safeWipeSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(EVIDENCE, { recursive: true });
  const home = join(DATA_DIR, "fixture-home"); mkdirSync(home, { recursive: true });
  const tmp = join(DATA_DIR, "tmp"); mkdirSync(tmp, { recursive: true });
  mkdirSync(finishGateDir(), { recursive: true });
  // A PATH with this node and the OS tools only: no developer-installed
  // engine may answer for the bundled one.
  const bin = join(DATA_DIR, "bin"); mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  writeConfig();
  const preload = pathToFileURL(join(ROOT, "server", "testing", "search-fetch-preload.mjs")).href;
  harnessEnv = {
    ...Object.fromEntries(["LANG", "LC_ALL", "TZ"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
    PATH: [bin, "/usr/bin", "/bin"].join(":"),
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    MURAGE_DATA_DIR: DATA_DIR, MURAGE_PORT: String(HARNESS_PORT), MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
    MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
    // The built UI, when present, is what the harness serves to a phone
    // (electron/harness-resources.mjs decides the same for `pnpm dev:server`).
    ...(existsSync(join(ROOT, "dist", "index.html")) ? { MURAGE_STATIC_DIR: join(ROOT, "dist") } : {}),
    FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dumpPath(), FAKE_CLAUDE_FINISH_GATE_DIR: finishGateDir(),
    ...(FUIGO_DIR ? { MURAGE_FUIGO_DIR: FUIGO_DIR } : {}),
    // The FluxRouter connected-apps door is a release switch ("" in 0.1.52,
    // electron/composio-release-config.mjs); the documented QA override
    // turns it on so the CTA a switched-on build shows can be read.
    MURAGE_FLUX_COMPOSIO_BROKER_URL: process.env.MURAGE_SMOKE_FLUX_COMPOSIO_BROKER_URL || "https://api.fluxrouter.ai/composio",
  };
  logPath = join(DATA_DIR, "harness.log");
  const log = openSync(logPath, "a");
  try {
    harness = spawn(process.execPath, ["--experimental-strip-types", "--import", preload, join(ROOT, "server", "index.ts")], { cwd: ROOT, env: harnessEnv, stdio: ["ignore", log, log] });
  } finally { closeSync(log); }
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (harness.exitCode !== null) throw new Error(`harness exited early; see ${logPath}\n${readFileSync(logPath, "utf8").slice(-2000)}`);
    try { const res = await fetch(`${HARNESS_URL}/api/health`, { signal: AbortSignal.timeout(1000) }); if (res.ok && (await res.json()).app === "murage") break; } catch {}
    if (Date.now() > deadline) throw new Error(`harness never answered on ${HARNESS_URL}; see ${logPath}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = await (await fetch(`${HARNESS_URL}/api/desktop-secret`, { headers: { "x-murage-surface": "desktop" } })).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}
async function stopHarness() {
  const child = harness; if (!child || child.exitCode !== null) return;
  const closed = new Promise<void>((r) => child.once("close", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(HARNESS_URL + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
}
async function api(path: string, method = "GET", body?: unknown) {
  const response = await request(path, method, body);
  expect(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text().catch(() => "")}`).toBe(true);
  return await response.json() as any;
}
/** Fixture setup only: a bot on a named engine, the way the seed step of
 *  every human spec does it. The user-facing create flow is proven in
 *  feature 1 through the sidebar. */
async function makeBot(name: string, instanceId: string, model = "sonnet", patch: Record<string, unknown> = {}): Promise<Bot> {
  // A title and description mark the bot as one a person already set up, so
  // the first-run intake quiz (proven in feature 1) does not take its first
  // message. `model: null` leaves the engine's own default in place.
  const bot = (await api("/api/bots", "POST", { name, title: "Smoke fixture", description: `Fixture bot on ${instanceId}.`, ...(instanceId ? { modelSelection: { instanceId, model } } : {}) })).bot as Bot;
  if (Object.keys(patch).length) await api(`/api/bots/${bot.id}`, "PATCH", patch);
  return bot;
}
const botState = async (who: Bot) => (await api("/api/bots?messages=0")).bots.find((item: Bot) => item.id === who.id);
const busy = async (who: Bot) => Boolean((await botState(who))?.busy);
const workspaceOf = async (who: Bot) => (await api(`/api/artifacts/workspace?botId=${who.id}&threadId=${who.threadId}`)).path as string;

// ── The real app ─────────────────────────────────────────────────────────

async function openApp(page: Page, { width = 1440, height = 900, skin = "light" } = {}) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((skin) => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", skin); }, skin);
  // A person uses the app once it has finished loading. The engine list is
  // the slowest part of that (about 3 s with the real CLIs probed); a send
  // before it lands is the startup race recorded in 0152-USER-SMOKE.md.
  const engines = page.waitForResponse((response) => /\/api\/instances(\?|$)/.test(response.url()) && response.ok(), { timeout: 60_000 });
  await page.goto(origin);
  // At phone width both the drawer toggle and the (off-canvas) sidebar match; either proves the app shell is up.
  await expect(page.getByRole("complementary", { name: "Bots and navigation" }).or(page.getByRole("button", { name: "Open bot list" })).first()).toBeVisible();
  await engines;
}
async function selectBot(page: Page, who: Bot | string) {
  const name = typeof who === "string" ? who : who.name;
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await expect(composer(page, name)).toBeVisible();
  await settleIntake(page, name);
  return sidebar;
}
/** Every new bot opens with its two-question setup quiz, and the composer's
 *  first messages answer it (feature 1 walks it deliberately). A fixture bot
 *  that still has the quiz open is taken through it the same way a person
 *  would — "general it is" — so the turns that follow reach the engine. */
async function settleIntake(page: Page, name: string) {
  const log = transcript(page);
  await expect(log.getByText(/What do you actually want me for\?|I'm .* Untrained|precisely nothing so far|Fine, general it is|Right, I'm/).first()).toBeVisible();
  if (await log.getByText("Fine, general it is.").count() || await log.getByText(/^Right, I'm /).count()) return;
  if (!(await log.getByText("What do you actually want me for?").count())) return;
  if (!(await log.getByText("Give me one real thing you'd rather hand over.").count())) {
    await say(page, name, "just chat with me");
    await expect(log.getByText("Give me one real thing you'd rather hand over.")).toBeVisible();
  }
  await say(page, name, "nothing specific, general chat");
  await expect(log.getByText("I don't think you need a specialist for this.")).toBeVisible();
  await page.getByRole("button", { name: "That's fine", exact: true }).click();
  await expect(log.getByText("Fine, general it is.")).toBeVisible();
}
const composer = (page: Page, name: string) => page.getByRole("textbox", { name: `Message ${name}`, exact: true });
async function say(page: Page, name: string, text: string) {
  const box = composer(page, name);
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await retryIfRevoked(page, name);
}
/** The harness incident the candidate record carries as open (§4.1): a turn
 *  can end with `error: MEMORY_CONTEXT_REVOKED` before its engine starts.
 *  A person clicks the card's Retry; so does this, at most three times, and
 *  every retry is recorded as an incident so the frequency stays visible. */
const incidents: string[] = [];
async function retryIfRevoked(_page: Page, name: string) {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const state = ((await api("/api/bots?messages=1")).bots as any[]).find((b) => b.name === name);
    const last = state?.messages?.at(-1);
    if (state && !state.busy && last?.kind === "activity" && String(last?.tool?.name ?? "").includes("MEMORY_CONTEXT_REVOKED")) {
      const description = `${name}: turn ended with ${last.tool.name} before the engine started`;
      incidents.push(description);
      test.info().annotations.push({ type: "harness-incident", description });
      throw new Error(`REGRESSION (RED2C/RED2E): ${description}`);
    }
    if (state?.busy) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
const transcript = (page: Page) => page.locator("main");
async function shot(page: Page, name: string, options: { fullPage?: boolean; clip?: Locator } = {}) {
  const path = join(EVIDENCE, `${name}.png`);
  if (options.clip) await options.clip.screenshot({ path }); else await page.screenshot({ path, fullPage: options.fullPage ?? false });
  return path;
}
async function openSettings(page: Page, section: string) {
  await page.getByRole("button", { name: "App settings", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const entry = dialog.getByRole("navigation").getByRole("button", { name: section, exact: true });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
  return dialog;
}
async function closeSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
/** Whether the fake engine holds a prompt carrying `marker` at its gate. */
const cliHolds = (marker: string) => { try { return String(JSON.parse(readFileSync(dumpPath(), "utf8")).prompt?.message?.content ?? "").includes(marker); } catch { return false; } };
/** Sends a turn to a `slow` bot from the composer and waits until the engine
 *  holds it (prompt read, reply gated). */
async function holdTurn(page: Page, who: Bot, text: string, ready: () => boolean) {
  rmSync(replyGate(), { force: true });
  rmSync(dumpPath(), { force: true });
  await say(page, who.name, text);
  await expect.poll(ready, { timeout: 30_000, message: `the fake engine never reached the gate for ${JSON.stringify(text)}; log ${logPath}` }).toBe(true);
}
async function releaseTurn(who: Bot) {
  writeFileSync(replyGate(), "go");
  try { await expect.poll(() => busy(who), { timeout: 40_000 }).toBe(false); } finally { rmSync(replyGate(), { force: true }); }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (!LOCAL_SERVER) ({ server: llama } = await fakeLlamaServer());
  await startHarness();
  try {
    vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(DATA_DIR, "vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } },
      plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: UI_PORT, strictPort: true, watch: null, hmr: false, proxy: { "/api": { target: HARNESS_URL } } } });
    await vite.listen();
    const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw new Error("the app did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await stopHarness(); throw error; }
});
test.afterAll(async () => {
  try { await vite?.close(); } finally {
    try { await stopHarness(); } finally { if (llama) await new Promise<void>((r) => llama!.close(() => r())); }
  }
});


// ── Round 2 shared bits ──────────────────────────────────────────────────

const questionCard = (page: Page) => page.getByRole("region", { name: /^Question from / }).last();
const filesDialog = (page: Page) => page.getByRole("dialog", { name: "Files", exact: true });
const pane = (page: Page) => page.getByTestId("workspace-pane");
const sourceBox = (page: Page) => page.getByRole("textbox", { name: "Markdown source" });
const lightbox = (page: Page) => page.getByTestId("image-lightbox");
async function openConnectedApps(page: Page) {
  const sidebar = await openSidebar(page);
  const entry = sidebar.getByRole("button", { name: /Connected apps/ }).first();
  // The Tools group folds on shorter windows; a person opens it first.
  if (await entry.isVisible()) await entry.click();
  else {
    await sidebar.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByRole("menu", { name: "Tools" }).getByRole("menuitem", { name: "Connected apps", exact: true }).click();
  }
  const panel = page.getByRole("dialog", { name: "Plugins" });
  await expect(panel).toBeVisible();
  return panel;
}
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = (g + x) % 256; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function wav(seconds: number, hz: number): Buffer {
  const rate = 8000, samples = rate * seconds, data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * index) / rate) * 6000), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const external: string[] = [];

// ═════════════════════════════════════════════════════════════════════════
// 5. Connected apps locked state (CTA1) — first, while no key exists
// ═════════════════════════════════════════════════════════════════════════

test("05 CTA1: no key → dimmed app grid behind 'Connect 500+ apps', 'Add FluxRouter key' lands on the key field, no catalog request", async ({ page }) => {
  const catalog: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/connectors/catalog") || /composio|logo\.clearbit|favicon/i.test(url.hostname + url.pathname)) catalog.push(r.method() + " " + url.href);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") external.push(url.href);
  });
  for (const skin of ["light", "dark"] as const) {
    await openApp(page, { width: 1100, height: 800, skin });
    const panel = await openConnectedApps(page);
    await expect(panel.getByText("Connect 500+ apps", { exact: true })).toBeVisible({ timeout: 20_000 });
    const lock = panel.locator("[data-connected-apps-lock]");
    const showcase = lock.locator('[aria-hidden="true"]').first();
    await expect(showcase).toBeVisible();
    const look = await showcase.evaluate((el) => { const cs = getComputedStyle(el); return { opacity: Number(cs.opacity), filter: cs.filter, pointer: cs.pointerEvents, inert: (el as HTMLElement).inert, tiles: el.querySelectorAll(".grid > div").length }; });
    note(`${skin}: showcase opacity ${look.opacity}, filter ${look.filter}, pointer-events ${look.pointer}, inert ${look.inert}, ${look.tiles} app tiles`);
    expect(look.opacity).toBeLessThan(0.6);
    expect(look.filter).toContain("blur");
    expect(look.pointer).toBe("none");
    expect(look.tiles).toBeGreaterThanOrEqual(4);
    await expect(panel.getByRole("button", { name: "Add FluxRouter key", exact: true })).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Search apps" })).toHaveCount(0);
    await shot(page, `05a-connected-apps-locked-${skin}`);
    if (skin === "light") {
      await panel.getByRole("button", { name: "Add FluxRouter key", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
      await expect(page.getByLabel("Flux Router key", { exact: true })).toBeFocused();
      await shot(page, "05b-add-fluxrouter-key-lands-on-field");
      await closeSettings(page);
    } else {
      // Close the panel the way a person does before narrowing the window.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Plugins" })).toHaveCount(0);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await openConnectedApps(page);
  await expect(narrow.getByText("Connect 500+ apps", { exact: true })).toBeVisible();
  await shot(page, "05c-connected-apps-locked-390");
  note(`catalog/logo requests while locked: ${JSON.stringify(catalog)}`);
  expect(catalog).toEqual([]);
});

// ═════════════════════════════════════════════════════════════════════════
// 7. Regression sweep (fast) — before the FluxRouter key is added
// ═════════════════════════════════════════════════════════════════════════

test("07 regression sweep: create bot, fake turn, Claude question card, pane Markdown save, chat image lightbox, Local models, Composio CTA, narrow Stop", async ({ page }) => {
  await openApp(page);
  const sidebar = await openSidebar(page);
  const before = ((await api("/api/bots?messages=0")).bots as Bot[]).length;
  await sidebar.getByRole("button", { name: "New or share", exact: true }).click();
  await page.getByRole("button", { name: "Blank Bot", exact: true }).click();
  await expect.poll(async () => ((await api("/api/bots?messages=0")).bots as Bot[]).length).toBe(before + 1);
  const created = ((await api("/api/bots?messages=0")).bots as Array<Bot & { createdAt: number }>).sort((a, b) => b.createdAt - a.createdAt)[0]!;
  const bot: Bot = { id: created.id, threadId: created.threadId, name: created.name };
  await expect(composer(page, bot.name)).toBeVisible();
  await settleIntake(page, bot.name);
  const picker = page.getByRole("dialog", { name: "Choose model", exact: true });
  await page.locator('[data-chat-header] button[aria-haspopup="dialog"]').first().click();
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox", { name: "Engine", exact: true }).selectOption({ label: "Fixture Claude" });
  await picker.getByRole("button", { name: /^Claude Sonnet 5 / }).click();
  await expect(picker).toHaveCount(0);
  await say(page, bot.name, "Hello from smoke round two.");
  await expect(transcript(page).getByText("hello from fake claude", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  await shot(page, "07a-sweep-bot-created-fake-turn");

  // A Claude-driver question card, answered on screen.
  await say(page, bot.name, "Ask me first. __fixture_ask_user_question__");
  const card = questionCard(page);
  await expect(card.getByRole("button", { name: "Send answer", exact: true })).toBeVisible({ timeout: 30_000 });
  await card.getByRole("radio", { name: /^Summary/ }).click();
  await card.getByRole("checkbox", { name: /^Findings/ }).click();
  await card.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(transcript(page).getByText(/AskUserQuestion result:.*Summary/).last()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  await shot(page, "07b-sweep-claude-question-answered");

  // The bot writes a Markdown report; Open here; edit; Save.
  await say(page, bot.name, "Write the sweep report. __fixture_write_output__:outputs/sweep-report.md");
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  const reportCard = page.locator("main [data-artifact-id]").filter({ hasText: "sweep-report.md" }).first();
  await expect(reportCard).toBeVisible({ timeout: 30_000 });
  await reportCard.getByRole("button", { name: "Open the working file outputs/sweep-report.md here" }).click();
  await expect(pane(page)).toBeVisible();
  await page.getByTestId("workspace-document-edit").click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const edited = "# Weekly report\n\nEdited in the pane during smoke round 2.\n";
  await sourceBox(page).fill(edited);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
  expect(readFileSync(join(await workspaceOf(bot), "outputs", "sweep-report.md"), "utf8")).toBe(edited);
  await shot(page, "07c-sweep-pane-markdown-saved");

  // A chat image opens the lightbox.
  await page.locator('input[type="file"]').setInputFiles([{ name: "sweep.png", mimeType: "image/png", buffer: png(64, 48, [30, 140, 220]) }]);
  await say(page, bot.name, "A picture for the sweep.");
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  const attached = page.locator("main").getByRole("button", { name: /^Preview attached image / }).last();
  await expect(attached).toBeVisible({ timeout: 30_000 });
  await attached.click();
  await expect(lightbox(page)).toBeVisible();
  await shot(page, "07d-sweep-chat-image-lightbox");
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).toHaveCount(0);

  // Settings → Models: Local models.
  const models = await openSettings(page, "Models");
  const local = models.locator("#local-models");
  await local.scrollIntoViewIfNeeded();
  await expect(local.getByRole("heading", { name: "Local models", exact: true })).toBeVisible();
  await shot(page, "07e-sweep-local-models-section", { clip: local });
  await closeSettings(page);

  // Composio CTA with no key.
  const panel = await openConnectedApps(page);
  await expect(panel.getByText("Connect 500+ apps", { exact: true })).toBeVisible({ timeout: 20_000 });
  await shot(page, "07f-sweep-composio-cta-no-key");
  await page.keyboard.press("Escape");

  // Narrow header keeps Stop visible during a turn. Close the workspace pane
  // first, as a person would: at phone width it covers the chat.
  if (await pane(page).isVisible()) {
    await page.getByRole("button", { name: "Close workspace pane", exact: true }).click();
    await expect(pane(page)).toBeHidden();
  }
  await say(page, bot.name, "Hold this one. __fixture_hold_authority__");
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const header = page.locator("[data-chat-header]");
  await expect(header.getByRole("button", { name: "Stop this turn" })).toBeVisible();
  await expect(pane(page)).toBeHidden();
  const stop = header.getByRole("button", { name: "Stop this turn" });
  const box = await stop.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  // Visible is not enough: nothing may sit on top of it.
  const onTop = await stop.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(hit && (hit === el || el.contains(hit))); });
  expect(onTop, "Stop is covered at 390px").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await shot(page, "07g-sweep-narrow-header-stop");
  await header.getByRole("button", { name: "Stop this turn" }).click();
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
});

// ═════════════════════════════════════════════════════════════════════════
// 6. Question card polish (QCARD1)
// ═════════════════════════════════════════════════════════════════════════

test("06 QCARD1: single + multi-select card: padded groups, gapped rounded rows, accent-tinted selection, in-card Answered footer (light 1024, dark 390)", async ({ page }) => {
  const asker = await makeBot("Question polish bot", "verification");
  for (const [skin, width] of [["light", 1024], ["dark", 390]] as const) {
    await openApp(page, { width, height: 900, skin });
    await selectBot(page, asker);
    await say(page, asker.name, `Ask me (${skin}). __fixture_ask_user_question__`);
    const card = questionCard(page);
    await expect(card.getByRole("button", { name: "Send answer", exact: true })).toBeVisible({ timeout: 30_000 });
    await card.getByRole("radio", { name: /^Detailed/ }).click();
    await card.getByRole("checkbox", { name: /^Intro/ }).click();
    await card.getByRole("checkbox", { name: /^Outro/ }).click();
    await card.scrollIntoViewIfNeeded();
    await shot(page, `06a-question-card-picked-${skin}-${width}`, { clip: card });
    const metrics = await card.evaluate((section) => {
      const px = (v: string) => Math.round(parseFloat(v));
      const groups = [...section.querySelectorAll('[role="radiogroup"],[role="group"]')] as HTMLElement[];
      const g = groups.map((el) => { const cs = getComputedStyle(el); return { padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px), radius: px(cs.borderTopLeftRadius), border: px(cs.borderTopWidth) }; });
      const betweenGroups = groups.length > 1 ? Math.round(groups[1]!.getBoundingClientRect().top - groups[0]!.getBoundingClientRect().bottom) : -1;
      const rows = [...section.querySelectorAll('[role="radio"],[role="checkbox"]')] as HTMLElement[];
      const r = rows.map((el) => { const cs = getComputedStyle(el); return { label: el.innerText.split("\n")[0], checked: el.getAttribute("aria-checked") === "true", radius: px(cs.borderTopLeftRadius), padding: [cs.paddingTop, cs.paddingLeft].map(px), bg: cs.backgroundColor, border: cs.borderTopColor }; });
      const first = rows[0]!.getBoundingClientRect(), second = rows[1]!.getBoundingClientRect();
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
      return { groups: g, betweenGroups, rowGap: Math.round(second.top - first.bottom), rows: r, accent, card: section.getBoundingClientRect().toJSON() };
    });
    note(`${skin} ${width}px metrics: ${JSON.stringify(metrics)}`);
    for (const group of metrics.groups) { expect(group.padding).toEqual([16, 16, 16, 16]); expect(group.radius).toBeGreaterThanOrEqual(10); }
    expect(metrics.betweenGroups).toBeGreaterThanOrEqual(12);
    expect(metrics.rowGap).toBeGreaterThanOrEqual(8);
    for (const row of metrics.rows) { expect(row.radius).toBe(10); expect(row.padding[0]).toBeGreaterThanOrEqual(12); }
    const picked = metrics.rows.filter((row) => row.checked), plain = metrics.rows.filter((row) => !row.checked);
    expect(picked.map((row) => row.label)).toEqual(["Detailed", "Intro", "Outro"]);
    // Accent-tinted, not a solid gray block: a translucent tint (alpha < 0.35) whose
    // border differs from an unselected row's hairline.
    for (const row of picked) {
      // Chromium serialises the tint as rgba(), color(srgb …), oklch() or oklab().
      const alpha = /rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)|okl(?:ch|ab)\(([^)]+)\)/.exec(row.bg);
      note(`${skin} selected row ${row.label}: bg ${row.bg}, border ${row.border}`);
      expect(row.bg).not.toBe(plain[0]!.bg);
      expect(row.border).not.toBe(plain[0]!.border);
      expect(alpha, row.bg).not.toBeNull();
      const parts = (alpha![1] ?? alpha![2] ?? alpha![3] ?? "").split(/[ ,/]+/).filter(Boolean);
      expect(Number(parts.at(-1))).toBeLessThan(0.35);
    }
    await card.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect(transcript(page).getByText(/AskUserQuestion result:.*Detailed/).last()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => busy(asker), { timeout: 30_000 }).toBe(false);
    const answered = page.locator('section[data-question-state="answered"]').last();
    await expect(answered).toContainText("Answered");
    const inside = await answered.evaluate((section) => {
      const footer = [...section.querySelectorAll("div")].find((d) => d.innerText.trim().startsWith("Answered"))!;
      const s = section.getBoundingClientRect(), f = footer.getBoundingClientRect();
      return { inside: f.top >= s.top && f.bottom <= s.bottom, footerText: footer.innerText.trim(), borderTop: getComputedStyle(footer).borderTopWidth };
    });
    note(`${skin} answered footer: ${JSON.stringify(inside)}`);
    expect(inside.inside).toBe(true);
    await answered.scrollIntoViewIfNeeded();
    await shot(page, `06b-question-card-answered-${skin}-${width}`, { clip: answered });
    // The picked rows stay visible as selected once answered.
    await expect(answered.getByRole("radio", { name: /^Detailed/ })).toHaveAttribute("aria-checked", "true");
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Inline previews (INLINE1 + RED2C widened kinds)
// ═════════════════════════════════════════════════════════════════════════

test("01 INLINE1: saved-file cards show image, audio, video, bounded Markdown with Show more + Open here, sandboxed HTML, .py/.ts code, PDF buttons", async ({ page }) => {
  const downloads: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (/\/api\/artifacts\/[^/]+\/download$/.test(u.pathname)) downloads.push(u.pathname); });
  const bot = await makeBot("Inline previews bot", "slow");
  await openApp(page);
  await selectBot(page, bot);
  await holdTurn(page, bot, "Warm up.", () => cliHolds("Warm up."));
  await releaseTurn(bot);
  const workspace = await workspaceOf(bot);
  await holdTurn(page, bot, "Make every kind of file. __fixture_inline_smoke__", () => cliHolds("__fixture_inline_smoke__"));
  const out = join(workspace, "outputs"); mkdirSync(out, { recursive: true });
  const report = ["# Quarterly report", "", "SMOKE2_HEAD_SENTENCE: the findings follow.", "", ...Array.from({ length: 120 }, (_, i) => `- Finding ${i + 1}: ${"detail ".repeat(8)}`), "", "SMOKE2_TAIL_SENTENCE: only reachable after Show more.", ""].join("\n");
  writeFileSync(join(out, "chart.png"), png(600, 400, [200, 60, 160]));
  writeFileSync(join(out, "narration.wav"), wav(2, 440));
  const haveMp4 = Boolean(MP4_FIXTURE && existsSync(MP4_FIXTURE));
  if (haveMp4) writeFileSync(join(out, "clip.mp4"), readFileSync(MP4_FIXTURE)); else pending("MURAGE_SMOKE_MP4 naming a small MP4 for the video card");
  writeFileSync(join(out, "quarterly-report.md"), report);
  writeFileSync(join(out, "nightly.html"), "<!doctype html><style>body{font:18px system-ui;padding:20px;color:#173047;background:#fff}</style><h1>Nightly report</h1><p>SMOKE2_HTML_RESULT rendered inside the card.</p><script>document.body.append('SCRIPT_RAN')</script>");
  writeFileSync(join(out, "tool.py"), "import json\n\ndef main():\n    print(json.dumps({'smoke': 'SMOKE2_PY_VALUE'}))\n\nmain()\n");
  writeFileSync(join(out, "util.ts"), "export const smoke = \"SMOKE2_TS_VALUE\";\nexport function twice(n: number): number {\n  return n * 2;\n}\n");
  writeFileSync(join(out, "deck.pdf"), Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"));
  await releaseTurn(bot);
  const cards = page.locator("main [data-artifact-id]");
  await expect(cards).toHaveCount(haveMp4 ? 8 : 7, { timeout: 40_000 });
  await expect(page.locator('main [data-artifact-inline="loading"]')).toHaveCount(0, { timeout: 30_000 });
  const cardFor = (name: string) => cards.filter({ hasText: name }).first();
  note(`card texts: ${JSON.stringify((await cards.allInnerTexts()).map((t) => t.split("\n").slice(0, 2).join(" | ")))}`);
  await shot(page, "01a-inline-cards-overview", { fullPage: true });

  // Image: in the card; click opens the lightbox in place.
  const image = cardFor("chart.png");
  await image.scrollIntoViewIfNeeded();
  await expect(image.locator('[data-artifact-inline="image"] img')).toBeVisible();
  await expect.poll(() => image.locator('[data-artifact-inline="image"] img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(600);
  await shot(page, "01b-inline-image-card", { clip: image });
  const url = page.url();
  await image.getByRole("button", { name: /^Enlarge image / }).click();
  await expect(lightbox(page)).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(filesDialog(page)).toHaveCount(0);
  await shot(page, "01c-inline-image-lightbox-in-place");
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).toHaveCount(0);

  // Audio and video: players, nothing plays on its own.
  const audio = cardFor("narration.wav");
  await audio.scrollIntoViewIfNeeded();
  await expect(audio.locator("[data-media-player=audio]")).toBeVisible();
  await expect(audio.locator("audio")).toHaveJSProperty("autoplay", false);
  await page.waitForTimeout(1500);
  await expect(audio.locator("audio")).toHaveJSProperty("paused", true);
  await shot(page, "01d-inline-audio-player", { clip: audio });
  if (haveMp4) {
    const video = cardFor("clip.mp4");
    await video.scrollIntoViewIfNeeded();
    await expect(video.locator("[data-media-player=video]")).toBeVisible();
    await expect(video.locator("video")).toHaveJSProperty("autoplay", false);
    await expect(video.locator("video")).toHaveJSProperty("paused", true);
    await shot(page, "01e-inline-video-player", { clip: video });
  }

  // Markdown: bounded, Show more, Open here.
  const md = cardFor("quarterly-report.md");
  await md.scrollIntoViewIfNeeded();
  const inline = md.locator('[data-artifact-inline="markdown"]');
  await expect(inline).toContainText("SMOKE2_HEAD_SENTENCE");
  await expect(inline).not.toContainText("SMOKE2_TAIL_SENTENCE");
  const collapsedHeight = (await inline.boundingBox())!.height;
  note(`markdown collapsed height ${collapsedHeight}px`);
  await inline.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "01f-inline-markdown-bounded");
  await md.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(inline).toContainText("SMOKE2_TAIL_SENTENCE");
  await inline.getByText(/SMOKE2_TAIL_SENTENCE/).scrollIntoViewIfNeeded();
  await shot(page, "01g-inline-markdown-show-more");
  await expect(filesDialog(page)).toHaveCount(0);
  await md.getByRole("button", { name: "Open the working file outputs/quarterly-report.md here" }).click();
  await expect(pane(page)).toBeVisible();
  await expect(page.getByTestId("workspace-markdown-preview")).toContainText("SMOKE2_HEAD_SENTENCE");
  await shot(page, "01h-inline-markdown-open-here-pane");

  // HTML: a sandboxed frame; its script does not run.
  const html = cardFor("nightly.html");
  await html.scrollIntoViewIfNeeded();
  await expect(html.locator("iframe")).toHaveAttribute("sandbox", "");
  await expect(html.frameLocator("iframe").getByText("SMOKE2_HTML_RESULT rendered inside the card.")).toBeVisible();
  await expect(html.frameLocator("iframe").getByText("SCRIPT_RAN")).toHaveCount(0);
  await shot(page, "01i-inline-html-sandboxed-frame", { clip: html });

  // .py / .ts: bounded code previews.
  for (const [name, value, file] of [["tool.py", "SMOKE2_PY_VALUE", "01j-inline-code-py"], ["util.ts", "SMOKE2_TS_VALUE", "01k-inline-code-ts"]] as const) {
    const code = cardFor(name);
    await code.scrollIntoViewIfNeeded();
    await expect(code.locator('[data-artifact-inline="code"] pre')).toContainText(value);
    await shot(page, file, { clip: code });
  }

  // PDF: today's buttons, no inline preview.
  const pdf = cardFor("deck.pdf");
  await pdf.scrollIntoViewIfNeeded();
  await expect(pdf.locator("[data-artifact-inline]")).toHaveCount(0);
  await expect(pdf.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await shot(page, "01l-inline-pdf-buttons", { clip: pdf });

  // Never bounces to Files for these kinds: no card offers a Preview button
  // (the open workspace pane's own Preview/Edit toggle is not a card action).
  await expect(cards.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  await expect(cards.getByRole("button", { name: /^Open the working file .+ here$/ })).toHaveCount(haveMp4 ? 8 : 7);
  await expect(filesDialog(page)).toHaveCount(0);
  expect(downloads).toEqual([]);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Revoked-context turn (RED2C)
// ═════════════════════════════════════════════════════════════════════════

test("04 RED2C: a turn whose own memory capture rolls the thread checkpoint is not cancelled; the owner saves a workspace file right after (no 423)", async ({ page }) => {
  const gate = join(DATA_DIR, "pi-session-gate");
  const engines = (await api("/api/instances")).instances as any[];
  const models = engines.find((engine) => engine.instanceId === "piGate").models.options as Array<{ id: string }>;
  const bot = await makeBot("Checkpoint roll bot", "piGate", models[0]!.id);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  const saves: Array<{ url: string; status: number }> = [];
  page.on("response", (r) => { if (["PUT", "POST", "PATCH"].includes(r.request().method()) && /workspace|artifacts/.test(r.url())) saves.push({ url: new URL(r.url()).pathname, status: r.status() }); });
  try {
    const checkpoint = () => db.prepare("SELECT r.id,r.version,r.state FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.kind='conversation' AND s.owner_key=? ORDER BY r.version DESC LIMIT 1").get(bot.threadId) as { id: string; version: number; state: string } | undefined;
    const pendingJobs = () => Number((db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status NOT IN ('complete','cancelled','failed')").get() as { n: number }).n);
    note(`memory mode: ${(await api("/api/memory/status")).mode}`);
    await openApp(page);
    await selectBot(page, bot);

    writeFileSync(gate, "");
    await say(page, bot.name, "First turn: remember that the smoke round is two.");
    await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
    await expect.poll(() => checkpoint()?.state, { timeout: 30_000 }).toBe("active");
    await expect.poll(() => pendingJobs(), { timeout: 30_000 }).toBe(0);
    const selected = checkpoint()!;
    await shot(page, "04a-revoked-context-first-turn");

    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    const workspace = await workspaceOf(bot);
    await say(page, bot.name, "Second turn: this one's own capture rolls the checkpoint.");
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => checkpoint()?.version, { timeout: 30_000 }).toBeGreaterThan(selected.version);
    const archived = db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(selected.id, selected.version) as { state: string };
    note(`checkpoint ${selected.id} v${selected.version} → ${archived.state}; now v${checkpoint()!.version} (turn held at the engine handshake)`);
    expect(archived.state).toBe("archived");
    // The engine's shell writes a note during the held turn (fixture stand-in).
    mkdirSync(join(workspace, "outputs"), { recursive: true });
    writeFileSync(join(workspace, "outputs", "roll-notes.md"), "# Roll notes\n\nWritten during the held turn.\n");
    await shot(page, "04b-revoked-context-turn-held");
    writeFileSync(gate, "");
    await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
    const log = transcript(page);
    await expect(log.getByText(/MEMORY_CONTEXT_REVOKED/)).toHaveCount(0);
    const texts = ((await api(`/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[]);
    const revoked = texts.filter((m) => String(m.tool?.name ?? "").includes("MEMORY_CONTEXT_REVOKED") || /cancel/i.test(String(m.tool?.name ?? "")));
    const replies = texts.filter((m) => m.role === "bot" && m.kind === "text" && m.text);
    note(`bot replies: ${JSON.stringify(replies.map((m) => String(m.text).slice(0, 80)))}; revoked/cancel activity: ${JSON.stringify(revoked.map((m) => m.tool?.name))}`);
    expect(revoked).toEqual([]);
    expect(replies.length).toBeGreaterThanOrEqual(2);
    await shot(page, "04c-revoked-context-second-turn-replied");

    // The owner saves a workspace file straight away.
    const card = page.locator("main [data-artifact-id]").filter({ hasText: "roll-notes.md" }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: "Open the working file outputs/roll-notes.md here" }).click();
    await expect(pane(page)).toBeVisible();
    await page.getByTestId("workspace-document-edit").click();
    await page.getByRole("button", { name: "Source", exact: true }).click();
    const mine = "# Roll notes\n\nSaved by the owner right after the checkpoint-roll turn.\n";
    await sourceBox(page).fill(mine);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
    expect(readFileSync(join(workspace, "outputs", "roll-notes.md"), "utf8")).toBe(mine);
    note(`write responses: ${JSON.stringify(saves)}`);
    expect(saves.filter((s) => s.status === 423)).toEqual([]);
    await shot(page, "04d-revoked-context-owner-save-no-423");
  } finally { writeFileSync(gate, ""); db.close(); }
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Fuigo bundle (LFU2) — last: it adds the FluxRouter key
// ═════════════════════════════════════════════════════════════════════════

test("02 LFU2: Settings → Engines shows the pinned Fuigo; a Fuigo bot completes a real FluxRouter turn and answers a real question card", async ({ page }) => {
  test.setTimeout(600_000);
  if (!FUIGO_DIR) pending("MURAGE_SMOKE_FUIGO_DIR naming the staged bundle");
  const haveKey = Boolean(FLUX_KEY_FILE && existsSync(FLUX_KEY_FILE));
  if (!haveKey) pending("MURAGE_SMOKE_FLUX_KEY_FILE naming a FluxRouter key");
  await openApp(page);
  const settings = await openSettings(page, "Engines");
  const fuigo = settings.locator("section").filter({ hasText: /^Fuigo/ }).first();
  await fuigo.scrollIntoViewIfNeeded();
  await expect(fuigo).toContainText(/Selected source: \w+ · Installed: [\d.]+/, { timeout: 120_000 });
  const line = (await fuigo.innerText()).match(/Selected source: .*?(?=\n|$)/)?.[0] ?? "";
  note(`Engines line: ${line}; pinned in scripts/prepare-fuigo.mjs: ${EXPECTED_FUIGO}`);
  expect(line).toContain(`Installed: ${EXPECTED_FUIGO}`);
  expect(line).toContain("Selected source: bundled");
  await shot(page, "02a-engines-fuigo-pinned-version", { clip: fuigo });
  await closeSettings(page);
  if (!haveKey) return;

  const panel = await openConnectedApps(page);
  await panel.getByRole("button", { name: "Add FluxRouter key", exact: true }).click();
  const field = page.getByLabel("Flux Router key", { exact: true });
  await expect(field).toBeFocused();
  await field.fill(readFileSync(FLUX_KEY_FILE, "utf8").trim());
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Test connection", exact: true })).toBeVisible({ timeout: 60_000 });
  await closeSettings(page);

  const bot = await makeBot("Fuigo smoke bot", "");
  await selectBot(page, bot);
  const headerText = await page.locator("[data-chat-header]").innerText();
  note(`Fuigo bot header: ${headerText.replace(/\n/g, " | ").slice(0, 200)}`);
  await say(page, bot.name, "Reply with exactly the single word: pong");
  await expect.poll(() => busy(bot), { timeout: 180_000 }).toBe(false);
  const replyBubble = transcript(page).getByText(/^pong\.?$/i).or(transcript(page).getByText(/"sourceId"/)).last();
  await expect(replyBubble).toBeVisible({ timeout: 30_000 });
  const pongText = (await replyBubble.innerText()).trim();
  note(`Fuigo (Flux Auto) reply bubble to "Reply with exactly the single word: pong": ${JSON.stringify(pongText)}`);
  if (/sourceId/.test(pongText)) test.info().annotations.push({ type: "defect", description: `the reply bubble shows a raw memory evidence locator instead of the answer: ${pongText}` });
  await shot(page, "02b-fuigo-flux-turn-pong");
  expect.soft(pongText, "the Fuigo reply should be the word pong").toMatch(/^pong\.?$/i);

  await say(page, bot.name, "Before doing anything else you must call your ask_user_question tool exactly once with two questions: (1) \"Which database?\" single-select with options \"Postgres\" and \"SQLite\"; (2) \"Which features?\" multi-select with options \"Auth\", \"Search\" and \"Billing\". Wait for my answers. Then reply with one line of the form: DB=<my database choice>; FEATURES=<my feature choices comma separated>. Do not use any other tool.");
  const card = questionCard(page);
  const deadline = Date.now() + 180_000;
  const permissions: string[] = [];
  for (;;) {
    if (await card.getByRole("button", { name: "Send answer", exact: true }).isVisible().catch(() => false)) break;
    const allow = page.locator("main").getByRole("button", { name: /^(Yes|Allow once|Allow)$/ }).last();
    if (await allow.isVisible().catch(() => false)) { permissions.push(await allow.innerText()); await allow.click(); }
    if (!(await busy(bot))) throw new Error(`the Fuigo turn ended without a question card; transcript tail: ${(await transcript(page).innerText()).slice(-600)}`);
    if (Date.now() > deadline) throw new Error("no question card within 180 s");
    await page.waitForTimeout(500);
  }
  note(`permission cards allowed before the question: ${JSON.stringify(permissions)}`);
  await expect(card).toContainText("Which database?");
  await expect(card).toContainText("Which features?");
  await shot(page, "02c-fuigo-question-card", { clip: card });
  await card.getByRole("radio", { name: /^SQLite/ }).click();
  await card.getByRole("checkbox", { name: /^Auth/ }).click();
  await card.getByRole("checkbox", { name: /^Billing/ }).click();
  await card.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect.poll(() => busy(bot), { timeout: 180_000 }).toBe(false);
  const reply = transcript(page).getByText(/DB=\s*SQLite/i).last();
  await expect(reply).toBeVisible({ timeout: 30_000 });
  const replyText = await reply.innerText();
  note(`Fuigo reply after the answer: ${replyText.slice(0, 200)}`);
  expect(replyText).toMatch(/Auth/);
  expect(replyText).toMatch(/Billing/);
  await expect(page.locator('section[data-question-state="answered"]').last()).toBeVisible();
  await shot(page, "02d-fuigo-question-answered-reply");
});
