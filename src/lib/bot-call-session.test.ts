// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The desktop call session as a state machine (bot-call-session.ts): the server's session is the one source of truth.
// Fake fetch, websocket and clock; the renderer suite runs with no DOM.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CALL_PROTOCOL } from "../../shared/bot-calls-contract";

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; hangBody?: boolean };
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(type: string, extra: Record<string, unknown> = {}) { this.onmessage?.({ data: JSON.stringify({ type, ...extra }) }); }
  /** The heartbeat numbers sent so far. */
  seqs(): number[] { return this.sent.map((data) => (JSON.parse(data) as { type: string; seq: number })).filter((f) => f.type === "call.alive").map((f) => f.seq); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

const listeners = new Map<string, Array<(event: Event) => void>>();
const notes: string[] = [];
let routes: Record<string, (init?: { signal?: AbortSignal }) => Reply | Promise<Reply>> = {};
const calls: string[] = [];
let mod: typeof import("./bot-call-session");
let call: typeof import("./call");

beforeAll(async () => {
  vi.stubGlobal("window", {
    muragebox: { speechStop: async () => {} },
    localStorage: { getItem: () => "desktop:test", setItem: () => {} },
    addEventListener: (type: string, fn: (event: Event) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    dispatchEvent: (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; text?: string }>).detail;
      if (detail?.type === "call.note" && detail.text) notes.push(detail.text);
      return true;
    },
  });
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:1" });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (path: string, init?: { signal?: AbortSignal }) => {
    calls.push(path);
    const route = Object.keys(routes).find((key) => path.endsWith(key));
    const reply = route ? await routes[route](init) : { status: 404 };
    // hangBody: the headers arrived and the body never does (it rejects only when the request is aborted)
    const json = reply.hangBody
      ? () => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); })
      : async () => reply.body ?? {};
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers: new Headers(reply.headers ?? {}), json };
  });
  mod = await import("./bot-call-session");
  call = await import("./call");
});

const CALL_ID = "c0ffee00-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  calls.length = 0;
  notes.length = 0;
  routes = {
    "/ticket": () => ({ status: 200, body: { ticket: "t" } }),
    "/opener": () => ({ status: 200, body: { text: "Hi Sean, it's Scout." } }),
    "/end": () => ({ status: 200, body: { ended: true } }),
    "/api/calls/sessions": () => ({ status: 200, body: { callId: CALL_ID, sessionId: "s1" } }),
  };
});
afterEach(() => {
  call.endCall();
  vi.useRealTimers();
});

async function answered(): Promise<FakeSocket> {
  mod.attachAnsweredCall({ intentId: "i1", callId: CALL_ID, botId: "scout", device: "desktop:test" });
  call.startCall("scout");
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  return ws;
}
const ended = () => calls.filter((path) => path.endsWith(`/api/calls/sessions/${CALL_ID}/end`)).length;

describe("one source of truth: the server's session", () => {
  it("call.ended on the channel ends the call screen here (Astra N1)", async () => {
    const ws = await answered();
    expect(mod.botCallHeaders()).toEqual({ [CALL_PROTOCOL.callIdHeader]: CALL_ID });
    ws.frame("call.ended");
    expect(call.currentCall()).toBeNull();
    expect(mod.botCallHeaders()).toEqual({});
  });

  it("the live stream's call.ended hint for this call ends it too; another call's hint does not", async () => {
    await answered();
    const hint = (callId: string) => { for (const fn of listeners.get("murage:bot-call") ?? []) fn({ detail: { type: "call.ended", callId } } as unknown as Event); };
    hint("c0ffee00-0000-4000-8000-0000000000ff");
    expect(call.currentCall()).toBe("scout");
    hint(CALL_ID);
    expect(call.currentCall()).toBeNull();
  });

  it("a gone session (ticket 410) on a reconnect ends the call", async () => {
    const ws = await answered();
    routes["/ticket"] = () => ({ status: 410 });
    ws.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(call.currentCall()).toBeNull();
  });

  it("both clocks come from one constant, and the client gives up after the server", () => {
    expect(CALL_PROTOCOL.clientGivesUpMs).toBe(CALL_PROTOCOL.silenceEndsMs + CALL_PROTOCOL.silenceEndsMs / 4);
    expect(CALL_PROTOCOL.clientGivesUpMs).toBeGreaterThan(CALL_PROTOCOL.silenceEndsMs);
  });

  it("reconnects past the server's silence window and ends only at the client's give-up (Grok r2)", async () => {
    // the ticket answer just arrived: the server counted this call no later than now
    const ws = await answered();
    routes["/ticket"] = () => ({ status: 503 });
    ws.drop();
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.clientGivesUpMs - 1_000);
    expect(call.currentCall()).toBe("scout");
    expect(calls.filter((path) => path.endsWith("/ticket")).length).toBeGreaterThan(5);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(call.currentCall()).toBeNull();
    expect(ended()).toBe(1);
  });

  it("heartbeats go every pingEveryMs, numbered, without waiting for an answer", async () => {
    const ws = await answered();
    expect(ws.seqs()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.pingEveryMs * 3);
    expect(ws.seqs()).toEqual([1, 2, 3, 4]);
  });

  it("a 35 s round trip never hangs up a call the server still holds (R3-H1)", async () => {
    const RTT = 35_000;
    const ws = await answered();
    // the server receives each heartbeat after RTT/2 and its echo arrives RTT/2 later, numbered
    const echoed = new Set<number>();
    for (let t = 0; t < 10 * 60_000; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      for (const seq of ws.seqs()) {
        if (!echoed.has(seq)) { echoed.add(seq); setTimeout(() => ws.frame("call.live", { seq }), RTT); }
      }
      expect(call.currentCall(), `at ${t + 1_000} ms`).toBe("scout");
    }
    expect(ended()).toBe(0);
  });

  it("an echo of a number never sent, or no number, does not count; half-open ends at the give-up", async () => {
    const ws = await answered();
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.pingEveryMs);
      ws.frame("call.live", { seq: ws.seqs().at(-1) });
    }
    expect(call.currentCall()).toBe("scout");
    // half-open: heartbeats go out, only bogus echoes come back
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.pingEveryMs);
      ws.frame("call.live", { seq: 999 });
      ws.frame("call.live");
    }
    expect(call.currentCall()).toBe("scout");
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.clientGivesUpMs - 3 * CALL_PROTOCOL.pingEveryMs + 1);
    expect(call.currentCall()).toBeNull();
  });

  it("hanging up ends the server's session once and closes the channel", async () => {
    const ws = await answered();
    call.endCall("scout");
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()).toBe(1);
    expect(ws.readyState).toBe(3);
    expect(mod.botCallHeaders()).toEqual({});
  });

  it("switching to another call ends the answered call's session", async () => {
    await answered();
    call.startCall("echo");
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()).toBe(1);
    expect(call.currentCall()).toBe("echo");
  });

  it("the opener is handed to the call screen once", async () => {
    await answered();
    const opener = mod.takeBotCallOpener("scout");
    expect(await opener).toBe("Hi Sean, it's Scout.");
    expect(mod.takeBotCallOpener("scout")).toBeNull();
  });
});

describe("an ordinary call holds a session too (design 5.4, 5.7)", () => {
  it("opens one, so the server knows a call is up (and ends a ring that was ringing)", async () => {
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain("/api/calls/sessions");
    expect(mod.botCallHeaders("scout")).toEqual({ [CALL_PROTOCOL.callIdHeader]: CALL_ID });
    FakeSocket.all.at(-1)!.frame("call.ended");
    expect(call.currentCall()).toBeNull();
  });

  it("a failed open is retried inside the window and the call goes on with the session", async () => {
    let tries = 0;
    routes["/api/calls/sessions"] = () => (++tries < 4 ? { status: 503 } : { status: 200, body: { callId: CALL_ID, sessionId: "s1" } });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tries).toBe(4);
    expect(call.currentCall()).toBe("scout");
    expect(mod.botCallHeaders("scout")).toEqual({ [CALL_PROTOCOL.callIdHeader]: CALL_ID });
    expect(notes).toEqual([]);
  });

  it("an open that keeps failing for the window ends the call with a short note; no call runs without a session", async () => {
    routes["/api/calls/sessions"] = () => ({ status: 503 });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.silenceEndsMs - 5_000);
    expect(call.currentCall()).toBe("scout");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(call.currentCall()).toBeNull();
    expect(notes).toEqual(["The call couldn't connect, so it ended. Try again in a moment."]);
    expect(calls.filter((path) => path === "/api/calls/sessions").length).toBeGreaterThan(3);
  });

  it("an open the server refuses outright (no such bot or thread) ends the call at once with the note", async () => {
    routes["/api/calls/sessions"] = () => ({ status: 404 });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(0);
    expect(call.currentCall()).toBeNull();
    expect(notes).toHaveLength(1);
    expect(calls.filter((path) => path === "/api/calls/sessions").length).toBe(1);
  });

  it("hanging up while it opens sends no note", async () => {
    routes["/api/calls/sessions"] = () => ({ status: 503 });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(0);
    call.endCall("scout");
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.silenceEndsMs);
    expect(notes).toEqual([]);
  });

  it("an open whose POST never settles is aborted at the deadline and the call ends with the note (p5 r4 High)", async () => {
    let aborted = false;
    routes["/api/calls/sessions"] = (init) => new Promise<Reply>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(0);
    // a call screen with no session: the ring banner holds back while it opens
    expect(mod.callSessionOpening()).toBe(true);
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.silenceEndsMs - 1);
    expect(call.currentCall()).toBe("scout");
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect(call.currentCall()).toBeNull();
    expect(mod.callSessionOpening()).toBe(false);
    expect(notes).toEqual(["The call couldn't connect, so it ended. Try again in a moment."]);
    // the deadline ended the open: no retry posts after it
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.silenceEndsMs);
    expect(calls.filter((path) => path === "/api/calls/sessions").length).toBe(1);
  });

  it("a retry that hangs too: the deadline ends the call and nothing posts after it", async () => {
    let tries = 0;
    routes["/api/calls/sessions"] = () => (++tries === 1 ? { status: 503 } : new Promise<Reply>(() => {}));
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.silenceEndsMs);
    expect(call.currentCall()).toBeNull();
    const posted = tries;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tries).toBe(posted);
  });

  it("a session id that arrives after the deadline ended the call is ended on the server at once", async () => {
    let answer: (reply: Reply) => void = () => {};
    // a server (or proxy) that ignores the abort and answers late with the session it opened
    routes["/api/calls/sessions"] = () => new Promise<Reply>((resolve) => { answer = resolve; });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.silenceEndsMs);
    expect(call.currentCall()).toBeNull();
    expect(ended()).toBe(0);
    answer({ status: 200, body: { callId: CALL_ID, sessionId: "s1" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()).toBe(1);
    expect(mod.botCallHeaders("scout")).toEqual({});
    expect(FakeSocket.all).toHaveLength(0);
    expect(notes).toHaveLength(1);
  });

  it("an open that succeeds before the deadline disarms it; the call stays up past 60 s on echoes", async () => {
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.callSessionOpening()).toBe(false);
    const ws = FakeSocket.all.at(-1)!;
    ws.open();
    for (let t = 0; t < 4; t += 1) {
      await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.pingEveryMs);
      ws.frame("call.live", { seq: ws.seqs().at(-1) });
    }
    expect(call.currentCall()).toBe("scout");
    expect(notes).toEqual([]);
  });

  it("subscribers hear the open start, its session id and the end, so a ring showing hides during a hung open (p5 r5 Medium A)", async () => {
    let answer: (reply: Reply) => void = () => {};
    routes["/api/calls/sessions"] = () => new Promise<Reply>((resolve) => { answer = resolve; });
    const seen: boolean[] = [];
    const off = mod.onCallSessionChange(() => { seen.push(mod.callSessionOpening()); });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    // told at once, before the POST answers: the banner re-renders and reads "opening"
    expect(seen).toEqual([true]);
    answer({ status: 200, body: { callId: CALL_ID, sessionId: "s1" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([true, false]);
    call.endCall();
    expect(seen).toEqual([true, false, false]);
    off();
  });

  it("a session id on the response headers is used even when the body never arrives (p5 r5 Medium B)", async () => {
    routes["/api/calls/sessions"] = () => ({ status: 200, headers: { [CALL_PROTOCOL.callIdHeader]: CALL_ID }, hangBody: true });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.callSessionOpening()).toBe(false);
    expect(mod.botCallHeaders("scout")).toEqual({ [CALL_PROTOCOL.callIdHeader]: CALL_ID });
  });

  it("headers that arrive after the deadline ended the call, with a body that never comes, still end the server's session (p5 r5 Medium B)", async () => {
    let answer: (reply: Reply) => void = () => {};
    routes["/api/calls/sessions"] = () => new Promise<Reply>((resolve) => { answer = resolve; });
    call.startCall("scout");
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(CALL_PROTOCOL.silenceEndsMs);
    expect(call.currentCall()).toBeNull();
    answer({ status: 200, headers: { [CALL_PROTOCOL.callIdHeader]: CALL_ID }, hangBody: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()).toBe(1);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("an answered call's session is the one the call screen holds", async () => {
    await answered();
    mod.holdCallSession("scout", "t1");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).not.toContain("/api/calls/sessions");
  });
});

describe("the opener plays out before the owner's turn (CallView sayOpener)", () => {
  it("holds recognition off until the opener has ended", async () => {
    const playing = { current: false };
    let finish!: () => void;
    const done = mod.sayOpener(() => new Promise<void>((resolve) => { finish = resolve; }), playing);
    expect(playing.current).toBe(true);
    // the opener plays for a while: still held
    await vi.advanceTimersByTimeAsync(8_000);
    expect(playing.current).toBe(true);
    finish();
    await done;
    expect(playing.current).toBe(false);
  });

  it("an opener that never reports its end is capped", async () => {
    const playing = { current: false };
    const done = mod.sayOpener(() => new Promise<void>(() => {}), playing);
    await vi.advanceTimersByTimeAsync(mod.OPENER_CAP_MS - 1);
    expect(playing.current).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(playing.current).toBe(false);
  });

  it("a failing opener releases the turn too", async () => {
    const playing = { current: false };
    await mod.sayOpener(() => Promise.reject(new Error("no voice")), playing);
    expect(playing.current).toBe(false);
  });
});
