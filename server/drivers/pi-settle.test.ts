// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When a Pi turn is really over (designs/PI-SETTLE-AGENT-END-1013.md). The frame orders below are recorded from
// real pi 1.4.0 (scenario names match reports-1012/pi-settle/r2-evidence).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { PI_TURN_MIN, PiDriver } from "./pi.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
type Frame = Record<string, unknown>;
const usage = (input: number, output: number) => ({ input, output });
const text = (delta: string): Frame => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
const opened: Frame = { type: "message_start", message: { role: "assistant" } };
const ended = (stopReason: string, extra: Frame = {}): Frame => ({ type: "message_end", message: { role: "assistant", stopReason, ...extra } });
const turnEnd = (stopReason: string, extra: Frame = {}): Frame => ({ type: "turn_end", message: { role: "assistant", stopReason, ...extra }, toolResults: [] });
const agentEnd = (willRetry = false): Frame => ({ type: "agent_end", willRetry });
const settledFrame = (aborted = false): Frame => ({ type: "agent_settled", aborted });
const start: Frame[] = [{ type: "agent_start" }, { type: "turn_start" }, opened];
const done = (reply: string, u = usage(10, 2)): Frame[] => [opened, text(reply), ended("stop", { usage: u }), turnEnd("stop", { usage: u }), agentEnd(), settledFrame()];
const retryStart = (attempt: number, errorMessage = "500: upstream failed"): Frame => ({ type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 2000, errorMessage });

const scratch: string[] = [];
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose().catch(() => {});
  instance = undefined;
  for (const dir of scratch.splice(0)) removeTempDirSync(dir);
});
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "murage-pi-settle-")); scratch.push(dir); return dir; };
const create = async (environment: Record<string, string>, cli = FAKE_CLI, config: { fullAuto?: boolean } = {}) => {
  instance = await PiDriver.create({ instanceId: "pi-settle", displayName: "Pi", environment, enabled: true, config: { cli, fullAuto: config.fullAuto ?? false } });
  recorder = recordEvents(instance.adapter);
  return instance;
};
/** One turn over a recorded frame order; resolves at its one terminal event. */
const playTurn = async (frames: Frame[], environment: Record<string, string> = {}) => {
  const dir = tempDir(), script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify(frames));
  await create({ FAKE_PI_SCRIPT: script, ...environment });
  const { turnId } = await instance!.adapter.sendTurn({ threadId: `t-${Math.random().toString(36).slice(2)}`, text: "go" });
  const completed = await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  return { turnId, completed };
};
const ofType = <T extends RuntimeEvent["type"]>(type: T) => recorder!.events.filter((e) => e.type === type) as Array<Extract<RuntimeEvent, { type: T }>>;
const replies = () => ofType("item.completed").filter((e) => e.itemType === "assistant_text").map((e) => (e as { text: string }).text);
const errors = () => ofType("runtime.error").map((e) => e.message);
const dumpRows = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { uiResponse?: { id: string; cancelled?: boolean } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("a turn ends at agent_settled, with its result read from the last assistant message", () => {
  it("tool calls with finish_reason stop reach the second round's reply (tool_finish_stop)", async () => {
    const { completed } = await playTurn([...start, ended("stop", { usage: usage(5, 1) }),
      { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} }, { type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false },
      turnEnd("stop", { usage: usage(5, 1) }), { type: "turn_start" }, ...done("the reply")]);
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 15, output: 3 } });
    expect(replies()).toEqual(["the reply"]);
  });

  it("a retry that succeeds is one reply and no error, with no reset when nothing streamed (retry_then_ok)", async () => {
    const { completed } = await playTurn([...start, ended("error", { errorMessage: "500: upstream failed" }), turnEnd("error"), agentEnd(true), retryStart(1), { type: "agent_start" }, ...done("whole"), { type: "auto_retry_end", success: true }]);
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(replies()).toEqual(["whole"]);
    expect(errors()).toEqual([]);
    expect(ofType("content.reset")).toEqual([]);
    expect(ofType("turn.retrying")).toMatchObject([{ attempt: 1, delayMs: 2000, maxAttempts: 4, reason: "server_error" }]);
    expect(JSON.stringify(ofType("turn.retrying"))).not.toContain("upstream failed");
  });

  it("a retry replaces the part text of the failed attempt, once for each stream (partial_break_retry)", async () => {
    await playTurn([...start, text("half"), ended("error", { errorMessage: "terminated" }), turnEnd("error"), agentEnd(true), retryStart(1, "terminated"), { type: "agent_start" }, ...done("whole")]);
    expect(replies()).toEqual(["whole"]);
    expect(ofType("content.reset").map((e) => e.streamKind).sort()).toEqual(["assistant_text", "reasoning_text"]);
  });

  it("a reset keeps an earlier committed round (tool_then_partial_then_ok)", async () => {
    await playTurn([...start, text("first"), ended("toolUse"), { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} }, { type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false }, turnEnd("toolUse"),
      { type: "turn_start" }, opened, text("half"), ended("error", { errorMessage: "terminated" }), turnEnd("error"), agentEnd(true), retryStart(1, "terminated"), { type: "agent_start" }, ...done("whole")]);
    expect(replies()).toEqual(["first", "whole"]);
  });

  it("retries used up report exactly one error, after the last attempt (retry_exhausted)", async () => {
    const failed = [opened, ended("error", { errorMessage: "500: upstream failed" }), turnEnd("error")];
    const { completed } = await playTurn([...start.slice(0, 2), ...failed, agentEnd(true), retryStart(1), { type: "agent_start" }, ...failed, agentEnd(false), { type: "auto_retry_end", success: false }, settledFrame()]);
    expect(completed).toMatchObject({ ok: false, stopReason: "failed" });
    expect(errors()).toEqual(["500: upstream failed"]);
  });

  it("recovery with no auto_retry_start: the cut text is replaced and no error shows (w_length_recover)", async () => {
    const { completed } = await playTurn([...start, text("cut re"), ended("length"), turnEnd("length"), agentEnd(), { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", result: {}, aborted: false, willRetry: true }, { type: "agent_start" }, { type: "turn_start" }, ...done("full reply")]);
    expect(completed).toMatchObject({ ok: true });
    expect(replies()).toEqual(["full reply"]);
    expect(errors()).toEqual([]);
    expect(recorder!.events.some((e) => e.type === "item.started" && (e as { title?: string }).title === "compact")).toBe(true);
  });

  it("a reply cut with no compaction event fails with its text kept (length_recover, 1.4.0 and 0.80.5)", async () => {
    const { completed } = await playTurn([...start, text("cut re"), ended("length"), turnEnd("length"), agentEnd(), settledFrame()]);
    expect(completed).toMatchObject({ ok: false, stopReason: "failed" });
    expect(replies()).toEqual(["cut re"]);
    expect(errors()).toEqual(["This reply stopped at the model's length limit, so it is not complete. Ask Pi to continue, or choose a model with a longer limit."]);
  });

  it("a failed recovery keeps the text and shows one error (w_length_twice)", async () => {
    const { completed } = await playTurn([...start, text("cut re"), ended("length"), turnEnd("length"), agentEnd(), { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "Truncated response recovery failed after one compact-and-retry attempt." }, settledFrame()]);
    expect(completed).toMatchObject({ ok: false });
    expect(replies()).toEqual(["cut re"]);
    expect(errors()).toEqual(["Truncated response recovery failed after one compact-and-retry attempt."]);
  });

  it("compaction after a finished reply runs to its end and never fails the turn (threshold_compact_fails)", async () => {
    const { completed } = await playTurn([...start, text("reply"), ended("stop"), turnEnd("stop"), agentEnd(), { type: "compaction_start", reason: "threshold" }, { type: "wait", wait: 50 }, { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, errorMessage: "nope" }, settledFrame()]);
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(errors()).toEqual([]);
  });

  it("slow hooks between the events do not end the turn (ext_slow_agent_end)", async () => {
    const { completed } = await playTurn([...start, text("reply"), ended("stop"), turnEnd("stop"), { wait: 200 }, agentEnd(), { wait: 200 }, settledFrame()]);
    expect(completed).toMatchObject({ ok: true });
    expect(completed.createdAt).toBeTruthy();
    expect(ofType("turn.completed")).toHaveLength(1);
  });

  it("a repeated agent_settled adds nothing", async () => {
    await playTurn([...start, ...done("reply").slice(1), settledFrame()]);
    await settle();
    expect(ofType("turn.completed")).toHaveLength(1);
    expect(replies()).toEqual(["reply"]);
  });

  it.each([["no assistant message", []], ["toolUse", [ended("toolUse")]], ["pending", [ended("pending")]], ["deferred", [ended("deferred")]]])("agent_settled after %s is a failure, never success", async (_name, frames) => {
    const { completed } = await playTurn([{ type: "agent_start" }, ...(frames as Frame[]), settledFrame()]);
    expect(completed).toMatchObject({ ok: false, stopReason: "failed" });
    expect(errors()).toEqual(["Pi could not finish this turn."]);
  });

  it("aborted with a last error message reads cancelled (abort_in_tool)", async () => {
    const { completed } = await playTurn([...start, ended("error", { errorMessage: "This operation was aborted" }), { type: "agent_settled", aborted: true }]);
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(errors()).toEqual([]);
  });
});

describe("a prompt pi does not run", () => {
  it.each([
    ["No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.", "No API key found for the selected model"],
    ["No model selected.", "No model selected"],
  ])("a refused prompt is one error, at once: %s", async (error, reason) => {
    const { completed } = await playTurn([], { FAKE_PI_PROMPT_RESPONSE: JSON.stringify({ success: false, error }) });
    expect(completed).toMatchObject({ ok: false, stopReason: "failed" });
    expect(errors()).toEqual([`Pi did not take this message: ${reason}. Check this bot's engine and model in Settings, then send it again.`]);
  });

  it("a handled prompt ends at once and reads as a finished turn (ext_input_handled)", async () => {
    const { completed } = await playTurn([], { FAKE_PI_PROMPT_RESPONSE: JSON.stringify({ data: { disposition: "handled" } }) });
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
  });
});

describe("a pi that goes away", () => {
  it("a crash after the reply and before agent_settled fails, reply and usage kept (ext_exit_agent_end)", async () => {
    const { completed } = await playTurn([...start, text("reply"), ended("stop", { usage: usage(7, 2) }), turnEnd("stop", { usage: usage(7, 2) }), { exit: 7 }]);
    expect(completed).toMatchObject({ ok: false, stopReason: "failed", usage: { input: 7, output: 2 } });
    expect(replies()).toEqual(["reply"]);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatch(/exit code 7/);
  });

  it("a crash after a message_end and before its turn_end keeps that usage", async () => {
    const { completed } = await playTurn([...start, ended("toolUse", { usage: usage(9, 4) }), { exit: 3 }]);
    expect(completed).toMatchObject({ ok: false, usage: { input: 9, output: 4 } });
  });

  it("a round reported at both message_end and turn_end counts once", async () => {
    const { completed } = await playTurn(start.concat(done("reply", usage(6, 2)).slice(1)));
    expect(completed).toMatchObject({ ok: true, usage: { input: 6, output: 2 } });
  });

  it("stdout end, then close inside the bound, keeps the exit line", async () => {
    const { completed } = await playTurn([...start, text("part"), { closeStdout: true }, { exit: 1 }]);
    expect(completed).toMatchObject({ ok: false });
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatch(/exit code 1/);
  });
});

describe("Stop", () => {
  it("answers an open gate card so the abort finishes inside its grace, and no tool runs", async () => {
    const dir = tempDir(), dump = join(dir, "dump.jsonl");
    await create({ FAKE_PI_MODE: "gate", FAKE_PI_DUMP: dump, FAKE_PI_ABORT_MS: "50" });
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-stop-card", text: "go" });
    await recorder!.until((e) => e.type === "request.opened");
    await instance!.adapter.interruptTurn("t-stop-card", turnId);
    expect(dumpRows(dump).filter((row) => row.uiResponse?.id === "ask-host")).toMatchObject([{ uiResponse: { cancelled: true } }]);
    expect(ofType("turn.completed")).toMatchObject([{ ok: true, stopReason: "cancelled" }]);
    expect(recorder!.events.filter((e) => e.type === "item.started")).toEqual([]);
    expect(await instance!.adapter.respondToRequest("t-stop-card", "ask-host", { behavior: "allow" })).toBe("unavailable");
  });

  it("a dialog in the abort grace is cancelled and opens no card", async () => {
    const dir = tempDir(), dump = join(dir, "dump.jsonl");
    await create({ FAKE_PI_MODE: "gate", FAKE_PI_DUMP: dump, FAKE_PI_ABORT_MS: "150", FAKE_PI_ABORT_DIALOG: "1" });
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-stop-late", text: "go" });
    await recorder!.until((e) => e.type === "request.opened");
    await instance!.adapter.interruptTurn("t-stop-late", turnId);
    expect(dumpRows(dump).filter((row) => row.uiResponse?.id === "ask-late")).toMatchObject([{ uiResponse: { cancelled: true } }]);
    expect(ofType("request.opened")).toHaveLength(1);
  });

  it("Stop during compaction after the reply keeps the reply and the usage (abort_after_turn_end)", async () => {
    const dir = tempDir(), script = join(dir, "s.json");
    writeFileSync(script, JSON.stringify([...start, text("reply"), ended("stop", { usage: usage(4, 1) }), turnEnd("stop", { usage: usage(4, 1) }), agentEnd(), { type: "compaction_start", reason: "threshold" }]));
    await create({ FAKE_PI_SCRIPT: script });
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-stop-compact", text: "go" });
    await recorder!.until((e) => e.type === "item.started");
    await instance!.adapter.interruptTurn("t-stop-compact", turnId);
    expect(ofType("turn.completed")).toMatchObject([{ ok: true, stopReason: "cancelled", usage: { input: 4, output: 1 } }]);
    expect(replies()).toEqual(["reply"]);
  });

  it("a late delta, tool and dialog after the turn closed emit nothing", async () => {
    const dir = tempDir(), script = join(dir, "s.json");
    writeFileSync(script, JSON.stringify([...start, text("reply"), ...done("x").slice(2), text("late"), { type: "tool_execution_start", toolCallId: "c9", toolName: "read", args: {} }]));
    await create({ FAKE_PI_SCRIPT: script });
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-late", text: "go" });
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    await settle();
    const at = recorder!.events.findIndex((e) => e.type === "turn.completed");
    expect(recorder!.events.slice(at + 1)).toEqual([]);
  });
});

describe("the Pi floor", () => {
  /** A pi of this version on a path of its own: the version cache is per file. */
  const oldPi = (version: string) => {
    const dir = tempDir(), cli = join(dir, "pi");
    writeFileSync(cli, `#!/bin/sh\nFAKE_PI_VERSION=${version} exec ${JSON.stringify(FAKE_CLI)} "$@"\n`, { mode: 0o755 });
    invalidateCliVersions();
    return cli;
  };

  it("the floor is the first pi that reports agent_settled", () => {
    expect(PI_TURN_MIN).toEqual([0, 80, 5]);
  });

  it("below the floor the engine reads as needing an update, and its version shows", async () => {
    await create({}, oldPi("0.73.1"));
    expect(await instance!.snapshot()).toMatchObject({ state: "unavailable", version: "pi 0.73.1 (fake)", reason: "Pi 0.73.1 is older than 0.80.5, the oldest version Murage can run." });
  });

  it("below the floor a turn fails at once with the setup card and spawns nothing", async () => {
    const dir = tempDir(), dump = join(dir, "dump.jsonl");
    await create({ FAKE_PI_DUMP: dump }, oldPi("0.75.4"));
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-old", text: "go" });
    const completed = await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(completed).toMatchObject({ ok: false, stopReason: "failed" });
    expect(ofType("runtime.error")).toMatchObject([{ setup: true, message: "Pi 0.75.4 is older than 0.80.5, the oldest version Murage can run. Update it in Settings under Engines, then send your message again." }]);
    expect(instance!.adapter.hasSession("t-old")).toBe(false);
    await expect(instance!.adapter.sendTurn({ threadId: "t-old", text: "again" })).resolves.toBeTruthy();
  });

  it("an unreadable or older-than-isolation pi keeps its existing refusal, and at the floor a turn runs", async () => {
    await create({}, oldPi("0.80.5"));
    expect((await instance!.snapshot()).state).toBe("available");
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-floor", text: "go" });
    expect(await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: true });
  });
});

describe("nothing can run after agent_settled (design section 3)", () => {
  const source = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), "utf8");
  const loaded = ["pi-permission-gate.ts", "pi-mcp-extension.ts"] as const;

  it("Murage's extensions register only the events the contract lists and queue no work", () => {
    for (const file of loaded) {
      const text = source(file);
      const events = [...text.matchAll(/\bpi\.on\(\s*"([a-z_]+)"/g)].map((match) => match[1]!);
      for (const event of events) expect(["tool_call", "tool_result", "turn_end", "agent_end", "session_shutdown"], `${file} ${event}`).toContain(event);
      expect(text, file).not.toMatch(/\bagent_settled\b|\bregisterCommand\b|\bsendMessage\b|\bsendUserMessage\b|\bctx\.abort\b|\bterminate\s*:/);
    }
  });

  it("the gate's loop over turn_end and agent_end stays those two", () => {
    expect(source("pi-permission-gate.ts")).toMatch(/for \(const name of \["turn_end", "agent_end"\] as const\)/);
  });

  it("the driver writes one prompt and never steers or queues", async () => {
    const text = source("pi.ts");
    expect(text).not.toMatch(/type: "(steer|follow_up)"/);
  });

  it("a turn loads no extension but Murage's own", async () => {
    const dump = join(tempDir(), "dump.jsonl");
    await create({ FAKE_PI_DUMP: dump });
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-args", text: "go" });
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const argv = (readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv?: string[] }).findLast((row) => row.argv?.includes("--mode"))?.argv) ?? [];
    expect(argv).toContain("--no-extensions");
    const loadedFiles = argv.flatMap((arg, at) => (arg === "-e" ? [argv[at + 1]!] : []));
    for (const file of loadedFiles) expect(file).toMatch(/pi-(mcp-extension|permission-gate)|pinned-bash/);
  });
});
