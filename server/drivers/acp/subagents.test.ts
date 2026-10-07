// Sub agents on the shared ACP core (Fuigo's wire shape), against the fake
// ACP CLI: the prompt result is not the end of the turn while sub agents run.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const SUPPORT: AcpSupport = {
  driverKind: "subagentTest",
  displayName: "Subagent Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-subagent",
  nativeSource: "subagent.acp",
  loginNote: "never reached",
  spawnArgs: () => ["agent", "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const Driver = createAcpDriver(SUPPORT);
const ENV = ["FAKE_ACP_BG_LOG", "FAKE_ACP_BG_ASKS", "FAKE_ACP_BG_HOLD", "FAKE_ACP_BG_WAKE", "MURAGE_BACKGROUND_CAP_MIN_MS", "MURAGE_BACKGROUND_CAP_MS"];

describe("ACP sub agents (fake CLI)", () => {
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
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-sub-"));
    log = join(scratch, "bg.log");
    writeFileSync(log, "");
    process.env.FAKE_ACP_BG_LOG = log;
    process.env.MURAGE_BACKGROUND_CAP_MIN_MS = "50";
    instance = await Driver.create({ instanceId: "acp-sub-test", displayName: "Subagent Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  });
  afterEach(async () => {
    for (const key of ENV) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("holds the turn past the prompt result: the helpers' asks reach the approval path, not a refusal", async () => {
    autoApprove("t-sub-open");
    const { turnId } = await send("t-sub-open");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(verdicts()).toEqual(["verdict:allow-once", "verdict:allow-once"]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(2);
  });

  it("reports each helper as a turn.subtask and ends them all before the turn completes", async () => {
    autoApprove("t-sub-evt");
    const { turnId } = await send("t-sub-evt");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const subs = recorder.events.filter((e) => e.type === "turn.subtask") as any[];
    expect(subs.filter((e) => e.subtask.status === "started").map((e) => e.subtask.id)).toEqual(["sub-1", "sub-2", "sub-3"]);
    expect(subs.filter((e) => e.subtask.status === "done").map((e) => e.subtask.id)).toEqual(["sub-1", "sub-2", "sub-3"]);
    expect(subs.find((e) => e.subtask.status === "running").subtask).toMatchObject({ id: "sub-1", toolCount: 1 });
    expect(subs.every((e) => e.turnId === turnId)).toBe(true);
    const lastSub = recorder.events.map((e) => e.type).lastIndexOf("turn.subtask");
    expect(lastSub).toBeLessThan(recorder.events.findIndex((e) => e.type === "turn.completed"));
  });

  it("delivers the reply the engine wakes itself for inside the same turn", async () => {
    process.env.FAKE_ACP_BG_WAKE = "1";
    autoApprove("t-sub-wake");
    const { turnId } = await send("t-sub-wake");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const reply = recorder.events.findIndex((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text.includes("All helpers reported."));
    expect(reply).toBeGreaterThan(-1);
    expect(reply).toBeLessThan(recorder.events.findIndex((e) => e.type === "turn.completed"));
  });

  it("still asks the owner when the bot's mode asks: nothing is auto answered or refused", async () => {
    process.env.FAKE_ACP_BG_ASKS = "1";
    const { turnId } = await send("t-sub-ask");
    const opened = await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-sub-ask");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(verdicts()).toEqual([]);
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.respondToRequest("t-sub-ask", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(verdicts()).toEqual(["verdict:reject"]);
  });

  it("ends cleanly when the owner stops the turn during the wait", async () => {
    process.env.FAKE_ACP_BG_HOLD = "1";
    process.env.FAKE_ACP_BG_ASKS = "0";
    const { turnId } = await send("t-sub-stop");
    await recorder.until((e) => e.type === "turn.subtask" && (e as any).subtask.id === "sub-3");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.interruptTurn("t-sub-stop", turnId);
    const done = (await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)) as any;
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    const last = (recorder.events.filter((e) => e.type === "turn.subtask").at(-1) as any).subtasks;
    expect(last.every((s: any) => s.status === "failed" && typeof s.endedAt === "number")).toBe(true);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("ends at the cap with a plain note and stops the helpers", async () => {
    process.env.FAKE_ACP_BG_HOLD = "1";
    process.env.FAKE_ACP_BG_ASKS = "0";
    process.env.MURAGE_BACKGROUND_CAP_MS = "200";
    const { turnId } = await send("t-sub-cap");
    const done = (await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)) as any;
    expect(done).toMatchObject({ ok: true, stopReason: "background_wait_cap" });
    expect(recorder.events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text.includes("Stopped waiting"))).toBe(true);
  });

  it("a turn with no sub agents settles at the prompt result exactly as before", async () => {
    const { turnId } = await send("t-sub-none", "plain turn");
    const done = (await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)) as any;
    expect(done.ok).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.subtask")).toBe(false);
  });
});
