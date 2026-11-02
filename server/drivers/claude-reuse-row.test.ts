// The fake reuse gate row (ENGINE-PERSIST design section 6). A stdio server slow enough
// to be in the init baseline forks one child and never waits for it. Real process
// listing, real settle probe: after one cold turn the next five must find the engine.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { reuseStats } from "./reuse-stats.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("reuse gate row (fake CLI, real ps)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let dispatches: string[];
  let info: ReturnType<typeof vi.spyOn>;
  const sessions = new Map<string, string>();
  const extra = {
    integrations: { agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_BOT_ID: "b1", MURAGE_COMMS_TOKEN: "tok", MURAGE_TURN_DEPTH: "0" } } },
    warmIdentity: { botId: "b1", audience: "owner" as const },
  } satisfies Partial<SendTurnInput>;
  const run = async (threadId: string, text: string, more: Partial<SendTurnInput> = {}) => {
    const sent = await instance.adapter.sendTurn({ threadId, text, ...(sessions.has(threadId) ? { resumeCursor: sessions.get(threadId) } : {}), ...extra, ...more });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const started = [...recorder.events].reverse().find((e) => e.type === "session.started" && e.threadId === threadId) as { sessionId?: string } | undefined;
    if (started?.sessionId) sessions.set(threadId, started.sessionId);
    return dispatches.at(-1) ?? "";
  };

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    sessions.clear();
    dispatches = [];
    scratch = mkdtempSync(join(tmpdir(), "murage-reuse-row-"));
    process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.startsWith("claude dispatch")) dispatches.push(line);
    });
    instance = await ClaudeDriver.create({
      instanceId: "claude-reuse-row", displayName: "Claude Reuse Row", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  });
  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_SLOW_SERVER;
    delete process.env.CLAUDE_CONFIG_DIR;
    info.mockRestore();
    recorder.stop();
    await instance.dispose();
    await removeTempDir(scratch);
  });

  it("unsealed thread, a server that leaves a zombie: at least 4 of 5 repeat turns are hot", async () => {
    process.env.FAKE_CLAUDE_SLOW_SERVER = "zombie";
    const before = reuseStats.snapshot();
    await run("t-row", "cold");
    await pause(900); // the server's child has exited and stays a zombie from here on
    const lines: string[] = [];
    for (let turn = 1; turn <= 5; turn++) {
      lines.push(await run("t-row", `repeat ${turn}`));
      await pause(200); // the settle probe answers before the next turn
    }
    const after = reuseStats.snapshot();
    expect(lines.filter((line) => line.includes("process=reused")).length).toBeGreaterThanOrEqual(4);
    expect(after.repeatTurns - before.repeatTurns).toBe(5);
    expect(after.hotRepeatTurns - before.hotRepeatTurns).toBeGreaterThanOrEqual(4);
    expect(Object.keys(after.spares.lost).filter((reason) => /spare limit|intent|background turn/.test(reason))).toEqual([]);
  }, 40_000);

  it("the negative: a server's live child still recycles the engine", async () => {
    process.env.FAKE_CLAUDE_SLOW_SERVER = "live";
    await run("t-live", "cold");
    await pause(900); // the server's child is running from here on
    expect(await run("t-live", "two")).toContain("process=reused");
    await pause(600); // its settle probe saw the child and closed the engine
    expect(await run("t-live", "three")).toContain("process=spawned");
  }, 40_000);

  it("a sealed thread is counted cold and printed, never left out", async () => {
    const before = reuseStats.snapshot();
    await run("t-sealed", "one", { sealed: true });
    await instance.adapter.resetSession!("t-sealed", { route: "sealed" });
    const second = await run("t-sealed", "two", { sealed: true });
    const after = reuseStats.snapshot();
    expect(second).toContain("process=spawned");
    expect(after.sealedTurns - before.sealedTurns).toBe(2);
    expect(after.hotRepeatTurns).toBe(before.hotRepeatTurns);
    expect(after.repeatTurns - before.repeatTurns).toBe(1);
  }, 20_000);
});
