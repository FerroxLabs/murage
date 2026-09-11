// F4-T7 joined proof: a report a bot writes becomes a card, the card opens
// the working file beside the chat, the owner edits it, a bot competes, and
// everything survives a restart.
//
// Everything below runs against the real harness (server/index.ts) launched
// the way docs/verification/README.md describes, with the suite's own fake
// engine (server/testing/fake-claude-cli.ts) as the only instance. The fake
// writes a Markdown file inside the turn's working folder the way a Bash or
// Write tool would — it never calls register_artifact — and the real
// terminal sweep (server/output-publication.ts, R3-T3) publishes it. The
// real Vite app renders the real host card (ArtifactCards), the real
// workspace pane (F4-T3) and the real Markdown editor (F4-T4) over the real
// F4-T1 write route. Nothing here touches a real app, ~/.murage, a provider
// or the network.
//
// Proves, end to end:
//   1. One shell-written outputs/weekly-report.md with no register call is
//      one verified saved version, one receipt and one persisted host card;
//      the card's "Open here" shows that working file beside the chat.
//   2. Edit and Save writes exactly the bytes the owner typed and keeps the
//      revision it replaced as a saved version in Files. While a bot turn
//      holds the workspace, Save is refused with the bot-writing message and
//      nothing is written. The bot's own competing write to the same file
//      becomes a second card, and in the dirty editor a conflict rather than
//      a clobber: both texts are kept, Compare shows the bot's, Keep my
//      version and Save land the owner's, and the bot's revision is retained.
//   3. After a real harness restart over the same data: both cards are still
//      in the conversation, each saved version still names its original
//      bytes, the working file holds what was last saved, reopening it from
//      Files shows the current revision, and a further edit saves without a
//      conflict. Below `md` the pane covers the chat and Back to chat
//      returns the composer.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures.ts";
import type { Artifact } from "../../shared/artifacts.ts";

interface Fixture {
  info: { url: string; dataDir: string; logPath: string }; fixtureDumpPath: string; child: ChildProcess;
  restart(): Promise<void>; close(): Promise<void>;
}
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;
interface Bot { id: string; threadId: string; name: string }

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const RELATIVE_PATH = "outputs/weekly-report.md";
/** Exactly what the fake engine writes for a Markdown output path. */
const REPORT = `# Weekly report\n\nThree updates this week.\n\n- Written by the fixture engine to ${RELATIVE_PATH}\n`;
const MINE_1 = "# Weekly report\n\nThree updates this week.\n\nReviewed by the owner.\n";
const MINE_2 = "# Weekly report\n\nThree updates this week.\n\nReviewed by the owner, second pass.\n";
const THEIRS = "# Weekly report\n\nFour updates this week, rewritten by the bot while the owner was typing.\n";
const AFTER_RESTART = "# Weekly report\n\nThree updates this week.\n\nReviewed by the owner, second pass, after the restart.\n";

test.describe.configure({ mode: "serial" });

let fixture: Fixture, vite: ViteDevServer, origin: string, headers: Record<string, string>;
let bot: Bot, otherBot: Bot, workspace: string, reportPath: string;
/** What the earlier tests established; the later tests build on it. */
let firstCard: { messageId: string; artifactId: string };
let secondCard: { messageId: string; artifactId: string };

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
async function bytesOf(path: string): Promise<Buffer> {
  const response = await fetch(fixture.info.url + path, { headers, signal: AbortSignal.timeout(10_000) });
  expect(response.status, `GET ${path}`).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}
const messagesOf = async (who: Bot) => (await api("/api/bots?messages=200")).bots.find((item: Bot) => item.id === who.id).messages as any[];
const hostCards = async (who: Bot) => (await messagesOf(who)).filter(message => message.artifactIds?.length);
const artifactsOf = async (who: Bot) => (await api(`/api/artifacts?botId=${who.id}&pageSize=50`)).items as Artifact[];
const describe = async (id: string) => (await api(`/api/artifacts/${id}`)).artifact as Artifact;
const busy = async (who: Bot) => Boolean((await api("/api/bots?messages=0")).bots.find((item: Bot) => item.id === who.id)?.busy);
const disk = () => readFileSync(reportPath, "utf8");

/** The receipt rows the harness wrote, read straight from its database. */
function receiptRows(botId: string) {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, run_id, path_token, sha256, stage, artifact_id, message_id, error_category FROM output_publications WHERE bot_id=? AND producer='shell-output' ORDER BY created_at, id").all(botId) as Array<Record<string, string | null>>;
  } finally { db.close(); }
}

/** The harness's own dispatch-preparation incident (see
 * media-publication.human.spec.ts): the memory bundle prepared for a turn
 * was invalidated before the engine started, so the turn ended with no
 * engine process. Not part of this proof; a turn that ends this way is sent
 * again after a pause, at most TURN_ATTEMPTS times, every retry annotated. */
const MEMORY_REVOKED = "error: MEMORY_CONTEXT_REVOKED";
const TURN_ATTEMPTS = 3, TURN_RETRY_PAUSE_MS = 1_500;
async function turnRevokedBeforeEngine(who: Bot): Promise<boolean> {
  if (await busy(who)) return false;
  const last = (await messagesOf(who)).at(-1);
  return last?.kind === "activity" && last?.tool?.name === MEMORY_REVOKED;
}
async function retryAfterRevocation(what: string, attempt: number): Promise<void> {
  if (attempt >= TURN_ATTEMPTS) throw new Error(`${what} ended with ${MEMORY_REVOKED} ${TURN_ATTEMPTS} times; log ${fixture.info.logPath}`);
  const description = `${what} ended with ${MEMORY_REVOKED} before the engine started (attempt ${attempt}); sent again after ${TURN_RETRY_PAUSE_MS} ms`;
  test.info().annotations.push({ type: "harness-incident", description });
  console.warn(`[workspace-editor] ${description}`);
  await new Promise(resolve => setTimeout(resolve, TURN_RETRY_PAUSE_MS));
}

/** The fake engine in slow mode replies only once this file exists. */
const gatePath = () => join(fixture.info.dataDir, "reply-gate");
/** Whether the engine process holds a prompt carrying `marker` at its gate.
 * The dump is written per turn, so it names the turn the CLI is on. */
const cliHolds = (marker: string) => { try { return String(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt?.message?.content ?? "").includes(marker); } catch { return false; } };

/** Sends a turn whose reply is gated, and returns once `ready()` holds —
 * the engine has the prompt and is waiting on the gate. */
async function holdTurn(who: Bot, text: string, ready: () => boolean): Promise<void> {
  await expect.poll(() => busy(who), { timeout: 10_000 }).toBe(false);
  rmSync(gatePath(), { force: true });
  for (let attempt = 1; ; attempt++) {
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await request(`/api/bots/${who.id}/messages`, "POST", { text })).status).toBe(202);
    const deadline = Date.now() + 20_000;
    let revoked = false;
    while (!ready()) {
      if (await turnRevokedBeforeEngine(who)) { revoked = true; break; }
      if (Date.now() > deadline) throw new Error(`the fake engine never reached the gate for ${JSON.stringify(text)}; log ${fixture.info.logPath}: ${readFileSync(fixture.info.logPath, "utf8").slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!revoked) return;
    await retryAfterRevocation(`${who.name}'s turn ${JSON.stringify(text)}`, attempt);
  }
}
/** Opens the gate and waits for the turn to settle. */
async function releaseTurn(who: Bot): Promise<void> {
  writeFileSync(gatePath(), "go");
  try { await expect.poll(() => busy(who), { timeout: 20_000 }).toBe(false); }
  finally { rmSync(gatePath(), { force: true }); }
}
/** A plain turn with the gate open; used to pin the managed workspace. */
async function plainTurn(who: Bot, text: string): Promise<void> {
  writeFileSync(gatePath(), "go");
  try {
    for (let attempt = 1; ; attempt++) {
      expect((await request(`/api/bots/${who.id}/messages`, "POST", { text })).status).toBe(202);
      await expect.poll(() => busy(who), { timeout: 30_000 }).toBe(false);
      if (!(await turnRevokedBeforeEngine(who))) return;
      await retryAfterRevocation(`${who.name}'s turn ${JSON.stringify(text)}`, attempt);
    }
  } finally { rmSync(gatePath(), { force: true }); }
}

// ── The real app ─────────────────────────────────────────────────────────

async function openApp(page: Page, { width = 1440 } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
  await page.goto(origin);
}
async function selectBot(page: Page, who: Bot) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: new RegExp(`^${who.name}`) }).first().click();
  return sidebar;
}
const pane = (page: Page) => page.getByTestId("workspace-pane");
const transcriptCard = (page: Page, artifactId: string) => page.locator("main").locator(`[data-artifact-id="${artifactId}"]`);
const tabNamed = (page: Page, name: string) => page.getByTestId("workspace-tab").filter({ has: page.getByRole("tab", { name: new RegExp(`^${name.replace(/\./g, "\\.")}`) }) });
const sourceBox = (page: Page) => page.getByRole("textbox", { name: "Markdown source" });
const fileStatus = (page: Page) => page.getByTestId("markdown-file-status");
async function editInSource(page: Page, expected: string) {
  await page.getByTestId("workspace-document-edit").click();
  await expect(page.getByTestId("workspace-document")).toHaveAttribute("data-mode", "edit");
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(sourceBox(page)).toHaveValue(expected);
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(fileStatus(page)).toHaveText("File saved");
  await expect(tabNamed(page, "weekly-report.md")).not.toHaveAttribute("data-dirty", "true");
}

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  // Fixture-owned observation only, inside the launched child: the one
  // instance runs the fake in slow mode behind a reply gate and dumps every
  // turn, so a test can hold a turn open at a known point.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: [
    "import {readFileSync, writeFileSync} from 'node:fs';",
    "import {join} from 'node:path';",
    "const dataDir = process.env.MURAGE_DATA_DIR;",
    "const configPath = join(dataDir, 'config.json'); const config = JSON.parse(readFileSync(configPath, 'utf8'));",
    "config.instances.verification.environment = { FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_REPLY_GATE: join(dataDir, 'reply-gate'), FAKE_CLAUDE_DUMP_EACH_TURN: '1' };",
    "writeFileSync(configPath, JSON.stringify(config, null, 2));",
  ].join("\n") });
  try {
    await ownerProof();
    otherBot = (await api("/api/bots", "POST", { name: "Unrelated editor bot", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot;
    bot = (await api("/api/bots", "POST", { name: "Report editor bot", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot;
    vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(fixture.info.dataDir, "workspace-editor-vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } },
      plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0);
    const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw new Error("workspace editor fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => {
  try { await vite?.close(); } finally { await fixture?.close(); }
});

test("a Markdown report a bot writes into outputs/ without a register call is one saved version and one host card, and Open here shows the working file beside the chat", async ({ page }, testInfo) => {
  // A first ordinary turn pins the managed workspace so its path is known.
  // (The first engine launch of a fresh harness also warms its indexes.)
  await plainTurn(bot, "Warm up.");
  workspace = (await api(`/api/artifacts/workspace?botId=${bot.id}&threadId=${bot.threadId}`)).path as string;
  reportPath = join(workspace, ...RELATIVE_PATH.split("/"));
  expect(existsSync(reportPath)).toBe(false);
  const before = (await messagesOf(bot)).length;

  // The engine writes the report the moment it has the prompt, then waits
  // at its gate: the file exists while the turn is still running, and
  // nothing is published until the turn settles.
  await holdTurn(bot, `Write the weekly report. __fixture_write_output__:${RELATIVE_PATH}`, () => existsSync(reportPath));
  expect(disk()).toBe(REPORT);
  expect(await busy(bot)).toBe(true);
  expect(await hostCards(bot)).toEqual([]);
  expect(await artifactsOf(bot)).toEqual([]);
  await releaseTurn(bot);

  let card: any;
  await expect.poll(async () => { card = (await hostCards(bot))[0]; return Boolean(card); }, { timeout: 15_000 }).toBe(true);
  expect(card.text).toBe("Saved file: weekly-report.md");
  expect(card.artifactIds).toHaveLength(1);
  const artifactId = card.artifactIds[0] as string;
  expect(await hostCards(bot)).toHaveLength(1);
  expect((await messagesOf(bot)).length).toBeGreaterThan(before);
  const artifact = await describe(artifactId);
  expect(artifact).toMatchObject({ kind: "text", sha256: sha256(REPORT), bytes: Buffer.byteLength(REPORT), producer: "shell-output", botId: bot.id, threadId: bot.threadId, relativePath: RELATIVE_PATH, name: "weekly-report.md", sourceState: "current", sourceConversationAvailable: true, runId: expect.any(String) });
  expect(receiptRows(bot.id)).toEqual([expect.objectContaining({ path_token: RELATIVE_PATH, sha256: sha256(REPORT), stage: "registered", artifact_id: artifactId, message_id: card.id, error_category: null })]);
  expect((await artifactsOf(bot)).map(item => item.id)).toEqual([artifactId]);
  expect(await artifactsOf(otherBot)).toEqual([]);
  expect(sha256(await bytesOf(`/api/artifacts/${artifactId}/download`))).toBe(sha256(REPORT));
  firstCard = { messageId: card.id, artifactId };

  // The app: the one card in this conversation, Open here, the pane over
  // the working file — and a preview writes nothing.
  await openApp(page);
  await selectBot(page, bot);
  const shown = transcriptCard(page, artifactId);
  await expect(shown).toHaveCount(1);
  await expect(shown).toContainText("weekly-report.md");
  await expect(shown).toContainText("Saved copy");
  await expect(page.locator("main [data-artifact-id]")).toHaveCount(1);
  await expect(pane(page)).toHaveCount(0);
  await shown.getByRole("button", { name: `Open the working file ${RELATIVE_PATH} here` }).click();
  await expect(pane(page)).toBeVisible();
  await expect(pane(page)).toHaveAttribute("data-layout", "rail");
  await expect(page.getByTestId("workspace-tab")).toHaveCount(1);
  await expect(tabNamed(page, "weekly-report.md")).toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("workspace-document")).toHaveAttribute("aria-label", RELATIVE_PATH);
  await expect(page.getByTestId("workspace-markdown-preview")).toContainText("Three updates this week.");
  await expect(page.getByTestId("workspace-markdown-preview")).toContainText(`Written by the fixture engine to ${RELATIVE_PATH}`);
  await expect(page.getByTestId("workspace-markdown-preview")).not.toContainText("# Weekly");
  await expect(page.getByTestId("workspace-pane-scope")).toContainText("Report editor bot");
  // The composer is still there beside the pane.
  await expect(page.getByRole("textbox", { name: `Message ${bot.name}`, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("open-here-light.png") });
  expect(disk()).toBe(REPORT);
  expect((await artifactsOf(bot)).map(item => item.id)).toEqual([artifactId]);

  // The other conversation sees neither the card nor the file.
  await selectBot(page, otherBot);
  await expect(page.locator("main [data-artifact-id]")).toHaveCount(0);
});

test("Edit and Save writes the owner's bytes and keeps the replaced revision; a save during a bot turn is held; the bot's competing write is a conflict, not a clobber", async ({ page }, testInfo) => {
  await openApp(page);
  await selectBot(page, bot);
  await transcriptCard(page, firstCard.artifactId).getByRole("button", { name: `Open the working file ${RELATIVE_PATH} here` }).click();
  await expect(pane(page)).toBeVisible();
  await editInSource(page, REPORT);

  // First save: exactly the typed bytes land; the revision they replaced
  // (the bot's report) is kept as a saved version in Files.
  await sourceBox(page).fill(MINE_1);
  await expect(tabNamed(page, "weekly-report.md")).toHaveAttribute("data-dirty", "true");
  expect(disk()).toBe(REPORT);
  await save(page);
  expect(disk()).toBe(MINE_1);
  const afterFirstSave = await artifactsOf(bot);
  expect(afterFirstSave).toHaveLength(2);
  const kept = afterFirstSave.find(item => item.id !== firstCard.artifactId)!;
  expect(kept).toMatchObject({ sha256: sha256(REPORT), relativePath: RELATIVE_PATH, botId: bot.id, threadId: bot.threadId });
  expect(kept.producer, "a kept revision claims no producer").toBeUndefined();
  expect(sha256(await bytesOf(`/api/artifacts/${kept.id}/download`))).toBe(sha256(REPORT));
  // The card's own saved version is untouched; its original moved on.
  expect(await describe(firstCard.artifactId)).toMatchObject({ sha256: sha256(REPORT), sourceState: "changed" });
  expect(await hostCards(bot)).toHaveLength(1);

  // Keep typing, then a bot turn takes the workspace. Save is refused —
  // held, nothing written — and the draft stays in the editor.
  await sourceBox(page).fill(MINE_2);
  await expect(fileStatus(page)).toHaveText("Unsaved changes");
  const marker = "revise-pass-7f3";
  await holdTurn(bot, `Revise the weekly report (${marker}).`, () => cliHolds(marker));
  expect(await busy(bot)).toBe(true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-save-error")).toHaveText("File not saved: a bot is writing to this workspace. Your changes are still here; try again when it finishes.");
  await expect(fileStatus(page)).toHaveText("File not saved");
  await expect(sourceBox(page)).toHaveValue(MINE_2);
  expect(disk()).toBe(MINE_1);
  expect(await artifactsOf(bot)).toHaveLength(2);
  await page.screenshot({ path: testInfo.outputPath("save-held-bot-writing.png") });

  // The bot's shell rewrites the same file inside its turn; when the turn
  // settles the sweep publishes that revision as a second card.
  writeFileSync(reportPath, THEIRS);
  await releaseTurn(bot);
  let second: any;
  await expect.poll(async () => { second = (await hostCards(bot)).find(message => message.id !== firstCard.messageId); return Boolean(second); }, { timeout: 15_000 }).toBe(true);
  expect(second.text).toBe("Saved file: weekly-report.md");
  expect(second.artifactIds).toHaveLength(1);
  secondCard = { messageId: second.id, artifactId: second.artifactIds[0] };
  expect(await describe(secondCard.artifactId)).toMatchObject({ sha256: sha256(THEIRS), producer: "shell-output", relativePath: RELATIVE_PATH, sourceState: "current" });
  expect(receiptRows(bot.id).map(row => [row.stage, row.sha256, row.artifact_id])).toEqual([
    ["registered", sha256(REPORT), firstCard.artifactId], ["registered", sha256(THEIRS), secondCard.artifactId],
  ]);

  // In the dirty editor that is a conflict: both texts kept, nothing
  // written over the bot's file. Compare shows the bot's text.
  await expect(page.getByTestId("markdown-conflict")).toBeVisible({ timeout: 15_000 });
  await expect(fileStatus(page)).toHaveText("Not saved: the file changed on disk");
  // The held save's refusal is over; only the conflict describes the file now.
  await expect(page.getByTestId("markdown-save-error")).toHaveCount(0);
  await expect(sourceBox(page)).toHaveValue(MINE_2);
  expect(disk()).toBe(THEIRS);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByTestId("markdown-conflict")).toContainText("rewritten by the bot while the owner was typing.");
  await page.screenshot({ path: testInfo.outputPath("conflict-compare-light.png") });
  await page.getByRole("button", { name: "Keep my version", exact: true }).click();
  await expect(page.getByTestId("markdown-conflict")).toHaveCount(0);
  await expect(fileStatus(page)).toHaveText("Unsaved changes");
  await save(page);
  expect(disk()).toBe(MINE_2);
  // The bot's revision is retained: its card's version, and the copy kept
  // by the save that replaced it.
  const afterConflict = await artifactsOf(bot);
  expect(afterConflict.filter(item => item.sha256 === sha256(THEIRS)).map(item => item.id)).toContain(secondCard.artifactId);
  expect(afterConflict.filter(item => item.sha256 === sha256(THEIRS))).toHaveLength(2);
  expect(sha256(await bytesOf(`/api/artifacts/${secondCard.artifactId}/download`))).toBe(sha256(THEIRS));
  expect(await hostCards(bot)).toHaveLength(2);
  expect(await artifactsOf(otherBot)).toEqual([]);
  // Two cards in the conversation, both over their own saved version.
  await expect(transcriptCard(page, firstCard.artifactId)).toHaveCount(1);
  await expect(transcriptCard(page, secondCard.artifactId)).toHaveCount(1);
});

test("after a restart the cards, the saved versions and the working file's current revision are all retained, and a further edit saves without conflict", async ({ page }, testInfo) => {
  const receiptsBefore = JSON.stringify(receiptRows(bot.id));
  await fixture.restart();
  await ownerProof();

  // Same data, same identities, same bytes.
  expect(disk()).toBe(MINE_2);
  expect(JSON.stringify(receiptRows(bot.id))).toBe(receiptsBefore);
  const cards = await hostCards(bot);
  expect(cards.map(message => [message.id, message.artifactIds[0]])).toEqual([[firstCard.messageId, firstCard.artifactId], [secondCard.messageId, secondCard.artifactId]]);
  expect(await describe(firstCard.artifactId)).toMatchObject({ sha256: sha256(REPORT), sourceState: "changed", savedState: "available", sourceConversationAvailable: true });
  expect(await describe(secondCard.artifactId)).toMatchObject({ sha256: sha256(THEIRS), sourceState: "changed", savedState: "available", sourceConversationAvailable: true });
  expect(sha256(await bytesOf(`/api/artifacts/${firstCard.artifactId}/download`))).toBe(sha256(REPORT));
  expect(sha256(await bytesOf(`/api/artifacts/${secondCard.artifactId}/download`))).toBe(sha256(THEIRS));
  const versions = await artifactsOf(bot);
  expect(versions.map(item => item.sha256).sort()).toEqual([sha256(REPORT), sha256(REPORT), sha256(THEIRS), sha256(THEIRS)].sort());
  expect((await api(`/api/artifacts/${firstCard.artifactId}/preview`)).content).toBe(REPORT);

  // The app after the restart: both cards, each saying its original moved
  // on and its version is retained; the first card's Preview in Files shows
  // the retained bytes, not the working file.
  await openApp(page);
  await selectBot(page, bot);
  const first = transcriptCard(page, firstCard.artifactId), second = transcriptCard(page, secondCard.artifactId);
  await expect(first).toContainText("Original file has changed. The saved version is retained.");
  await expect(second).toContainText("Original file has changed. The saved version is retained.");
  await expect(first.getByRole("button", { name: /^Open the working file/ })).toHaveCount(0);
  // INLINE1: the retained bytes are rendered inside the card itself, not the
  // working file, and the card offers no Preview that leaves the chat.
  const retained = first.locator('[data-artifact-inline="markdown"]');
  await expect(retained).toContainText(`Written by the fixture engine to ${RELATIVE_PATH}`);
  await expect(retained).not.toContainText("Reviewed by the owner");
  await expect(first.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  await first.screenshot({ path: testInfo.outputPath("after-restart-card-retained.png") });
  await page.locator('[data-header-labelled="folder"]').click();
  const files = page.getByRole("dialog", { name: "Files", exact: true });
  await expect(files).toBeVisible();

  // Reopening the working file from Files shows the current revision, and a
  // further edit saves against it without a conflict.
  const workspaceHalf = files.locator('[data-testid="files-workspace"]');
  await workspaceHalf.getByRole("button", { name: "Open folder outputs", exact: true }).click();
  await workspaceHalf.locator(`[data-workspace-path="${RELATIVE_PATH}"]`).getByRole("button", { name: "Edit weekly-report.md beside the chat" }).click();
  await expect(files).toBeHidden();
  await expect(pane(page)).toBeVisible();
  await expect(page.getByTestId("workspace-document")).toHaveAttribute("data-mode", "edit");
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(sourceBox(page)).toHaveValue(MINE_2);
  await sourceBox(page).fill(AFTER_RESTART);
  await save(page);
  expect(disk()).toBe(AFTER_RESTART);
  const afterRestartSave = await artifactsOf(bot);
  expect(afterRestartSave).toHaveLength(5);
  expect(afterRestartSave.filter(item => item.sha256 === sha256(MINE_2))).toHaveLength(1);
  expect(await hostCards(bot)).toHaveLength(2);

  // Below md the pane covers the chat; Back to chat returns the composer.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pane(page)).toHaveAttribute("data-layout", "compact");
  await page.screenshot({ path: testInfo.outputPath("after-restart-compact-light.png") });
  await page.getByTestId("workspace-pane-back").click();
  await expect(pane(page)).toBeHidden();
  await expect(page.getByRole("textbox", { name: `Message ${bot.name}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
