// tools/flux-stream-sim/sim.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { SUBPROTOCOL, parseServerMessage, type ServerMessage } from "../../shared/flux-stream-contract.ts";
import { toneAndSilence } from "../flux-stream-conformance/fixtures/analyse.ts";
import { scriptedProvider } from "./providers/scripted.ts";
import { createSimServer } from "./server.ts";

type Sim = Awaited<ReturnType<typeof createSimServer>>;
let sim: Sim;
const logs: string[] = [];

beforeEach(async () => {
  logs.length = 0;
  sim = await createSimServer({ port: 0, provider: scriptedProvider(), allowFaults: true, pingMs: 200, usageEveryMs: 500, leaseMs: 1000, log: (l) => logs.push(l) });
});
afterEach(async () => {
  await sim.close();
});

export function connect(query = "", key: string | null = "sim_key", protocols: string[] = [SUBPROTOCOL]) {
  const ws = new WebSocket(`${sim.baseUrl}/audio/transcriptions/stream${query ? `?${query}` : ""}`, protocols, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  const messages: ServerMessage[] = [];
  ws.on("message", (data, binary) => {
    if (binary) return;
    const msg = parseServerMessage(String(data));
    if (msg) messages.push(msg);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, messages, closed, opened };
}

export async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function sendPaced(ws: WebSocket, pcm: Int16Array) {
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < bytes.length; i += 2048) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(bytes.subarray(i, i + 2048));
    await new Promise((r) => setTimeout(r, 64));
  }
}

describe("handshake", () => {
  it("starts a session with the subprotocol and resolved defaults", async () => {
    const c = connect("foo=1");
    await c.opened;
    expect(c.ws.protocol).toBe(SUBPROTOCOL);
    await until(() => c.messages.length > 0);
    expect(c.messages[0]).toMatchObject({ type: "session.started", seq: 1, model: "flux-voice-stream", ignored_params: ["foo"] });
    const cfg = (c.messages[0] as { config: Record<string, unknown> }).config;
    expect(cfg.min_silence_ms).not.toBeNull();
    expect(cfg.max_silence_ms).not.toBeNull();
    c.ws.close();
  });

  it("ignores the legacy silence name instead of applying it", async () => {
    const c = connect("min_end_of_turn_silence_when_confident=900");
    await until(() => c.messages.length > 0);
    expect(c.messages[0]).toMatchObject({ type: "session.started", ignored_params: ["min_end_of_turn_silence_when_confident"] });
    const control = connect(); // the same silences as a connect without the name
    await until(() => control.messages.length > 0);
    const cfg = (c.messages[0] as { config: Record<string, unknown> }).config;
    expect(cfg).toEqual((control.messages[0] as { config: Record<string, unknown> }).config);
    expect(cfg.min_silence_ms).not.toBe(900);
    c.ws.close();
    control.ws.close();
  });

  it("returns no subprotocol when none was offered, and serves v1", async () => {
    const c = connect("", "sim_key", []);
    await c.opened;
    expect(c.ws.protocol).toBe("");
    await until(() => c.messages.length > 0);
    expect(c.messages[0].type).toBe("session.started");
    c.ws.close();
  });

  it.each([
    [null, 4401, "unauthorized"],
    ["not-a-flux-key", 4401, "unauthorized"],
    ["sim_bad", 4401, "unauthorized"],
    ["sim_free", 4402, "premium_locked"],
    ["sim_noCredit", 4402, "credit_exhausted"],
    ["sim_nobilling", 4402, "billing_unavailable"],
    ["sim_forbidden", 4403, "forbidden"],
    ["sim_dark", 4404, "not_found"],
  ])("key %s closes %i with an error first", async (key, code, errorCode) => {
    const c = connect("", key);
    const closed = await c.closed;
    expect(closed.code).toBe(code);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]).toMatchObject({ type: "error", error: { code: errorCode, fatal: true, close_code: code } });
  });

  it("refuses an unknown protocol version", async () => {
    const c = connect("", "sim_key", ["flux.stt.v9"]);
    expect((await c.closed).code).toBe(4400);
    expect(c.messages[0]).toMatchObject({ error: { code: "unsupported_protocol" } });
  });

  it("refuses a key in the query, naming the parameter", async () => {
    const c = connect("ApiKey=not-a-flux-key");
    expect((await c.closed).code).toBe(4400);
    expect(c.messages[0]).toMatchObject({ error: { code: "invalid_param", param: "ApiKey" } });
  });

  it("limits concurrent sessions per account, not per key string", async () => {
    const a = connect("", "sim_limited");
    await until(() => a.messages.some((m) => m.type === "session.started"));
    const b = connect("", "sim_limited");
    expect((await b.closed).code).toBe(4429);
    expect(b.messages[0]).toMatchObject({ error: { code: "concurrency_limit" } });
    a.ws.close();
  });
});

describe("session start rate limit", () => {
  it("refuses the start over startsPerMinute fleet-wide, whichever account it is", async () => {
    const limited = await createSimServer({ port: 0, provider: scriptedProvider(), startsPerMinute: 2, log: () => {} });
    const open = (key: string) => {
      const ws = new WebSocket(`${limited.baseUrl}/audio/transcriptions/stream`, [SUBPROTOCOL], { headers: { authorization: `Bearer ${key}` } });
      const messages: ServerMessage[] = [];
      ws.on("message", (d, binary) => {
        if (binary) return;
        const m = parseServerMessage(String(d));
        if (m) messages.push(m);
      });
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      return { ws, messages, closed };
    };
    try {
      const a = open("sim_key");
      await until(() => a.messages.length > 0);
      a.ws.close();
      await a.closed;
      const b = open("sim_key");
      await until(() => b.messages.length > 0);
      b.ws.close();
      await b.closed;
      const c = open("sim_key2"); // a different account: the cap is fleet-wide
      expect(await c.closed).toBe(4503);
      expect(c.messages[0]).toMatchObject({ type: "error", error: { code: "service_unavailable", type: "api_error", fatal: true, close_code: 4503 } });
      expect((c.messages[0] as { error: { retry_after_ms: number } }).error.retry_after_ms).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});

describe("audio and turns", () => {
  it("turns two bursts at low eagerness into one turn, with finals before the end", async () => {
    const c = connect("eagerness=low&sim_script=Blues%20Brothers,|and%20Heartbreak%20Ridge.");
    await until(() => c.messages.length > 0);
    await sendPaced(c.ws, toneAndSilence([["silence", 200], ["tone", 900], ["silence", 1200], ["tone", 800], ["silence", 2200]]));
    await until(() => c.messages.some((m) => m.type === "turn.end"));
    const ends = c.messages.filter((m) => m.type === "turn.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ turn: 0, text: "Blues Brothers, and Heartbreak Ridge." });
    expect((ends[0] as { server_lag_ms: number }).server_lag_ms).toBeGreaterThanOrEqual(0);
    const finals = c.messages.filter((m) => m.type === "transcript.final");
    expect(finals.at(-1)).toMatchObject({ turn_text: "Blues Brothers, and Heartbreak Ridge." });
    expect(c.messages.map((m) => m.seq)).toEqual(c.messages.map((_, i) => i + 1));
    c.ws.close();
  }, 15_000);

  it("buffers audio sent before session.started, dropping the oldest, and reports it after", async () => {
    const c = connect("sim_fault=begin_delay_ms%3D1500");
    await c.opened;
    for (let i = 0; i < 70; i += 1) c.ws.send(Buffer.alloc(2048)); // 4.48 s before the session starts
    await until(() => c.messages.some((m) => m.type === "warning"), 5000);
    expect(c.messages[0].type).toBe("session.started");
    expect(c.messages.find((m) => m.type === "warning")).toMatchObject({ code: "audio_dropped", at_audio_ms: 0 });
    c.ws.close();
  });

  it("closes 4413 on a frame over a second", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    c.ws.send(Buffer.alloc(35_200));
    expect((await c.closed).code).toBe(4413);
  });

  it("forces a turn end on commit", async () => {
    const c = connect("eagerness=low&sim_script=hello%20there");
    await until(() => c.messages.length > 0);
    await sendPaced(c.ws, toneAndSilence([["tone", 700]]));
    c.ws.send(JSON.stringify({ type: "turn.commit" }));
    await until(() => c.messages.some((m) => m.type === "turn.end"));
    expect(c.messages.find((m) => m.type === "turn.end")).toMatchObject({ reason: "forced" });
    c.ws.close();
  });

  it("answers a commit with no open turn after the commit deadline", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    const at = Date.now();
    c.ws.send(JSON.stringify({ type: "turn.commit" }));
    await until(() => c.messages.some((m) => m.type === "turn.committed"));
    expect(c.messages.find((m) => m.type === "turn.committed")).toMatchObject({ turn: null });
    expect(Date.now() - at).toBeLessThan(1500);
    c.ws.close();
  });

  it("reports non-fatal protocol errors, then closes after five", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    c.ws.send('{"type":"dance"}');
    await until(() => c.messages.some((m) => m.type === "error"));
    expect(c.messages.find((m) => m.type === "error")).toMatchObject({ error: { code: "unknown_message_type", fatal: false } });
    for (let i = 0; i < 4; i += 1) c.ws.send("{nope");
    expect((await c.closed).code).toBe(4400);
  });

  it("applies an eagerness change from the preset, not from stale resolved numbers", async () => {
    const c = connect("eagerness=high");
    await until(() => c.messages.length > 0);
    c.ws.send(JSON.stringify({ type: "session.update", config: { eagerness: "low" } }));
    await until(() => c.messages.some((m) => m.type === "session.updated"));
    expect(c.messages.find((m) => m.type === "session.updated")).toMatchObject({ config: { eagerness: "low", min_silence_ms: 1500 } });
    c.ws.close();
  });

  it("keeps controls sent before session.started in order with the audio around them", async () => {
    const c = connect("eagerness=low&sim_fault=begin_delay_ms%3D1000&sim_script=first|second");
    await c.opened;
    const tone = toneAndSilence([["tone", 700]]);
    const bytes = Buffer.from(tone.buffer, tone.byteOffset, tone.byteLength);
    for (let i = 0; i < bytes.length; i += 2048) c.ws.send(bytes.subarray(i, i + 2048)); // audio A
    c.ws.send(JSON.stringify({ type: "turn.commit" })); // then the commit
    for (let i = 0; i < bytes.length; i += 2048) c.ws.send(bytes.subarray(i, i + 2048)); // then audio B
    await until(() => c.messages.some((m) => m.type === "turn.end"), 5000);
    expect(c.messages[0].type).toBe("session.started");
    expect(c.messages.find((m) => m.type === "turn.end")).toMatchObject({ turn: 0, text: "first", reason: "forced" });
    c.ws.close();
  });

  it("accepts nothing queued after a session.close sent before session.started (Astra 2 I10)", async () => {
    const c = connect("sim_fault=begin_delay_ms%3D500");
    await c.opened;
    c.ws.send(Buffer.alloc(3200)); // 100 ms
    c.ws.send(JSON.stringify({ type: "session.close" }));
    c.ws.send(Buffer.alloc(3200)); // after the barrier
    await c.closed;
    const closed = c.messages.find((m) => m.type === "session.closed") as { usage: { audio_seconds: number } } | undefined;
    expect(closed?.usage.audio_seconds).toBe(0.1);
  });

  it("keeps the audio before a pre-start close: later audio can neither queue nor evict it (Astra 3 I6)", async () => {
    const c = connect("sim_fault=begin_delay_ms%3D500");
    await c.opened;
    for (let i = 0; i < 30; i += 1) c.ws.send(Buffer.alloc(3200)); // A: 3 s, the whole pre-start buffer
    c.ws.send(JSON.stringify({ type: "session.close" }));
    for (let i = 0; i < 30; i += 1) c.ws.send(Buffer.alloc(3200)); // B: 3 s after the close
    await c.closed;
    const closed = c.messages.find((m) => m.type === "session.closed") as { usage: { audio_seconds: number } } | undefined;
    expect(closed?.usage.audio_seconds).toBe(3); // all of A, none of B
    expect(c.messages.some((m) => m.type === "warning")).toBe(false); // nothing of A was evicted
  });

  it("reports every dropped range still owed before session.closed (Astra 4 I7)", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    for (let i = 0; i < 40; i += 1) c.ws.send(Buffer.alloc(3200)); // 4 s at once: 1 s over the burst, dropped inside one warning interval
    c.ws.send(JSON.stringify({ type: "session.close" }));
    await c.closed;
    const closed = c.messages.at(-1) as { type: string; received_audio_ms: number };
    const warnings = c.messages.filter((m) => m.type === "warning") as Array<{ dropped_ms: number }>;
    expect(closed.type).toBe("session.closed");
    expect(warnings.reduce((n, w) => n + w.dropped_ms, 0) + closed.received_audio_ms).toBe(4000);
  });

  it("refuses an immutable update without closing", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    c.ws.send(JSON.stringify({ type: "session.update", config: { format: false } }));
    c.ws.send(JSON.stringify({ type: "session.update", config: { eagerness: "high" } }));
    await until(() => c.messages.some((m) => m.type === "session.updated"));
    expect(c.messages.find((m) => m.type === "error")).toMatchObject({ error: { code: "config_immutable", param: "format" } });
    c.ws.close();
  });
});

describe("lifecycle and metering", () => {
  it("closes idle sessions with 4408", async () => {
    const c = connect("idle_timeout_s=5");
    const closed = await c.closed;
    expect(closed.code).toBe(4408);
    expect(c.messages.at(-1)).toMatchObject({ type: "error", error: { code: "idle_timeout" } });
  }, 10_000);

  it("keeps a session alive on keepalive", async () => {
    const c = connect("idle_timeout_s=5");
    await c.opened;
    const timer = setInterval(() => c.ws.send('{"type":"keepalive"}'), 1000);
    await new Promise((r) => setTimeout(r, 6500));
    clearInterval(timer);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  }, 10_000);

  it("closes gracefully with usage, and the lease rows sum to the billed seconds", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    await new Promise((r) => setTimeout(r, 2600)); // leases of 1 s in this test server
    c.ws.send('{"type":"session.close"}');
    const closed = await c.closed;
    expect(closed.code).toBe(1000);
    const last = c.messages.at(-1) as { type: string; reason: string; usage: { billed_seconds: number } };
    expect(last).toMatchObject({ type: "session.closed", reason: "client_close", usage: { billed_seconds: 10, unit: "session_second" } });
    const rows = sim.ledger().filter((r) => r.session === (c.messages[0] as { session_id: string }).session_id);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.reduce((n, r) => n + r.units, 0)).toBe(last.usage.billed_seconds);
  });

  it("sends periodic usage and pings", async () => {
    const c = connect();
    let pings = 0;
    c.ws.on("ping", () => (pings += 1));
    await new Promise((r) => setTimeout(r, 1200));
    expect(c.messages.some((m) => m.type === "usage")).toBe(true);
    expect(pings).toBeGreaterThan(2);
    c.ws.close();
  });

  it("closes at max_session_s with the max_duration reason", async () => {
    const c = connect("sim_fault=max_session_s%3D1");
    const closed = await c.closed;
    expect(closed.code).toBe(1000);
    expect(c.messages.at(-1)).toMatchObject({ type: "session.closed", reason: "max_duration" });
  }, 10_000);

  it("never logs a key", async () => {
    const c = connect("", "sim_key");
    await until(() => c.messages.length > 0);
    c.ws.close();
    await c.closed;
    expect(logs.join("\n")).not.toContain("sim_key");
  });
});

describe("faults", () => {
  it.each([
    ["reject=402", 4402, "premium_locked"],
    ["reject=429", 4429, "rate_limit_error"],
    ["reject=404", 4404, "not_found"],
    ["close_after_ms=300:4502", 4502, "capability_unavailable"],
    ["close_after_ms=300:4504", 4504, "upstream_timeout"],
    ["begin_delay_ms=10000", 4504, "upstream_timeout"],
  ])("%s closes %i", async (fault, code, errorCode) => {
    const c = connect(`sim_fault=${encodeURIComponent(fault)}`);
    expect((await c.closed).code).toBe(code);
    expect(c.messages.at(-1)).toMatchObject({ type: "error", error: { code: errorCode } });
    if (code === 4429) expect(c.messages.at(-1)).toMatchObject({ error: { retry_after_ms: 5000 } });
  }, 15_000);

  it("answers 503 at the handshake", async () => {
    const c = connect("sim_fault=reject%3D503");
    const err = await c.opened.catch((e: Error) => e);
    expect(String(err)).toMatch(/503/);
  });

  it("drops the TCP connection without a close frame", async () => {
    const c = connect("sim_fault=drop_after_ms%3D300");
    expect((await c.closed).code).toBe(1006);
  });

  it("drains with session.closed going_away and 1001", async () => {
    const c = connect("sim_fault=close_after_ms%3D300%3A1001");
    expect((await c.closed).code).toBe(1001);
    expect(c.messages.at(-1)).toMatchObject({ type: "session.closed", reason: "going_away" });
  });

  it("delays every message by latency_ms", async () => {
    const t0 = Date.now();
    const c = connect("sim_fault=latency_ms%3D400");
    await until(() => c.messages.length > 0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    c.ws.close();
  });

  it("applies global faults to new sessions", async () => {
    sim.setFaults({ reject: 402 });
    const c = connect();
    expect((await c.closed).code).toBe(4402);
    sim.setFaults({});
  });

  it("arms a fault on an open session that fires after its next speech", async () => {
    const c = connect("eagerness=low&sim_script=a%20long%20sentence");
    await until(() => c.messages.some((m) => m.type === "session.started"));
    const res = await fetch(`${sim.baseUrl.replace("ws://", "http://").replace("/v1", "")}/__sim/faults`, {
      method: "POST",
      body: JSON.stringify({ spec: "close_after_speech_ms=300:4502", open: true }),
    });
    expect(((await res.json()) as { applied: string[] }).applied).toHaveLength(1);
    await sendPaced(c.ws, toneAndSilence([["tone", 1500]]));
    expect((await c.closed).code).toBe(4502);
    expect(logs.some((l) => /fault close_after_speech_ms fired .* open=true/.test(l))).toBe(true);
  }, 10_000);

  it("banks at most the burst while idle: a burst after a long silence is still capped (Astra 2 I9)", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    c.ws.send(Buffer.alloc(3200)); // 100 ms, then 4 s of nothing
    await new Promise((r) => setTimeout(r, 4000));
    for (let i = 0; i < 100; i += 1) c.ws.send(Buffer.alloc(3200)); // 10 s at once
    await until(() => c.messages.some((m) => m.type === "warning"));
    const warning = c.messages.find((m) => m.type === "warning") as { dropped_ms: number };
    expect(warning.dropped_ms).toBeGreaterThanOrEqual(6_900); // at most 3 s (plus the frame in flight) was accepted
    c.ws.close();
  }, 15_000);

  it("reports each separate dropped run as its own range (Astra 3 I9)", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    for (let i = 0; i < 40; i += 1) c.ws.send(Buffer.alloc(3200)); // 4 s at once: about 1 s dropped, warned at once
    await until(() => c.messages.some((m) => m.type === "warning"));
    // two more runs inside the next warning interval, accepted audio between them
    for (const _ of [0, 1]) {
      await new Promise((r) => setTimeout(r, 300)); // about 300 ms of credit comes back
      for (let i = 0; i < 6; i += 1) c.ws.send(Buffer.alloc(3200)); // 600 ms: about 300 accepted, then a run dropped
    }
    await until(() => c.messages.filter((m) => m.type === "warning").length >= 2, 3000);
    const w = c.messages.filter((m) => m.type === "warning")[1] as { dropped_ms: number; at_audio_ms: number; ranges: Array<{ at_audio_ms: number; dropped_ms: number }> };
    expect(w.ranges.length).toBe(2);
    expect(w.ranges[1].at_audio_ms).toBeGreaterThan(w.ranges[0].at_audio_ms); // accepted audio lies between them
    expect(w.dropped_ms).toBe(w.ranges[0].dropped_ms + w.ranges[1].dropped_ms);
    c.ws.close();
  });

  it("keeps one barrier's padding free when it admits audio (Astra 5 I2)", async () => {
    const backed = await createSimServer({
      port: 0, allowFaults: true, pingMs: 200, usageEveryMs: 500, leaseMs: 1000, log: () => undefined,
      provider: {
        name: "backlogged",
        async connect(config) {
          return { sendAudio() {}, commit() {}, update: () => true, keepalive() {}, backlogMs: () => 2940, barrierReserveMs: () => 50,
            effectiveConfig: () => ({ ...config, min_silence_ms: 400, max_silence_ms: 1280 }), async close() {} };
        },
      },
    });
    try {
      const ws = new WebSocket(`${backed.baseUrl}/audio/transcriptions/stream`, [SUBPROTOCOL], { headers: { authorization: "Bearer sim_key" } });
      const messages: ServerMessage[] = [];
      ws.on("message", (d) => { const m = parseServerMessage(String(d)); if (m) messages.push(m); });
      await until(() => messages.length > 0);
      ws.send(Buffer.alloc(640)); // 20 ms: 2940 + 20 fits burst_ms, but not with the 50 ms a following barrier may need
      await until(() => messages.some((m) => m.type === "warning"), 3000);
      expect(messages.find((m) => m.type === "warning")).toMatchObject({ code: "audio_dropped", dropped_ms: 20 });
      ws.close();
    } finally {
      await backed.close();
    }
  });

  it("never admits audio past the provider's queued work, padding included (Astra 3 I8)", async () => {
    const backed = await createSimServer({
      port: 0, allowFaults: true, pingMs: 200, usageEveryMs: 500, leaseMs: 1000, log: () => undefined,
      provider: {
        name: "backlogged",
        async connect(config) {
          return { sendAudio() {}, commit() {}, update: () => true, keepalive() {}, backlogMs: () => 2990, effectiveConfig: () => ({ ...config, min_silence_ms: 400, max_silence_ms: 1280 }), async close() {} };
        },
      },
    });
    try {
      const ws = new WebSocket(`${backed.baseUrl}/audio/transcriptions/stream`, [SUBPROTOCOL], { headers: { authorization: "Bearer sim_key" } });
      const messages: ServerMessage[] = [];
      ws.on("message", (d) => { const m = parseServerMessage(String(d)); if (m) messages.push(m); });
      await until(() => messages.length > 0);
      ws.send(Buffer.alloc(640)); // 20 ms: credit allows it, the provider's 2990 ms queue does not
      await until(() => messages.some((m) => m.type === "warning"), 3000);
      expect(messages.find((m) => m.type === "warning")).toMatchObject({ code: "audio_dropped", dropped_ms: 20 });
      ws.close();
    } finally {
      await backed.close();
    }
  });

  it("warns and keeps going when audio arrives in a burst", async () => {
    const c = connect();
    await until(() => c.messages.length > 0);
    for (let i = 0; i < 100; i += 1) c.ws.send(Buffer.alloc(2048)); // 6.4 s at once
    await until(() => c.messages.some((m) => m.type === "warning"));
    expect(c.messages.find((m) => m.type === "warning")).toMatchObject({ code: "audio_dropped" });
    expect((c.messages.find((m) => m.type === "warning") as { at_audio_ms?: number }).at_audio_ms).toBeGreaterThan(0);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("closes a client that stops reading with 4503 slow_consumer", async () => {
    const c = connect("sim_fault=flood");
    await until(() => c.messages.some((m) => m.type === "session.started"));
    (c.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const closed = await Promise.race([c.closed, new Promise<{ code: number }>((r) => setTimeout(() => r({ code: -1 }), 8000))]);
    (c.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    expect([4503, -1]).toContain(closed.code);
    await until(() => c.messages.some((m) => m.type === "error"), 8000);
    expect(c.messages.find((m) => m.type === "error")).toMatchObject({ error: { code: "slow_consumer" } });
  }, 20_000);

  it("sends session.expiring 30 s before max_session, then closes with max_duration", async () => {
    const c = connect("sim_fault=max_session_s%3D32");
    await c.opened;
    const keepalive = setInterval(() => c.ws.readyState === WebSocket.OPEN && c.ws.send('{"type":"keepalive"}'), 1000); // idle_timeout_s is 30, under the 32 s session
    await until(() => c.messages.some((m) => m.type === "session.expiring"), 5000);
    const closed = await c.closed;
    clearInterval(keepalive);
    expect(closed.code).toBe(1000);
    expect(c.messages.at(-1)).toMatchObject({ type: "session.closed", reason: "max_duration" });
  }, 45_000);

  it("answers 400 to a malformed /__sim/faults body", async () => {
    const url = `${sim.baseUrl.replace("ws://", "http://").replace("/v1", "")}/__sim/faults`;
    for (const body of ["{not json", "null", "[1]"]) {
      const res = await fetch(url, { method: "POST", body });
      expect(res.status).toBe(400);
    }
    const ok = await fetch(url, { method: "POST", body: JSON.stringify({ spec: "" }) });
    expect(ok.status).toBe(204);
  });

  it("leaves no live timers when the provider errors during the pre-start replay", async () => {
    const made: Array<ReturnType<typeof setInterval>> = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const handle = realSet(...args);
      made.push(handle);
      return handle;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(((handle: Parameters<typeof clearInterval>[0]) => {
      cleared.add(handle);
      return realClear(handle);
    }) as typeof clearInterval);
    const failing = await createSimServer({
      port: 0, allowFaults: true, pingMs: 200, usageEveryMs: 500, leaseMs: 1000, log: () => undefined,
      provider: {
        name: "fails-in-replay",
        async connect(config, _options, emit) {
          await new Promise((r) => setTimeout(r, 200)); // audio sent meanwhile is queued for the replay
          return { sendAudio() { emit({ kind: "error", code: "capability_unavailable", message: "boom" }); }, commit() {}, update: () => true, keepalive() {},
            effectiveConfig: () => ({ ...config, min_silence_ms: 400, max_silence_ms: 1280 }), async close() {} };
        },
      },
    });
    try {
      const ws = new WebSocket(`${failing.baseUrl}/audio/transcriptions/stream`, [SUBPROTOCOL], { headers: { authorization: "Bearer sim_key" } });
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      await new Promise<void>((r) => ws.once("open", () => r()));
      ws.send(Buffer.alloc(640));
      expect(await closed).toBe(4502);
      await new Promise((r) => setTimeout(r, 100));
      await vi.waitFor(() => expect(failing.openSessions()).toEqual([]));
      expect(made.length).toBeGreaterThan(0);
      expect(made.filter((h) => !cleared.has(h))).toEqual([]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      for (const h of made) realClear(h); // never leave one running, whatever the assertion said
      await failing.close();
    }
  });
});

describe("session start cap, with the concurrency limit", () => {
  const open = (baseUrl: string, key: string) => {
    const ws = new WebSocket(`${baseUrl}/audio/transcriptions/stream`, [SUBPROTOCOL], { headers: { authorization: `Bearer ${key}` } });
    const messages: ServerMessage[] = [];
    ws.on("message", (d, binary) => {
      if (binary) return;
      const m = parseServerMessage(String(d));
      if (m) messages.push(m);
    });
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    return { ws, messages, closed };
  };

  it("answers service_unavailable when the start cap and the concurrency limit would both refuse (the start check runs first)", async () => {
    const limited = await createSimServer({ port: 0, provider: scriptedProvider(), startsPerMinute: 2, log: () => undefined });
    try {
      const a = open(limited.baseUrl, "sim_limited"); // start 1, takes the account's only slot
      await until(() => a.messages.some((m) => m.type === "session.started"));
      const b = open(limited.baseUrl, "sim_limited"); // start 2 counts, then the concurrency check refuses it
      expect(await b.closed).toBe(4429);
      expect(b.messages[0]).toMatchObject({ error: { code: "concurrency_limit" } });
      const c = open(limited.baseUrl, "sim_limited"); // the cap is hit and the slot is taken: the cap wins
      expect(await c.closed).toBe(4503);
      expect(c.messages[0]).toMatchObject({ error: { code: "service_unavailable" } });
      a.ws.close();
    } finally {
      await limited.close();
    }
  });

  it("lets a start through again once the oldest leaves the 60 s window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // sockets and timers stay real; only the clock the window reads moves
    const limited = await createSimServer({ port: 0, provider: scriptedProvider(), startsPerMinute: 1, log: () => undefined });
    try {
      const a = open(limited.baseUrl, "sim_key");
      await until(() => a.messages.some((m) => m.type === "session.started"));
      a.ws.close();
      await a.closed;
      const b = open(limited.baseUrl, "sim_key");
      expect(await b.closed).toBe(4503);
      const retry = (b.messages[0] as { error: { retry_after_ms: number } }).error.retry_after_ms;
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(60_000);
      vi.setSystemTime(Date.now() + 59_000);
      const early = open(limited.baseUrl, "sim_key"); // still inside the window
      expect(await early.closed).toBe(4503);
      vi.setSystemTime(Date.now() + 2_000); // the first start is now 61 s old
      const d = open(limited.baseUrl, "sim_key");
      await until(() => d.messages.some((m) => m.type === "session.started"));
      d.ws.close();
    } finally {
      vi.useRealTimers();
      await limited.close();
    }
  });
});


