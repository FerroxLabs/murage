// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-N (179) GATE: a bot that runs the same command and gets the same failure five times is told once, mid-turn,
// through the lineage steer path, on every engine that can be steered; every other engine keeps only the chip. The
// start and completion shapes below are the ones each driver emits (design SL-MN 0b: claude.ts:3355/:3374,
// codex.ts:1711/:1761, acp/core.ts:3288-3334, pi.ts:1051-1073).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "./contracts.ts";
import { LOOP_NUDGE_NOTE, callArgs, createLoopNudge, loopCallKey, loopFailureText } from "./loop-nudge.ts";

const T = "thread-1";
let seq = 0;
const base = (itemId?: string) => ({ eventId: `e${++seq}`, provider: "claude" as const, threadId: T, createdAt: "2026-10-20T00:00:00Z", ...(itemId ? { itemId } : {}) });
type Start = { title?: string; input?: unknown; toolIdentity?: { name?: string } };
type Done = { ok: boolean; result?: unknown; detail?: string };
const started = (itemId: string, start: Start) => ({ ...base(itemId), type: "item.started", itemType: "tool", origin: "engine", ...start }) as RuntimeEvent;
const completed = (itemId: string, done: Done) => ({ ...base(itemId), type: "item.completed", itemType: "tool", ...done }) as RuntimeEvent;

// the real shapes, per engine
const claudeBash = (description: string, command = "npm test"): Start => ({ title: "Bash", input: { command, description } });
const claudeFail: Done = { ok: false, result: [{ type: "text", text: "Error: Cannot find module 'x'" }] };
const codexCommand: Start = { title: "npm run build", toolIdentity: { name: "shell" }, input: undefined };
const codexFail: Done = { ok: false, result: { exitCode: 1 } };
const acpShell: Start = { title: "curl -f http://localhost:3000/health", toolIdentity: { name: "run_shell_command" }, input: { command: "curl -f http://localhost:3000/health" } };
const acpFail: Done = { ok: false, result: { exitCode: 7 }, detail: "curl: (7) Failed to connect to localhost port 3000" };
const piRead: Start = { title: "read", toolIdentity: { name: "read" }, input: { path: "src/missing.ts" } };
const piFail: Done = { ok: false, result: { content: [] }, detail: "ENOENT: no such file or directory, open 'src/missing.ts'" };

type Answer = boolean | "delivered" | "rejected" | "uncertain";
function rig(opts: { steer?: (beforeWrite?: () => void) => Promise<Answer>; steerable?: boolean } = {}) {
  const flags = { watching: true, waiting: false, stopping: false };
  const rows: string[] = [];
  const logs: string[] = [];
  const steer = vi.fn(async (_threadId: string, _text: string, beforeWrite?: () => void) => {
    if (opts.steer) return opts.steer(beforeWrite);
    beforeWrite?.();
    return true as Answer;
  });
  const adapter = opts.steerable === false ? { capabilities: {} } : { capabilities: { queueing: true }, steer };
  const nudge = createLoopNudge({
    watching: () => flags.watching,
    waitingOnHuman: () => flags.waiting,
    stopping: () => flags.stopping,
    adapter: () => adapter,
    record: (threadId) => rows.push(threadId),
    log: (line) => logs.push(line),
    waitMs: 20,
  });
  let n = 0;
  /** One call: start then complete. Returns the note's pending send, if one started. */
  const call = (start: Start, done: Done) => {
    const id = `item-${++n}`;
    nudge.observe(started(id, start));
    return nudge.observe(completed(id, done));
  };
  const fail = async (times: number, start: Start, done: Done) => { for (let i = 0; i < times; i++) await call(start, done); };
  return { nudge, call, fail, steer, rows, logs, flags };
}

describe("loop nudge keys (one key per call, on every engine)", () => {
  it("Claude's Bash keys on the command alone, whatever the description says", () => {
    expect(loopCallKey(claudeBash("Run the tests"))).toBe("Bash:npm test");
    expect(loopCallKey(claudeBash("Try the tests again"))).toBe("Bash:npm test");
    expect(loopCallKey(claudeBash("x", "npm run lint"))).not.toBe(loopCallKey(claudeBash("x")));
    // a Read keys on its canonical input, keys sorted
    expect(loopCallKey({ title: "Read", input: { limit: 10, file_path: "/a.ts" } })).toBe(loopCallKey({ title: "Read", input: { file_path: "/a.ts", limit: 10 } }));
  });
  it("Codex keys on the command title (no input); an MCP call on its name and arguments", () => {
    expect(loopCallKey(codexCommand)).toBe("shell:npm run build");
    expect(loopCallKey({ title: "search_docs", toolIdentity: { name: "search_docs" }, input: { q: "routines" } })).toBe('search_docs:{"q":"routines"}');
  });
  it("ACP keys on the identity and rawInput.command, a wrapper on its inner input", () => {
    expect(loopCallKey(acpShell)).toBe("run_shell_command:curl -f http://localhost:3000/health");
    expect(callArgs({ tool_name: "fetch", tool_input: { url: "https://x" } }, "use_tool")).toBe('{"url":"https://x"}');
  });
  it("pi keys on toolName and args", () => {
    expect(loopCallKey(piRead)).toBe('read:{"path":"src/missing.ts"}');
  });
  it("a bare title with no input never counts, and a long command is never cut", () => {
    expect(loopCallKey({ title: "Bash" })).toBeNull();
    expect(loopCallKey({ title: "Bash", input: {} })).toBeNull();
    expect(loopCallKey({ title: "ls", toolIdentity: { name: "shell" } })).toBeNull();
    const long = `node -e "${"x".repeat(300)}"`;
    expect(loopCallKey(claudeBash("d", long))).toBe(`Bash:${long}`);
  });
  it("the failure text is detail, else the result text; cut or empty text is refused", () => {
    expect(loopFailureText(claudeFail)).toBe("Error: Cannot find module 'x'");
    expect(loopFailureText({ result: "boom" })).toBe("boom");
    expect(loopFailureText(acpFail)).toBe(acpFail.detail);
    expect(loopFailureText({ detail: "partial\n…" })).toBeUndefined();
    expect(loopFailureText({ detail: "e".repeat(4000) })).toBeUndefined();
    expect(loopFailureText({ result: "  " })).toBeUndefined();
    expect(loopFailureText(codexFail)).toBe("exit 1");
    expect(loopFailureText({ result: { exitCode: 0 } })).toBeUndefined();
    expect(loopFailureText({ result: { content: [] } })).toBeUndefined();
  });
});

describe("loop nudge (SL-N GATE)", () => {
  it("Claude: 5 identical failures send one note through steerBusyDesk and record one activity row", async () => {
    const r = rig();
    for (let i = 0; i < 4; i++) await r.call(claudeBash(`attempt ${i}`), claudeFail);
    expect(r.steer).not.toHaveBeenCalled();
    await r.call(claudeBash("attempt 5"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
    expect(r.steer.mock.calls[0]![0]).toBe(T);
    expect(r.steer.mock.calls[0]![1]).toBe(LOOP_NUDGE_NOTE);
    expect(r.rows).toEqual([T]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/\([0-9a-f]{8}\)$/);
    expect(r.logs[0]).not.toContain("npm test");
    await r.fail(10, claudeBash("again"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
  });

  it("ACP (Fuigo): the same rule on rawInput.command and detail", async () => {
    const r = rig();
    await r.fail(5, acpShell, acpFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
    expect(r.rows).toHaveLength(1);
  });

  it("an engine without steer gets no note (the chip is unchanged): Codex, grok/opencode-style ACP, pi", async () => {
    for (const [start, done] of [[codexCommand, { ok: false, result: "exit 1: build failed" }], [acpShell, acpFail], [piRead, piFail]] as Array<[Start, Done]>) {
      const r = rig({ steerable: false });
      await r.fail(6, start, done);
      expect(r.rows).toEqual([]);
    }
  });

  it("a completion is matched to its own start by itemId; an unknown itemId never counts", async () => {
    const r = rig();
    for (let i = 0; i < 6; i++) await r.nudge.observe(completed(`stray-${i}`, claudeFail));
    expect(r.steer).not.toHaveBeenCalled();
    // two calls interleaving: separate keys, neither reaches five
    for (let i = 0; i < 4; i++) { await r.call(claudeBash("a"), claudeFail); await r.call(claudeBash("b", "npm run lint"), claudeFail); }
    expect(r.steer).not.toHaveBeenCalled();
  });

  it("different failure text is a different streak", async () => {
    const r = rig();
    for (let i = 0; i < 6; i++) await r.call(claudeBash("d"), { ok: false, result: `Error at line ${i}` });
    expect(r.steer).not.toHaveBeenCalled();
  });

  it("cut failure text never counts", async () => {
    const r = rig();
    await r.fail(6, acpShell, { ok: false, detail: "very long output\n…" });
    await r.fail(6, acpShell, { ok: false, detail: "z".repeat(4000) });
    expect(r.steer).not.toHaveBeenCalled();
  });

  it("a success resets that call's streak; a second streak notes again; a third is capped", async () => {
    const r = rig();
    await r.fail(4, claudeBash("d"), claudeFail);
    await r.call(claudeBash("d"), { ok: true, result: "ok" });
    await r.fail(4, claudeBash("d"), claudeFail);
    expect(r.steer).not.toHaveBeenCalled();
    await r.call(claudeBash("d"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
    await r.call(claudeBash("d"), { ok: true, result: "ok" });
    await r.fail(5, claudeBash("d"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(2);
    await r.call(claudeBash("d"), { ok: true, result: "ok" });
    await r.fail(5, claudeBash("d"), claudeFail);
    await r.fail(5, acpShell, acpFail);
    expect(r.steer).toHaveBeenCalledTimes(2);
    expect(r.rows).toHaveLength(2);
  });

  it("Codex: 5 x {exitCode:1} on the same command counts; exit 0 or no exitCode never does", async () => {
    const r = rig();
    await r.fail(5, codexCommand, codexFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
    const zero = rig();
    await zero.fail(6, codexCommand, { ok: false, result: { exitCode: 0 } });
    await zero.fail(6, codexCommand, { ok: false, result: {} });
    expect(zero.steer).not.toHaveBeenCalled();
  });

  it("a stopped turn's late turn.completed leaves the new turn's count alone", async () => {
    const r = rig();
    const inTurn = (turnId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const id = `${turnId}-${i}-${++seq}`;
        r.nudge.observe({ ...started(id, claudeBash("d")), turnId } as RuntimeEvent);
        r.nudge.observe({ ...completed(id, claudeFail), turnId } as RuntimeEvent);
      }
    };
    inTurn("B", 4);
    r.nudge.observe({ ...base(), type: "turn.completed", turnId: "A" } as RuntimeEvent);
    inTurn("B", 1);
    expect(r.steer).toHaveBeenCalledTimes(1);
  });

  it("failures never carry from one turn into the next", async () => {
    const r = rig();
    const inTurn = (turnId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const id = `${turnId}-${i}-${++seq}`;
        r.nudge.observe({ ...started(id, claudeBash("d")), turnId } as RuntimeEvent);
        r.nudge.observe({ ...completed(id, claudeFail), turnId } as RuntimeEvent);
      }
    };
    inTurn("A", 3);
    inTurn("B", 2);
    expect(r.steer).not.toHaveBeenCalled();
    inTurn("B", 3);
    expect(r.steer).toHaveBeenCalledTimes(1);
    // the matching completion still settles its own turn
    r.nudge.observe({ ...base(), type: "turn.completed", turnId: "B" } as RuntimeEvent);
    inTurn("C", 4);
    expect(r.steer).toHaveBeenCalledTimes(1);
  });

  it("the turn's end settles it: counting starts again", async () => {
    const r = rig();
    await r.fail(4, claudeBash("d"), claudeFail);
    r.nudge.observe({ ...base(), type: "turn.completed" } as RuntimeEvent);
    await r.fail(4, claudeBash("d"), claudeFail);
    expect(r.steer).not.toHaveBeenCalled();
    r.nudge.observe({ ...base(), type: "session.exited" } as RuntimeEvent);
    await r.fail(5, claudeBash("d"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
  });

  it("the fifth failure while a person has a card open skips; the sixth after it closes sends", async () => {
    const r = rig();
    await r.fail(4, claudeBash("d"), claudeFail);
    r.flags.waiting = true;
    await r.call(claudeBash("d"), claudeFail);
    expect(r.steer).not.toHaveBeenCalled();
    r.flags.waiting = false;
    await r.call(claudeBash("d"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
  });

  it("a stopping run, or a turn the watchdog is not watching, gets no note", async () => {
    const stopping = rig();
    stopping.flags.stopping = true;
    await stopping.fail(6, claudeBash("d"), claudeFail);
    expect(stopping.steer).not.toHaveBeenCalled();
    const unwatched = rig();
    unwatched.flags.watching = false;
    await unwatched.fail(6, claudeBash("d"), claudeFail);
    expect(unwatched.steer).not.toHaveBeenCalled();
  });

  it("a refused steer is dropped: one note, no row, never queued, never retried", async () => {
    const r = rig({ steer: async () => false });
    await r.fail(12, claudeBash("d"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
    expect(r.rows).toEqual([]);
  });

  it("an uncertain steer is noted once with no row", async () => {
    const r = rig({ steer: async (beforeWrite) => { beforeWrite?.(); return "uncertain"; } });
    await r.fail(12, claudeBash("d"), claudeFail);
    expect(r.steer).toHaveBeenCalledTimes(1);
    expect(r.rows).toEqual([]);
  });

  it("a late answer after the fence: delivered records the row once; rejected records nothing", async () => {
    let settle!: (answer: Answer) => void;
    const late = rig({ steer: (beforeWrite) => { beforeWrite?.(); return new Promise<Answer>((resolve) => { settle = resolve; }); } });
    await late.fail(5, claudeBash("d"), claudeFail);
    expect(late.rows).toEqual([]);
    await late.fail(5, claudeBash("d"), claudeFail);
    settle("delivered");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(late.steer).toHaveBeenCalledTimes(1);
    expect(late.rows).toEqual([T]);

    let refuse!: (answer: Answer) => void;
    const lateNo = rig({ steer: (beforeWrite) => { beforeWrite?.(); return new Promise<Answer>((resolve) => { refuse = resolve; }); } });
    await lateNo.fail(5, claudeBash("d"), claudeFail);
    refuse(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lateNo.rows).toEqual([]);
    expect(lateNo.steer).toHaveBeenCalledTimes(1);
  });

  it("a steer that never reaches the fence within the wait is dropped (queue): nothing is written later", async () => {
    let write!: () => void;
    const r = rig({ steer: (beforeWrite) => new Promise<Answer>((resolve) => { write = () => { try { beforeWrite?.(); resolve(true); } catch { resolve(false); } }; }) });
    await r.fail(5, claudeBash("d"), claudeFail);
    write();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.rows).toEqual([]);
    expect(r.steer).toHaveBeenCalledTimes(1);
  });

  it("the module sends only through steerBusyDesk with a fixed note on none and never queues", () => {
    const source = readFileSync(join(import.meta.dirname, "loop-nudge.ts"), "utf8");
    expect(source).toContain('buildPrompt(undefined, [promptPart(LOOP_NUDGE_NOTE, [noneRef("murage")])])');
    expect(source.split("steerBusyDesk(").length - 1).toBe(1);
    expect(source).not.toMatch(/\.steer\(|owner_send|enqueue|appendMessage|database\(/);
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain("void loopNudge.observe(event);");
    expect(index).toContain('stopping: (threadId) => directRuns.get(threadId)?.phase === "stopping",');
    expect(index).toContain("waitingOnHuman: (threadId) => watchdog.waitingOnHuman(threadId),");
  });
});
