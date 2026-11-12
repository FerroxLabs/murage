// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-CLAUDE-RESUME: a chat keeps its native session across an app restart on a slow machine. End to end against the real harness and
// the fake CLI, with the real 50 ms lineage time budget (the child runs without VITEST). One slow cold read in the resume check, on a
// session nothing was revoked from, must still resume it.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "slow-lineage-preload.mjs")).href;
const DESKTOP_SECRET = "d".repeat(64);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;
const REPLAY_MARK = "here is the conversation so far.]";

interface BotView { id: string; threadId: string; busy: boolean }
interface TaskRow { threadId: string; resumeCursors?: Record<string, unknown> }
interface BotRow { id: string; tasks?: TaskRow[] }

describe("a chat's native session across a restart on a slow machine", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let base: string;
  let port: number;
  let stderr = "";
  let dump: string;
  let flag: string;

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
    child = spawn(process.execPath, ["--import", PRELOAD, join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
        MURAGE_TEST_SLOW_LINEAGE_FLAG: flag,
        // a short required-server wait, so the pending approvals server is reported in seconds
        MURAGE_MCP_REQUIRED_WAIT_MS: "1500",
        MURAGE_MCP_RECOVERY_MS: "2000",
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

  const turn = async (bot: BotView, text: string): Promise<{ argv: string[]; prompt: string }> => {
    rmSync(dump, { force: true });
    expect((await request("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
    await expect.poll(() => existsSync(dump), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: BotView) => b.id === bot.id)?.busy, { timeout: 20_000 }).toBe(false);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; prompt: unknown };
    return { argv: seen.argv, prompt: JSON.stringify(seen.prompt) };
  };

  beforeAll(async () => {
    const fake = FAKE_CLAUDE;
    chmodSync(fake, 0o755);
    port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-resume-slow-check-"));
    dump = join(home, "fake-claude-dump.json");
    flag = join(home, "slow-lineage-once");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1" },
          config: { cli: fake },
        },
        // the approvals server stays pending on the first status answers, as on a cold slow start
        "claude-slow-tools": {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1", FAKE_CLAUDE_MCP_READY_MS: JSON.stringify({ muragebox: -1 }) },
          config: { cli: fake },
        },
      },
    }));
    await start();
  }, 40_000);

  afterAll(async () => {
    await stop();
    await removeTempDir(home);
  });

  it("resumes the same session when one read of the resume check is slow, and needs no replay", async () => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await request("POST", "/api/bots", { name: "Slow check", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    expect((await request("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);

    const first = await turn(bot, "remember the word HERON-ONE");
    const cursor = first.argv[first.argv.indexOf("--session-id") + 1]!;
    await expect.poll(() => taskOf(bot)?.resumeCursors?.claude, { timeout: 10_000 }).toBe(cursor);

    await stop();
    await start();
    writeFileSync(flag, "1");
    const resumed = await turn(bot, "second message");
    // the slow read really happened on this turn's check
    expect(existsSync(flag)).toBe(false);
    expect(stderr).not.toContain("memory continuation reset");
    expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(cursor);
    expect(resumed.prompt).not.toContain(REPLAY_MARK);
  }, 120_000);

  it("keeps the cursor of a first turn whose approvals tools never finished loading", async () => {
    const modelSelection = { instanceId: "claude-slow-tools", model: "claude-sonnet-5" };
    const created = await request("POST", "/api/bots", { name: "Slow tools", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    expect((await request("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);

    const first = await turn(bot, "remember the word EGRET-ONE");
    expect(first.prompt).toContain("did not finish loading");
    const cursor = first.argv[first.argv.indexOf("--session-id") + 1]!;
    await expect.poll(() => taskOf(bot)?.resumeCursors?.["claude-slow-tools"], { timeout: 10_000 }).toBe(cursor);

    await stop();
    await start();
    const resumed = await turn(bot, "second message");
    expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(cursor);
    expect(resumed.prompt).not.toContain(REPLAY_MARK);
  }, 120_000);
});
