// Direct-run settlement across a Claude child's LATE close and a retry
// relaunch, end to end against the real harness (WIN1 fix round).
//
// A Stop on the Claude driver is "requested, not observed": POST /interrupt
// signals the child and the bot reads idle while the process is still
// closing — the real CLI tears down its MCP children and flushes first, and
// Windows ends it through an asynchronous taskkill on every Stop.
// FAKE_CLAUDE_SIGTERM_DELAY_MS opens the same window on POSIX. Three shapes
// share the turn.completed fold in server/index.ts:
//
//  1. Stop, then edit the message and resend. The edited turn replays on a
//     fresh session (the thread is rewound), so its dispatch waits for the
//     stopped child's close inside memory's resetSession — the stopped
//     turn's turn.completed lands while the replacement run is in setup.
//     0.1.52 released the replacement there and its dispatch was cancelled
//     without a word: the message sat in the transcript, the bot went idle.
//  2. Stop, then send the next message at once. The turn resumes the same
//     session, so the driver itself meets the still-closing child: it used
//     to refuse ("a turn is already running on this thread"); now it waits
//     for the close, and that close lands while the replacement is inside
//     sendTurn (phase "dispatching", no provider turn id yet).
//  3. A transient pre-accept exit that the driver retries (U-17). The
//     relaunch is the SAME turn: its turn.completed must carry the id the
//     harness bound the run to at acceptance, or the run is never released
//     and the bot stays busy until restart.
//  4. The same retried turn, seen from what the user does next (the 0.1.53
//     hotfix symptom). The run is not the only thing the harness binds to
//     the id sendTurn returned: the folder writer lease and the routine
//     scheduler's admission are too. A relaunch that minted a fresh id left
//     the lease held after the bot read idle — workspace Save/Restore
//     answered 423 `bot-writing` until restart — and a Telegram message that
//     arrived during the turn was never dispatched. So after the retried
//     turn settles, the owner's save must land on disk and the queued
//     channel delivery must run and reply. Telegram is the fetch fixture in
//     testing/telegram-fetch-preload.mjs; the transport has no endpoint
//     override.
//
// Both engines here are the fake CLI, one instance per fixture shape so the
// knobs (per-instance `environment`) cannot leak into each other's launches.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const TELEGRAM_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "telegram-fetch-preload.mjs")).href;
const DESKTOP_SECRET = "0123456789abcdef".repeat(4);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;
// U-17: only a launch that died before its prompt was written may be
// relaunched. The pre-accept fixture never reads stdin, and a prompt far
// larger than any OS pipe buffer makes the driver's write report refusal.
const PRE_ACCEPT_PROMPT = "x".repeat(1000 * 1024);

interface BotView { id: string; threadId: string; busy: boolean; tasks?: Array<{ activity?: string }> }
interface MessageView { id: string; role: string; kind: string; text?: string; turnId?: string; tool?: { name: string; ok?: boolean } }
interface RoutineRunView { id: string; status: string; triggerSource?: string; botId: string; threadId?: string; output?: string; error?: string }
interface Reply { status: number; body: any }
// Telegram fixture identities: the paired owner's private chat with bot 123.
const TELEGRAM_OWNER = 777;
const TELEGRAM_TOKEN = "123:abcdefghijklmnopqrstuvwxyz123456";
const telegramMessage = (updateId: number, text: string) => ({
  update_id: updateId,
  message: { message_id: updateId, date: 1_700_000_000 + updateId, text, from: { id: TELEGRAM_OWNER, is_bot: false }, chat: { id: TELEGRAM_OWNER, type: "private" } },
});

describe("direct run settlement across a late close and a retry relaunch", () => {
  let child: ChildProcess;
  let home: string;
  let base: string;
  let stderr = "";
  let stopDump: string;
  let retryDump: string;
  let retryLaunches: string;
  let finishGateDir: string;
  let telegramDir: string;

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const api = (method: string, path: string, body?: unknown) => request(method, path, body);
  const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, DESKTOP_HEADERS);
  const botView = async (id: string): Promise<BotView | undefined> =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: BotView) => bot.id === id);
  const busy = async (id: string) => (await botView(id))?.busy;
  const messagesOf = async (threadId: string): Promise<MessageView[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages;
  const readJsonFileWhenReady = async <T,>(file: string, timeout: number): Promise<T> => {
    let parsed: unknown;
    await expect.poll(() => {
      try { parsed = JSON.parse(readFileSync(file, "utf8")); return true; } catch { return false; }
    }, { timeout, interval: 50 }).toBe(true);
    return parsed as T;
  };
  const makeBot = async (instanceId: string, name: string) => {
    const modelSelection = { instanceId, model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name, modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
    return bot;
  };

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-late-close-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    finishGateDir = join(home, "finish-fake");
    mkdirSync(finishGateDir);
    stopDump = join(home, "stop-dump.json");
    retryDump = join(home, "retry-dump.json");
    retryLaunches = join(home, "retry-launches");
    telegramDir = join(home, "telegram-fixture");
    mkdirSync(telegramDir);
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        instances: {
          // Shape 1: a turn that runs until Stop, and a child that takes a
          // moment to close after SIGTERM (Windows: taskkill /F ends it at
          // once, and its close is asynchronous by nature).
          claude: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: stopDump, FAKE_CLAUDE_FINISH_GATE_DIR: finishGateDir, FAKE_CLAUDE_SIGTERM_DELAY_MS: "1500" },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // Shape 2: the first launch of every turn dies before reading its
          // prompt (counted in FAKE_CLAUDE_STATE); the relaunch replies, or
          // holds until the finish gate when the prompt asks it to (shape 4).
          claudeRetry: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: retryDump, FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS: "1", FAKE_CLAUDE_STATE: retryLaunches, FAKE_CLAUDE_RETRY_SCALE: "0.001", FAKE_CLAUDE_FINISH_GATE_DIR: finishGateDir },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
        },
      }),
    );
    child = spawn(process.execPath, ["--import", TELEGRAM_PRELOAD, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
        FAKE_TELEGRAM_DIR: telegramDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 40_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  /** Send, wait for the fake to launch (its dump), Stop, wait for idle:
   * the stopped child is now closing (FAKE_CLAUDE_SIGTERM_DELAY_MS) while
   * the thread already reads idle — the window every shape below stands in. */
  const stopMidTurn = async (bot: BotView, text: string) => {
    rmSync(stopDump, { force: true });
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text });
    expect(sent.status).toBe(202);
    const launched = await readJsonFileWhenReady<{ pid: number }>(stopDump, 20_000);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    await expect.poll(() => busy(bot.id), { timeout: 5_000 }).toBe(false);
    expect(process.kill(launched.pid, 0)).toBe(true);
    return { pid: launched.pid, messageId: sent.body.message.id as string };
  };
  /** The replacement launched (a new fake, a new pid), the stopped child is
   * gone, and the bot is still busy with the replacement: its late close
   * settled nothing of the replacement's. Then the replacement finishes. */
  const replacementRunsAndFinishes = async (bot: BotView, stoppedPid: number, userText: string) => {
    const second = await readJsonFileWhenReady<{ pid: number }>(stopDump, 20_000);
    expect(second.pid).not.toBe(stoppedPid);
    await expect.poll(() => { try { process.kill(stoppedPid, 0); return false; } catch { return true; } }, { timeout: 10_000 }).toBe(true);
    expect(await busy(bot.id)).toBe(true);
    writeFileSync(join(finishGateDir, String(second.pid)), "finish");
    await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
    const messages = await messagesOf(bot.threadId);
    expect(messages.map((message) => message.tool?.name ?? "").filter((name) => name.startsWith("error:"))).toEqual([]);
    expect(messages.some((message) => message.role === "user" && message.text === userText)).toBe(true);
    // and the thread takes the next message at once — no phantom run
    rmSync(stopDump, { force: true });
    const again = await api("POST", `/api/bots/${bot.id}/messages`, { text: "one more" });
    expect(again.status).toBe(202);
    expect(again.body.queued).not.toBe(true);
    const third = await readJsonFileWhenReady<{ pid: number }>(stopDump, 20_000);
    writeFileSync(join(finishGateDir, String(third.pid)), "finish");
    await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
  };

  it("runs the edited message sent right after Stop, while the stopped engine's child is still closing (fresh session)", async () => {
    const bot = await makeBot("claude", "Stop then edit");
    try {
      const stopped = await stopMidTurn(bot, "hold this");
      // Edit the stopped message: the thread rewinds, the edited turn
      // replays on a fresh session, and its dispatch waits for the stopped
      // child's close in setup — the late close lands there.
      rmSync(stopDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages/${stopped.messageId}/edit`, { text: "hold this, corrected" })).status).toBe(202);
      await replacementRunsAndFinishes(bot, stopped.pid, "hold this, corrected");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 90_000);

  it("runs the next message sent right after Stop, while the stopped engine's child is still closing (resumed session)", async () => {
    // Memory off pins the resumed path: the dispatch keeps the session
    // cursor and never resets, so the Claude driver itself meets the
    // still-closing child (the same technique as folder-trust-api (7)).
    expect((await desktopApi("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    const bot = await makeBot("claude", "Stop then resend");
    try {
      const stopped = await stopMidTurn(bot, "hold this");
      rmSync(stopDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "and now this" })).status).toBe(202);
      await replacementRunsAndFinishes(bot, stopped.pid, "and now this");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("POST", "/api/memory/action", { action: "configure", mode: "active" });
    }
  }, 90_000);

  it("returns the bot to idle after a transient pre-accept exit is retried", async () => {
    const bot = await makeBot("claudeRetry", "Retried turn");
    try {
      // The turn's own first launch is the one transient; its relaunch replies.
      writeFileSync(retryLaunches, "0");
      rmSync(retryDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: PRE_ACCEPT_PROMPT })).status).toBe(202);
      await expect.poll(() => (existsSync(retryLaunches) ? readFileSync(retryLaunches, "utf8") : "0"), { timeout: 20_000 }).toBe("2");
      await expect.poll(async () => (await messagesOf(bot.threadId)).some((message) => message.role === "bot" && message.kind === "text" && Boolean(message.turnId)), { timeout: 20_000 }).toBe(true);
      // The relaunch's completion settles the run the harness bound at
      // acceptance: the bot is idle, and its task reads idle too.
      await expect.poll(() => busy(bot.id), { timeout: 15_000, interval: 100 }).toBe(false);
      expect((await botView(bot.id))?.tasks?.[0]?.activity).toBe("idle");
      const messages = await messagesOf(bot.threadId);
      expect(messages.some((message) => message.kind === "activity" && (message.tool?.name ?? "").startsWith("retrying — attempt 2/"))).toBe(true);
      expect(messages.map((message) => message.tool?.name ?? "").filter((name) => name.startsWith("error:"))).toEqual([]);
      // and a follow-up send dispatches at once instead of queueing behind
      // a run that will never settle
      writeFileSync(retryLaunches, "9");
      const again = await api("POST", `/api/bots/${bot.id}/messages`, { text: "follow-up" });
      expect(again.status).toBe(202);
      expect(again.body.queued).not.toBe(true);
      await expect.poll(() => busy(bot.id), { timeout: 20_000, interval: 100 }).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 90_000);

  it("after a retried turn settles, the owner's save lands and a Telegram message that arrived during the turn is delivered", async () => {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const note = join(project, "notes.md");
    const NOTE = "# Notes\n", EDIT = "# Notes\n\nEdited after the retried turn.\n";
    writeFileSync(note, NOTE);
    // Memory off: an active memory would recall the held turn's prompt — the
    // fixture marker included — into the channel turn's context, and the
    // fake would hold that turn too. Nothing here is about memory.
    expect((await desktopApi("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    const bot = await makeBot("claudeRetry", "Retried turn, then Save");
    const scopeQuery = `botId=${encodeURIComponent(bot.id)}&threadId=${encodeURIComponent(bot.threadId)}`;
    const save = (requestId: string, baseRevision: string) => desktopApi("POST", "/api/workspace-files/write", {
      scope: { botId: bot.id, threadId: bot.threadId }, relativePath: "notes.md", baseRevision, requestId, content: EDIT, bom: false,
    });
    const telegramSent = (): Array<{ chatId: string; text: string }> => {
      const file = join(telegramDir, "sent.jsonl");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    };
    const telegramUpdates: unknown[] = [];
    const telegramArrives = (update: unknown) => {
      telegramUpdates.push(update);
      const staged = join(telegramDir, "updates.json.tmp");
      writeFileSync(staged, JSON.stringify(telegramUpdates));
      renameSync(staged, join(telegramDir, "updates.json"));
    };
    const channelRuns = async (): Promise<RoutineRunView[]> =>
      ((await api("GET", "/api/routines")).body.runs as RoutineRunView[]).filter((run) => run.triggerSource === "channel" && run.botId === bot.id);
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { cwd: project })).status).toBe(200);
      // Pair Telegram with this bot: the owner answers the pairing code from
      // their private chat, and the channel polls it up.
      expect((await desktopApi("PATCH", "/api/config", { telegram: { botToken: TELEGRAM_TOKEN } })).status).toBe(200);
      const pair = await desktopApi("POST", "/api/telegram/pair", { targetBotId: bot.id });
      expect(pair.status).toBe(200);
      telegramArrives(telegramMessage(1, `/pair ${pair.body.code}`));
      await expect.poll(async () => (await desktopApi("GET", "/api/telegram/status")).body.paired, { timeout: 15_000, interval: 100 }).toBe(true);

      // The retried turn: its first launch dies before reading its prompt,
      // the relaunch reads it and holds until the finish gate.
      writeFileSync(retryLaunches, "0");
      rmSync(retryDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `${PRE_ACCEPT_PROMPT}\n__fixture_hold_authority__` })).status).toBe(202);
      const relaunch = await readJsonFileWhenReady<{ pid: number }>(retryDump, 20_000);
      expect(readFileSync(retryLaunches, "utf8")).toBe("2");
      expect(await busy(bot.id)).toBe(true);
      // The owner's message arrives while the turn runs: queued behind the
      // busy bot, on the bot's own conversation.
      telegramArrives(telegramMessage(2, "status please"));
      await expect.poll(async () => (await channelRuns()).map((run) => run.status), { timeout: 15_000, interval: 100 }).toEqual(["queued"]);
      // A live turn refuses the owner's save at once: the writer lease is
      // held for the whole turn, relaunch included.
      const opened = await desktopApi("GET", `/api/workspace-files/read?${scopeQuery}&path=notes.md`);
      expect(opened.status).toBe(200);
      const refused = await save("save-during-turn", opened.body.revision);
      expect(refused.status).toBe(423);
      expect(refused.body.code).toBe("bot-writing");
      expect(readFileSync(note, "utf8")).toBe(NOTE);

      // The relaunch finishes. Its turn.completed carries the id the harness
      // bound at acceptance, so the run AND the writer lease are released in
      // the same fold that reads the bot idle: the save that follows is the
      // user's next click, not a retry loop.
      writeFileSync(join(finishGateDir, String(relaunch.pid)), "finish");
      await expect.poll(() => busy(bot.id), { timeout: 15_000, interval: 100 }).toBe(false);
      expect((await botView(bot.id))?.tasks?.[0]?.activity).toBe("idle");
      const saved = await save("save-after-retry", opened.body.revision);
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ requestId: "save-after-retry", previousRevision: opened.body.revision, relativePath: "notes.md" });
      expect(readFileSync(note, "utf8")).toBe(EDIT);
      // The queued channel delivery dispatches on the idle bot and its reply
      // reaches the owner's chat.
      await expect.poll(async () => (await channelRuns()).map((run) => run.status), { timeout: 30_000, interval: 100 }).toEqual(["completed"]);
      const [delivered] = await channelRuns();
      expect(delivered).toMatchObject({ threadId: bot.threadId, output: "hello from fake claude" });
      await expect.poll(() => telegramSent(), { timeout: 15_000, interval: 100 }).toEqual([{ chatId: String(TELEGRAM_OWNER), text: "hello from fake claude" }]);
      const messages = await messagesOf(bot.threadId);
      expect(messages.map((message) => message.tool?.name ?? "").filter((name) => name.startsWith("error:"))).toEqual([]);
      expect(messages.some((message) => message.role === "user" && message.text?.includes("status please"))).toBe(true);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("POST", "/api/telegram/revoke");
      await desktopApi("PATCH", "/api/config", { telegram: { botToken: "", targetBotId: "" } });
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("POST", "/api/memory/action", { action: "configure", mode: "active" });
    }
  }, 120_000);
});
