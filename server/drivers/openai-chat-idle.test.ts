// Renewable idle budget over a real loopback HTTP/SSE transport (U02). The
// runtime's fetch talks to a node:http server on 127.0.0.1, so aborts, socket
// closes and chunk timing are the real ones. Waits that are the quantity under
// test (progress cadence, the idle budget) use the server's own timers; every
// synchronisation point waits on an observed event instead.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { freePortBlock } from "../testing/ports.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const IDLE_MS = 600;
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const content = (text: string) => frame({ choices: [{ delta: { content: text } }] });
const reasoningFrame = (text: string) => frame({ choices: [{ delta: { reasoning_content: text } }] });
const finish = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
const DONE = "data: [DONE]\n\n";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const replies = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : []));
const errors = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "runtime.error" ? [event.message] : []));
const completions = (events: RuntimeEvent[]) => events.filter((event) => event.type === "turn.completed");

/** Resolves on the first call, or rejects after `ms` so a missed barrier
 * fails with a message instead of hanging the file. */
const barrier = (what: string, ms = 10_000) => {
  let open!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`barrier not reached: ${what}`)), ms);
    open = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, open };
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createOpenAIChatRuntime idle budget over loopback HTTP", () => {
  let server: Server;
  let baseUrl = "";
  let handler: Handler = (_req, res) => res.end();
  let requests = 0;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const instances: ProviderInstance[] = [];

  /** Server-side timers owned by the test, cleared in afterEach. */
  const every = (ms: number, fn: () => void) => {
    const timer = setInterval(fn, ms);
    timers.add(timer);
    return () => {
      clearInterval(timer);
      timers.delete(timer);
    };
  };

  beforeEach(async () => {
    ensureDirs();
    requests = 0;
    const port = await freePortBlock([0], 42_000, 1_000);
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") requests++;
      req.resume();
      handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    for (const instance of instances.splice(0)) await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const create = (overrides: { timeoutMs?: number; reasoning?: boolean } = {}) => {
    const instance = createOpenAIChatRuntime({
      input: { instanceId: "idle-test", displayName: "Idle test", environment: {}, enabled: true, config: {} },
      driverKind: "openai-chat-idle-test",
      apiKey: "sk-idle-loopback-synthetic",
      apiUrl: baseUrl,
      models: () => ({ default: "test-model", options: [{ id: "test-model", label: "Test model" }] }),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Loopback",
      missingKeyError: "missing key",
      unavailableReason: "no key",
      timeoutMs: IDLE_MS,
      nativeLog: {
        source: "test.idle.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text }) => ({ textLength: text.length }),
      },
      ...overrides,
    });
    instances.push(instance);
    return instance;
  };

  const sse = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
  };

  /** Run one turn to its terminal event, then prove the runtime stays inert
   * past another idle budget: no late event and no replayed request. */
  const runTurn = async (instance: ProviderInstance, threadId: string) => {
    const recorder = recordEvents(instance.adapter);
    const started = performance.now();
    await instance.adapter.sendTurn({ threadId, text: "question" });
    const completed = await recorder.until((event) => event.type === "turn.completed", 15_000);
    const settledAt = performance.now();
    const settledMs = settledAt - started;
    const seen = recorder.events.length;
    const requestsAtSettle = requests;
    await delay(IDLE_MS + 300);
    expect(recorder.events.length).toBe(seen);
    expect(requests).toBe(requestsAtSettle);
    expect(completions(recorder.events)).toHaveLength(1);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
    recorder.stop();
    return { completed, events: recorder.events, settledMs, settledAt };
  };

  it("completes an actively progressing stream that outlasts the idle budget several times", async () => {
    const total = 10;
    handler = (_req, res) => {
      sse(res);
      let sent = 0;
      const stop = every(150, () => {
        if (sent < total) {
          res.write(content(`${sent} `));
          sent++;
          return;
        }
        stop();
        res.end(finish + DONE);
      });
    };
    const { completed, events, settledMs } = await runTurn(create(), "t-progress");

    expect(completed).toMatchObject({ ok: true, stopReason: null });
    expect(settledMs).toBeGreaterThan(IDLE_MS * 2);
    expect(replies(events)).toEqual(["0 1 2 3 4 5 6 7 8 9 "]);
    expect(errors(events)).toEqual([]);
    expect(requests).toBe(1);
  });

  it("fails a stream that stalls after output, keeps the partial and never replays", async () => {
    let lastProgressAt = 0;
    handler = (_req, res) => {
      sse(res);
      res.write(content("partial "));
      lastProgressAt = performance.now();
    };
    const { completed, events, settledAt } = await runTurn(create(), "t-stall");
    const idleFor = settledAt - lastProgressAt;

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(idleFor).toBeGreaterThanOrEqual(IDLE_MS);
    expect(replies(events)).toEqual(["partial "]);
    expect(errors(events)).toEqual(['The model server stopped sending this answer before it was finished.']);
    expect(requests).toBe(1);
  });

  it("bounds a provider that never sends a first byte", async () => {
    const received = barrier("request received");
    handler = () => received.open();
    const { completed, events, settledMs } = await runTurn(create(), "t-no-first-byte");
    await received.promise;

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(settledMs).toBeGreaterThanOrEqual(IDLE_MS - 5);
    expect(errors(events)).toEqual(['The model server did not answer in time. If a large model is still loading, try again in a moment.']);
    expect(replies(events)).toEqual([]);
    expect(requests).toBe(1);
  });

  it("does not let keepalive comments or empty deltas hold a stalled stream open", async () => {
    let keepalives = 0;
    let keepalivesAtTimeout = 0;
    let lastProgressAt = 0;
    handler = (_req, res) => {
      sse(res);
      res.write(content("partial "));
      lastProgressAt = performance.now();
      const stop = every(100, () => {
        keepalives++;
        res.write(": keep-alive\n\n");
        res.write(frame({ choices: [{ delta: { role: "assistant" } }] }));
        res.write(frame({ choices: [{ delta: { content: "" } }] }));
        res.write("data:\n\n");
      });
      res.on("close", () => {
        keepalivesAtTimeout = keepalives;
        stop();
      });
    };
    const { completed, events, settledAt } = await runTurn(create(), "t-keepalive");
    const idleFor = settledAt - lastProgressAt;

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(idleFor).toBeGreaterThanOrEqual(IDLE_MS);
    // keepalive bytes kept arriving every 100ms across the whole idle window
    expect(keepalivesAtTimeout).toBeGreaterThanOrEqual(Math.floor(IDLE_MS / 100) - 1);
    expect(errors(events)).toEqual(['The model server stopped sending this answer before it was finished.']);
    expect(requests).toBe(1);
  });

  it.each([true, false])("renews on reasoning progress (reasoning surfaced: %s)", async (reasoning) => {
    handler = (_req, res) => {
      sse(res);
      let sent = 0;
      const stop = every(150, () => {
        if (sent < 10) {
          res.write(reasoningFrame("thinking "));
          sent++;
          return;
        }
        stop();
        res.end(content("answer") + finish + DONE);
      });
    };
    const { completed, events, settledMs } = await runTurn(create({ reasoning }), `t-reasoning-${reasoning}`);

    expect(completed).toMatchObject({ ok: true, stopReason: null });
    expect(settledMs).toBeGreaterThan(IDLE_MS * 2);
    expect(replies(events)).toEqual(["answer"]);
    expect(requests).toBe(1);
  });

  it("settles an external Stop mid-stream promptly as cancelled and closes the connection", async () => {
    const received = barrier("request received");
    const closed = barrier("provider connection closed");
    handler = (_req, res) => {
      sse(res);
      res.write(content("working "));
      res.on("close", () => closed.open());
      received.open();
    };
    const instance = create({ timeoutMs: 20_000 });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-stop", text: "question" });
    await received.promise;
    await recorder.until((event) => event.type === "content.delta");
    const stoppedAt = performance.now();
    await instance.adapter.interruptTurn("t-stop");
    const completed = await recorder.until((event) => event.type === "turn.completed");
    const stopMs = performance.now() - stoppedAt;
    await closed.promise;
    recorder.stop();

    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(stopMs).toBeLessThan(5_000);
    expect(completions(recorder.events)).toHaveLength(1);
    expect(errors(recorder.events)).toEqual([]);
    // F6: the words the person already watched arrive are kept when they stop.
    expect(replies(recorder.events)).toEqual(["working "]);
    expect(requests).toBe(1);
  });

  it("bounds a non-streamed helper call that never answers", async () => {
    const received = barrier("request received");
    handler = () => received.open();
    const instance = create();
    const started = performance.now();
    const result = instance.generateText!("hello");
    await received.promise;
    const error = await result.then(() => null, (value: unknown) => value as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.name).not.toBe("AbortError");
    expect(error?.message).toBe('The model server did not answer in time. If a large model is still loading, try again in a moment.');
    expect(performance.now() - started).toBeGreaterThanOrEqual(IDLE_MS - 5);
    expect(requests).toBe(1);
  });

  it("keeps an HTTP error status when its error body stalls past the budget", async () => {
    handler = (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.flushHeaders();
    };
    const { completed, events } = await runTurn(create(), "t-http-error-stall");

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(errors(events)).toEqual(["The model server would not accept this request."]);
    expect(requests).toBe(1);
  });

  it("keeps a premature end of stream honest instead of calling it a timeout", async () => {
    handler = (_req, res) => {
      sse(res);
      res.end(content("cut off"));
    };
    const { completed, events } = await runTurn(create(), "t-premature-eof");

    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete" });
    expect(replies(events)).toEqual(["cut off"]);
    expect(errors(events)).toEqual(['The model server stopped before it finished this answer.']);
    expect(requests).toBe(1);
  });
});
