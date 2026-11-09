import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 V5 under load: the ask holds up to 2 s for its own stdout item. On a machine whose event loop stalls, the
// item can already sit in the pipe when the 2 s timer comes due. Real driver, fake CLI, no provider.
import { chmodSync, existsSync, mkdtempSync, readFileSync, stat, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver, CLAUDE_ASK_ITEM_WAIT_MS, permissionSocketPath, setClaudeLaneHooks } from "./claude.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const HOLD = "Please wait.\n__fixture_hold_authority__";
const INPUT = { command: "echo stall" };

const connectSocket = (path: string): Promise<Socket> => new Promise((resolve, reject) => {
  const conn = connect(path);
  conn.once("connect", () => resolve(conn));
  conn.once("error", reject);
});
/** Blocks this thread, and so the driver's event loop, for `ms`. */
const blockLoop = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe("V5 ask hold while the event loop stalls (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  const unseen: string[] = [];

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-v5-stall-"));
    unseen.length = 0;
    setClaudeLaneHooks({ laneMarked: () => "clean", itemUnseen: (threadId) => { unseen.push(threadId); } });
    process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify(INPUT);
    process.env.FAKE_CLAUDE_ITEM_WHEN_FILE = join(scratch, "item-now");
  });
  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_PERM_INPUT;
    delete process.env.FAKE_CLAUDE_ITEM_WHEN_FILE;
    setClaudeLaneHooks(null);
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  /** The ask is read and held, the item is written to the pipe, and the loop blocks for `stallMs` around that write. */
  const run = async (threadId: string, stallMs: number, from: "timer" | "immediate" | "io" = "io") => {
    instance = await ClaudeDriver.create({ instanceId: "claude-v5-stall", displayName: "Claude V5 stall", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId, text: HOLD, cwd: scratch });
    await recorder.until((e) => e.type === "session.started");
    await pause(300);
    const conn = await connectSocket(permissionSocketPath(threadId));
    const askAt = Date.now();
    conn.write(JSON.stringify({ t: "ask", id: "s1", tool: "Bash", input: INPUT }) + "\n");
    await pause(100); // the driver has read the ask: its 2 s hold is running
    const item = process.env.FAKE_CLAUDE_ITEM_WHEN_FILE!;
    let blockedAt = 0, unblockedAt = 0, writtenBeforeUnblock = false;
    await new Promise<void>((resolve) => {
      const go = () => {
        writeFileSync(item, "go");
        blockedAt = Date.now();
        blockLoop(stallMs);
        unblockedAt = Date.now();
        writtenBeforeUnblock = existsSync(`${item}.written`);
        resolve();
      };
      if (from === "timer") setTimeout(go, 0);
      else if (from === "immediate") setImmediate(go);
      else stat(scratch, go);
    });
    const opened = await recorder.until((e) => e.type === "request.opened" && (e as { requestId?: string }).requestId === "s1", 8_000) as { itemUnseen?: boolean };
    await recorder.until((e) => e.type === "item.started" && (e as { title?: string }).title === "Bash", 8_000);
    const writtenAt = Number(readFileSync(`${item}.written`, "utf8"));
    const row = { from, stallMs, itemUnseen: opened.itemUnseen === true, marked: unseen.includes(threadId), writtenBeforeUnblock, itemWrittenAfterAskMs: writtenAt - askAt, itemInPipeMsBeforeUnblock: unblockedAt - writtenAt, blockedMs: unblockedAt - blockedAt, holdMs: CLAUDE_ASK_ITEM_WAIT_MS };
    console.log(`V5-STALL ${JSON.stringify(row)}`);
    conn.destroy();
    return row;
  };

  /** NLMI-MARKS 6, T-V5-A/B/D: the ask is read and held; the loop is NOT blocked around the item (or blocked in many slices). */
  const hold = async (threadId: string, opts: { touch: boolean; delayMs?: number; slices?: number; sliceMs?: number }) => {
    if (opts.delayMs !== undefined) process.env.FAKE_CLAUDE_ITEM_DELAY_MS = String(opts.delayMs);
    const info = vi.spyOn(console, "info");
    instance = await ClaudeDriver.create({ instanceId: "claude-v5-stall", displayName: "Claude V5 stall", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId, text: HOLD, cwd: scratch });
    await recorder.until((e) => e.type === "session.started");
    await pause(300);
    const conn = await connectSocket(permissionSocketPath(threadId));
    conn.write(JSON.stringify({ t: "ask", id: "s1", tool: "Bash", input: INPUT }) + "\n");
    await pause(100);
    if (opts.touch) writeFileSync(process.env.FAKE_CLAUDE_ITEM_WHEN_FILE!, "go");
    for (let i = 0; i < (opts.slices ?? 0); i++) { await pause(1); blockLoop(opts.sliceMs ?? 0); }
    const opened = await recorder.until((e) => e.type === "request.opened" && (e as { requestId?: string }).requestId === "s1", 20_000) as { itemUnseen?: boolean };
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`approvals: v5-hold thread=${threadId} `));
    conn.destroy();
    delete process.env.FAKE_CLAUDE_ITEM_DELAY_MS;
    return { itemUnseen: opened.itemUnseen === true, hookCalled: unseen.includes(threadId), lines };
  };

  it("T-V5-A: a healthy loop and no item: the ask opens itemUnseen after about 2 s of readable time, one log line", async () => {
    const started = Date.now();
    const row = await hold("t-v5-a", { touch: false });
    expect(row.itemUnseen).toBe(true);
    expect(row.hookCalled).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(CLAUDE_ASK_ITEM_WAIT_MS);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]).toMatch(/^approvals: v5-hold thread=t-v5-a seen=0 readableMs=2000 wallMs=\d+ ticks=40 ceiling=0$/);
  }, 30_000);

  it("T-V5-B: a loop stalled in slices past the 10 s ceiling, the item written at 11 s: ceiling, itemUnseen, one line", async () => {
    const row = await hold("t-v5-b", { touch: true, delayMs: 11_000, slices: 12, sliceMs: 900 });
    expect(row.itemUnseen).toBe(true);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]).toMatch(/seen=0 readableMs=\d+ wallMs=\d+ ticks=\d+ ceiling=1$/);
    expect(row.lines[0]).not.toContain("echo");
  }, 40_000);

  it("T-V5-D: a seen item writes one line with seen=1 and no call text", async () => {
    const row = await hold("t-v5-d", { touch: true });
    expect(row.itemUnseen).toBe(false);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]).toMatch(/^approvals: v5-hold thread=t-v5-d seen=1 readableMs=\d+ wallMs=\d+ ticks=\d+ ceiling=0$/);
    expect(row.lines[0]).not.toContain("stall");
  }, 30_000);

  it("control: a stall shorter than the hold, item in the pipe: no mark", async () => {
    const row = await run("t-v5-stall-short", 800);
    expect(row.writtenBeforeUnblock).toBe(true);
    expect(row.itemUnseen).toBe(false);
    expect(row.marked).toBe(false);
  }, 30_000);

  it.each(["timer", "immediate", "io"] as const)("a stall past the hold from a %s callback, the item already in the pipe before the loop can read: no mark", async (from) => {
    const row = await run(`t-v5-stall-long-${from}`, CLAUDE_ASK_ITEM_WAIT_MS + 600, from);
    expect(row.writtenBeforeUnblock).toBe(true);
    expect(row.itemInPipeMsBeforeUnblock).toBeGreaterThan(CLAUDE_ASK_ITEM_WAIT_MS);
    expect(row.itemUnseen).toBe(false);
    expect(row.marked).toBe(false);
  }, 30_000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
