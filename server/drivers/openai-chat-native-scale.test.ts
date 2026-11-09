// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALL.eld250: the outgoing native record of a chat-completions engine scrubbed every message of the thread, every round, before
// the record's size was known. Per-turn work must not scale with history, and skipping the scrub must never let a secret through.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GrokDriver } from "./grok.ts";
import { MinimaxDriver } from "./minimax.ts";
import { outgoingRecordFloor, type OpenAIChatMessage } from "./openai-chat.ts";
import { scrubKnown } from "./openai-chat-tools.ts";

vi.mock("./openai-chat-tools.ts", async (original) => {
  const real = await original<typeof import("./openai-chat-tools.ts")>();
  return { ...real, scrubKnown: vi.fn(real.scrubKnown) };
});

const SECRET = ["planted", "canary", "never", "real"].join("-");
const LIMIT = 64 * 1024;
/** The system message every rendered turn carries, ahead of the thread and the new prompt. */
const RENDERED_SYSTEM = 1;
const sse = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const thread = (messages: number, chars: number, planted = "") => Array.from({ length: messages }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: `${planted}${"y".repeat(chars)}` }));

let instance: ProviderInstance;
let recorder: EventRecorder;
let previousFetch: typeof globalThis.fetch;
let serial = 0;

beforeEach(() => {
  ensureDirs();
  previousFetch = globalThis.fetch;
  // SAFETY: the stub only returns real Response objects, the sole member of fetch's return type these drivers consume.
  globalThis.fetch = (async () => sse()) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = previousFetch;
  recorder?.stop();
  await instance?.dispose();
  vi.mocked(scrubKnown).mockClear();
});

const grok = async () => GrokDriver.create({ instanceId: "scale-grok", displayName: "Scale Grok", environment: { XAI_API_KEY: SECRET }, enabled: true, config: { url: "https://fake.xai.invalid/v1", apiKeyEnv: "XAI_API_KEY" } });
const minimax = async () => MinimaxDriver.create({ instanceId: "scale-minimax", displayName: "Scale MiniMax", environment: { MINIMAX_API_KEY: SECRET }, enabled: true, config: { url: "https://fake.minimax.invalid/v1" } });

/** One full turn; answers how many scrubs it ran and what its native log holds. */
const turn = async (create: () => Promise<ProviderInstance>, transcript: ReturnType<typeof thread>, text = "go") => {
  instance = await create();
  recorder = recordEvents(instance.adapter);
  const threadId = `t-native-scale-${Date.now()}-${++serial}`;
  vi.mocked(scrubKnown).mockClear();
  await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, transcript });
  await recorder.until((event) => event.type === "turn.completed");
  const scrubs = vi.mocked(scrubKnown).mock.calls.length;
  recorder.stop();
  await instance.dispose();
  return { scrubs, log: readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8") };
};
const outRecord = (log: string) => log.trim().split("\n").map((line) => JSON.parse(line) as { dir?: string; msg?: Record<string, unknown> }).find((row) => row.dir === "out");

describe.each([["Grok, whose record keeps the messages", grok], ["MiniMax, whose record keeps a count", minimax]] as const)("%s", (_name, create) => {
  it("a 10x thread costs the same scrubs as the shorter one", async () => {
    const short = await turn(create, thread(40, 3_000));
    const long = await turn(create, thread(400, 3_000));
    expect(long.scrubs).toBeLessThanOrEqual(short.scrubs);
    expect(long.scrubs).toBeLessThan(40);
  });

  // Preservation checks, these two: the path before this fix also scrubbed, so they hold with the fix removed.
  it("a thread over the record limit leaves no planted secret in the log", async () => {
    const { log } = await turn(create, thread(40, 3_000, SECRET), `tell me ${SECRET}`);
    expect(log).not.toContain(SECRET);
  });

  it("a thread under the record limit leaves no planted secret in the log", async () => {
    const { log } = await turn(create, thread(4, 100, SECRET), `tell me ${SECRET}`);
    expect(log).not.toContain(SECRET);
    expect(outRecord(log)).toBeTruthy();
  });
});

it("Grok writes the omitted marker and none of the messages when the thread is over the limit", async () => {
  const { log } = await turn(grok, thread(40, 3_000));
  expect(log).toContain("frame exceeds byte limit before redaction");
  expect(log).not.toContain("yyyyyyyy");
});

it("Grok keeps the role order and the count of the scrubbed messages when the thread fits", async () => {
  const { log } = await turn(grok, thread(4, 100, SECRET));
  const messages = outRecord(log)?.msg?.messages as { role?: string }[];
  expect(messages.length).toBe(RENDERED_SYSTEM + 4 + 1);
  expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
});

// A preservation check: the old path logged the same count. The 10x scrub-count test above is what fails if the expensive walk comes back.
it("MiniMax still logs the count and no message text", async () => {
  const { log } = await turn(minimax, thread(40, 3_000));
  expect(outRecord(log)?.msg?.messageCount).toBe(RENDERED_SYSTEM + 40 + 1);
  expect(log).not.toContain("yyyyyyyy");
});

describe("outgoingRecordFloor", () => {
  it("visits a bounded number of messages however long the list is", () => {
    let visits = 0;
    const message = { get role() { visits++; return "user" as const; }, content: "" };
    const messages = Array.from({ length: 200_000 }, () => message) as OpenAIChatMessage[];
    expect(outgoingRecordFloor(messages, LIMIT)).toBeGreaterThan(LIMIT);
    expect(visits).toBeLessThan(LIMIT / 20);
  });

  it("counts a tool result at most at its cap, and a list under the limit stays under", () => {
    expect(outgoingRecordFloor([{ role: "tool", content: "z".repeat(1_000_000), tool_call_id: "a" }], LIMIT)).toBeLessThan(LIMIT);
    expect(outgoingRecordFloor([{ role: "user", content: "z".repeat(100) }], LIMIT)).toBeLessThan(LIMIT);
    expect(outgoingRecordFloor([{ role: "user", content: "z".repeat(LIMIT + 1) }], LIMIT)).toBeGreaterThan(LIMIT);
  });
});
