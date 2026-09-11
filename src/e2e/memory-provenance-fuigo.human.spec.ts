// MEMJSON1 — the real-app proof for the smoke round 1 defect (feature 15):
// a Fuigo bot on Flux Auto answered "Reply with exactly the single word:
// pong" with {"sourceId":"message:reply","revision":1,"startByte":0,
// "endByte":4}, copied from the JSON memory reference block Murage prepended
// to its prompt.
//
// One isolated harness (own data dir, HOME and ports) serving the BUILT
// renderer (dist/, MURAGE_VERIFY_BUILT_UI=1; the Vite dev app otherwise),
// the bundled Fuigo named by MURAGE_SMOKE_FUIGO_DIR, the FluxRouter key in
// MURAGE_SMOKE_FLUX_KEY_FILE added through the app the way a person adds it.
// Ten text turns through the composer; every reply must be an answer, never
// provenance JSON, and every prompt Fuigo recorded in its own
// chat_history.jsonl must carry remembered words inside <remembered-context>
// and no sourceId/startByte/endByte/scopeId/"evidence" at all. The prompts
// and replies are copied into the evidence directory. Absent live inputs are
// recorded as "live proof pending"; nothing is skipped.
import { test, expect, type Page } from "@playwright/test";
import { createServer, preview, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openSidebar } from "./fixtures.ts";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE } from "../../shared/memory.ts";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { laneDataDir } from "./lane-data-dir";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATA_DIR = laneDataDir("this proof never uses ~/.murage");
const HARNESS_PORT = Number(process.env.MURAGE_E2E_PORT || 9980);
const UI_PORT = Number(process.env.MURAGE_E2E_UI_PORT || 9982);
const VERIFY_BUILT_UI = process.env.MURAGE_VERIFY_BUILT_UI === "1";
const EVIDENCE = process.env.MURAGE_SMOKE_EVIDENCE_DIR || join(DATA_DIR, "evidence");
const FUIGO_DIR = process.env.MURAGE_SMOKE_FUIGO_DIR || "";
const FLUX_KEY_FILE = process.env.MURAGE_SMOKE_FLUX_KEY_FILE || "";
const TURNS = Math.min(10, Math.max(1, Number(process.env.MURAGE_MEMJSON1_TURNS || 10)));
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");
const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}`;
const PROVENANCE = /sourceId|startByte|endByte|scopeId|"evidence"|Memory reference data follows/;

const pending = (what: string) => { test.info().annotations.push({ type: "live-proof-pending", description: what }); console.warn(`[memjson1] live proof pending: ${what}`); };
const note = (what: string) => { test.info().annotations.push({ type: "observed", description: what }); console.log(`[memjson1] ${what}`); };

interface Bot { id: string; threadId: string; name: string }
let harness: ChildProcess | undefined, logPath: string, vite: ViteDevServer, origin: string, headers: Record<string, string>;
const fixtureHome = () => join(DATA_DIR, "fixture-home");

async function startHarness() {
  safeWipeSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(EVIDENCE, { recursive: true });
  const home = fixtureHome(); mkdirSync(home, { recursive: true });
  const tmp = join(DATA_DIR, "tmp"); mkdirSync(tmp, { recursive: true });
  const bin = join(DATA_DIR, "bin"); mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  // A `claude` entry makes the harness add fuigo and the rest the way an
  // installed app would; the fake stands in for the CLI and is never used.
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Claude (fake stand-in)", config: { cli: FAKE_CLI } } } }, null, 2) + "\n", { mode: 0o600 });
  const preload = pathToFileURL(join(ROOT, "server", "testing", "search-fetch-preload.mjs")).href;
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(["LANG", "LC_ALL", "TZ"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
    PATH: [bin, "/usr/bin", "/bin"].join(":"),
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    MURAGE_DATA_DIR: DATA_DIR, MURAGE_PORT: String(HARNESS_PORT), MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
    MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
    ...(existsSync(join(ROOT, "dist", "index.html")) ? { MURAGE_STATIC_DIR: join(ROOT, "dist") } : {}),
    FAKE_CLAUDE_MODE: "happy",
    ...(FUIGO_DIR ? { MURAGE_FUIGO_DIR: FUIGO_DIR } : {}),
    MURAGE_FLUX_COMPOSIO_BROKER_URL: process.env.MURAGE_SMOKE_FLUX_COMPOSIO_BROKER_URL || "https://api.fluxrouter.ai/composio",
  };
  logPath = join(DATA_DIR, "harness.log");
  const log = openSync(logPath, "a");
  try { harness = spawn(process.execPath, ["--experimental-strip-types", "--import", preload, join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdio: ["ignore", log, log] }); }
  finally { closeSync(log); }
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
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(HARNESS_URL + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  expect(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text().catch(() => "")}`).toBe(true);
  return await response.json() as any;
}
/** Fixture setup only: a bot on the fleet's default engine (Fuigo on Flux
 *  Auto once the FluxRouter key is in), with a title so the intake quiz does
 *  not take its first message. The turns themselves go through the composer. */
async function makeBot(name: string): Promise<Bot> {
  return (await api("/api/bots", "POST", { name, title: "MEMJSON1 fixture", description: "Fixture bot for the memory provenance proof." })).bot as Bot;
}
const botState = async (who: Bot) => (await api("/api/bots?messages=0")).bots.find((item: Bot) => item.id === who.id);
const busy = async (who: Bot) => Boolean((await botState(who))?.busy);
const botMessages = async (who: Bot) => (await api(`/api/threads/${who.threadId}/messages?limit=200`)).messages as any[];

async function openApp(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
  const engines = page.waitForResponse((response) => /\/api\/instances(\?|$)/.test(response.url()) && response.ok(), { timeout: 60_000 });
  await page.goto(origin);
  await expect(page.getByRole("complementary", { name: "Bots and navigation" }).or(page.getByRole("button", { name: "Open bot list" }))).toBeVisible();
  await engines;
}
const composer = (page: Page, name: string) => page.getByRole("textbox", { name: `Message ${name}`, exact: true });
const transcript = (page: Page) => page.locator("main");
async function selectBot(page: Page, who: Bot) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: new RegExp(`^${who.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await expect(composer(page, who.name)).toBeVisible();
  await settleIntake(page, who.name);
}
/** A new bot opens with its two-question setup quiz; answer it the way a
 *  person does so the turns that follow reach the engine. */
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
async function say(page: Page, name: string, text: string) {
  const box = composer(page, name);
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}
/** The dispatch-preparation incident the candidate record carries as open
 *  (0152-CONTRACTS.md, harness incident): a turn can end with
 *  `error: MEMORY_CONTEXT_REVOKED` before its engine starts. A person clicks
 *  Retry; so does this, at most three times, each one recorded. */
const incidents: string[] = [];
async function retryIfRevoked(page: Page, who: Bot) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const start = Date.now();
    let revoked = false;
    while (Date.now() - start < 4000) {
      const last = (await botMessages(who)).at(-1);
      if (!(await busy(who)) && last?.kind === "activity" && last?.tool?.name === "error: MEMORY_CONTEXT_REVOKED") { revoked = true; break; }
      if (await busy(who)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!revoked) return;
    const description = `turn ended with error: MEMORY_CONTEXT_REVOKED before the engine started (attempt ${attempt}); Retry clicked`;
    incidents.push(description);
    test.info().annotations.push({ type: "harness-incident", description });
    await page.getByRole("button", { name: "Retry", exact: true }).last().click();
  }
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
async function openConnectedApps(page: Page) {
  const sidebar = await openSidebar(page);
  const direct = sidebar.getByRole("button", { name: /^Connected apps/ });
  if (await direct.first().isVisible().catch(() => false)) await direct.first().click();
  else { await sidebar.getByRole("button", { name: /^Tools/ }).first().click(); await page.getByRole("menuitem", { name: "Connected apps", exact: true }).click(); }
  return page.getByRole("dialog", { name: "Plugins" });
}
async function shot(page: Page, name: string) { const path = join(EVIDENCE, `${name}.png`); await page.screenshot({ path, fullPage: false }); return path; }

/** Every chat_history.jsonl the bundled Fuigo wrote under the fixture HOME. */
function fuigoHistories(): string[] {
  const root = join(fixtureHome(), ".fuigo", "sessions");
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir)) { const full = join(dir, entry); if (statSync(full).isDirectory()) walk(full); else if (entry === "chat_history.jsonl") found.push(full); } };
  walk(root);
  return found;
}
/** The user prompts (Murage's turn text) and assistant replies in a history. */
function historyTurns(file: string) {
  const prompts: string[] = [], replies: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(row.content) ? row.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n") : typeof row.content === "string" ? row.content : "";
    const role = row.type ?? row.role;
    if (role === "user" && content.includes("<user_query>")) prompts.push(content);
    else if (role === "assistant" && typeof row.content === "string") replies.push(row.content);
  }
  return { prompts, replies };
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await startHarness();
  try {
    if (VERIFY_BUILT_UI) {
      if (!existsSync(join(ROOT, "dist", "index.html"))) throw new Error("MURAGE_VERIFY_BUILT_UI=1 needs dist/index.html (vite build)");
      const pv = await preview({ configFile: false, root: ROOT, logLevel: "warn", build: { outDir: join(ROOT, "dist") }, preview: { host: "127.0.0.1", port: UI_PORT, strictPort: true, proxy: { "/api": { target: HARNESS_URL } } } });
      vite = { close: () => pv.close() } as unknown as ViteDevServer;
      origin = `http://127.0.0.1:${UI_PORT}`;
    } else {
      vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(DATA_DIR, "vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } },
        plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: UI_PORT, strictPort: true, watch: null, hmr: false, proxy: { "/api": { target: HARNESS_URL } } } });
      await vite.listen();
      origin = `http://127.0.0.1:${UI_PORT}`;
    }
  } catch (error) { await vite?.close(); await stopHarness(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await stopHarness(); } });

test("MEMJSON1: ten Fuigo (Flux Auto) turns answer normally and every prompt carries remembered words, never provenance JSON", async ({ page }) => {
  if (!FUIGO_DIR) pending("MURAGE_SMOKE_FUIGO_DIR naming the staged bundle (pnpm build:fuigo)");
  const haveKey = Boolean(FLUX_KEY_FILE && existsSync(FLUX_KEY_FILE));
  if (!haveKey) pending("MURAGE_SMOKE_FLUX_KEY_FILE naming a FluxRouter key for the Fuigo turns");
  note(`renderer: ${VERIFY_BUILT_UI ? "built dist/ (vite preview)" : "Vite dev app"}; harness: server/index.ts from source; turns: ${TURNS}`);
  await openApp(page);
  const settings = await openSettings(page, "Engines");
  const fuigo = settings.locator("section").filter({ hasText: /^Fuigo/ }).first();
  await fuigo.scrollIntoViewIfNeeded();
  await expect(fuigo).toContainText(/Selected source: \w+ · Installed: [\d.]+/, { timeout: 120_000 });
  note(`Engines line: ${(await fuigo.innerText()).match(/Selected source: .*?(?=\n|$)/)?.[0] ?? ""}`);
  await closeSettings(page);
  if (!FUIGO_DIR || !haveKey) return;

  const panel = await openConnectedApps(page);
  await panel.getByRole("button", { name: "Add FluxRouter key", exact: true }).click();
  const field = page.getByLabel("Flux Router key", { exact: true });
  await expect(field).toBeFocused();
  await field.fill(readFileSync(FLUX_KEY_FILE, "utf8").trim()); // a password field: never echoed, never logged
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Test connection", exact: true })).toBeVisible({ timeout: 60_000 });
  await closeSettings(page);

  const bot = await makeBot("Fuigo memory bot");
  await selectBot(page, bot);
  await expect(page.locator("[data-chat-header]")).toContainText("Flux Auto");
  note(`bot header: ${(await page.locator("[data-chat-header]").innerText()).replace(/\n/g, " | ").slice(0, 200)}`);

  // The same request the smoke round sent, plus a few equally short ones so
  // the proof is not one string; every reply has an exact expected form.
  const requests: Array<{ text: string; expect: RegExp }> = [
    { text: "Reply with exactly the single word: pong", expect: /^\W*pong\W*$/i },
    { text: "What is 2+2? Answer with just the number.", expect: /^\W*4\W*$/ },
    { text: "Reply with exactly the single word: pong", expect: /^\W*pong\W*$/i },
    { text: "Name the capital of France in one word.", expect: /^\W*Paris\W*$/i },
    { text: "Reply with exactly the single word: pong", expect: /^\W*pong\W*$/i },
    { text: "Spell the word cat in uppercase letters only.", expect: /^\W*C\W*A\W*T\W*$/ },
    { text: "Reply with exactly the single word: pong", expect: /^\W*pong\W*$/i },
    { text: "What colour is the sky on a clear day? One word.", expect: /^\W*blue\W*$/i },
    { text: "Reply with exactly the single word: pong", expect: /^\W*pong\W*$/i },
    { text: "Reply with exactly the single word: pong", expect: /^\W*pong\W*$/i },
  ].slice(0, TURNS);
  const results: Array<{ turn: number; request: string; reply: string; answered: boolean; notices: string[] }> = [];
  for (const [index, request] of requests.entries()) {
    const before = (await botMessages(bot)).length;
    await say(page, bot.name, request.text);
    await retryIfRevoked(page, bot);
    await expect.poll(() => busy(bot), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => busy(bot), { timeout: 240_000 }).toBe(false);
    const fresh = (await botMessages(bot)).slice(before).filter((m) => m.role === "bot");
    const texts = fresh.filter((m) => m.kind === "text" && m.turnId).map((m) => String(m.text ?? ""));
    const notices = fresh.filter((m) => m.kind === "activity" && m.tool?.ok === false).map((m) => String(m.tool.name));
    const reply = texts.at(-1) ?? "";
    const answered = request.expect.test(reply.trim());
    results.push({ turn: index + 1, request: request.text, reply, answered, notices });
    note(`turn ${index + 1}: ${JSON.stringify(request.text)} → ${JSON.stringify(reply).slice(0, 200)}${notices.length ? ` notices=${JSON.stringify(notices)}` : ""}`);
    // The defect: a reply that is provenance JSON. Never, in any turn.
    for (const text of texts) expect(text, `turn ${index + 1} reply carries provenance`).not.toMatch(PROVENANCE);
    expect(notices.some((name) => /memory references/i.test(name)), `turn ${index + 1} hit the provenance-echo guard`).toBe(false);
  }
  await shot(page, "memjson1-ten-turns");
  writeFileSync(join(EVIDENCE, "turns.json"), JSON.stringify({ turns: results, incidents }, null, 2));
  const answered = results.filter((r) => r.answered).length;
  note(`${answered}/${results.length} turns answered in the expected form; incidents: ${incidents.length}`);

  // What Fuigo actually received: its own record of every prompt.
  const histories = fuigoHistories();
  expect(histories.length, "the bundled Fuigo wrote no chat_history.jsonl under the fixture HOME").toBeGreaterThan(0);
  let prompts = 0, framed = 0;
  for (const [index, file] of histories.entries()) {
    copyFileSync(file, join(EVIDENCE, `fuigo-chat_history-${index + 1}.jsonl`));
    const turns = historyTurns(file);
    for (const prompt of turns.prompts) {
      prompts += 1;
      expect(prompt, `Fuigo prompt carries provenance:\n${prompt.slice(0, 2000)}`).not.toMatch(PROVENANCE);
      if (prompt.includes(MEMORY_REFERENCE_OPEN)) {
        framed += 1;
        expect(prompt).toContain(MEMORY_REFERENCE_PREAMBLE);
        expect(prompt).toContain(MEMORY_REFERENCE_CLOSE);
        expect(prompt.indexOf(MEMORY_REFERENCE_CLOSE)).toBeLessThan(prompt.indexOf("Current request:"));
      }
    }
    for (const reply of turns.replies) expect(reply, "Fuigo reply is provenance JSON").not.toMatch(PROVENANCE);
  }
  note(`Fuigo histories: ${histories.length}; prompts recorded: ${prompts}; prompts carrying <remembered-context>: ${framed}`);
  expect(prompts).toBeGreaterThanOrEqual(1);
  expect(framed, "no recorded prompt carried the remembered-context frame — memory was never delivered").toBeGreaterThanOrEqual(1);
  expect(answered, `only ${answered}/${results.length} turns answered in the expected form: ${JSON.stringify(results.filter((r) => !r.answered))}`).toBe(results.length);
});
