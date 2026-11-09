import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot 97d7c6df3: a Pi turn that ran a tool reports the tokens of every model round, not only
// the last one. The fake's tooluse turn is a 5/1 tool round, then a 12/2 reply round.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { addPiRoundUsage, PiDriver } from "./pi.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
const scratch: string[] = [];
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  for (const dir of scratch.splice(0)) removeTempDirSync(dir);
});

const turnUsage = async (mode?: string) => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  instance = await PiDriver.create({ instanceId: "pi-usage", displayName: "pi Test", environment: mode ? { FAKE_PI_MODE: mode } : {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: `t-usage-${mode ?? "plain"}`, text: "run it" });
  const done = await recorder.until((event) => event.type === "turn.completed");
  return { done, usage: (done as { usage?: { input: number; output: number } }).usage };
};

it("sums the tool round and the reply round", async () => {
  const { done, usage } = await turnUsage("tooluse");
  expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  expect(usage).toEqual({ input: 17, output: 3 });
});

it("keeps a one-round turn's usage as reported", async () => {
  const { done, usage } = await turnUsage();
  expect(done).toMatchObject({ ok: true });
  expect(usage).toEqual({ input: 12, output: 3 });
});

// G6 (adapted from OpenMausBot 95d60df4e): pi's real usage shape carries cached tokens and its own priced cost on
// message.usage. A turn books the priced cost and the cache reads, and its input counts every prompt token, cached
// ones included, as the other drivers do.
const piUsage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) =>
  ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const toolRound = [
  { type: "agent_start" }, { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } },
  { type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: piUsage(5, 1, 100, 20, 0.0021) } },
  { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } },
];
const scripted = async (threadId: string, frames: unknown[]) => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-priced-"));
  scratch.push(dir);
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify(frames));
  instance = await PiDriver.create({ instanceId: "pi-usage", displayName: "pi Test", environment: { FAKE_PI_SCRIPT: script }, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  recorder = recordEvents(instance.adapter);
  return instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "run it" });
};

it("G6: books pi's priced cost and cached tokens summed over the whole run", async () => {
  const reply = { role: "assistant", stopReason: "stop", usage: piUsage(12, 2, 120, 0, 0.0004) };
  const { turnId } = await scripted("t-usage-priced", [
    ...toolRound,
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }] } },
    { type: "turn_end", message: { role: "assistant", stopReason: "toolUse", usage: piUsage(5, 1, 100, 20, 0.0021) }, toolResults: [{}] },
    { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } },
    { type: "message_end", message: reply }, { type: "turn_end", message: reply, toolResults: [] },
    { type: "agent_end", willRetry: false }, { type: "agent_settled", aborted: false },
  ]);
  const done = await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
  expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  expect((done as { usage?: unknown }).usage).toEqual({ input: 257, output: 3, cachedInput: 220 });
  expect((done as { cost?: number }).cost).toBeCloseTo(0.0025, 10);
});

it("G6: books a model call's cost when the turn is stopped while its tool runs", async () => {
  const { turnId } = await scripted("t-usage-priced-stop", [...toolRound, { wait: 10_000 }]);
  await recorder!.until((event) => event.type === "item.started" && event.turnId === turnId);
  await instance!.adapter.interruptTurn("t-usage-priced-stop", turnId);
  const done = await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
  expect(done).toMatchObject({ ok: true, stopReason: "cancelled", usage: { input: 125, output: 1, cachedInput: 100 } });
  expect((done as { cost?: number }).cost).toBeCloseTo(0.0021, 10);
});

it.each(["Stop", "dispose"] as const)("USAGE-1 pi %s on a live turn that already booked usage and cost keeps both on the final turn.completed", async (kind) => {
  const threadId = `t-usage1-${kind}`;
  const { turnId } = await scripted(threadId, [...toolRound, { wait: 10_000 }]);
  await recorder!.until((event) => event.type === "item.started" && event.turnId === turnId);
  if (kind === "Stop") await instance!.adapter.interruptTurn(threadId, turnId);
  else await instance!.dispose();
  const ended = recorder!.events.filter((event) => event.type === "turn.completed" && event.turnId === turnId);
  expect(ended).toHaveLength(1);
  if (kind === "Stop") expect(ended[0]).toMatchObject({ ok: true, stopReason: "cancelled", usage: { input: 125, output: 1, cachedInput: 100 } });
  else expect(ended[0]).toMatchObject({ ok: false, stopReason: "exit_before_result", usage: { input: 125, output: 1, cachedInput: 100 } });
  expect((ended[0] as { cost?: number }).cost).toBeCloseTo(0.0021, 10);
});

it("G6: a zero price stays unknown, and a round without cache figures adds no cachedInput", () => {
  const unpriced = addPiRoundUsage(undefined, undefined, { input: 4, output: 1, cost: { total: 0 } });
  expect(unpriced).toEqual({ usage: { input: 4, output: 1 }, cost: undefined });
  const next = addPiRoundUsage(unpriced.usage, unpriced.cost, { input: 2, output: 1, cacheRead: 3, cost: { total: 0.5 } });
  expect(next).toEqual({ usage: { input: 9, output: 2, cachedInput: 3 }, cost: 0.5 });
  expect(addPiRoundUsage(undefined, undefined, { input: -1, output: Number.NaN, cacheRead: -5 })).toEqual({ usage: { input: 0, output: 0 }, cost: undefined });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
