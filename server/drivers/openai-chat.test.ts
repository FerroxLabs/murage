// Shared OpenAI chat-completions stream runtime (A3). A streamed reply is a
// successful completion only when it meets the terminal contract: [DONE], or
// a finish frame followed by clean EOF. In-band errors, unreadable frames,
// truncation and empty replies fail the turn, and any output that did arrive
// is kept ahead of the failed terminal instead of being dropped.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const SECRET = "sk-openai-chat-test-secret";
const encoder = new TextEncoder();

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const contentFrame = (content: string, finishReason?: string) =>
  frame({ choices: [{ delta: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }] });
const DONE = "data: [DONE]\n\n";

type Responder = (signal: AbortSignal | undefined) => Response;

/** A 200 SSE body that hands out exactly these chunks, one per read, then
 * closes (or errors with `fail`). Pull-driven, so an error can never discard
 * a chunk the runtime has not read yet. */
const sse = (chunks: Array<string | Uint8Array>, fail?: Error): Response => {
  const queue = [...chunks];
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = queue.shift();
          if (next !== undefined) controller.enqueue(typeof next === "string" ? encoder.encode(next) : next);
          else if (fail) controller.error(fail);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

const replies = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : []));
const errors = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "runtime.error" ? [event.message] : []));

describe("createOpenAIChatRuntime stream contract", () => {
  const instances: ProviderInstance[] = [];
  let previousFetch: typeof globalThis.fetch;
  let responders: Responder[] = [];
  let calls = 0;

  beforeEach(() => {
    ensureDirs();
    previousFetch = globalThis.fetch;
    responders = [];
    calls = 0;
    // SAFETY: the stub returns real Response objects, the only part of
    // fetch's contract this runtime consumes.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const next = responders.shift();
      if (!next) throw new Error("unexpected extra provider request");
      return next(init?.signal ?? undefined);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    for (const instance of instances.splice(0)) await instance.dispose();
  });

  const create = (overrides: { retryScale?: number; reasoning?: boolean } = {}) => {
    const instance = createOpenAIChatRuntime({
      input: { instanceId: "chat-test", displayName: "Chat test", environment: {}, enabled: true, config: {} },
      driverKind: "openai-chat-test",
      apiKey: SECRET,
      apiUrl: "https://chat.invalid/v1",
      models: () => ({ default: "test-model", options: [{ id: "test-model", label: "Test model" }] }),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "TestProvider",
      missingKeyError: "missing key",
      unavailableReason: "no key",
      timeoutMs: 10_000,
      nativeLog: {
        source: "test.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messages }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
      ...overrides,
    });
    instances.push(instance);
    return instance;
  };

  const runTurn = async (
    threadId: string,
    next: Responder[],
    overrides: { retryScale?: number; reasoning?: boolean } = {},
  ) => {
    responders = next;
    const instance = create(overrides);
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId, text: "question" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    return { completed, events: recorder.events, instance };
  };

  it("completes a stream with a finish frame, usage and [DONE]", async () => {
    const { completed, events } = await runTurn("t-finish-done", [() => sse([
      contentFrame("hello "),
      contentFrame("world", "stop"),
      frame({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
      DONE,
    ])]);

    expect(completed).toMatchObject({ ok: true, stopReason: null });
    expect(replies(events)).toEqual(["hello world"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "thread.token-usage.updated", input: 4, output: 2 }));
    expect(errors(events)).toEqual([]);
  });

  it("accepts [DONE] without a finish_reason", async () => {
    const { completed, events } = await runTurn("t-done-only", [() => sse([contentFrame("answer"), DONE])]);
    expect(completed).toMatchObject({ ok: true });
    expect(replies(events)).toEqual(["answer"]);
  });

  it("accepts a finish frame followed by clean EOF without [DONE]", async () => {
    const { completed, events } = await runTurn("t-finish-eof", [() => sse([contentFrame("answer", "stop")])]);
    expect(completed).toMatchObject({ ok: true });
    expect(replies(events)).toEqual(["answer"]);
  });

  it("fails a clean truncation after text, keeps the partial reply and never replays it", async () => {
    const { completed, events } = await runTurn(
      "t-truncated",
      [() => sse([contentFrame("half an ans")]), () => sse([contentFrame("replayed", "stop"), DONE])],
      { retryScale: 0.001 },
    );

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["half an ans"]);
    expect(errors(events)).toEqual(["TestProvider stream ended before the provider signalled completion"]);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(calls).toBe(1);
    const types = events.map((event) => event.type);
    expect(types.indexOf("item.completed")).toBeLessThan(types.indexOf("runtime.error"));
    expect(types.at(-1)).toBe("turn.completed");
  });

  it("fails an empty stream that closes without any frame", async () => {
    const { completed, events, instance } = await runTurn("t-empty-eof", [() => sse([])]);
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual([]);
    expect(errors(events)).toEqual(["TestProvider stream ended before the provider signalled completion"]);
    expect(instance.adapter.hasSession("t-empty-eof")).toBe(false);
  });

  it("surfaces an in-band error after output, keeps the partial and never replays it", async () => {
    const { completed, events } = await runTurn(
      "t-inband-after-output",
      [
        () => sse([contentFrame("partial "), frame({ error: { message: "upstream overloaded", code: 529 } })]),
        () => sse([contentFrame("replayed", "stop"), DONE]),
      ],
      { retryScale: 0.001 },
    );

    expect(completed).toMatchObject({ ok: false, stopReason: "provider_error" });
    expect(replies(events)).toEqual(["partial "]);
    expect(errors(events)).toEqual(["TestProvider stream error: upstream overloaded, code 529"]);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(calls).toBe(1);
  });

  it("retries a transient in-band error that arrives before any output", async () => {
    const { completed, events } = await runTurn(
      "t-inband-before-output",
      [
        () => sse([frame({ error: { message: "The server is overloaded" } })]),
        () => sse([contentFrame("recovered", "stop"), DONE]),
      ],
      { retryScale: 0.001 },
    );

    expect(completed).toMatchObject({ ok: true });
    expect(replies(events)).toEqual(["recovered"]);
    expect(events.filter((event) => event.type === "turn.retrying")).toEqual([
      expect.objectContaining({ attempt: 1, reason: "overloaded" }),
    ]);
    expect(calls).toBe(2);
  });

  it("never replays after reasoning streamed, even without assistant text", async () => {
    const { completed, events } = await runTurn(
      "t-reasoning-then-reset",
      [
        () => sse([frame({ choices: [{ delta: { reasoning_content: "thinking" } }] })], new Error("socket hang up")),
        () => sse([contentFrame("replayed", "stop"), DONE]),
      ],
      { retryScale: 0.001, reasoning: true },
    );

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["thinking"]);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(calls).toBe(1);
  });

  it("treats finish_reason error as a failed turn", async () => {
    const { completed, events } = await runTurn("t-finish-error", [() => sse([
      contentFrame("so far"),
      frame({ choices: [{ delta: {}, finish_reason: "error" }] }),
      DONE,
    ])]);

    expect(completed).toMatchObject({ ok: false, stopReason: "provider_error" });
    expect(replies(events)).toEqual(["so far"]);
    expect(errors(events)).toEqual(['TestProvider stream ended with finish_reason "error"']);
  });

  it("fails a stream with an unreadable frame even when [DONE] follows", async () => {
    const { completed, events } = await runTurn("t-unreadable", [() => sse([
      contentFrame("before "),
      "data: {not json\n\n",
      contentFrame("after"),
      DONE,
    ])]);

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["before after"]);
    expect(errors(events)).toEqual(["TestProvider stream contained 1 unreadable frame"]);
  });

  it("folds a final [DONE] that arrives without a trailing newline", async () => {
    const { completed, events } = await runTurn("t-done-no-newline", [() => sse([contentFrame("hi"), "data: [DONE]"])]);
    expect(completed).toMatchObject({ ok: true });
    expect(replies(events)).toEqual(["hi"]);
  });

  it("folds a final finish frame that arrives without a trailing newline", async () => {
    const last = `data: ${JSON.stringify({ choices: [{ delta: { content: "last words" }, finish_reason: "stop" }] })}`;
    const { completed, events } = await runTurn("t-finish-no-newline", [() => sse([last])]);
    expect(completed).toMatchObject({ ok: true });
    expect(replies(events)).toEqual(["last words"]);
  });

  it("decodes multibyte characters split across network chunks", async () => {
    const bytes = encoder.encode(contentFrame("héllo 🙂 wörld", "stop") + DONE);
    const insideAccent = bytes.indexOf(0xc3) + 1;
    const insideEmoji = bytes.indexOf(0xf0) + 2;
    const { completed, events } = await runTurn("t-split-utf8", [() => sse([
      bytes.slice(0, insideAccent),
      bytes.slice(insideAccent, insideEmoji),
      bytes.slice(insideEmoji),
    ])]);

    expect(completed).toMatchObject({ ok: true });
    expect(replies(events)).toEqual(["héllo 🙂 wörld"]);
  });

  it("fails an empty reply even when the terminal contract is valid", async () => {
    const { completed, events } = await runTurn("t-empty-reply", [() => sse([
      frame({ choices: [{ delta: { content: "" }, finish_reason: "content_filter" }] }),
      DONE,
    ])]);

    expect(completed).toMatchObject({ ok: false, stopReason: "empty_response" });
    expect(replies(events)).toEqual([]);
    expect(errors(events)).toEqual(['TestProvider returned an empty reply (finish_reason "content_filter")']);
  });

  it("keeps partial output when the connection drops mid-stream", async () => {
    const { completed, events } = await runTurn(
      "t-mid-stream-drop",
      [() => sse([contentFrame("streamed ")], new Error("socket hang up")), () => sse([contentFrame("replayed", "stop"), DONE])],
      { retryScale: 0.001 },
    );

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["streamed "]);
    expect(errors(events)).toEqual(["TestProvider stream failed: socket hang up"]);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(calls).toBe(1);
  });

  it("redacts the API key from an in-band error message", async () => {
    const { completed, events } = await runTurn("t-redact", [() => sse([
      frame({ error: { message: `rejected credential ${SECRET}` } }),
    ])]);

    expect(completed).toMatchObject({ ok: false, stopReason: "provider_error" });
    expect(errors(events)).toEqual(["TestProvider stream error: rejected credential [redacted]"]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("reports an interrupt mid-stream as interrupted without inventing a reply", async () => {
    responders = [(signal) => {
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode(contentFrame("working on it")));
                return;
              }
              // hold the stream open until the runtime aborts the request
              return new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => {
                  controller.error(signal.reason);
                  resolve();
                }, { once: true });
              });
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }];
    const instance = create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-interrupt", text: "question" });
    await recorder.until((event) => event.type === "content.delta");
    await instance.adapter.interruptTurn("t-interrupt");
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(errors(recorder.events)).toEqual([]);
    expect(replies(recorder.events)).toEqual([]);
  });

  it("surfaces an in-band error from a non-streamed helper call", async () => {
    responders = [() => new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })];
    const instance = create();
    await expect(instance.generateText?.("hello")).rejects.toThrow("TestProvider error: model unavailable");
  });
});
