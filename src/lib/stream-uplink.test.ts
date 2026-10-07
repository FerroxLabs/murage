import { describe, expect, it, vi } from "vitest";

import { StreamUplink, UplinkRefused } from "./stream-uplink";

class FakeSocket {
  static last: FakeSocket | undefined;
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  sent: unknown[] = [];
  private handlers: Record<string, Array<(e: any) => void>> = {};
  constructor(readonly url: string, readonly protocols: string[]) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  fire(type: string, e: any = {}) {
    for (const fn of this.handlers[type] ?? []) fn(e);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.fire("close", { code: 1000 });
  }
}

const calls: Array<{ url: string; init?: RequestInit }> = [];
const okTicket = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  return new Response(JSON.stringify({ ticket: "T1", path: "/api/voice/stream" }), { status: 200 });
});

function make(fetchImpl = okTicket) {
  return new StreamUplink({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    origin: { protocol: "https:", host: "mac.local:8443" },
    ticketHeaders: async () => ({ "x-murage-surface": "desktop", "x-murage-surface-secret": "test-secret" }),
  });
}

/** The socket this test's connect made (never the previous test's). */
const sock = () => FakeSocket.last!;

async function connected(u = make(), query = {}, opts = {}) {
  FakeSocket.last = undefined;
  const p = u.connect(query, opts);
  await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
  sock().readyState = 1;
  sock().fire("open");
  await p;
  return u;
}

describe("StreamUplink", () => {
  it("gets a ticket with the surface headers and opens wss on the same origin with the subprotocol", async () => {
    calls.length = 0;
    await connected(make(), { eagerness: "medium", keyterms: ["Sable"] });
    expect(calls[0].init?.headers).toMatchObject({ "x-murage-surface": "desktop" });
    expect(sock().url).toBe("wss://mac.local:8443/api/voice/stream?ticket=T1&eagerness=medium&keyterms=Sable");
    expect(sock().protocols).toEqual(["flux.stt.v1"]);
    expect(sock().binaryType).toBe("arraybuffer");
  });

  it("asks for a replacement slot when rolling over", async () => {
    calls.length = 0;
    await connected(make(), {}, { replace: true });
    expect(calls[0].url).toBe("/api/voice/stream/ticket?replace=1");
    expect(sock().url).toMatch(/[?&]replace=1/);
  });

  it("surfaces a ticket refusal with its reason", async () => {
    const refused = make(vi.fn(async () => new Response(JSON.stringify({ reason: "key" }), { status: 409 })) as never);
    await expect(refused.connect()).rejects.toMatchObject({ status: 409, reason: "key" });
    const again = make(vi.fn(async () => new Response(JSON.stringify({ reason: "key" }), { status: 409 })) as never);
    await expect(again.connect()).rejects.toBeInstanceOf(UplinkRefused);
  });

  it("is single-shot: a second connect on the same instance is refused as reused", async () => {
    const u = await connected();
    const first = sock();
    await expect(u.connect()).rejects.toMatchObject({ status: 0, reason: "reused" });
    expect(sock()).toBe(first);
    const t = make(vi.fn(async () => new Response("{}", { status: 500 })) as never);
    await expect(t.connect()).rejects.toBeInstanceOf(UplinkRefused);
    await expect(t.connect()).rejects.toMatchObject({ reason: "reused" });
  });

  it("exposes retry-after from a 429 as retryAfterMs", async () => {
    const limited = make(vi.fn(async () => new Response(JSON.stringify({ reason: "busy" }), { status: 429, headers: { "retry-after": "5" } })) as never);
    await expect(limited.connect()).rejects.toMatchObject({ status: 429, reason: "busy", retryAfterMs: 5000 });
    const none = make(vi.fn(async () => new Response(JSON.stringify({ reason: "key" }), { status: 409 })) as never);
    await expect(none.connect()).rejects.toMatchObject({ retryAfterMs: null });
  });

  it("refuses a ticket path that is not a single-slash path, and ignores reserved caller query keys", async () => {
    for (const path of ["//evil.example/x", "https://evil.example/x", "api/voice/stream"]) {
      const bad = make(vi.fn(async () => new Response(JSON.stringify({ ticket: "T1", path }), { status: 200 })) as never);
      await expect(bad.connect()).rejects.toBeInstanceOf(UplinkRefused);
    }
    await connected(make(), { ticket: "X", replace: "1", eagerness: "low" });
    expect(sock().url).toBe("wss://mac.local:8443/api/voice/stream?ticket=T1&eagerness=low");
  });

  it("bounds close(): force-closes the socket after the grace, and stops sending once closed", async () => {
    vi.useFakeTimers();
    try {
      const u = await connected();
      u.close();
      expect(sock().sent.map(String)).toEqual(['{"type":"session.close"}']);
      expect(u.send(new Int16Array(8))).toBe(false);
      expect(sock().readyState).toBe(1);
      vi.advanceTimersByTime(2600);
      expect(sock().readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds messages that arrive before anyone subscribes", async () => {
    const u = await connected();
    sock().fire("message", { data: JSON.stringify({ type: "session.started", seq: 1, received_audio_ms: 0, session_id: "s", model: "flux-voice-stream", config: {}, limits: { min_frame_ms: 20, max_frame_ms: 1000, prestart_buffer_ms: 3000, burst_ms: 3000 }, ignored_params: [], expires_at: 0 }) });
    const types: string[] = [];
    u.onMessage((m) => types.push(m.type));
    expect(types).toEqual(["session.started"]);
  });

  it("sends Int16 frames as binary and drops them when the socket backs up", async () => {
    const u = await connected();
    expect(u.send(new Int16Array(1024))).toBe(true);
    expect(sock().sent[0]).toBeInstanceOf(ArrayBuffer);
    sock().bufferedAmount = 64 * 1024;
    expect(u.send(new Int16Array(1024))).toBe(false);
    expect(u.dropped).toBe(1);
  });

  it("reports the close with the last fatal error", async () => {
    const u = await connected();
    let closed: unknown = null;
    u.onMessage(() => undefined);
    u.onClose((c) => (closed = c));
    sock().fire("message", { data: "not json" });
    sock().fire("message", { data: JSON.stringify({ type: "error", seq: 3, received_audio_ms: 600, error: { code: "capability_unavailable", type: "api_error", message: "x", fatal: true, close_code: 4502, retry_after_ms: null } }) });
    sock().fire("close", { code: 4502 });
    expect(closed).toMatchObject({ code: 4502, error: { code: "capability_unavailable" } });
    expect(u.live).toBe(false);
  });

  it("cancels a connect still waiting for its ticket when closed (a hold or a hang-up)", async () => {
    let aborted = false;
    const slow = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    }));
    const u = make(slow as never);
    const p = u.connect();
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    u.close();
    await expect(p).rejects.toMatchObject({ reason: "closed" });
    expect(aborted).toBe(true);
  });

  it("cancels a connect mid-handshake when closed, and closes the socket it opened", async () => {
    FakeSocket.last = undefined;
    const u = make();
    const p = u.connect();
    await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
    u.close();
    await expect(p).rejects.toMatchObject({ reason: "closed" });
    expect(sock().readyState).toBe(3);
    await expect(u.connect()).rejects.toMatchObject({ reason: "closed" }); // a closed uplink never connects again
  });

  it("gives up a connect that outlives its deadline", async () => {
    FakeSocket.last = undefined;
    const u = new StreamUplink({
      fetchImpl: okTicket as unknown as typeof fetch,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      origin: { protocol: "https:", host: "mac.local:8443" },
      ticketHeaders: async () => ({}),
      connectDeadlineMs: 50,
    });
    await expect(u.connect()).rejects.toMatchObject({ reason: "timeout" });
    expect(sock().readyState).toBe(3);
  });

  it("cancels a connect still waiting for the desktop headers, on close and at the deadline (Astra 3 I5)", async () => {
    const never = () => new Promise<Record<string, string>>(() => {});
    const a = new StreamUplink({ fetchImpl: okTicket as unknown as typeof fetch, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, origin: { protocol: "https:", host: "mac.local:8443" }, ticketHeaders: never });
    const pa = a.connect();
    a.close();
    await expect(pa).rejects.toMatchObject({ reason: "closed" });
    const b = new StreamUplink({ fetchImpl: okTicket as unknown as typeof fetch, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, origin: { protocol: "https:", host: "mac.local:8443" }, ticketHeaders: never, connectDeadlineMs: 50 });
    await expect(b.connect()).rejects.toMatchObject({ reason: "timeout" });
  });

  it("sends control messages as JSON", async () => {
    const u = await connected();
    u.commit();
    u.keepalive();
    u.update({ eagerness: "low" });
    expect(sock().sent.map(String)).toEqual(['{"type":"turn.commit"}', '{"type":"keepalive"}', '{"type":"session.update","config":{"eagerness":"low"}}']);
  });
});
