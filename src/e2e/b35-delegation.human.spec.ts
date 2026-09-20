import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";
import { evidenceRoot } from "./evidence.ts";
import { B35_CHILD_NAME, B35_CHILD_TASK, B35_CREATE_MARKER, B35_DELEGATE_MARKER, B35_LOG_NAME, readB35Log, writeB35DelegationCli, type B35LogEntry } from "./b35-delegation-engine.ts";
import { createHarness, promoteFixtureChief, ROOT, waitFor, type Harness } from "../../scripts/channel-live-harness.ts";

// B35 genuine delegated-subagent approval in the full isolated app: the real
// source server, agents MCP proxy, delegation queue/drain and permission broker,
// a task-owned fake Claude engine copy whose Chief calls the real create_bot and
// delegate_bot tools and whose delegated child asks for one exact Bash
// permission, and the real renderer. No channel preload and no tokens. Not
// native notification, sound or packaged-app proof.
//
// MURAGE_E2E_DATA_DIR is required and admitted by the shared lane helper
// (evidence.ts → lane-data-dir.ts → server/testing/safe-wipe.mjs: OS temp or a
// *scratch*/*evidence*/*.e2e* segment, never a home or Murage data dir). The
// harness root itself is always a fresh OS-temp mkdtemp. Server evidence goes to
// <MURAGE_E2E_DATA_DIR>/b35-delegation-server-evidence, which must be absent or
// empty: the journey refuses to mix its evidence with an earlier run's.
test.describe.configure({ mode: "serial" });

const CHIEF = "B35 Delegation Chief";
const TEAM = "B35 Team";
const CHILD = B35_CHILD_NAME;
const REPLY_PREFIX = `@${CHILD} replied to the delegated task:`;
const DELEGATED_TEXT = `[Delegated by @${CHIEF}, another bot in this Murage workspace. Do the work and reply directly.]\n\n${B35_CHILD_TASK}`;
/** UI deny message (src/components/PendingApproval.tsx:176), delivered verbatim by the proxy (server/permission-proxy.ts:154). */
const DENY_MESSAGE = "Denied by the user.";
// evidenceRoot() is the lane data dir for every spec (evidence.ts:21-23), so this journey names its own directory.
const evidence = join(evidenceRoot("b35-delegation"), "b35-delegation-server-evidence");
let harness: Harness, vite: ViteDevServer, origin = "", chiefId = "", chiefThread = "", childId = "";
let first: { taskId: string; requestId: string; replyText: string } | undefined;

const engine = (role: B35LogEntry["role"]) => readB35Log(join(harness.root, B35_LOG_NAME)).filter(entry => entry.role === role);
const inbox = async () => (await harness.request("GET", "/api/inbox?view=approvals&pageSize=25")).body;
const roster = async () => (await harness.request("GET", "/api/bots?messages=0")).body;
const botRecord = async (id: string) => (await roster()).bots.find((bot: any) => bot.id === id);
const threadsOf = (record: any): string[] => record ? [...new Set<string>([record.threadId, ...(record.tasks ?? []).map((task: any) => task.threadId)])] : [];
const messages = async (threadId: string): Promise<any[]> => {
  const page = await harness.request("GET", `/api/threads/${threadId}/messages?limit=200`);
  if (page.status !== 200) throw new Error(`thread unreadable (HTTP ${page.status})`);
  return page.body.messages;
};
/** Every options card carrying a requestId, with its thread, across every bot, task and room thread. */
const requestCards = async () => {
  const { bots, groups } = await roster();
  const found: Array<{ threadId: string; message: any }> = [];
  for (const threadId of new Set<string>([...bots, ...groups].flatMap(threadsOf))) for (const message of await messages(threadId)) if (message.kind === "options" && typeof message.card?.requestId === "string") found.push({ threadId, message });
  return found;
};
const cardsWith = async (match: (card: any) => boolean) => (await requestCards()).filter(({ message }) => match(message.card)).map(({ message }) => message);
const parentReplies = async () => (await messages(chiefThread)).filter(m => m.kind === "text" && typeof m.text === "string" && m.text.startsWith(REPLY_PREFIX));
const channel = async () => {
  const named = (await roster()).groups.filter((group: any) => group.name === `${CHIEF} ⇄ ${CHILD}`);
  if (named.length !== 1) throw new Error(`expected exactly one ${CHIEF} ⇄ ${CHILD} channel (found ${named.length})`);
  return named[0];
};
const mirroredReplies = async (text: string) => (await messages((await channel()).threadId)).filter(m => m.kind === "text" && m.from?.botId === childId && m.text === text);
const dataJson = (name: string, fallback: unknown) => { const file = join(harness.data, name); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback; };
const receiptsFor = (taskId: string) => (dataJson("delegation-receipts.json", []) as any[]).filter(receipt => receipt.id === taskId);
const pendingFor = (threadId: string) => ((dataJson("delegations.json", {}) as Record<string, any[]>)[threadId] ?? []);
const idle = (botId: string, label: string) => waitFor(label, () => botRecord(botId), (bot: any) => Boolean(bot) && bot.busy !== true, 60_000);
const cardIn = async (threadId: string, messageId: string) => (await messages(threadId)).find(m => m.id === messageId)?.card;

/** A sampled proof that the parent never holds an approval and every approval is
 * the child's own provider permission. A peer-comms card would sit on the Chief
 * (source) thread with tool ask_bot/delegate_bot (server/peer-approval.ts:84-94);
 * its pending map is module memory with no route (peer-approval.ts:63), so the
 * transcripts and the Inbox are where it is observable. */
async function expectApprovalsOnlyOnChild(stage: string) {
  const cards = await requestCards();
  const childThreads = threadsOf(childId ? await botRecord(childId) : undefined);
  const shape = ({ threadId, message }: { threadId: string; message: any }) => ({ threadId, id: message.id, tool: message.card.tool, title: message.card.title });
  expect(cards.filter(card => card.threadId === chiefThread).map(shape), `${stage}: request cards on the Chief (parent) thread`).toEqual([]);
  expect(cards.filter(card => !childThreads.includes(card.threadId)).map(shape), `${stage}: request cards outside the child's threads`).toEqual([]);
  expect(cards.filter(card => card.message.card.tool !== "Bash").map(shape), `${stage}: request cards that are not the child's Bash permission`).toEqual([]);
  const listed = await inbox();
  expect(listed.items.filter((entry: any) => entry.botId !== childId || !childThreads.includes(entry.link?.threadId)), `${stage}: pending approvals not owned by the child`).toEqual([]);
}

async function tellChief(text: string) {
  const posted = await harness.request("POST", `/api/bots/${chiefId}/messages`, { threadId: chiefThread, text });
  expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
}
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
async function showChief(page: Page, sidebar: Locator) {
  await sidebar.locator(`[data-sidebar-bot-row="${chiefId}"]`).click();
  await expect(page.locator("[data-chat-header-name]").first()).toContainText(CHIEF, { timeout: 15_000 });
}
/** Select the Chief (parent) thread and require the global count to read `value` there. */
async function chiefCount(page: Page, value: string) {
  const sidebar = await openSidebar(page);
  await showChief(page, sidebar);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText(value, { timeout: 15_000 });
  await expect(page.locator("[data-chat-header-name]").first()).toContainText(CHIEF);
  return sidebar;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (existsSync(evidence) && readdirSync(evidence).length > 0) throw new Error(`B35 delegation evidence directory is not empty: ${evidence}. Use a fresh MURAGE_E2E_DATA_DIR or move the earlier evidence first.`);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  // FAKE_CLAUDE_DUMP is emptied: its turn dump would copy the MCP config, which
  // carries the per-turn comms token, into the root. The engine log is whitelisted.
  harness = await createHarness({ label: "b35-delegation", evidenceDir: evidence, env: () => ({ FAKE_CLAUDE_DUMP: "", FAKE_B35_LOG: join(harness.root, B35_LOG_NAME) }) });
  const fixtureCli = writeB35DelegationCli(harness.root);
  const configPath = join(harness.data, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.fixtureClaude.config.cli = fixtureCli;
  writeFileSync(configPath, JSON.stringify(config));
  try {
    await harness.boot();
    chiefId = (await promoteFixtureChief(harness, CHIEF, undefined, { autoReview: "off", autoApprove: false, alwaysAllow: [], approvePeerComms: false })).id;
    const chief = await botRecord(chiefId);
    chiefThread = chief.threadId;
    expect(chief).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace", approvePeerComms: false });
    vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(harness.root, "vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: harness.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("B35 delegation renderer did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await harness.close(); throw error; }
});

test.afterAll(async () => {
  try {
    if (harness && existsSync(join(harness.root, B35_LOG_NAME))) copyFileSync(join(harness.root, B35_LOG_NAME), join(evidence, "engine-b35.jsonl"));
    if (harness && existsSync(join(harness.data, "delegation-receipts.json"))) copyFileSync(join(harness.data, "delegation-receipts.json"), join(evidence, "delegation-receipts.json"));
    await vite?.close();
  } finally { await harness?.close(); }
});

/** Chief delegates to the child; the child's permission is global attention on
 * the exact child task while the Chief is selected; one UI decision reaches the
 * engine once; later answers are refused; the child settles and the parent gets
 * exactly one reply; the count is back to 0 on the Chief, before and after reload. */
async function delegatedApproval(page: Page, testInfo: TestInfo, behavior: "allow" | "deny", shot: string) {
  const before = { delegated: engine("parent-delegate").length, asked: engine("child-asked").length, decided: engine("child-decision").length, replies: (await parentReplies()).length };
  expect((await inbox()).total).toBe(0);
  await idle(childId, "child idle before delegation");
  await expectApprovalsOnlyOnChild("before delegation");

  // UI before anything is delegated: the Chief (parent) thread is selected and the global count reads 0.
  await openApp(page);
  let sidebar = await chiefCount(page, "0");
  await page.screenshot({ path: testInfo.outputPath(`${shot}-before.png`), fullPage: true });

  // Delegate through the product: agents delegate_bot → queueDelegation → drain after the Chief's turn completes.
  await tellChief(`Assign the fictional task.\n${B35_DELEGATE_MARKER}:${childId}`);
  const delegated = (await waitFor("parent delegate_bot call", () => engine("parent-delegate"), list => list.length === before.delegated + 1, 60_000)).at(-1)!;
  expect(delegated.isError, delegated.text).toBe(false);
  expect(delegated.text).toContain(`Delegation queued — @${CHILD} will pick it up after your current turn finishes.`);
  expect(delegated.env).toEqual({ MURAGE_BOT_ID: chiefId, MURAGE_THREAD_ID: chiefThread, MURAGE_TURN_DEPTH: "0" });
  const taskId = String(delegated.taskId);
  expect(taskId).toMatch(/^[\w-]{4,64}$/);
  await expectApprovalsOnlyOnChild("after delegate_bot");

  // The child's permission is the one canonical approval, and it names the exact child task.
  const listed: any = await waitFor("one delegated child approval", inbox, (value: any) => value?.total === 1, 60_000);
  const item = listed.items[0];
  const child = await botRecord(childId);
  const task = (child.tasks ?? []).find((candidate: any) => candidate.threadId === item.link.threadId);
  expect(item).toMatchObject({ kind: "request", title: "Approval requested", status: "pending", botId: childId, duplicates: 1 });
  expect(threadsOf(child)).toContain(item.link.threadId);
  // The Inbox caps a source label at 100 characters (server/inbox.ts), and a
  // delegated task is titled after what was asked, which can run past that.
  expect(item.sourceLabel).toBe([CHILD, task?.title].filter(Boolean).join(" · ").slice(0, 100));
  expect(item.link.threadId).not.toBe(chiefThread);
  expect(item.link.threadId).not.toBe((await channel()).threadId);
  const asked = await waitFor("child engine asked once", () => engine("child-asked"), list => list.length === before.asked + 1, 30_000);
  expect(asked.at(-1)).toMatchObject({ env: { MURAGE_BOT_ID: childId, MURAGE_THREAD_ID: item.link.threadId, MURAGE_TURN_DEPTH: "1" }, delegatedBy: CHIEF, delegatedPrefix: `[Delegated by @${CHIEF}` });
  expect(engine("child-decision")).toHaveLength(before.decided);
  const childMessages = await messages(item.link.threadId);
  expect(childMessages.filter(m => m.role === "user" && m.text === DELEGATED_TEXT)).toHaveLength(before.asked + 1);
  const card = childMessages.find(m => m.id === item.link.messageId);
  expect(card?.kind).toBe("options");
  expect(card.card).toMatchObject({ title: "Approval needed", tool: "Bash" });
  expect(card.card.answered).toBeUndefined();
  const requestId = String(card.card.requestId);
  expect(await cardsWith(candidate => candidate.requestId === requestId)).toHaveLength(1);
  // Not a peer-comms card: nothing on the parent, nothing outside the child, only Bash (sampled again below).
  await expectApprovalsOnlyOnChild("child request pending");
  const parent = await messages(chiefThread);
  expect(parent.filter(m => m.kind === "activity" && m.tool?.name === `Delegated to @${CHILD}`)).toHaveLength(before.delegated + 1);
  expect(parent.filter(m => m.kind === "activity" && m.tool?.name === `Messaged @${CHILD}` && m.comm?.withBotId === childId)).toHaveLength(before.delegated + 1);

  // UI: the count turns 1 with the Chief (parent) thread still selected, and survives reload.
  await expect(page.locator("[data-chat-header-name]").first()).toContainText(CHIEF);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("1", { timeout: 15_000 });
  await expect(page.locator(`[data-mid="${item.link.messageId}"]`)).toHaveCount(0); // the child card is offscreen
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0); // the parent has no approval composer
  await page.screenshot({ path: testInfo.outputPath(`${shot}-pending.png`), fullPage: true });
  await page.reload();
  sidebar = await chiefCount(page, "1");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
  await expectApprovalsOnlyOnChild("child request pending after reload");
  await openPendingApprovals(page);
  await expect(page.locator("[data-inbox-id]")).toHaveCount(1, { timeout: 15_000 });
  const entry = page.locator(`[data-inbox-id="${item.id}"]`);
  await expect(entry).toContainText(CHILD);
  await expect(entry).toContainText("Approval requested");
  await entry.getByRole("button", { name: "Open request", exact: true }).click();
  await expect(page.locator(`[data-mid="${item.link.messageId}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-chat-header-name]").first()).toContainText(CHILD);
  expect((await inbox()).total).toBe(1); // opening is not answering
  await page.screenshot({ path: testInfo.outputPath(`${shot}-opened.png`), fullPage: true });
  const decide = page.getByRole("button", { name: behavior === "allow" ? "Allow once" : "Deny", exact: true });
  await expect(decide).toHaveCount(1);
  await decide.click();

  // One decision reaches the child engine, once. The composer sends Deny with
  // DENY_MESSAGE (PendingApproval.tsx:170-176, store.tsx:1980-1987); the broker
  // writes behavior+message to the proxy (drivers/claude.ts:579-601, 493), which
  // answers the engine {behavior:"deny",message} or {behavior:"allow",updatedInput}
  // with no updatedPermissions for a one-time allow (permission-proxy.ts:149-154).
  // A peer-comms requestId would be consumed by resolvePeerComms and never reach
  // an engine (index.ts:12831-12833, peer-approval.ts:152-159).
  const decided = (await waitFor("one child engine decision", () => engine("child-decision"), list => list.length === before.decided + 1, 30_000)).at(-1)!;
  expect(decided.decision).toEqual(behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE });
  // request.resolved carries the broker behavior and source "user" (claude.ts:495, 1163-1166);
  // the fold writes answered=behavior, dismissed=false (index.ts:3313-3315).
  await expect.poll(async () => { const settled = await cardIn(item.link.threadId, item.link.messageId); return settled && { answered: settled.answered, dismissed: settled.dismissed }; }, { timeout: 15_000 }).toEqual({ answered: behavior, dismissed: false });
  await expect.poll(async () => (await inbox()).total, { timeout: 15_000 }).toBe(0);
  await expect(sidebar.locator("[data-needs-you-count]")).toHaveText("0", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);

  // Later answers never reach the engine. A repeat on a settled card now
  // reports the first decision instead of claiming the action failed
  // (server/index.ts, the settled-card check before respondToRequest). Was:
  //   expect(answer.body).toEqual({ ok: true, outcome: "unavailable" });
  for (const late of ["allow", "deny"] as const) {
    const answer = await harness.request("POST", `/api/threads/${item.link.threadId}/respond`, { requestId, behavior: late });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toEqual({ ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
  }
  await page.waitForTimeout(1_500);
  expect(engine("child-decision")).toHaveLength(before.decided + 1);
  expect((await cardIn(item.link.threadId, item.link.messageId))?.answered).toBe(behavior);
  expect((await inbox()).total).toBe(0);
  await expectApprovalsOnlyOnChild("after the decision");

  // Settlement: exactly one parent reply from the child, one mirrored channel reply, one done receipt.
  const replyText = `B35 child decision: ${behavior}`;
  const replies = await waitFor("exactly one new parent reply", parentReplies, list => list.length === before.replies + 1, 30_000);
  expect(replies.at(-1).text).toBe(`${REPLY_PREFIX}\n\n${replyText}`);
  expect(replies.at(-1).from?.botId).toBe(childId);
  await idle(childId, "child settled");
  expect(await mirroredReplies(replyText)).toHaveLength(1);
  const receipts = await waitFor("one done receipt", () => receiptsFor(taskId), list => list.length === 1, 15_000);
  expect(receipts[0]).toMatchObject({ sourceThreadId: chiefThread, toBotId: childId, status: "done", result: replyText });
  expect(pendingFor(chiefThread)).toHaveLength(0);
  await expectApprovalsOnlyOnChild("after settlement");

  // UI after settlement: re-select the Chief (parent) thread — 0 — then reload with the Chief selected — still 0.
  await chiefCount(page, "0");
  await expect(page.locator("[data-mid]", { hasText: "replied to the delegated task" })).toHaveCount(before.replies + 1, { timeout: 15_000 });
  await page.reload();
  await chiefCount(page, "0");
  await expect(page.locator("[data-mid]", { hasText: "replied to the delegated task" })).toHaveCount(before.replies + 1, { timeout: 15_000 });
  return { taskId, requestId, replyText };
}

test("a Chief-created sub-bot's delegated permission is global attention, opens its exact card, decides once and delivers one reply", async ({ page }, testInfo) => {
  // A sub-bot created through the product: agents create_bot with lead:true.
  expect((await inbox()).total).toBe(0);
  await expectApprovalsOnlyOnChild("before create_bot");
  await tellChief(`Stand up the fixture team.\n${B35_CREATE_MARKER}:${TEAM}`);
  const created = await waitFor("parent create_bot call", () => engine("parent-create"), list => list.length === 1, 60_000);
  expect(created[0].isError, created[0].text).toBe(false);
  expect(created[0].env).toEqual({ MURAGE_BOT_ID: chiefId, MURAGE_THREAD_ID: chiefThread, MURAGE_TURN_DEPTH: "0" });
  await idle(chiefId, "Chief settled after create_bot");
  const named = (await roster()).bots.filter((bot: any) => bot.name === CHILD);
  expect(named).toHaveLength(1);
  const child = named[0];
  childId = child.id;
  expect(created[0].text).toBe(`Created @${CHILD} in ${TEAM} [id: ${childId}], Ask mode (the user approves each action). Assign work with delegate_bot.`);
  expect(child).toMatchObject({ section: TEAM, chiefOfStaff: true, approvePeerComms: false, autoApprove: false, computer: "off" });
  expect(child.chiefScope).not.toBe("workspace");
  expect(child.autoReview ?? "off").toBe("off");
  expect(child.tasks.find((candidate: any) => candidate.threadId === child.threadId)).toMatchObject({ autoApprove: false, alwaysAllow: [] });
  expect((await inbox()).total).toBe(0);
  await expectApprovalsOnlyOnChild("after create_bot");

  first = await delegatedApproval(page, testInfo, "allow", "b35-delegation");

  // The Chief thread shows exactly one delivered reply (delegatedApproval left it selected after a reload).
  let sidebar = await openSidebar(page);
  await showChief(page, sidebar);
  await expect(page.locator("[data-mid]", { hasText: "replied to the delegated task" })).toHaveCount(1, { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("b35-delegation-settled.png"), fullPage: true });

  // Restart on the same data: stale while down, reconciled after, nothing replays.
  const trigger = sidebar.locator("[data-sidebar-needs-you]"), count = sidebar.locator("[data-needs-you-count]");
  await expect(count).toHaveText("0", { timeout: 15_000 });
  await harness.stop();
  await expect(trigger).toHaveAttribute("aria-label", /may be out of date/, { timeout: 15_000 });
  await expect(count).toHaveText(/^0\s*\?$/);
  await harness.boot();
  await expect(trigger).not.toHaveAttribute("aria-label", /out of date/, { timeout: 20_000 });
  await expect(count).toHaveText("0", { timeout: 15_000 });
  await page.waitForTimeout(3_000); // room for a boot drain to misbehave
  expect(await parentReplies()).toHaveLength(1);
  expect(await cardsWith(candidate => candidate.requestId === first!.requestId)).toHaveLength(1);
  await expectApprovalsOnlyOnChild("after restart");
  expect(engine("parent-create")).toHaveLength(1);
  expect(engine("parent-delegate")).toHaveLength(1);
  expect(engine("child-asked")).toHaveLength(1);
  expect(engine("child-decision")).toHaveLength(1);
  expect(engine("fixture-error")).toHaveLength(0);
  expect(receiptsFor(first.taskId)).toHaveLength(1);
  expect(await mirroredReplies(first.replyText)).toHaveLength(1);
  expect(pendingFor(chiefThread)).toHaveLength(0);
  expect((await inbox()).total).toBe(0);
  await page.reload();
  await chiefCount(page, "0");
  await expect(page.locator("[data-mid]", { hasText: "replied to the delegated task" })).toHaveCount(1, { timeout: 15_000 });
  await testInfo.attach("b35-delegation-journey-1.json", { body: JSON.stringify({ chiefId, childId, chiefThread, taskId: first.taskId, requestId: first.requestId, boots: harness.boots }), contentType: "application/json" });
});

test("Deny on a second delegated child request reaches the child once and the parent once", async ({ page }, testInfo) => {
  expect(childId, "the first journey creates the child").not.toBe("");
  expect(first, "the first journey delivers its reply").toBeTruthy();
  const earlier = (await parentReplies()).map(m => ({ id: m.id, text: m.text }));
  expect(earlier).toHaveLength(1);
  const second = await delegatedApproval(page, testInfo, "deny", "b35-delegation-deny");
  expect(second.taskId).not.toBe(first!.taskId);
  expect(second.requestId).not.toBe(first!.requestId);
  const replies = await parentReplies();
  expect(replies).toHaveLength(2);
  expect(replies.slice(0, 1).map(m => ({ id: m.id, text: m.text }))).toEqual(earlier);
  expect(await mirroredReplies(first!.replyText)).toHaveLength(1);
  expect(receiptsFor(first!.taskId)).toHaveLength(1);
  expect(engine("child-asked")).toHaveLength(2);
  expect(engine("child-decision")).toHaveLength(2);
  expect(engine("fixture-error")).toHaveLength(0);
  await expectApprovalsOnlyOnChild("after the deny journey");
  // delegatedApproval ended on the Chief after a reload with the count at 0.
  const sidebar = await openSidebar(page);
  await showChief(page, sidebar);
  await expect(page.locator("[data-mid]", { hasText: "replied to the delegated task" })).toHaveCount(2, { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("b35-delegation-deny-settled.png"), fullPage: true });
});
