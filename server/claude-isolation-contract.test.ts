// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Claude session made before the isolation contract (claude.ts CLAUDE_ISOLATION_CONTRACT) may
// carry the owner's personal setup in its recorded prompt, and `--resume` restores that prompt
// whatever flags the new process gets. End to end against the real harness and the fake CLI: a
// cursor recorded under the current contract resumes across a restart; the same cursor with no
// contract recorded (a thread from before) starts a fresh engine session and gets the
// conversation replayed, as on any other reset.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { CLAUDE_ISOLATION_CONTRACT } from "./drivers/claude.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = "0123456789abcdef".repeat(4);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;
/** The end of the restarted-session preamble (turn-context.ts RESTARTED_PREAMBLE): the replayed history follows it. */
const REPLAY_MARK = "here is the conversation so far.]";
/** The engine-switch preamble (FRESH_PREAMBLE): wrong here, the engine never changed. */
const SWITCH_MARK = "switched over";

interface BotView { id: string; threadId: string; busy: boolean }
interface TaskRow { threadId: string; resumeCursors?: Record<string, unknown>; resumeContracts?: Record<string, number> }
interface BotRow { id: string; tasks?: TaskRow[] }

describe("Claude sessions made before the isolation contract", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let base: string;
  let port: number;
  let stderr = "";
  let dump: string;

  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...DESKTOP_HEADERS, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as any };
  };

  const start = async () => {
    stderr = "";
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
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const stop = async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    child = undefined;
  };

  const botsFile = () => join(home, ".murage", "bots.json");
  const taskOf = (bot: BotView): TaskRow | undefined =>
    (JSON.parse(readFileSync(botsFile(), "utf8")) as BotRow[]).find((row) => row.id === bot.id)?.tasks?.find((task) => task.threadId === bot.threadId);

  /** Sends one message and waits for its turn to finish; returns what the fake CLI was launched with. */
  const turn = async (bot: BotView, text: string): Promise<{ argv: string[]; prompt: string }> => {
    rmSync(dump, { force: true });
    expect((await request("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
    await expect.poll(() => existsSync(dump), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: BotView) => b.id === bot.id)?.busy, { timeout: 20_000 }).toBe(false);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; prompt: unknown };
    return { argv: seen.argv, prompt: JSON.stringify(seen.prompt) };
  };

  beforeAll(async () => {
    port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-isolation-contract-"));
    dump = join(home, "fake-claude-dump.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1" },
          config: { cli: FAKE_CLAUDE },
        },
      },
    }));
    await start();
  }, 40_000);

  afterAll(async () => {
    await stop();
    await removeTempDir(home);
  });

  it("resumes a cursor made under the current contract, and replays on a fresh session for one made before it", async () => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await request("POST", "/api/bots", { name: "Contract", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    expect((await request("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);

    const first = await turn(bot, "remember the word PELICAN-ONE");
    expect(first.argv).toContain("--session-id");
    const cursor = first.argv[first.argv.indexOf("--session-id") + 1]!;
    await expect.poll(() => taskOf(bot)?.resumeContracts?.claude, { timeout: 10_000 }).toBe(CLAUDE_ISOLATION_CONTRACT);
    expect(taskOf(bot)?.resumeCursors?.claude).toBe(cursor);

    // A restart drops every retained process: the next turn has to choose between --resume and a fresh session.
    await stop();
    await start();
    const resumed = await turn(bot, "second message");
    expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(cursor);
    // a resumed session needs no replay (memory may still recall the earlier words, so look for the replay itself)
    expect(resumed.prompt).not.toContain(REPLAY_MARK);
    expect(resumed.prompt).not.toContain(SWITCH_MARK);

    // The same thread as a build from before the contract left it: a cursor with no contract beside it.
    await stop();
    const rows = JSON.parse(readFileSync(botsFile(), "utf8")) as Array<BotRow & Record<string, unknown>>;
    for (const row of rows) for (const task of row.tasks ?? []) delete task.resumeContracts;
    writeFileSync(botsFile(), JSON.stringify(rows));
    expect(taskOf(bot)?.resumeCursors?.claude).toBe(cursor);
    await start();
    const fresh = await turn(bot, "third message");
    expect(fresh.argv).not.toContain("--resume");
    expect(fresh.argv).toContain("--session-id");
    expect(fresh.argv[fresh.argv.indexOf("--session-id") + 1]).not.toBe(cursor);
    // Murage's own replay carries the conversation into the new session, worded as a restart on the
    // same engine (never as a switch to another engine)
    expect(fresh.prompt).toContain(REPLAY_MARK);
    expect(fresh.prompt).toContain("Murage started a fresh engine session for this conversation");
    expect(fresh.prompt).not.toContain(SWITCH_MARK);
    expect(fresh.prompt.slice(fresh.prompt.indexOf(REPLAY_MARK))).toContain("PELICAN-ONE");
    expect(fresh.prompt).toContain("third message");
    // and the new cursor is recorded under the contract
    await expect.poll(() => taskOf(bot)?.resumeContracts?.claude, { timeout: 10_000 }).toBe(CLAUDE_ISOLATION_CONTRACT);
  }, 120_000);
});
