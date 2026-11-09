import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 cut V5 (designs/NOLIMITS-V1-CUT.md, train 1.0.18): Claude's ask order. (a) On a No limits owner turn the
// broker holds an ask up to 2 s for the engine's own item.started of the same tool and input; past that the ask is opened
// with `itemUnseen: true` and the turn is marked. (b) On a marked lane turn the in-project shortcut does not take a path
// with a segment starting with `.` or a gate file; the ask goes on to the gate. Off the lane both are today's.
import { chmodSync, mkdtempSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver, CLAUDE_ASK_ITEM_WAIT_MS, claudeLaneShortcutSkip, claudeToolKey, permissionSocketPath, setClaudeLaneHooks, type ClaudeLaneState } from "./claude.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const HOLD = "Please wait.\n__fixture_hold_authority__";

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const conn = connect(path);
    conn.once("connect", () => resolve(conn));
    conn.once("error", reject);
  });
}

describe("V5 pure parts", () => {
  it("the tool key is the name and the input with sorted keys, so field order never splits one call", () => {
    expect(claudeToolKey("Bash", { command: "ls", description: "d" })).toBe(claudeToolKey("Bash", { description: "d", command: "ls" }));
    expect(claudeToolKey("Bash", { command: "ls" })).not.toBe(claudeToolKey("Bash", { command: "ls -a" }));
    expect(claudeToolKey("Read", { file_path: "/a" })).not.toBe(claudeToolKey("Write", { file_path: "/a" }));
  });
  it("(b) skips a dot segment inside the folder or a gate file; an ordinary in-project path is kept", () => {
    const cwd = "/w/proj";
    expect(claudeLaneShortcutSkip("Write", { file_path: "/w/proj/.claude/settings.json", content: "{}" }, cwd)).toBe(true);
    expect(claudeLaneShortcutSkip("Write", { file_path: "/w/proj/.env.example", content: "PORT=1" }, cwd)).toBe(true);
    expect(claudeLaneShortcutSkip("Edit", { file_path: "/w/proj/src/a.ts", old_string: "a", new_string: "b" }, cwd)).toBe(false);
    expect(claudeLaneShortcutSkip("Write", { file_path: "/w/proj/package.json", content: "{}" }, cwd)).toBe(false);
    expect(claudeLaneShortcutSkip("Write", { file_path: "/w/proj/node_modules/.bin/tool", content: "x" }, cwd)).toBe(true);
    expect(claudeLaneShortcutSkip("Write", { file_path: "/elsewhere/a.txt", content: "x" }, cwd)).toBe(true);
    expect(claudeLaneShortcutSkip("Grep", { pattern: "x" }, cwd)).toBe(false);
    // the folder itself sitting under a dot folder does not count: only the part inside it
    expect(claudeLaneShortcutSkip("Write", { file_path: "/home/s/.murage/bots/b/a.txt", content: "x" }, "/home/s/.murage/bots/b")).toBe(false);
  });
});

describe("V5 Claude ask order (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let lane: ClaudeLaneState = "off";
  const unseen: string[] = [];

  const create = async () => {
    instance = await ClaudeDriver.create({ instanceId: "claude-v5", displayName: "Claude V5", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
  };
  const ask = async (threadId: string, id: string, tool: string, input: Record<string, unknown>) => {
    await instance.adapter.sendTurn({ threadId, text: HOLD, cwd: scratch });
    await recorder.until((e) => e.type === "session.started");
    const conn = await connectSocket(permissionSocketPath(threadId));
    const sentAt = Date.now();
    conn.write(JSON.stringify({ t: "ask", id, tool, input }) + "\n");
    return { conn, sentAt };
  };
  const settledOrOpened = (id: string) =>
    recorder.until((e) => (e.type === "request.opened" || e.type === "request.resolved") && (e as { requestId?: string }).requestId === id, 6_000);

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-v5-"));
    lane = "off";
    unseen.length = 0;
    setClaudeLaneHooks({ laneMarked: () => lane, itemUnseen: (threadId) => { unseen.push(threadId); } });
  });
  afterEach(async () => {
    setClaudeLaneHooks(null);
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("V5-1 lane turn: an ask with no stdout item within 2 s opens with itemUnseen and marks the turn", async () => {
    lane = "clean";
    await create();
    const { conn, sentAt } = await ask("t-v5-unseen", "u1", "Bash", { command: "echo hi" });
    const opened = await settledOrOpened("u1");
    expect(opened.type).toBe("request.opened");
    expect(opened).toMatchObject({ itemUnseen: true });
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(CLAUDE_ASK_ITEM_WAIT_MS - 100);
    expect(unseen).toContain("t-v5-unseen");
    conn.destroy();
  }, 15_000);

  it("V5-1 off the lane: the same ask opens at once, with no itemUnseen and no mark (today's)", async () => {
    await create();
    const { conn, sentAt } = await ask("t-v5-off", "o1", "Bash", { command: "echo hi" });
    const opened = await settledOrOpened("o1");
    expect(opened.type).toBe("request.opened");
    expect((opened as { itemUnseen?: boolean }).itemUnseen).toBeUndefined();
    expect(Date.now() - sentAt).toBeLessThan(CLAUDE_ASK_ITEM_WAIT_MS - 500);
    expect(unseen).toEqual([]);
    conn.destroy();
  }, 15_000);

  it("V5-2 lane turn: the matching item first, then the ask: no wait, no extra mark", async () => {
    lane = "clean";
    process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ command: "echo seen" });
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-v5-seen", text: "__fixture_permission_tool__", cwd: scratch });
      const started = await recorder.until((e) => e.type === "item.started" && (e as { title?: string }).title === "Bash");
      const at = Date.now();
      const opened = await recorder.until((e) => e.type === "request.opened" && (e as { tool?: string }).tool === "Bash", 6_000);
      expect(started).toBeTruthy();
      expect((opened as { itemUnseen?: boolean }).itemUnseen).toBeUndefined();
      expect(Date.now() - at).toBeLessThan(CLAUDE_ASK_ITEM_WAIT_MS - 500);
      expect(unseen).toEqual([]);
      await instance.adapter.respondToRequest("t-v5-seen", (opened as { requestId: string }).requestId, { behavior: "deny" });
    } finally {
      delete process.env.FAKE_CLAUDE_PERM_INPUT;
    }
  }, 15_000);

  it("V5-3 marked lane turn: an in-project Write of a dot path goes on to the gate (a card)", async () => {
    lane = "marked";
    await create();
    const { conn } = await ask("t-v5-dot", "d1", "Write", { file_path: join(scratch, ".env.example"), content: "PORT=1" });
    const first = await settledOrOpened("d1");
    expect(first.type).toBe("request.opened");
    conn.destroy();
  }, 15_000);

  it("V5-3 off the lane (Auto, or any level but an owner No limits turn): the same Write takes today's shortcut", async () => {
    await create();
    const { conn } = await ask("t-v5-dot-off", "d2", "Write", { file_path: join(scratch, ".env.example"), content: "PORT=1" });
    const first = await settledOrOpened("d2");
    expect(first).toMatchObject({ type: "request.resolved", behavior: "allow", source: "auto" });
    conn.destroy();
  }, 15_000);

  it("V5-3 clean lane turn whose ask item never came: marked, so a dot path cards, an ordinary path keeps the shortcut", async () => {
    lane = "clean";
    await create();
    const { conn } = await ask("t-v5-dot-unseen", "d3", "Write", { file_path: join(scratch, ".env.example"), content: "PORT=1" });
    expect((await settledOrOpened("d3")).type).toBe("request.opened");
    conn.destroy();
    await instance.dispose();
    recorder.stop();
    await create();
    const plain = await ask("t-v5-plain-unseen", "p1", "Write", { file_path: join(scratch, "notes.txt"), content: "hello" });
    expect(await settledOrOpened("p1")).toMatchObject({ type: "request.resolved", behavior: "allow", source: "auto" });
    // the mark still lands although no card opened
    expect(unseen).toContain("t-v5-plain-unseen");
    plain.conn.destroy();
  }, 20_000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
