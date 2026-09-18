// Grok driver contract tests — the API-backed driver rides fetch, so the
// fake is a stubbed globalThis.fetch that scripts HTTP failures and SSE
// bodies. Covers the auto-retry policy: transient (429/5xx) retried with
// backoff, terminal (401/400) never, partial streamed output never.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GrokDriver } from "./grok.ts";

const SSE_BODY = (text: string) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "data: [DONE]",
    "",
  ].join("\n");

const sseResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

describe("GrokDriver turns (fake fetch)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let previousFetch: typeof globalThis.fetch;
  /** Script of responses/errors consumed in order; empty = succeed with text. */
  let script: Array<{ status?: number; sse?: string }> = [];
  let calls = 0;

  const create = async () => {
    instance = await GrokDriver.create({
      instanceId: "grok-test",
      displayName: "Grok Test",
      environment: { XAI_API_KEY: "xai-fake" },
      enabled: true,
      config: { url: "https://fake.xai.invalid/v1", apiKeyEnv: "XAI_API_KEY" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    process.env.FAKE_GROK_RETRY_SCALE = "0.001";
    previousFetch = globalThis.fetch;
    calls = 0;
    // SAFETY: the stub only returns real Response objects, the sole member
    // of fetch's return type this driver consumes.
    globalThis.fetch = (async () => {
      const step = script.shift();
      calls++;
      if (!step || step.sse !== undefined) return sseResponse(step?.sse ?? SSE_BODY("done from fake grok"));
      return new Response(`HTTP ${step.status} body`, { status: step.status });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    delete process.env.FAKE_GROK_RETRY_SCALE;
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    script = [];
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.map((e) => e.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grok")).toBe(true);
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "done from fake grok",
    });
  });

  it("records the resolved default model in native diagnostics", async () => {
    script = [];
    await create();
    const threadId = "t-default-model-log";
    await instance.adapter.sendTurn({ threadId, text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");

    const entries = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { dir: string; msg: { model?: string } });
    expect(entries.find((entry) => entry.dir === "out")?.msg.model).toBe("grok-4");
  });

  it("auto-retries transient 429/5xx responses, then completes once", async () => {
    script = [{ status: 429 }, { status: 503 }];
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-retry", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0)).toBe(true);
    expect(retries.map((e) => e.reason)).toEqual(["rate_limited", "server_error"]);
    // exactly one settled reply across all three attempts
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
    expect(calls).toBe(3);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, turnId });
  }, 20_000);

  it("stops at the attempt cap and settles as failed", async () => {
    script = [{ status: 500 }, { status: 500 }, { status: 500 }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    // original + two retries; the third failure is past the cap and fails
    expect(calls).toBe(3);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  }, 20_000);

  it("never retries a terminal auth or invalid-request failure", async () => {
    script = [{ status: 401 }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    await recorder.until((e) => e.threadId === "t-auth" && e.type === "turn.completed" && e.ok === false);

    expect(recorder.events.filter((e) => e.threadId === "t-auth" && e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);

    script = [{ status: 400 }];
    await instance.adapter.sendTurn({ threadId: "t-badreq", text: "go" });
    await recorder.until((e) => e.threadId === "t-badreq" && e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.filter((e) => e.type === "turn.retrying" && e.threadId === "t-badreq")).toHaveLength(0);
  }, 20_000);

  it("never retries after assistant text already streamed (duplicate-text hazard)", async () => {
    // an SSE body whose stream ERRORS after delivering a delta — the
    // partial-output guard must forbid the retry that would duplicate it
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "half an answer" } }] })}\n\n`));
        setTimeout(() => controller.error(new Error("connection reset by peer")), 10);
      },
    });
    // SAFETY: a real Response built from a live stream, same as above.
    globalThis.fetch = (async () => {
      calls++;
      return new Response(failingStream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-partial", text: "go" });
    await recorder.until((e) => e.threadId === "t-partial" && e.type === "turn.completed" && e.ok === false);

    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.filter((e) => e.threadId === "t-partial" && e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);
  }, 20_000);

  it("fails a stream that ends without a terminal frame and keeps its partial reply (A3)", async () => {
    // HTTP 200, one content frame, then clean EOF: no finish_reason, no [DONE]
    script = [{ sse: `data: ${JSON.stringify({ choices: [{ delta: { content: "cut off mid" } }] })}\n` }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-truncated", text: "go" });
    const done = await recorder.until((e) => e.threadId === "t-truncated" && e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "cut off mid",
    });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: 'The model server stopped before it finished this answer.',
    });
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);
  }, 20_000);

  it("an interrupt during the retry backoff cancels cleanly without another attempt", async () => {
    script = [{ status: 503 }];
    process.env.FAKE_GROK_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: "go" });
    await recorder.until((e) => e.type === "turn.retrying");

    await instance.adapter.interruptTurn("t-cancel-backoff");
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(calls).toBe(1);
    // STOP1: a Stop during the backoff is a cancellation, not a failure
    expect(recorder.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: true,
      stopReason: "cancelled",
    });
  }, 20_000);

  it("declares no interactive channels this engine cannot honor", async () => {
    script = [];
    await create();
    await expect(instance.adapter.respondToRequest("t-x", "r", { behavior: "allow" })).resolves.toBe("unavailable");
  });
});

// The Authorization header on this request carries a real API key, so the
// address rule has to hold here and not only where a server is added. The
// shared classification refuses every cloud metadata / credential endpoint;
// this checks the driver actually consults it, and that nothing is sent when
// it says no. (openai-chat.ts, `completeWithin`.)
describe("GrokDriver address guard", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let previousFetch: typeof globalThis.fetch;
  let calls: Array<{ url: string; auth: string | null }> = [];

  beforeEach(() => {
    ensureDirs();
    process.env.FAKE_GROK_RETRY_SCALE = "0.001";
    previousFetch = globalThis.fetch;
    calls = [];
    // SAFETY: the stub only returns real Response objects, the sole member
    // of fetch's return type this driver consumes.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return sseResponse(SSE_BODY("this should never have been reached"));
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    delete process.env.FAKE_GROK_RETRY_SCALE;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
  });

  const turnTo = async (url: string) => {
    instance = await GrokDriver.create({
      instanceId: "grok-guard",
      displayName: "Grok Guard",
      environment: { XAI_API_KEY: "xai-fake" },
      enabled: true,
      config: { url, apiKeyEnv: "XAI_API_KEY" },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-guard", text: "hi" });
    return recorder.until((e) => e.type === "turn.completed");
  };

  it.each([
    ["http://169.254.169.254/latest/v1", "AWS/GCP/Azure/Oracle/DO/Hetzner IMDS"],
    ["http://169.254.170.2/v2/v1", "AWS ECS task-role credentials"],
    ["http://169.254.170.23/v1", "AWS ECS/EKS task metadata v4"],
    ["http://[fd00:ec2::254]/v1", "AWS IMDS over IPv6"],
    ["http://100.100.100.200/v1", "Alibaba Cloud metadata"],
    ["http://metadata.google.internal/v1", "GCP metadata by name"],
    ["http://gpu.example.com/v1", "any plain-http public host"],
  ])("sends no request and no key to %s (%s)", async (url) => {
    const completed = await turnTo(url);
    expect(calls).toEqual([]);
    expect(completed).toMatchObject({ type: "turn.completed", ok: false });
    // A refused address is terminal, never a transient hiccup: retrying would
    // just re-resolve the same name three times behind a 12s backoff.
    expect(recorder!.events.filter((event) => event.type === "turn.retrying")).toHaveLength(0);
  }, 20_000);

  it("still sends to a loopback server over plain http", async () => {
    const completed = await turnTo("http://127.0.0.1:11434/v1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(calls[0]!.auth).toBe("Bearer xai-fake");
    expect(completed).toMatchObject({ type: "turn.completed", ok: true });
  }, 20_000);
});
