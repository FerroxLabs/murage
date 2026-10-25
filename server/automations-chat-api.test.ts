// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-J (item 17) over real HTTP: a bot proposes a webhook from chat through
// the agents tool route, the owner confirms it on the same card as a routine
// through both /respond routes (desktop and the paired phone), and Undo puts
// back what a change replaced. A routine or webhook run, a channel message
// and a turn for someone else can never propose one. The room case is in
// index-3.test.ts.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME, the port comes
// from the fixture band clear of the live app's 8799, Telegram is the fetch
// fixture in testing/telegram-fetch-preload.mjs and every engine is a fake.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const IDLE_LOAD_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "idle-load-preload.mjs")).href;
const TELEGRAM_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "telegram-fetch-preload.mjs")).href;
const TELEGRAM_OWNER = 777;
const TELEGRAM_TOKEN = "123:abcdefghijklmnopqrstuvwxyz123456";
/** The launch credential shared by the harness and its companion (the paired phone). */
const COMPANION_TOKEN = "c".repeat(64);
const pairedPhone = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN };
const REFUSED = "Routines and webhooks can only be set up in the owner's own conversation with this bot, not from a routine or webhook run, a channel message, a room or a conversation for someone else.";

let base: string;
let port: number;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let holderDump: string;
let telegramDir: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const phoneApi = (method: string, path: string, body?: unknown) => request(method, path, body, pairedPhone);
const botState = async (botId: string) => (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
const taskState = async (botId: string, threadId: string) => (await botState(botId)).tasks.find((task: any) => task.threadId === threadId);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const cardFor = async (threadId: string, requestId: string) => (await threadMessages(threadId)).find((m) => m.card?.requestId === requestId)?.card ?? null;
const listWebhooks = async () => (await desktopApi("GET", "/api/webhooks")).body.webhooks as any[];
const receipts = () => (JSON.parse(readFileSync(join(home, ".murage", "routines.json"), "utf8")).routineRequestReceipts ?? []) as any[];

async function poll<T>(read: () => Promise<T | null | undefined>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function boot() {
  stderr = "";
  child = spawn(process.execPath, ["--import", TELEGRAM_PRELOAD, "--import", IDLE_LOAD_PRELOAD, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_COMPANION_TOKEN: COMPANION_TOKEN,
      MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
      FAKE_TELEGRAM_DIR: telegramDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = await api("GET", "/api/desktop-secret");
  expect(proof.status).toBe(200);
  desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}

async function makeBot(name: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "holder", model: "fake-model" } });
  expect(created.status).toBe(201);
  expect((await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string };
}

async function waitIdle(botId: string, threadId: string, ms = 20_000) {
  return poll(async () => {
    const task = await taskState(botId, threadId);
    return task && !task.busy ? task : null;
  }, ms);
}

async function dumpedToken(): Promise<Record<string, string>> {
  const dump = await poll(async () => {
    try {
      return withTurnSecrets(JSON.parse(readFileSync(holderDump, "utf8")));
    } catch {
      return null;
    }
  }, 30_000);
  expect(dump, `the held turn never started. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  return { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}` };
}

/** The owner's own held turn on the fake Claude: its agents-tool token. */
async function heldTurn(bot: { id: string }, threadId: string): Promise<Record<string, string>> {
  rmSync(holderDump, { force: true });
  expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "set things up" })).status).toBe(202);
  return dumpedToken();
}

async function stopTurn(botId: string, threadId: string) {
  await desktopApi("POST", `/api/bots/${botId}/interrupt`, { threadId });
  await waitIdle(botId, threadId);
}

const proposeWebhook = (bot: { id: string }, threadId: string, auth: Record<string, string>, name: string, eventTypes?: string[]) =>
  request("POST", "/api/internal/routine-requests", {
    fromBotId: bot.id, fromThreadId: threadId, kind: "webhook", action: "create",
    webhook: { name, instructions: `Summarize the event for ${name}.`, ...(eventTypes ? { eventTypes } : {}) },
  }, auth);
const proposeRoutine = (bot: { id: string }, threadId: string, auth: Record<string, string>, name: string) =>
  request("POST", "/api/internal/routine-requests", {
    fromBotId: bot.id, fromThreadId: threadId, action: "create",
    routine: { name, instructions: `Summarize the day for ${name}.`, schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } },
  }, auth);
const proposeAction = (bot: { id: string }, threadId: string, auth: Record<string, string>, body: Record<string, unknown>) =>
  request("POST", "/api/internal/routine-requests", { fromBotId: bot.id, fromThreadId: threadId, ...body }, auth);

/** Both proposal families from one turn are refused with the one plain line, and leave no card. */
/** `refusal` is the line expected; a turn for someone else may meet an earlier refusal of its own (no grant), still a 403. */
async function expectRefused(bot: { id: string }, threadId: string, auth: Record<string, string>, label: string, refusal: string | null = REFUSED) {
  for (const proposed of [await proposeRoutine(bot, threadId, auth, `${label} routine`), await proposeWebhook(bot, threadId, auth, `${label} webhook`)]) {
    expect(proposed.status, `${label}: ${JSON.stringify(proposed.body)}`).toBe(403);
    if (refusal) expect(proposed.body.error).toBe(refusal);
  }
  expect((await threadMessages(threadId)).some((m) => m.card?.routineRequest), `${label} left a card`).toBe(false);
  expect((await api("GET", "/api/routines")).body.routines.some((r: any) => r.name === `${label} routine`)).toBe(false);
  expect((await listWebhooks()).some((w) => w.name === `${label} webhook`)).toBe(false);
}

async function runThread(runId: string) {
  return poll(async () => {
    const { body } = await api("GET", "/api/routines");
    const run = (body.runs ?? []).find((r: { id: string }) => r.id === runId);
    return (run?.threadId as string | undefined) ?? null;
  }, 30_000);
}

describe.skipIf(process.platform === "win32")("SL-J automations from chat over HTTP", () => {
  beforeAll(async () => {
    port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-automations-chat-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    holderDump = join(home, "fake-claude-dump.json");
    telegramDir = join(home, "telegram-fixture");
    mkdirSync(telegramDir);
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        // holds every turn open so the test can call the bot's own tools
        holder: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: holderDump }, config: { cli: FAKE_CLAUDE } },
      },
    }));
    await boot();
  }, 45_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("a webhook from chat: one card, Confirm makes it with no usable link, nothing secret reaches the bot or the transcript; Undo from the phone removes it once", async () => {
    const bot = await makeBot("Hooks");
    const auth = await heldTurn(bot, bot.threadId);
    const proposed = await proposeWebhook(bot, bot.threadId, auth, "Build alerts", ["build.failed"]);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    expect(proposed.body.autoApproved).not.toBe(true);
    const shown = await cardFor(bot.threadId, proposed.body.requestId);
    expect(shown).toMatchObject({ tool: "create_webhook", options: ["Confirm", "Cancel"], routineRequest: { kind: "webhook", operation: { action: "create" } } });
    expect(shown.answered).toBeUndefined();
    expect(await listWebhooks()).toHaveLength(0);
    await stopTurn(bot.id, bot.threadId);

    // the paired phone without its credential may not confirm
    expect((await request("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: proposed.body.requestId, behavior: "allow" }, { "x-murage-companion": "1" })).status).toBe(403);
    const confirmed = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: proposed.body.requestId, behavior: "allow" });
    expect(confirmed, JSON.stringify(confirmed.body)).toMatchObject({ status: 200, body: { outcome: "allowed-once", routineAction: "create" } });
    const made = (await listWebhooks()).find((w) => w.id === confirmed.body.resultId);
    expect(made).toMatchObject({ botId: bot.id, name: "Build alerts", enabled: true, eventTypes: ["build.failed"], deliveryCount: 0 });
    // nobody holds a secret for it: a call with any secret is refused
    const ingress = (await desktopApi("GET", "/api/webhooks")).body.ingress;
    const call = await fetch(`${ingress.baseUrl}/hooks/${made.endpointId}/whsec_${"a".repeat(43)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(call.status).toBe(401);
    // GATE: absent by construction, in the tool result, the card and the transcript
    const seen = JSON.stringify({ proposed: proposed.body, confirmed: confirmed.body, transcript: await threadMessages(bot.threadId) });
    expect(seen).not.toMatch(/whsec_/);
    expect(seen).not.toContain(made.endpointId);
    expect(seen).not.toContain("/hooks/");
    // what the bot can read back about it carries no link either
    const listed = await heldTurn(bot, bot.threadId);
    const forBot = await request("GET", `/api/internal/routines?fromBotId=${bot.id}&fromThreadId=${bot.threadId}`, undefined, listed);
    expect(forBot.body.webhooks).toEqual([expect.objectContaining({ webhookId: made.id, name: "Build alerts", eventTypes: ["build.failed"] })]);
    expect(JSON.stringify(forBot.body)).not.toContain(made.endpointId);
    await stopTurn(bot.id, bot.threadId);

    // Undo from the paired phone, on the thread route
    const undone = await phoneApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: proposed.body.requestId, behavior: "undo" });
    expect(undone, JSON.stringify(undone.body)).toMatchObject({ status: 200, body: { outcome: "undone" } });
    expect((await listWebhooks()).some((w) => w.id === made.id)).toBe(false);
    expect((await cardFor(bot.threadId, proposed.body.requestId)).undone).toBe(true);
    const twice = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: proposed.body.requestId, behavior: "undo" });
    expect(twice).toMatchObject({ status: 200, body: { outcome: "undone", alreadySettled: true } });
    // an undo answers only a routine or webhook card, and only from the owner's surfaces
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: proposed.body.requestId, behavior: "undo" })).status).toBe(403);
    expect((await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: "not-a-card", behavior: "undo" })).status).toBe(400);
  }, 90_000);

  it("Ask and Auto show the card; Full access applies an owner turn's webhook with its receipt; after a minted link Undo answers changed_since", async () => {
    const bot = await makeBot("Levels");
    let auth = await heldTurn(bot, bot.threadId);
    const asked = await proposeWebhook(bot, bot.threadId, auth, "Ask hook");
    expect(asked.status).toBe(201);
    expect(asked.body.autoApproved).not.toBe(true);
    expect((await cardFor(bot.threadId, asked.body.requestId)).answered).toBeUndefined();
    await stopTurn(bot.id, bot.threadId);

    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
    auth = await heldTurn(bot, bot.threadId);
    const onAuto = await proposeWebhook(bot, bot.threadId, auth, "Auto hook");
    expect(onAuto.status).toBe(201);
    expect(onAuto.body.autoApproved).not.toBe(true);
    expect((await cardFor(bot.threadId, onAuto.body.requestId)).answered).toBeUndefined();
    await stopTurn(bot.id, bot.threadId);
    expect(await listWebhooks()).toEqual([]);

    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true, acknowledgeFullAccess: true, fullAccessSetupRequests: true })).status).toBe(200);
    auth = await heldTurn(bot, bot.threadId);
    const onFull = await proposeWebhook(bot, bot.threadId, auth, "Full hook");
    expect(onFull.status, JSON.stringify(onFull.body)).toBe(201);
    expect(onFull.body.autoApproved).toBe(true);
    expect(JSON.stringify(onFull.body)).not.toMatch(/whsec_/);
    expect((await cardFor(bot.threadId, onFull.body.requestId)).answered).toBe("allow");
    const made = (await listWebhooks()).find((w) => w.name === "Full hook");
    expect(made).toBeTruthy();
    expect(receipts().find((row) => row.requestId === onFull.body.requestId)).toMatchObject({ kind: "webhook", before: { absent: true }, resultId: made.id });
    await stopTurn(bot.id, bot.threadId);

    // the owner mints the first link: the record moved, so Undo refuses and changes nothing
    const minted = await desktopApi("POST", `/api/webhooks/${made.id}/rotate`);
    expect(minted.status).toBe(200);
    expect(minted.body.credential.url).toContain(made.endpointId);
    const refused = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: onFull.body.requestId, behavior: "undo" });
    expect(refused).toMatchObject({ status: 409, body: { code: "changed_since" } });
    expect((await listWebhooks()).some((w) => w.id === made.id)).toBe(true);
    // and a link that was minted now works
    const delivered = await fetch(minted.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
    expect(delivered.status).toBe(202);
    const runThreadId = await runThread(((await delivered.json()) as { runId: string }).runId);
    if (runThreadId) await stopTurn(bot.id, runThreadId);
  }, 120_000);

  it("a stale card is held 409; Undo restores a routine's `before` over both routes; delete offers none", async () => {
    const bot = await makeBot("Routines");
    let auth = await heldTurn(bot, bot.threadId);
    const created = await proposeRoutine(bot, bot.threadId, auth, "Brief");
    expect(created.status).toBe(201);
    await stopTurn(bot.id, bot.threadId);
    const applied = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: created.body.requestId, behavior: "allow" });
    expect(applied.status).toBe(200);
    const routineId = applied.body.resultId as string;

    // the owner edits it while a pause card waits: the card is held, nothing changes
    auth = await heldTurn(bot, bot.threadId);
    const pause = await proposeAction(bot, bot.threadId, auth, { action: "pause", routineId });
    expect(pause.status).toBe(201);
    await stopTurn(bot.id, bot.threadId);
    expect((await desktopApi("PATCH", `/api/routines/${routineId}`, { name: "Owner brief" })).status).toBe(200);
    const stale = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: pause.body.requestId, behavior: "allow" });
    expect(stale.status).toBe(409);
    expect((await cardFor(bot.threadId, pause.body.requestId)).held).toContain("changed after this confirmation card was prepared");
    expect((await api("GET", "/api/routines")).body.routines.find((r: any) => r.id === routineId).enabled).toBe(true);
    await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: pause.body.requestId, behavior: "deny" });

    auth = await heldTurn(bot, bot.threadId);
    const update = await proposeAction(bot, bot.threadId, auth, { action: "update", routineId, changes: { name: "Bot brief", instructions: "Summarize it shorter." } });
    expect(update.status).toBe(201);
    await stopTurn(bot.id, bot.threadId);
    expect((await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: update.body.requestId, behavior: "allow" })).status).toBe(200);
    expect((await api("GET", "/api/routines")).body.routines.find((r: any) => r.id === routineId)).toMatchObject({ name: "Bot brief", prompt: "Summarize it shorter." });
    const undone = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: update.body.requestId, behavior: "undo" });
    expect(undone, JSON.stringify(undone.body)).toMatchObject({ status: 200, body: { outcome: "undone", routineAction: "update" } });
    expect((await api("GET", "/api/routines")).body.routines.find((r: any) => r.id === routineId)).toMatchObject({ name: "Owner brief", prompt: "Summarize the day for Brief." });

    auth = await heldTurn(bot, bot.threadId);
    const removal = await proposeAction(bot, bot.threadId, auth, { action: "delete", routineId });
    await stopTurn(bot.id, bot.threadId);
    expect((await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: removal.body.requestId, behavior: "allow" })).status).toBe(200);
    expect(await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: removal.body.requestId, behavior: "undo" }))
      .toMatchObject({ status: 409, body: { error: "Undo is not offered for delete or run now." } });
  }, 120_000);

  it("a manual run, a scheduled run, a webhook turn, the owner's channel message and someone else's cannot propose a routine or a webhook", async () => {
    // a routine run by hand
    const bot = await makeBot("Runner");
    const routine = await desktopApi("POST", "/api/routines", { name: "Hand run", prompt: "Do the hand run", botId: bot.id, schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    expect(routine.status).toBe(201);
    rmSync(holderDump, { force: true });
    const started = await desktopApi("POST", `/api/routines/${routine.body.routine.id}/run`);
    expect(started.status).toBe(201);
    const manualThread = await runThread(started.body.run.id);
    expect(manualThread, "the manual run never started a task").toBeTruthy();
    await expectRefused(bot, manualThread!, await dumpedToken(), "Manual");
    await stopTurn(bot.id, manualThread!);

    // a routine on its schedule: an interval whose next occurrence is a few seconds away
    const scheduledBot = await makeBot("Scheduled");
    rmSync(holderDump, { force: true });
    const soon = await desktopApi("POST", "/api/routines", {
      name: "On schedule", prompt: "Do the scheduled run", botId: scheduledBot.id,
      schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() - 5 * 60_000 + 3_000 },
    });
    expect(soon.status).toBe(201);
    const scheduledRun = await poll(async () => ((await api("GET", "/api/routines")).body.runs as any[])
      .find((run) => run.routineId === soon.body.routine.id && run.triggerSource !== "manual" && run.threadId), 100_000);
    // the server spreads on-time runs over up to 60 s after their due time (dispatchStaggerMs)
    expect(scheduledRun, `the scheduled run never started. runs: ${JSON.stringify(((await api("GET", "/api/routines")).body.runs as any[]).map((r) => ({ id: r.routineId, s: r.status, t: r.triggerSource, th: r.threadId })))} routine: ${JSON.stringify((await api("GET", "/api/routines")).body.routines.find((r: any) => r.id === soon.body.routine.id))}`).not.toBeNull();
    await expectRefused(scheduledBot, scheduledRun!.threadId, await dumpedToken(), "Scheduled");
    await stopTurn(scheduledBot.id, scheduledRun!.threadId);
    await desktopApi("DELETE", `/api/routines/${soon.body.routine.id}`);

    // a webhook turn
    const hooked = await makeBot("Hooked");
    const hook = await desktopApi("POST", "/api/webhooks", { name: "Inbound", prompt: "Handle the event", botId: hooked.id, runOn: "ember" });
    expect(hook.status).toBe(201);
    rmSync(holderDump, { force: true });
    const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
    expect(delivered.status).toBe(202);
    const hookThread = await runThread(((await delivered.json()) as { runId: string }).runId);
    expect(hookThread, "the webhook never started a task").toBeTruthy();
    await expectRefused(hooked, hookThread!, await dumpedToken(), "Webhook");
    await stopTurn(hooked.id, hookThread!);

    // a channel message from the owner, then from someone else
    const chief = await makeBot("Chief");
    expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
    const updates: unknown[] = [];
    const arrives = (id: number, text: string) => {
      updates.push({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text, from: { id: TELEGRAM_OWNER, is_bot: false }, chat: { id: TELEGRAM_OWNER, type: "private" } } });
      const staged = join(telegramDir, "updates.json.tmp");
      writeFileSync(staged, JSON.stringify(updates));
      renameSync(staged, join(telegramDir, "updates.json"));
    };
    const channelRuns = async () => ((await api("GET", "/api/routines")).body.runs as any[]).filter((run) => run.triggerSource === "channel" && run.botId === chief.id);
    expect((await desktopApi("PATCH", "/api/config", { telegram: { botToken: TELEGRAM_TOKEN } })).status).toBe(200);
    const pair = await desktopApi("POST", "/api/telegram/pair", { targetBotId: chief.id });
    expect(pair.status).toBe(200);
    arrives(1, `/pair ${pair.body.code}`);
    await expect.poll(async () => (await desktopApi("GET", "/api/telegram/status")).body.paired, { timeout: 15_000, interval: 100 }).toBe(true);
    const bindings = (await desktopApi("POST", "/api/memory/action", { action: "humans" })).body.bindings as Array<{ id: string; revision: number }>;
    expect((await desktopApi("POST", "/api/memory/action", { action: "human-link", bindingId: bindings[0]!.id, expectedRevision: bindings[0]!.revision, as: "owner" })).status).toBe(200);
    rmSync(holderDump, { force: true });
    arrives(2, "set up a webhook for me");
    const ownerRun = await poll(async () => (await channelRuns()).find((run) => run.threadId), 30_000);
    expect(ownerRun, `no channel run. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await expectRefused(chief, ownerRun!.threadId, await dumpedToken(), "Owner channel");
    await desktopApi("POST", `/api/routine-runs/${ownerRun!.id}/cancel`);

    const relink = (await desktopApi("POST", "/api/memory/action", { action: "humans" })).body.bindings as Array<{ id: string; revision: number }>;
    expect((await desktopApi("POST", "/api/memory/action", { action: "human-link", bindingId: relink[0]!.id, expectedRevision: relink[0]!.revision, as: "person" })).status).toBe(200);
    rmSync(holderDump, { force: true });
    arrives(3, "set up a webhook for me too");
    const otherRun = await poll(async () => (await channelRuns()).find((run) => run.id !== ownerRun!.id && run.threadId), 30_000);
    expect(otherRun, `no channel run for the other person. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await expectRefused(chief, otherRun!.threadId, await dumpedToken(), "Someone else", null);
    await desktopApi("POST", `/api/routine-runs/${otherRun!.id}/cancel`);
  }, 300_000);

  it("section 8 item 2: Confirm, restart, Undo; and a webhook card proposed before the restart still waits", async () => {
    const bot = await makeBot("Restarts");
    const auth = await heldTurn(bot, bot.threadId);
    const applied = await proposeWebhook(bot, bot.threadId, auth, "Before restart");
    const waiting = await proposeWebhook(bot, bot.threadId, auth, "Still waiting");
    expect([applied.status, waiting.status]).toEqual([201, 201]);
    await stopTurn(bot.id, bot.threadId);
    expect((await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: applied.body.requestId, behavior: "allow" })).status).toBe(200);
    const made = (await listWebhooks()).find((w) => w.name === "Before restart");
    expect(made).toBeTruthy();

    await waitForExit(child, { signal: "SIGTERM" });
    await boot();

    // the receipt survived boot reconciliation, so Undo still reads `before`
    expect(receipts().find((row) => row.requestId === applied.body.requestId)).toMatchObject({ before: { absent: true }, resultId: made.id });
    const undone = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: applied.body.requestId, behavior: "undo" });
    expect(undone, JSON.stringify(undone.body)).toMatchObject({ status: 200, body: { outcome: "undone" } });
    expect((await listWebhooks()).some((w) => w.id === made.id)).toBe(false);
    // the card proposed before the restart persists and still confirms
    expect((await cardFor(bot.threadId, waiting.body.requestId)).answered).toBeUndefined();
    const later = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: waiting.body.requestId, behavior: "allow" });
    expect(later.status).toBe(200);
    expect((await listWebhooks()).some((w) => w.name === "Still waiting")).toBe(true);
  }, 120_000);
});
