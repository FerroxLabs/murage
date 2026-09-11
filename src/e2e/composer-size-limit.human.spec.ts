// COMPOSER4MB: the composer's answer to a message it cannot send.
//
// Smoke round 1 (feature 12a, built app at 19c0a8b9) typed a 4 MB message
// into the chat composer and pressed Enter: the text stayed in the box,
// nothing was sent, and nothing on screen said why. The harness's generic
// 1,000,000-byte JSON body bound answered 413, the store flashed that for six
// seconds as a passing toast, and the draft came back with no explanation.
//
// This spec drives the REAL renderer against a REAL isolated harness
// (server/index.ts with its own data dir, HOME and ports, the fake Claude CLI
// as its engine) the way a person would: select the bot, put the text in the
// box, press Enter, read the screen. It pins:
//   1. a 4 MB typed message is refused with a visible alert that states the
//      size and the limit in human units; the text is still in the box; the
//      textarea points at the alert; nothing reached the harness;
//   2. a pasted wall of text over the limit (a chip, the way a real paste
//      lands) is refused the same way and the chip stays;
//   3. a message exactly at the limit (1 MB) sends, is shown in the
//      transcript, and gets the engine's reply — the old 1,000,000-byte body
//      bound would have refused it.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MESSAGE_TEXT_MAX_BYTES } from "../../shared/message-limits.ts";
import { openSidebar } from "./fixtures.ts";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { laneDataDir } from "./lane-data-dir";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATA_DIR = resolve(laneDataDir("this spec never uses ~/.murage"), "composer-size-limit-data");
const HARNESS_PORT = Number(process.env.MURAGE_E2E_PORT || 9576);
const UI_PORT = Number(process.env.MURAGE_E2E_UI_PORT || 9578);
const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}`;
const EVIDENCE = process.env.MURAGE_COMPOSER_EVIDENCE_DIR || join(DATA_DIR, "evidence");
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");

/** The message smoke round 1 typed, byte for byte. */
const SMOKE_MESSAGE = `Please summarise this. ${"x".repeat(4 * 1024 * 1024)}`;
/** Exactly the limit: a lead sentence, then words the transcript can wrap. */
const AT_LIMIT_MESSAGE = (() => {
  const lead = "At the limit. ";
  const filler = "lorem ipsum dolor sit amet ";
  let text = lead + filler.repeat(Math.ceil((MESSAGE_TEXT_MAX_BYTES - lead.length) / filler.length));
  text = text.slice(0, MESSAGE_TEXT_MAX_BYTES);
  if (Buffer.byteLength(text) !== MESSAGE_TEXT_MAX_BYTES) throw new Error("the at-limit message is not at the limit");
  return text;
})();
/** A pasted wall of text just over the limit (1.5 MB), many lines like a real paste. */
const PASTED_WALL = `${"pasted line of text that goes on\n".repeat(Math.ceil((1.5 * 1024 * 1024) / 33))}`;

let harness: ChildProcess | undefined, vite: ViteDevServer | undefined, origin = "", logPath = "";
let headers: Record<string, string> = {};
interface Bot { id: string; threadId: string; name: string }

async function startHarness() {
  safeWipeSync(DATA_DIR);
  for (const dir of [DATA_DIR, EVIDENCE, join(DATA_DIR, "home"), join(DATA_DIR, "tmp"), join(DATA_DIR, "bin")]) mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(DATA_DIR, "bin", "node"));
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ instances: { verification: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLI } } } }, null, 2) + "\n", { mode: 0o600 });
  const home = join(DATA_DIR, "home"), tmp = join(DATA_DIR, "tmp");
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(["LANG", "LC_ALL", "TZ"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
    PATH: [join(DATA_DIR, "bin"), "/usr/bin", "/bin"].join(":"),
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    MURAGE_DATA_DIR: DATA_DIR, MURAGE_PORT: String(HARNESS_PORT), MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
    MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", FAKE_CLAUDE_MODE: "happy",
  };
  logPath = join(DATA_DIR, "harness.log");
  const log = openSync(logPath, "a");
  const preload = pathToFileURL(join(ROOT, "server", "testing", "search-fetch-preload.mjs")).href;
  try {
    harness = spawn(process.execPath, ["--experimental-strip-types", "--import", preload, join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdio: ["ignore", log, log] });
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
/** Fixture setup and read-back only; every check a person can see is made on screen. */
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(HARNESS_URL + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  expect(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text().catch(() => "")}`).toBe(true);
  return await response.json() as any;
}
/** A title and description mark the bot as one a person already set up, so
 *  the first-run setup quiz does not take its first message. */
async function makeBot(name: string): Promise<Bot> {
  return (await api("/api/bots", "POST", { name, title: "Size-limit fixture", description: "Fixture bot on the fake engine.", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot as Bot;
}
/** `messages=N` is a page size: 50 covers the quiz plus everything a test sends. */
const botState = async (who: Bot) => (await api("/api/bots?messages=50")).bots.find((item: Bot) => item.id === who.id);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await startHarness();
  try {
    vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(DATA_DIR, "vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } },
      plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: UI_PORT, strictPort: true, watch: null, hmr: false, proxy: { "/api": { target: HARNESS_URL } } } });
    await vite.listen();
    const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw new Error("the app did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await stopHarness(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await stopHarness(); } });

async function openApp(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
  const engines = page.waitForResponse((response) => /\/api\/instances(\?|$)/.test(response.url()) && response.ok(), { timeout: 60_000 });
  await page.goto(origin);
  await expect(page.getByRole("complementary", { name: "Bots and navigation" }).or(page.getByRole("button", { name: "Open bot list" }))).toBeVisible();
  await engines;
}
async function selectBot(page: Page, who: Bot) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: new RegExp(`^${who.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await expect(composer(page, who)).toBeVisible();
  await settleIntake(page, who);
}
/** Every new bot opens with its two-question setup quiz, and the composer's
 *  first messages answer it. The fixture bot is taken through it the way a
 *  person would ("general it is") so the message under test reaches the
 *  engine rather than the quiz. Same walk as the user smoke's settleIntake. */
async function settleIntake(page: Page, who: Bot) {
  const log = page.locator("main");
  await expect(log.getByText(/What do you actually want me for\?|Fine, general it is|Right, I'm/).first()).toBeVisible();
  if (await log.getByText("Fine, general it is.").count() || await log.getByText(/^Right, I'm /).count()) return;
  const box = composer(page, who);
  if (!(await log.getByText("Give me one real thing you'd rather hand over.").count())) {
    await box.fill("just chat with me");
    await box.press("Enter");
    await expect(log.getByText("Give me one real thing you'd rather hand over.")).toBeVisible();
  }
  await box.fill("nothing specific, general chat");
  await box.press("Enter");
  await expect(log.getByText("I don't think you need a specialist for this.")).toBeVisible();
  await page.getByRole("button", { name: "That's fine", exact: true }).click();
  await expect(log.getByText("Fine, general it is.")).toBeVisible();
}
const composer = (page: Page, who: Bot) => page.getByRole("textbox", { name: `Message ${who.name}`, exact: true });
/** The message bubbles only: the composer sits inside <main> too, and a textarea's value is text. */
const transcript = (page: Page) => page.locator("main").getByTestId("msg-bubble");
const notice = (page: Page) => page.getByRole("alert").filter({ hasText: "Not sent" });
const shot = (page: Page, name: string) => page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
/** Fires the textarea's own paste handler with `text` on the clipboard, the
 *  way a real ⌘V lands, without needing the headless clipboard permission. */
async function pasteInto(page: Page, who: Bot, text: string) {
  await composer(page, who).evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}
/** Whether the engine is running for this bot, and the opening words of every
 *  user message the harness holds for it (the quiz answers are user messages too). */
async function harnessSaw(who: Bot) {
  const state = await botState(who);
  const messages: Array<{ role?: string; text?: string }> = state?.messages ?? [];
  return { busy: Boolean(state?.busy), userMessages: messages.filter((m) => m.role === "user").map((m) => String(m.text ?? "").slice(0, 24)) };
}
const QUIZ_ANSWERS = ["just chat with me", "nothing specific, genera"];

test("a 4 MB typed message is refused on screen with the size and the limit, and the text stays in the box", async ({ page }) => {
  const bot = await makeBot("Size limit bot");
  await openApp(page);
  await selectBot(page, bot);
  const box = composer(page, bot);
  await box.click();
  await box.fill(SMOKE_MESSAGE);
  await box.press("Enter");

  // The reason, where the person is looking, as an alert a screen reader announces.
  const alert = notice(page);
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText("Not sent: this message is 4 MB, and one message can be up to 1 MB. Shorten it or split it into smaller messages. Your text is still here.");
  await expect(box).toHaveAttribute("aria-invalid", "true");
  const describedBy = await box.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(/one message can be up to 1 MB/);
  // Nothing lost: the whole message is still in the box, byte for byte.
  expect(await box.evaluate((element) => (element as HTMLTextAreaElement).value.length)).toBe(SMOKE_MESSAGE.length);
  expect(await box.evaluate((element) => (element as HTMLTextAreaElement).value.slice(0, 40))).toBe(SMOKE_MESSAGE.slice(0, 40));
  await shot(page, "01-typed-4mb-refused-inline");

  // Nothing was sent: no user bubble, no engine turn, and the harness holds no message for this bot.
  await expect(transcript(page).getByText("Please summarise this.", { exact: false })).toHaveCount(0);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await harnessSaw(bot)).toEqual({ busy: false, userMessages: QUIZ_ANSWERS });

  // Dismiss clears the notice; the text is still there to work on.
  await alert.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(box).not.toHaveAttribute("aria-invalid", "true");
  expect(await box.evaluate((element) => (element as HTMLTextAreaElement).value.length)).toBe(SMOKE_MESSAGE.length);

  // Enter again says it again; an edit is the person acting on it, and clears it.
  await box.press("Enter");
  await expect(notice(page)).toBeVisible();
  await box.press("End");
  await box.press("!");
  await expect(notice(page)).toHaveCount(0);
  await shot(page, "02-typed-4mb-notice-cleared-by-edit");
  await box.fill("");
});

test("a pasted wall of text over the limit is refused the same way and the pasted chip stays", async ({ page }) => {
  const bot = await makeBot("Paste limit bot");
  await openApp(page);
  await selectBot(page, bot);
  const box = composer(page, bot);
  await box.click();
  await box.fill("Here is the file:");
  await pasteInto(page, bot, PASTED_WALL);
  // A long paste lands as a chip rather than burying the box.
  await expect(page.getByText("PASTED", { exact: true })).toBeVisible();
  await expect(page.getByText(/lines, 1\.5 MB/)).toBeVisible();
  await box.press("Enter");

  const alert = notice(page);
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText(/^Not sent: this message is 1\.5 MB, and one message can be up to 1 MB\./);
  // The chip and the typed lead are both still there.
  await expect(page.getByText("PASTED", { exact: true })).toBeVisible();
  await expect(box).toHaveValue("Here is the file:");
  await shot(page, "03-pasted-1_5mb-refused-chip-kept");
  await expect(transcript(page).getByText("Here is the file:", { exact: false })).toHaveCount(0);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await harnessSaw(bot)).toEqual({ busy: false, userMessages: QUIZ_ANSWERS });
});

test("a message exactly at the 1 MB limit sends and gets its reply", async ({ page }) => {
  test.setTimeout(180_000);
  const bot = await makeBot("At limit bot");
  await openApp(page);
  await selectBot(page, bot);
  const box = composer(page, bot);
  await box.click();
  await box.fill(AT_LIMIT_MESSAGE);
  await box.press("Enter");

  // Sent: the box empties, no notice, the message is in the transcript and the engine answers it.
  await expect(box).toHaveValue("", { timeout: 30_000 });
  await expect(notice(page)).toHaveCount(0);
  await expect(transcript(page).getByText("At the limit.", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await expect(transcript(page).getByText("hello from fake claude", { exact: true }).last()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await harnessSaw(bot)).busy, { timeout: 60_000 }).toBe(false);
  const state = await botState(bot);
  const sent = (state.messages as Array<{ role?: string; text?: string }>).find((m) => m.role === "user" && m.text?.startsWith("At the limit."));
  expect(sent?.text?.length).toBe(AT_LIMIT_MESSAGE.length);
  expect(Buffer.byteLength(sent?.text ?? "")).toBe(MESSAGE_TEXT_MAX_BYTES);
  await shot(page, "04-at-limit-1mb-sent-and-answered");
});

test("the harness refuses an over-limit message itself, with the same reason, and admits one at the limit", async () => {
  // The composer's check is the first line; the harness's is the one a client
  // that skips it meets. Both state the size and the limit. The old generic
  // 1,000,000-byte body bound answered "body too large" and refused the
  // at-limit message the previous test sent.
  const bot = await makeBot("Route limit bot");
  const over = await fetch(`${HARNESS_URL}/api/bots/${bot.id}/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(MESSAGE_TEXT_MAX_BYTES + 1) }) });
  expect(over.status).toBe(413);
  expect(await over.json()).toEqual({
    error: "This message is 1.1 MB, and one message can be up to 1 MB. Shorten it or split it into smaller messages.",
    code: "message-too-large",
    sizeBytes: MESSAGE_TEXT_MAX_BYTES + 1,
    limitBytes: MESSAGE_TEXT_MAX_BYTES,
  });
  // A quiz answer routes through /intake and carries the same bound.
  const intake = await fetch(`${HARNESS_URL}/api/bots/${bot.id}/intake`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "m", text: "x".repeat(MESSAGE_TEXT_MAX_BYTES + 1) }) });
  expect(intake.status).toBe(413);
  expect((await intake.json()).code).toBe("message-too-large");
  // Nothing was stored for either.
  expect((await harnessSaw(bot)).userMessages).toEqual([]);
  // At the limit, escaped as JSON, the body is over the old 1,000,000-byte
  // bound and is admitted (a 202 once the engine takes it, or the quiz's own
  // answer): not a 413.
  const atLimit = await fetch(`${HARNESS_URL}/api/bots/${bot.id}/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: AT_LIMIT_MESSAGE }) });
  expect(atLimit.status, await atLimit.clone().text()).not.toBe(413);
  expect(atLimit.ok).toBe(true);
});
