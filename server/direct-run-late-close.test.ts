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
//
// Both engines here are the fake CLI, one instance per fixture shape so the
// knobs (per-instance `environment`) cannot leak into each other's launches.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = "0123456789abcdef".repeat(4);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;
// U-17: only a launch that died before its prompt was written may be
// relaunched. The pre-accept fixture never reads stdin, and a prompt far
// larger than any OS pipe buffer makes the driver's write report refusal.
const PRE_ACCEPT_PROMPT = "x".repeat(1000 * 1024);

interface BotView { id: string; threadId: string; busy: boolean; tasks?: Array<{ activity?: string }> }
interface MessageView { id: string; role: string; kind: string; text?: string; turnId?: string; tool?: { name: string; ok?: boolean } }
interface Reply { status: number; body: any }

describe("direct run settlement across a late close and a retry relaunch", () => {
  let child: ChildProcess;
  let home: string;
  let base: string;
  let stderr = "";
  let stopDump: string;
  let retryDump: string;
  let retryLaunches: string;
  let finishGateDir: string;

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
          // prompt (counted in FAKE_CLAUDE_STATE); the relaunch replies.
          claudeRetry: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: retryDump, FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS: "1", FAKE_CLAUDE_STATE: retryLaunches, FAKE_CLAUDE_RETRY_SCALE: "0.001" },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
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
});
