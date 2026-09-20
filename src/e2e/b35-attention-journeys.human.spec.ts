import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";
import { evidenceRoot } from "./evidence.ts";
import { createHarness, linkChannelOwner, promoteFixtureChief, ROOT, waitFor, type Harness } from "../../scripts/channel-live-harness.ts";

// B35 approval attention across bots and channels in the full isolated app:
// the real source server and permission broker, a fake Claude engine that asks
// for one exact tool permission, the scripted Telegram Bot API stand-in and the
// real renderer. Not native notification, sound or packaged-app proof.
test.describe.configure({ mode: "serial" });

const TOKEN = "123:rehearsal_token_not_real_abcdefghij";
const OWNER = 777;
const ACTION = "fixture_exact_action_no_execution";
const evidence = join(evidenceRoot("b35-attention-journeys"), "server-evidence");
let harness: Harness, vite: ViteDevServer, origin = "", api = "", delivered = false, updateId = 0, chiefId = "", offscreenId = "";
const updates: any[] = [];
const lines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const atomic = (file: string, value: unknown) => { writeFileSync(file + ".tmp", JSON.stringify(value)); renameSync(file + ".tmp", file); };
const arrive = (...values: any[]) => { updates.push(...values); atomic(join(api, "updates.json"), updates); };
const decisions = () => lines(join(harness.root, "decisions.jsonl"));
const sent = () => lines(join(api, "sent.jsonl"));
const edits = () => lines(join(api, "edits.jsonl"));
const callbacks = () => lines(join(api, "callbacks.jsonl"));
const inbox = async () => (await harness.request("GET", "/api/inbox?view=approvals&pageSize=25")).body;
const message = (text: string) => ({ update_id: ++updateId, message: { message_id: updateId, date: 1_700_000_000 + updateId, text,
  from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: "private" } } });

async function openApp(page: Page) {
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  return openSidebar(page);
}
async function openPendingApprovals(page: Page) {
  // 0.1.57: one sidebar row, not a menu entry folded under "Tools". The
  // dialog opens on "Needs you"; this walk wants the approvals-only view.
  const sidebar = await openSidebar(page);
  await sidebar.locator("[data-sidebar-needs-you]").click();
  await page.getByRole("button", { name: "Pending approvals", exact: true }).click();
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  harness = await createHarness({ label: "b35-attention", evidenceDir: evidence, preload: join(ROOT, "scripts", "channel-live-telegram-fake-api.mjs"),
    env: () => ({ CHANNEL_LIVE_TELEGRAM_DIR: api, FAKE_CLAUDE_MODE: "channel-permission", FAKE_PERMISSION_DECISIONS: join(harness.root, "decisions.jsonl") }),
    secretEnv: (): Record<string, string> => delivered ? { MURAGE_TELEGRAM_BOT_TOKEN: TOKEN } : {} });
  api = join(harness.root, "telegram-api");
  mkdirSync(api, { mode: 0o700 });
  // A permission-mode copy of the established fake CLI in the task-owned root,
  // exactly as scripts/channel-permission-rehearsal.ts extends it.
  const fixtureCli = join(harness.root, "permission-claude.ts");
  const source = readFileSync(join(ROOT, "server", "testing", "fake-claude-cli.ts"), "utf8");
  const anchor = '  if (mode === "ask-user-question" || fixtureRequested(promptText(prompt), "__fixture_ask_user_question__")) {';
  if (source.split(anchor).length !== 2) throw new Error("fake CLI insertion anchor must be unique");
  writeFileSync(fixtureCli, source.replace(anchor, `  if (mode === "channel-permission") {
    void (async () => {
      const input = { command: "${ACTION}" };
      const reply = await callPermissionPromptTool({ tool_name: "Bash", input, tool_use_id: "fixture-permission", permission_suggestions: [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash" }] }] });
      if (!reply) throw new Error("Missing permission prompt tool");
      const decision = JSON.parse(reply);
      appendFileSync(process.env.FAKE_PERMISSION_DECISIONS!, JSON.stringify({ decision }) + "\\n");
      out({ type: "assistant", message: { content: [{ type: "text", text: "Fixture decision: " + decision.behavior + "; no action executed" }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0 });
      turnRunning = false;
      finishIfDone();
    })();
    return;
  }
` + anchor));
  chmodSync(fixtureCli, 0o700);
  const configPath = join(harness.data, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.fixtureClaude.config.cli = fixtureCli;
  writeFileSync(configPath, JSON.stringify(config));
  try {
    await harness.boot();
    chiefId = (await promoteFixtureChief(harness, "Journey Chief", undefined, { autoReview: "off", autoApprove: false, alwaysAllow: [] })).id;
    const saved = await harness.request("PATCH", "/api/config?secretStorage=external", { telegram: { botToken: TOKEN } });
    if (saved.status !== 200) throw new Error(`token save refused ${saved.status}`);
    delivered = true;
    const pairing = await harness.request("POST", "/api/telegram/pair", {});
    if (pairing.status !== 200) throw new Error(`pairing refused ${pairing.status}`);
    arrive(message(`/pair ${pairing.body.code}`));
    await waitFor("paired", async () => (await harness.request("GET", "/api/telegram/status")).body, value => value.paired === true, 30_000);
    await linkChannelOwner(harness, "telegram", String(OWNER));
    vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(harness.root, "vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: harness.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("B35 journey renderer did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await harness.close(); throw error; }
});

test.afterAll(async () => {
  try {
    for (const name of ["requests.jsonl", "sent.jsonl", "callbacks.jsonl", "edits.jsonl"]) if (api && existsSync(join(api, name))) copyFileSync(join(api, name), join(evidence, `telegram-${name}`));
    if (harness && existsSync(join(harness.root, "decisions.jsonl"))) copyFileSync(join(harness.root, "decisions.jsonl"), join(evidence, "engine-decisions.jsonl"));
    await vite?.close();
  } finally { await harness?.close(); }
});

test("a Telegram-originated request is attention, opens its exact card, and the app decision settles Telegram", async ({ page }, testInfo) => {
  const before = sent().length;
  arrive(message("Channel request: ask for approval of the fictional action."));
  const offer: any = await waitFor("Telegram offer", () => sent().slice(before).find(item => item.keyboard), (value: any) => Boolean(value), 60_000);
  const listed: any = await waitFor("one canonical approval", inbox, (value: any) => value?.total === 1, 20_000);
  const item = listed.items[0];
  expect(item.title).toBe("Approval requested");
  expect(item.sourceLabel).toContain("Channel conversation");
  const sidebar = await openApp(page);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("1", { timeout: 15_000 });
  await openPendingApprovals(page);
  const entry = page.locator(`[data-inbox-id="${item.id}"]`);
  await expect(entry).toContainText("Approval requested");
  await entry.getByRole("button", { name: "Open request", exact: true }).click();
  await expect(page.locator(`[data-mid="${item.link.messageId}"]`)).toBeVisible({ timeout: 15_000 });
  expect(await inbox().then((value: any) => value.total)).toBe(1); // opening is not answering
  const allow = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toHaveCount(1);
  await allow.click();
  const decided = await waitFor("one engine decision", decisions, list => list.length === 1, 30_000);
  expect(decided[0].decision.behavior).toBe("allow");
  expect(decided[0].decision.updatedPermissions).toBeUndefined();
  await waitFor("Telegram buttons settled", edits, list => list.some(entry => entry.messageId === offer.messageId && Array.isArray(entry.keyboard) && entry.keyboard.length === 0), 30_000);
  await expect.poll(async () => (await inbox()).total, { timeout: 15_000 }).toBe(0);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("0", { timeout: 15_000 });
  const lateTap = { update_id: ++updateId, callback_query: { id: `callback-${updateId}`, data: offer.keyboard.flat()[0].callback_data,
    from: { id: OWNER, is_bot: false }, message: { message_id: offer.messageId, date: 1_700_000_000 + updateId, chat: { id: OWNER, type: "private" } } } };
  arrive(lateTap);
  await waitFor("late Telegram tap answered", callbacks, list => list.some(entry => entry.callbackId === lateTap.callback_query.id), 20_000);
  await page.waitForTimeout(2_000);
  expect(decisions()).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("b35-channel-resolved.png"), fullPage: true });
});

test("an off-screen bot's request and a burst across bots count, survive reload, and Deny resolves only that card", async ({ page }, testInfo) => {
  const created = await harness.request("POST", "/api/bots", { name: "Offscreen Researcher", modelSelection: { instanceId: "fixtureClaude", model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  offscreenId = (await harness.request("GET", "/api/bots")).body.bots.find((bot: any) => bot.name === "Offscreen Researcher").id;
  await harness.request("PATCH", `/api/bots/${offscreenId}`, { autoReview: "off", autoApprove: false, alwaysAllow: [] });
  const decisionsBefore = decisions().length;
  const bots = (await harness.request("GET", "/api/bots")).body.bots;
  for (const [botId, text] of [[offscreenId, "Offscreen request: ask for approval."], [chiefId, "Chief request: ask for approval."]] as const) {
    const posted = await harness.request("POST", `/api/bots/${botId}/messages`, { threadId: bots.find((bot: any) => bot.id === botId).threadId, text });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
  }
  const listed: any = await waitFor("two canonical approvals", inbox, (value: any) => value?.total === 2, 45_000);
  const offscreenItem = listed.items.find((item: any) => item.botId === offscreenId);
  expect(offscreenItem, JSON.stringify(listed.items)).toBeTruthy();
  let sidebar = await openApp(page);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("2", { timeout: 15_000 });
  await page.reload();
  sidebar = await openSidebar(page);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("2", { timeout: 15_000 });
  await openPendingApprovals(page);
  const entry = page.locator(`[data-inbox-id="${offscreenItem.id}"]`);
  await expect(entry).toContainText("Offscreen Researcher");
  await entry.getByRole("button", { name: "Open request", exact: true }).click();
  await expect(page.locator(`[data-mid="${offscreenItem.link.messageId}"]`)).toBeVisible({ timeout: 15_000 });
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await expect(deny).toHaveCount(1);
  await deny.click();
  const decided = await waitFor("one deny decision", decisions, list => list.length === decisionsBefore + 1, 30_000);
  expect(decided.at(-1).decision.behavior).toBe("deny");
  await expect.poll(async () => (await inbox()).total, { timeout: 15_000 }).toBe(1);
  expect((await inbox()).items[0].botId).toBe(chiefId);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("1", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("b35-offscreen-denied.png"), fullPage: true });
});

test("while the server restarts the count stays visible as stale, then reconciles to the canonical total", async ({ page }, testInfo) => {
  const sidebar = await openApp(page);
  const trigger = sidebar.locator("[data-sidebar-needs-you]"), count = sidebar.locator("[data-needs-you-count]");
  await expect(count).toHaveText("1", { timeout: 15_000 });
  await harness.stop();
  await expect(trigger).toHaveAttribute("aria-label", /may be out of date/, { timeout: 15_000 });
  await expect(count).toHaveText(/^1\s*\?$/); // the last known count stays, marked as unconfirmed
  await page.screenshot({ path: testInfo.outputPath("b35-restart-stale.png"), fullPage: true });
  await harness.boot();
  const total = (await waitFor("canonical total after restart", inbox, (value: any) => typeof value?.total === "number", 20_000) as any).total;
  await expect(trigger).not.toHaveAttribute("aria-label", /out of date/, { timeout: 20_000 });
  await expect(count).toHaveText(String(total), { timeout: 15_000 });
  await testInfo.attach("restart-reconciliation.json", { body: JSON.stringify({ countBeforeRestart: 1, canonicalTotalAfterRestart: total }), contentType: "application/json" });
});
