// Codex sub agents (collabAgentToolCall helper threads), against the fake
// app-server: the parent's turn/completed is not the end of the turn while a
// helper thread still runs.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const ENV = ["FAKE_CODEX_BG_LOG", "FAKE_CODEX_BG_ASKS", "FAKE_CODEX_BG_HOLD", "FAKE_CODEX_BG_WAKE", "MURAGE_BACKGROUND_CAP_MIN_MS", "MURAGE_BACKGROUND_CAP_MS", "MURAGE_CODEX_WAKE_GRACE_MS"];

describe("CodexDriver sub agents (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let log: string;
  const verdicts = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("verdict:"));
  const autoApprove = (threadId: string) =>
    instance.adapter.onEvent((e) => {
      if (e.type === "request.opened" && e.threadId === threadId) void instance.adapter.respondToRequest(threadId, e.requestId!, { behavior: "allow" });
    });
  const send = (threadId: string, text = "go __fixture_subagents__") => instance.adapter.sendTurn({ threadId, text });

  beforeEach(async () => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-codex-sub-"));
    log = join(scratch, "bg.log");
    writeFileSync(log, "");
    process.env.FAKE_CODEX_BG_LOG = log;
    process.env.MURAGE_BACKGROUND_CAP_MIN_MS = "50";
    process.env.MURAGE_CODEX_WAKE_GRACE_MS = "300";
    instance = await CodexDriver.create({ instanceId: "codex-sub-test", displayName: "Codex Sub Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  });
  afterEach(async () => {
    for (const key of ENV) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("holds the turn past the parent's turn/completed: the helpers' asks take the approval path", async () => {
    autoApprove("t-cx-open");
    const { turnId } = await send("t-cx-open");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(verdicts()).toHaveLength(2);
    expect(verdicts().every((v) => v !== "verdict:undefined")).toBe(true);
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(2);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("reports each helper as a turn.subtask and ends them before the turn completes", async () => {
    autoApprove("t-cx-evt");
    const { turnId } = await send("t-cx-evt");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const subs = recorder.events.filter((e) => e.type === "turn.subtask") as any[];
    expect(subs.filter((e) => e.subtask.status === "started").map((e) => e.subtask.id)).toEqual(["child-1", "child-2", "child-3"]);
    expect(subs.filter((e) => e.subtask.status === "done").map((e) => e.subtask.id)).toEqual(["child-1", "child-2", "child-3"]);
    expect(subs.find((e) => e.subtask.id === "child-1" && e.subtask.toolCount > 0)).toBeTruthy();
    expect(recorder.events.map((e) => e.type).lastIndexOf("turn.subtask")).toBeLessThan(recorder.events.findIndex((e) => e.type === "turn.completed"));
  });

  it("delivers the parent's reply to its helpers inside the same turn", async () => {
    process.env.FAKE_CODEX_BG_WAKE = "1";
    autoApprove("t-cx-wake");
    const { turnId } = await send("t-cx-wake");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const reply = recorder.events.findIndex((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "All helpers reported.");
    expect(reply).toBeGreaterThan(-1);
    expect(reply).toBeLessThan(recorder.events.findIndex((e) => e.type === "turn.completed"));
  });

  it("still asks the owner when the bot's mode asks: nothing is auto answered or refused", async () => {
    process.env.FAKE_CODEX_BG_ASKS = "1";
    const { turnId } = await send("t-cx-ask");
    const opened = await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-cx-ask");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(verdicts()).toEqual([]);
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.respondToRequest("t-cx-ask", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(verdicts()).toHaveLength(1);
  });

  it("ends cleanly when the owner stops the turn during the wait", async () => {
    process.env.FAKE_CODEX_BG_HOLD = "1";
    process.env.FAKE_CODEX_BG_ASKS = "0";
    const { turnId } = await send("t-cx-stop");
    await recorder.until((e) => e.type === "turn.subtask" && (e as any).subtask.id === "child-3");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.interruptTurn("t-cx-stop", turnId);
    const done = (await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)) as any;
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    const last = (recorder.events.filter((e) => e.type === "turn.subtask").at(-1) as any).subtasks;
    expect(last.every((s: any) => s.status === "failed")).toBe(true);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("ends at the cap with a plain note", async () => {
    process.env.FAKE_CODEX_BG_HOLD = "1";
    process.env.FAKE_CODEX_BG_ASKS = "0";
    process.env.MURAGE_BACKGROUND_CAP_MS = "200";
    const { turnId } = await send("t-cx-cap");
    const done = (await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)) as any;
    expect(done).toMatchObject({ ok: true, stopReason: "background_wait_cap" });
    expect(recorder.events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text.includes("Stopped waiting"))).toBe(true);
  });

  it("a turn with no helpers settles at turn/completed exactly as before", async () => {
    const { turnId } = await send("t-cx-none", "plain turn");
    const done = (await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)) as any;
    expect(done.ok).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.subtask")).toBe(false);
  });
});
