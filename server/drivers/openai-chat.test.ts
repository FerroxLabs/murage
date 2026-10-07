// Shared OpenAI chat-completions stream runtime (A3). A streamed reply is a
// successful completion only when it meets the terminal contract: [DONE], or
// a finish frame followed by clean EOF. In-band errors, unreadable frames,
// truncation and empty replies fail the turn, and any output that did arrive
// is kept ahead of the failed terminal instead of being dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { appendBounded, createOpenAIChatRuntime, MAX_RESPONSE_BYTES, MAX_SSE_LINE_BYTES } from "./openai-chat.ts";

const SECRET = "sk-openai-chat-test-secret";
const encoder = new TextEncoder();

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const contentFrame = (content: string, finishReason?: string) =>
  frame({ choices: [{ delta: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }] });
const DONE = "data: [DONE]\n\n";
const TOO_LARGE = "The model server sent a reply too large to read, so Murage kept what arrived before it.";

/** Count only bytes requested by the reader, without stream prefetch. */
const measuredBody = (chunks: Uint8Array[], status = 200) => {
  let index = 0;
  const observed = { pulled: 0, cancelled: false };
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) return controller.close();
      observed.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { observed.cancelled = true; },
  }, { highWaterMark: 0 }), { status });
  return { response, observed };
};

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
/** The engine-shaped line, which lives in the card's Technical details rather
 * than in the sentence the person reads. */
const errorDetails = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "runtime.error" ? [event.details ?? ""] : []));

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
    // The stub returns real Response objects, the only part of
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

  const create = (overrides: { retryScale?: number; reasoning?: boolean; timeoutMs?: number | undefined } = {}) => {
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
      includeUsageInCompleted: true,
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

  it("bounds a long unterminated line and keeps the earlier reply", async () => {
    const first = encoder.encode(contentFrame("partial answer"));
    const chunk = encoder.encode("x".repeat(1024 * 1024));
    const { response, observed } = measuredBody([first, ...Array<Uint8Array>(16).fill(chunk)]);
    const { completed, events } = await runTurn("t-line-cap", [() => response]);

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["partial answer"]);
    expect(errors(events)).toEqual([TOO_LARGE]);
    expect(errorDetails(events)[0]).toContain("stream line exceeded");
    expect(observed.cancelled).toBe(true);
    expect(observed.pulled - first.byteLength).toBeLessThanOrEqual(MAX_SSE_LINE_BYTES + chunk.byteLength);
    expect(calls).toBe(1);
  });

  it("keeps the diagnostic prefix within its byte cap for one large chunk", async () => {
    const chunk = "x".repeat(1024 * 1024);
    expect(appendBounded("", chunk, 64_000)).toHaveLength(64_000);
    expect(appendBounded("prefix", chunk, 64_000)).toHaveLength(64_000);
    expect(Buffer.byteLength(appendBounded("a", "🙂".repeat(64_000), 64_000))).toBeLessThanOrEqual(64_000);

    // A whole completion whose content extends beyond the diagnostic prefix.
    const whole = JSON.stringify({ choices: [{ message: { content: "x".repeat(64_000) }, finish_reason: "stop" }] });
    const { completed, events } = await runTurn("t-diagnostic-cap", [() => sse([whole.padEnd(1024 * 1024, " ")])]);
    expect(completed).toMatchObject({ ok: false, stopReason: "invalid_body" });
    expect(replies(events)).toEqual([]);
    expect(errors(events)).toEqual(["That address answered, but not with a model reply. Check that it points at your model server."]);
  });

  it("stops an HTTP error body at the diagnostic cap and retains its provider error", async () => {
    const chunk = encoder.encode("x".repeat(16 * 1024));
    const { response, observed } = measuredBody(Array<Uint8Array>(64).fill(chunk), 400);
    const { completed, events } = await runTurn("t-http-body-cap", [() => response]);
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(errors(events)).toEqual(["The model server would not accept this request."]);
    expect(errorDetails(events)[0]).toContain("TestProvider HTTP 400");
    expect(observed.cancelled).toBe(true);
    expect(observed.pulled).toBeLessThanOrEqual(64_000 + chunk.byteLength);
  });

  it("bounds the total bytes of short valid stream lines and keeps the reply", async () => {
    const first = encoder.encode(contentFrame("partial answer"));
    const chunk = encoder.encode(frame({ choices: [], padding: "x".repeat(1000) }).repeat(16));
    const count = Math.ceil(MAX_RESPONSE_BYTES / chunk.byteLength) + 4;
    const { response, observed } = measuredBody([first, ...Array<Uint8Array>(count).fill(chunk), encoder.encode(DONE)]);
    const { completed, events } = await runTurn("t-response-cap", [() => response]);
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["partial answer"]);
    expect(errors(events)).toEqual([TOO_LARGE]);
    expect(errorDetails(events)[0]).toContain("response exceeded");
    expect(observed.cancelled).toBe(true);
    expect(observed.pulled).toBeGreaterThan(MAX_RESPONSE_BYTES);
    expect(observed.pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + chunk.byteLength);
  });

  it("bounds a non-streamed success body before parsing it", async () => {
    const chunk = encoder.encode(" ".repeat(1024 * 1024));
    const whole = encoder.encode(JSON.stringify({ choices: [{ message: { content: "answer" } }] }));
    const { response, observed } = measuredBody([...Array<Uint8Array>(33).fill(chunk), whole]);
    responders = [() => response];
    await expect(create().generateText!("hello")).rejects.toThrow(TOO_LARGE);
    expect(observed.cancelled).toBe(true);
    expect(observed.pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + chunk.byteLength);
  });

  it("accepts a large chunk made of short lines", async () => {
    const chunk = frame({ choices: [], padding: "x".repeat(1000) }).repeat(1100);
    expect(encoder.encode(chunk).byteLength).toBeGreaterThan(MAX_SSE_LINE_BYTES);
    const { completed, events } = await runTurn("t-many-short-lines", [() => sse([chunk + contentFrame("answer", "stop") + DONE])]);
    expect(completed).toMatchObject({ ok: true });
    expect(replies(events)).toEqual(["answer"]);
  });

  it("counts multibyte line content by bytes", async () => {
    const first = encoder.encode(contentFrame("partial answer"));
    const chunk = encoder.encode("🙂".repeat(MAX_SSE_LINE_BYTES / 4));
    const { response, observed } = measuredBody([first, chunk, encoder.encode("🙂"), encoder.encode(DONE)]);
    const { completed, events } = await runTurn("t-line-byte-cap", [() => response]);
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(errors(events)).toEqual([TOO_LARGE]);
    expect(replies(events)).toEqual(["partial answer"]);
    expect(observed.cancelled).toBe(true);
    expect(observed.pulled).toBe(first.byteLength + MAX_SSE_LINE_BYTES + 4);
  });

  it("banks two per-turn totals and the provider reported cost once each", async () => {
    responders = [0.1, 0.2].map(cost => () => sse([contentFrame("ok", "stop"), frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost_usd: cost } }), DONE]));
    const instance = create(); const recorder = recordEvents(instance.adapter);
    for (let n = 0; n < 2; n++) {
      const sent = await instance.adapter.sendTurn({ threadId: "bank", text: "go" });
      await recorder.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
    }
    expect(recorder.events.filter(e => e.type === "turn.completed")).toMatchObject([
      { usage: { input: 10, output: 5 }, charge: 0.1, cost: null },
      { usage: { input: 10, output: 5 }, charge: 0.2, cost: null },
    ]);
    recorder.stop();
  });

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
    expect(errors(events)).toEqual(['The model server stopped before it finished this answer.']);
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
    expect(errors(events)).toEqual(['The model server stopped before it finished this answer.']);
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
    expect(errors(events)).toEqual(["The model server reported an error part-way through the answer."]);
    expect(errorDetails(events)).toEqual(["TestProvider stream error: upstream overloaded, code 529"]);
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

  it("fences every send: a retry refused after the backoff is never resent and the turn stops retrying", async () => {
    responders = [
      () => sse([frame({ error: { message: "The server is overloaded" } })]),
      () => sse([contentFrame("stale resend", "stop"), DONE]),
    ];
    const instance = create({ retryScale: 0.001 });
    const recorder = recordEvents(instance.adapter);
    let checks = 0;
    await instance.adapter.sendTurn({
      threadId: "t-fenced-retry",
      text: "question",
      // the first send passes; the turn is retired during the backoff
      beforeSubmit: () => { if (++checks > 1) throw new Error("retired during backoff"); },
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    expect(checks).toBe(2);
    expect(calls).toBe(1);
    expect(responders).toHaveLength(1);
    expect(completed).toMatchObject({ ok: false, stopReason: "submission_refused" });
    expect(recorder.events.filter((event) => event.type === "turn.retrying")).toHaveLength(1);
    expect(replies(recorder.events)).toEqual([]);
    expect(instance.adapter.hasSession("t-fenced-retry")).toBe(false);
  });

  it("fences the first send: a refused turn makes no request", async () => {
    responders = [() => sse([contentFrame("never", "stop"), DONE])];
    const instance = create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-fenced-first", text: "question", beforeSubmit: () => { throw new Error("refused"); } });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    expect(calls).toBe(0);
    expect(completed).toMatchObject({ ok: false, stopReason: "submission_refused" });
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
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
    expect(errors(events)).toEqual(["The model server ended this answer with an error."]);
    expect(errorDetails(events)).toEqual(['TestProvider stream ended with finish_reason "error"']);
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
    expect(errors(events)).toEqual(["Part of this answer arrived damaged, so some of it may be missing."]);
    expect(errorDetails(events)).toEqual(["TestProvider stream contained 1 unreadable frame"]);
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

  it("settles a finished answer whose socket closed part-way through a trailing frame", async () => {
    // The finish frame arrived whole; the connection then closed inside the
    // next frame. That tail is incomplete, not damaged, and the answer the
    // server already finished is a success.
    const { completed, events } = await runTurn("t-finish-then-cut-tail", [() => sse([
      contentFrame("Hello", "stop"),
      'data: {"choices":[{"delta":{"content":" wor',
    ])]);
    expect(completed).toMatchObject({ ok: true, stopReason: null });
    expect(replies(events)).toEqual(["Hello"]);
    expect(errors(events)).toEqual([]);
  });

  it("reports a stream cut mid-frame before any finish as stopped early, not damaged", async () => {
    const { completed, events } = await runTurn("t-cut-tail-no-finish", [() => sse([
      contentFrame("half an ans"),
      'data: {"choices":[{"delta":{"content":"wer',
    ])], { retryScale: 0.001 });
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["half an ans"]);
    expect(errors(events)).toEqual(["The model server stopped before it finished this answer."]);
  });

  it("still counts an unreadable frame that was terminated by a newline before EOF", async () => {
    const { completed, events } = await runTurn("t-unreadable-terminated-last", [() => sse([
      contentFrame("answer", "stop"),
      "data: {not json\n",
    ])]);
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(errors(events)).toEqual(["Part of this answer arrived damaged, so some of it may be missing."]);
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
    expect(errors(events)).toEqual(['The model returned an empty answer. Try sending the message again, or choose another model.']);
  });

  it("keeps partial output when the connection drops mid-stream", async () => {
    const { completed, events } = await runTurn(
      "t-mid-stream-drop",
      [() => sse([contentFrame("streamed ")], new Error("socket hang up")), () => sse([contentFrame("replayed", "stop"), DONE])],
      { retryScale: 0.001 },
    );

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["streamed "]);
    expect(errors(events)).toEqual(['The connection to the model server dropped before the answer finished.']);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(calls).toBe(1);
  });

  it("redacts the API key from an in-band error message", async () => {
    const { completed, events } = await runTurn("t-redact", [() => sse([
      frame({ error: { message: `rejected credential ${SECRET}` } }),
    ])]);

    expect(completed).toMatchObject({ ok: false, stopReason: "provider_error" });
    expect(errorDetails(events)).toEqual(["TestProvider stream error: rejected credential [redacted]"]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("reports an interrupt mid-stream as cancelled without inventing a reply", async () => {
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

    // STOP1: a user Stop is the shared cancelled state, never a failed turn
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(errors(recorder.events)).toEqual([]);
    // F6: what had already streamed is kept. The person watched those words
    // appear; pressing Stop must not erase them, and the provider-drop path
    // has always kept its partial (F11). Stop was the odd one out.
    expect(replies(recorder.events)).toEqual(["working on it"]);
  });

  it("keeps a long partial answer when the user stops mid-stream", async () => {
    const paragraph = "Mara climbed the lighthouse stairs every evening before the light came on. ";
    responders = [(signal) => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (sent < 3) {
                sent += 1;
                controller.enqueue(encoder.encode(contentFrame(paragraph)));
                return;
              }
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
    await instance.adapter.sendTurn({ threadId: "t-stop-long", text: "write a story" });
    let deltas = 0;
    await recorder.until((event) => event.type === "content.delta" && ++deltas === 3);
    await instance.adapter.interruptTurn("t-stop-long");
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(replies(recorder.events)).toEqual([paragraph.repeat(3)]);
    expect(errors(recorder.events)).toEqual([]);
  });

  it("separates a body that is not a completion from a stream that stopped early (F8)", async () => {
    responders = [() => new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })];
    const instance = create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-html", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: false, stopReason: "invalid_body" });
    expect(errors(recorder.events)).toEqual([
      "That address answered, but not with a model reply. Check that it points at your model server.",
    ]);
    const failure = recorder.events.find((event) => event.type === "runtime.error");
    expect(failure && "details" in failure ? failure.details : undefined)
      .toBe("TestProvider response body was not a completion");
  });

  it("reads a whole completion sent in place of a stream and reports an empty answer as one (F8)", async () => {
    responders = [() => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })];
    const instance = create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-empty-json", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: false, stopReason: "empty_response" });
    expect(errors(recorder.events)).toEqual([
      "The model returned an empty answer. Try sending the message again, or choose another model.",
    ]);
  });

  it("gives a 401 the reviewed provider copy instead of the provider's own JSON (F5)", async () => {
    responders = [() => new Response(
      JSON.stringify({ error: { message: `Incorrect API key provided: ${SECRET}. See https://platform.openai.com/account/api-keys`, code: "invalid_api_key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    )];
    const instance = create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-401", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: false });
    const failure = recorder.events.find((event) => event.type === "runtime.error");
    // The bubble gets a sentence, not a JSON blob, and the card can now reach
    // the reviewed authentication copy because the status travels structurally.
    expect(failure?.message).not.toContain("{");
    expect(failure?.message).toBe("The model server did not accept this engine's key. Check the key for this engine in App Settings.");
    expect(failure && "providerError" in failure ? failure.providerError : undefined)
      .toMatchObject({ kind: "authentication", httpStatus: 401 });
    // The provider's own words stay available, with the key redacted.
    expect(failure && "details" in failure ? failure.details : "").toContain("Incorrect API key provided");
    expect(JSON.stringify(recorder.events)).not.toContain(SECRET);
  });

  it("surfaces an in-band error from a non-streamed helper call", async () => {
    responders = [() => new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })];
    const instance = create();
    await expect(instance.generateText?.("hello")).rejects.toThrow("TestProvider error: model unavailable");
  });

  // ---------------------------------------------------------------------
  // F3 vs F11: the unreachable-endpoint wrapper must not eat a dropped
  // stream. `isEndpointUnreachable` matches ECONNRESET / UND_ERR_SOCKET /
  // EPIPE / ETIMEDOUT, which are exactly the codes a connection carries when
  // it dies HALFWAY THROUGH a reply. Applied after bytes have already
  // arrived, it threw away every streamed word and told the person the
  // server "could not be reached" while its answer was on their screen.
  // The old regression test missed this only because its fixture threw an
  // error with no `code` at all, which no real transport does.
  // ---------------------------------------------------------------------

  /** What undici throws when the socket dies mid-body: a TypeError whose
   *  cause carries the errno. Identical in shape to a connect failure. */
  const midStreamDrop = (code: string, syscall: string, message: string): Error =>
    Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error(message), { code, syscall }),
    });

  it("keeps partial output when a mid-stream drop carries ECONNRESET", async () => {
    const { completed, events } = await runTurn(
      "t-drop-econnreset",
      [
        () => sse([contentFrame("streamed ")], midStreamDrop("ECONNRESET", "read", "read ECONNRESET")),
        () => sse([contentFrame("replayed", "stop"), DONE]),
      ],
      { retryScale: 0.001 },
    );

    expect(replies(events)).toEqual(["streamed "]);
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(errors(events)).toEqual(["The connection to the model server dropped before the answer finished."]);
    // The endpoint plainly answered and streamed. Never claim otherwise.
    expect(errors(events).join(" ")).not.toMatch(/could not reach|nothing answered/i);
    expect(errorDetails(events)).toEqual(["TestProvider stream failed: terminated"]);
    expect(calls).toBe(1);
  });

  it("keeps partial output when a mid-stream drop carries UND_ERR_SOCKET", async () => {
    const { completed, events } = await runTurn(
      "t-drop-und-err-socket",
      [
        () => sse([contentFrame("half an ans")], midStreamDrop("UND_ERR_SOCKET", "read", "other side closed")),
        () => sse([contentFrame("replayed", "stop"), DONE]),
      ],
      { retryScale: 0.001 },
    );

    expect(replies(events)).toEqual(["half an ans"]);
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(errors(events)).toEqual(["The connection to the model server dropped before the answer finished."]);
    expect(errors(events).join(" ")).not.toMatch(/could not reach|nothing answered/i);
    expect(calls).toBe(1);
  });

  it("keeps reasoning-only partial output when a drop carries EPIPE", async () => {
    const { completed, events } = await runTurn(
      "t-drop-epipe-reasoning",
      [() => sse(
        [frame({ choices: [{ delta: { reasoning_content: "thinking out loud" } }] })],
        midStreamDrop("EPIPE", "write", "write EPIPE"),
      )],
      { reasoning: true },
    );

    expect(replies(events)).toEqual(["thinking out loud"]);
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(errors(events).join(" ")).not.toMatch(/could not reach|nothing answered/i);
  });

  it("still says which address never answered when the connection never happened", async () => {
    responders = [() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      });
    }];
    const instance = create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-dead-endpoint", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(replies(recorder.events)).toEqual([]);
    expect(errors(recorder.events)).toEqual([
      "Could not reach chat.invalid: nothing answered there. Check that the server is running and that its address is right.",
    ]);
    expect(errors(recorder.events)[0]).not.toContain("fetch failed");
  });

  it("still names the address when a response object never arrived after a retry", async () => {
    // A connect failure that is retried and fails again: nothing has ever been
    // received on either attempt, so the honest unreachable copy still wins.
    const refuse = () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }),
      });
    };
    const { completed, events } = await runTurn("t-dead-retry", [refuse, refuse, refuse], { retryScale: 0.001 });

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(errors(events)).toEqual([
      "Could not reach chat.invalid: nothing answered there. Check that the server is running and that its address is right.",
    ]);
  });

  it("never rewrites a user Stop as an unreachable endpoint", async () => {
    // The socket a Stop tears down reports ECONNRESET too. STOP1: a stopped
    // turn is cancelled, keeps its partial, and raises no error at all.
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
              return new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => {
                  controller.error(midStreamDrop("ECONNRESET", "read", "read ECONNRESET"));
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
    await instance.adapter.sendTurn({ threadId: "t-stop-econnreset", text: "question" });
    await recorder.until((event) => event.type === "content.delta");
    await instance.adapter.interruptTurn("t-stop-econnreset");
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(errors(recorder.events)).toEqual([]);
    expect(replies(recorder.events)).toEqual(["working on it"]);
  });

  // vLLM 0.16.0 and later stream reasoning as `delta.reasoning` only (the
  // `reasoning_content` alias was deprecated in 0.11.1 and removed in 0.16.0;
  // DeltaMessage in vllm/entrypoints/generate/base/protocol.py at v0.29.0).
  // 0.11.1 through 0.15.x send the same text under both names on every frame.
  const reasoningDeltas = (events: RuntimeEvent[]) =>
    events.flatMap((event) => (event.type === "content.delta" && event.streamKind === "reasoning_text" ? [event.delta] : []));

  it("streams reasoning a current vLLM sends as delta.reasoning", async () => {
    const { completed, events } = await runTurn(
      "t-vllm-reasoning",
      [() => sse([
        frame({ choices: [{ delta: { role: "assistant", content: "" } }] }),
        frame({ choices: [{ delta: { reasoning: "weigh " } }] }),
        frame({ choices: [{ delta: { reasoning: "options" } }] }),
        contentFrame("answer", "stop"),
        DONE,
      ])],
      { reasoning: true },
    );

    expect(completed).toMatchObject({ ok: true, stopReason: null });
    expect(reasoningDeltas(events)).toEqual(["weigh ", "options"]);
    expect(replies(events)).toEqual(["answer"]);
  });

  it("counts reasoning once when a server sends it under both names", async () => {
    const { events } = await runTurn(
      "t-vllm-both-names",
      [() => sse([
        frame({ choices: [{ delta: { reasoning: "once", reasoning_content: "once" } }] }),
        contentFrame("answer", "stop"),
        DONE,
      ])],
      { reasoning: true },
    );

    expect(reasoningDeltas(events)).toEqual(["once"]);
  });

  it("still reads reasoning_content from servers that only send the older name", async () => {
    const { events } = await runTurn(
      "t-reasoning-content",
      [() => sse([frame({ choices: [{ delta: { reasoning_content: "legacy" } }] }), contentFrame("answer", "stop"), DONE])],
      { reasoning: true },
    );

    expect(reasoningDeltas(events)).toEqual(["legacy"]);
  });

  it("uses message.reasoning from a whole completion when there is no answer text", async () => {
    responders = [() => new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning: "only thought" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })];
    const instance = create({ reasoning: true });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-vllm-whole", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();

    expect(completed).toMatchObject({ ok: true });
    expect(replies(recorder.events)).toEqual(["only thought"]);
  });

  it("returns message.reasoning from a non-streamed helper call with no answer text", async () => {
    responders = [() => new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning: "helper thought" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })];
    const instance = create({ reasoning: true });
    await expect(instance.generateText?.("hello")).resolves.toBe("helper thought");
  });

  // FerroxLabs/murage#7: a local model with no plan channel writes its to-do
  // list into the answer. It becomes the plan checklist and leaves the answer.
  describe("a <todo> block in the answer", () => {
    const assistantDeltas = (events: RuntimeEvent[]) =>
      events.flatMap((event) => (event.type === "content.delta" && event.streamKind === "assistant_text" ? [event.delta] : []));
    const plans = (events: RuntimeEvent[]) =>
      events.flatMap((event) => (event.type === "plan.updated" ? [event.entries] : []));

    it("becomes a plan update and is left out of the streamed and final answer, split anywhere", async () => {
      const reply = "Let me look.\n\n<todo>\n- [ ] Explore the folder\n- [x] Read the notes\n</todo>\n\nI'll start by listing it.";
      const pieces = ["Let me look.\n\n<to", "do>\n- [ ] Explore the fol", "der\n- [x] Read the notes\n</to", "do>\n\nI'll start by listing it."];
      const { completed, events } = await runTurn("t-todo-block", [() => sse([
        ...pieces.map((piece, index) => contentFrame(piece, index === pieces.length - 1 ? "stop" : undefined)),
        DONE,
      ])]);
      expect(pieces.join("")).toBe(reply);
      expect(completed).toMatchObject({ ok: true });
      expect(plans(events)).toEqual([[
        { content: "Explore the folder", status: "pending" },
        { content: "Read the notes", status: "completed" },
      ]]);
      expect(assistantDeltas(events).join("")).toBe("Let me look.\n\nI'll start by listing it.");
      expect(replies(events)).toEqual(["Let me look.\n\nI'll start by listing it."]);
      const types = events.map((event) => event.type);
      expect(types.indexOf("plan.updated")).toBeLessThan(types.indexOf("item.completed"));
    });

    it("keeps a block that is not a checklist, word for word", async () => {
      const reply = "Here:\n<todo>\nnot a list\n</todo>\nand <todo> mid-line";
      const { events } = await runTurn("t-todo-prose", [() => sse([contentFrame(reply, "stop"), DONE])]);
      expect(plans(events)).toEqual([]);
      expect(assistantDeltas(events).join("")).toBe(reply);
      expect(replies(events)).toEqual([reply]);
    });

    it("keeps an unclosed block when the stream is cut off", async () => {
      const partial = "Plan:\n<todo>\n- [ ] a\n- [ ] b";
      const { completed, events } = await runTurn("t-todo-cut", [() => sse([contentFrame(partial)])]);
      expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
      expect(plans(events)).toEqual([]);
      expect(replies(events)).toEqual([partial]);
    });

    it("a reply that is only a to-do list shows the plan and no empty message", async () => {
      const { completed, events } = await runTurn("t-todo-only", [() => sse([contentFrame("<todo>\n- [ ] a\n</todo>", "stop"), DONE])]);
      expect(completed).toMatchObject({ ok: true });
      expect(errors(events)).toEqual([]);
      expect(plans(events)).toEqual([[{ content: "a", status: "pending" }]]);
      expect(replies(events)).toEqual([]);
    });
  });

  describe("bounded network input (S5)", () => {
    type Hop = { url: string; redirect: string | undefined; auth: string | null };
    const hops: Hop[] = [];
    const record = (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      hops.push({ url: String(input), redirect: init?.redirect, auth: headers.get("authorization") });
    };
    const redirectTo = (location: string, status = 307) => new Response(null, { status, headers: { location } });
    const okJson = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    beforeEach(() => {
      hops.length = 0;
    });

    it("asks fetch not to follow redirects on its own", async () => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        record(input, init);
        return okJson();
      }) as typeof fetch;
      await create().generateText!("hello");
      expect(hops[0]?.redirect).toBe("manual");
    });

    it("refuses a redirect to plain http on a public address", async () => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        record(input, init);
        if (hops.length === 1) return redirectTo("http://203.0.113.9/v1/chat/completions");
        throw new Error("the redirected address must never be requested");
      }) as typeof fetch;
      await expect(create().generateText!("hello")).rejects.toThrow(/https/i);
      expect(hops).toHaveLength(1);
    });

    it("refuses a redirect to a non-http scheme", async () => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        record(input, init);
        return redirectTo("file:///etc/passwd");
      }) as typeof fetch;
      await expect(create().generateText!("hello")).rejects.toThrow();
      expect(hops).toHaveLength(1);
    });

    it("drops the Authorization header on a redirect to another origin", async () => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        record(input, init);
        return hops.length === 1 ? redirectTo("https://other.invalid/v1/chat/completions") : okJson();
      }) as typeof fetch;
      await create().generateText!("hello");
      expect(hops).toHaveLength(2);
      expect(hops[0]?.auth).toBe(`Bearer ${SECRET}`);
      expect(hops[1]?.url).toBe("https://other.invalid/v1/chat/completions");
      expect(hops[1]?.auth).toBeNull();
    });

    it("keeps Authorization on a same-origin redirect", async () => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        record(input, init);
        return hops.length === 1 ? redirectTo("/v2/chat/completions") : okJson();
      }) as typeof fetch;
      await create().generateText!("hello");
      expect(hops[1]?.url).toBe("https://chat.invalid/v2/chat/completions");
      expect(hops[1]?.auth).toBe(`Bearer ${SECRET}`);
    });

    it("stops after three redirects", async () => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        record(input, init);
        return redirectTo(`https://chat.invalid/hop${hops.length}`);
      }) as typeof fetch;
      await expect(create().generateText!("hello")).rejects.toThrow(/redirect/i);
      expect(hops).toHaveLength(4);
    });

    it("ends a non-streamed helper call that sends a brace and then goes silent", async () => {
      vi.useFakeTimers();
      try {
        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("{"));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
          });
          return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        const result = create({ timeoutMs: undefined }).generateText!("hello").then(
          () => null,
          (value: unknown) => value as Error,
        );
        await vi.advanceTimersByTimeAsync(300_000);
        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect(error?.name).not.toBe("AbortError");
        expect(error?.message).toBe(
          "The model server did not answer in time. If a large model is still loading, try again in a moment.",
        );
        expect(error?.message).not.toMatch(/\u2014|safe/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
