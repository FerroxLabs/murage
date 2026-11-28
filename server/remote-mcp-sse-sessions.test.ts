// SPDX-License-Identifier: AGPL-3.0-or-later
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RemoteSseSessions, sessionOwnedBy, type SseOpenInput } from "./remote-mcp-sse-sessions.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";
import { upstreamOwnerFixture } from "./testing/upstream-owner-fixture.ts";
import { RELEASE_LIMITS } from "./memory/release-budget.ts";

let fake: FakeRemoteMcp | undefined;
let sessions: RemoteSseSessions | undefined;
let upstream: ReturnType<typeof upstreamOwnerFixture>;
beforeEach(() => { upstream = upstreamOwnerFixture(); });
const openSession = (input: SseOpenInput) => upstream.run(input.generation, () => sessions!.open(input));
afterEach(async () => {
  sessions?.closeAll();
  sessions = undefined;
  await fake?.close();
  fake = undefined;
});
const open = (overrides: Record<string, unknown> = {}) => openSession({ name: "legacy", generation: "gen-1", url: fake!.mcpUrl, headers: {}, confirmed: "this-computer", ...overrides });
/** A call made for the entry as it is now: its current dial link and local confirmation. */
const current = () => ({ headers: {}, timeoutMs: 3_000, dialUrl: fake!.mcpUrl, confirmed: "this-computer" as const });

describe("sessionOwnedBy", () => {
  it("needs both the server name and the turn generation", () => {
    const session = { name: "a", generation: "g" };
    expect(sessionOwnedBy(session, "a", "g")).toBe(true);
    expect(sessionOwnedBy(session, "b", "g")).toBe(false);
    expect(sessionOwnedBy(session, "a", "h")).toBe(false);
  });
});

describe("legacy HTTP+SSE sessions held by the harness", () => {
  it.each(["split-crlf", "unterminated-eof", "empty-event"])("delivers a multiline reply through the guarded legacy transport (%s)", async (framing) => {
    let stream: http.ServerResponse | undefined;
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body);
      res.writeHead(202);
      res.end();
      const reply = `data: {"jsonrpc":"2.0","id":${JSON.stringify(id)},\r\ndata: "result":{"content":[{"type":"text","text":"reply"}]}}`;
      if (framing === "unterminated-eof") stream!.end(reply);
      else if (framing === "empty-event") stream!.write(`event:\r\n${reply}\r\n\r\n`);
      else {
        const split = reply.indexOf("\r") + 1;
        stream!.write(reply.slice(0, split));
        await new Promise(resolve => setTimeout(resolve, 20));
        stream!.write(reply.slice(split) + "\r\n\r\n");
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`;
    sessions = new RemoteSseSessions();
    try {
      const opened = await openSession({ name: "legacy", generation: "gen-1", url, headers: {}, confirmed: "this-computer" });
      expect(opened).toMatchObject({ ok: true });
      if (!opened.ok) throw new Error("fixture session did not open");
      const result = await sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 7, method: "tools/call" }, { headers: {}, timeoutMs: 1_000, dialUrl: url, confirmed: "this-computer" });
      expect(result).toMatchObject({ ok: true, frame: { id: 7, result: { content: [{ type: "text", text: "reply" }] } } });
    } finally {
      sessions.closeAll();
      stream?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("opens the stream, posts to the announced endpoint, and matches answers by id", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions();
    const opened = await open();
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) return;
    expect(sessions.size).toBe(1);
    const init = await sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, current());
    expect(init).toMatchObject({ ok: true, frame: { id: 1, result: { serverInfo: { name: "fake-remote-mcp" } } } });
    const note = await sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", method: "notifications/initialized" }, current());
    expect(note).toEqual({ ok: true, frame: null });
    const [a, b] = await Promise.all([
      sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, current()),
      sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sum", arguments: { a: 4, b: 5 } } }, current()),
    ]);
    expect(a).toMatchObject({ ok: true, frame: { id: 2, result: { tools: [{ name: "echo" }, { name: "sum" }] } } });
    expect(b).toMatchObject({ ok: true, frame: { id: 3, result: { content: [{ text: "9" }] } } });
  });

  // MAIN-RULING cause22-no-transport-caps (lane cause22-main-fable owns this row): the session has no event cap and no stream
  // byte ceiling. On the owner's own turn (the release budget's own marks on other turns are not a transport cap, and not this
  // lane's) a 20 MiB tool result arrives whole and the same session serves the next call. RED on c187b11166: event-too-large.
  it("cause22: a 20 MiB tool result arrives whole over the session's stream and the session serves the next call", async () => {
    const ITEM = 20 * 1024 * 1024;
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse", toolResultPadBytes: ITEM });
    sessions = new RemoteSseSessions();
    upstream.budget("gen-1").keepOwner(() => {});
    const opened = await open();
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) return;
    const big = await sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "a" } } }, { ...current(), timeoutMs: 60_000 });
    expect(big.ok, "the 20 MiB answer is not a failure").toBe(true);
    const text = big.ok ? (big.frame as { result?: { content?: Array<{ text?: string }> } } | null)?.result?.content?.[0]?.text : undefined;
    expect(text?.length, "every byte of the result arrived").toBe(ITEM + 1);
    expect(sessions.size, "the session is still open").toBe(1);
    const next = await sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "b" } } }, { ...current(), timeoutMs: 60_000 });
    expect(next.ok, "the next call on the same session is answered").toBe(true);
  }, 120_000);

  // SITES #20, the POST half: the POST's own answer body has no byte ceiling either. A server that acknowledges the POST with a
  // 24 MiB body still gets its call answered over the stream. RED on c187b11166: the guarded request's default 20 MiB ceiling.
  it("cause22: a 24 MiB POST acknowledgement is read whole, the call is answered over the stream and the session serves the next call", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse", messageAckBytes: 24 * 1024 * 1024 });
    sessions = new RemoteSseSessions();
    upstream.budget("gen-1").keepOwner(() => {});
    const opened = await open();
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) return;
    const first = await sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "a" } } }, { ...current(), timeoutMs: 60_000 });
    expect(first, "the call behind a 24 MiB acknowledgement is answered").toMatchObject({ ok: true, frame: { id: 2, result: { content: [{ text: "a" }] } } });
    expect(sessions.size, "the session is still open").toBe(1);
    const next = await sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "b" } } }, { ...current(), timeoutMs: 60_000 });
    expect(next, "the next call on the same session is answered").toMatchObject({ ok: true, frame: { id: 3, result: { content: [{ text: "b" }] } } });
  }, 120_000);

  it("another server name or another turn cannot use the session", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions();
    const opened = await open();
    if (!opened.ok) throw new Error("open");
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect(await sessions.call(opened.sessionId, "other", "gen-1", message, current())).toMatchObject({ ok: false, status: 404 });
    expect(await sessions.call(opened.sessionId, "legacy", "gen-2", message, current())).toMatchObject({ ok: false, status: 404 });
    expect(await sessions.call("not-a-session", "legacy", "gen-1", message, current())).toMatchObject({ ok: false, status: 404 });
    expect(fake.requests.filter((entry) => entry.path === "/messages")).toHaveLength(0);
  });

  it("closes a turn's sessions when its generation is revoked, and closeAll closes the rest", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions();
    const one = await open();
    const two = await open({ generation: "gen-2" });
    if (!one.ok || !two.ok) throw new Error("open");
    expect(sessions.size).toBe(2);
    sessions.closeGeneration("gen-1");
    expect(sessions.has(one.sessionId)).toBe(false);
    expect(sessions.has(two.sessionId)).toBe(true);
    expect(await sessions.call(one.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 1, method: "ping" }, current())).toMatchObject({ ok: false });
    sessions.closeAll();
    expect(sessions.size).toBe(0);
  });

  it("a session whose turn is gone closes by itself: on a sweep, on the next call and on the next open", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const live = new Set(["gen-1", "gen-2"]);
    sessions = new RemoteSseSessions({ isLive: (generation) => live.has(generation), sweepMs: 60_000 });
    const one = await open();
    const two = await open({ generation: "gen-2" });
    if (!one.ok || !two.ok) throw new Error("open");
    live.delete("gen-1");
    sessions.sweep();
    expect(sessions.has(one.sessionId)).toBe(false);
    expect(sessions.has(two.sessionId)).toBe(true);
    live.delete("gen-2");
    expect(await sessions.call(two.sessionId, "legacy", "gen-2", { jsonrpc: "2.0", id: 1, method: "ping" }, current())).toMatchObject({ ok: false });
    expect(sessions.size).toBe(0);
    expect(await open({ generation: "gen-3" })).toMatchObject({ ok: false, reason: "cancelled" });
    expect(fake.requests.filter((entry) => entry.path === "/messages")).toHaveLength(0);
  });

  it("the background sweep closes a stopped turn's session without anyone calling", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    let alive = true;
    sessions = new RemoteSseSessions({ isLive: () => alive, sweepMs: 40 });
    const opened = await open();
    if (!opened.ok) throw new Error("open");
    alive = false;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sessions.has(opened.sessionId)).toBe(false);
  });

  it("a quiet session closes at its idle limit, and a call waiting on it fails", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions({ idleMs: 150 });
    const opened = await open();
    if (!opened.ok) throw new Error("open");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sessions.has(opened.sessionId)).toBe(false);
  });

  it("refuses an endpoint on another origin", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse", sseEndpoint: "cross-origin" });
    sessions = new RemoteSseSessions();
    expect(await open()).toMatchObject({ ok: false, reason: "wrong-address" });
    expect(sessions.size).toBe(0);
    expect(fake.requests.filter((entry) => entry.path === "/messages")).toHaveLength(0);
  });

  it("a stream the server refuses is sign-in-ended for 401 and wrong-address otherwise", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", transport: "sse" });
    sessions = new RemoteSseSessions();
    expect(await open()).toMatchObject({ ok: false, reason: "sign-in-ended" });
    expect(await open({ bearer: fake.mintAccessToken() })).toMatchObject({ ok: true });
    const nowhere = await openSession({ name: "legacy", generation: "g", url: `${fake.origin}/nope`, headers: {}, bearer: fake.mintAccessToken(), confirmed: "this-computer" });
    expect(nowhere).toMatchObject({ ok: false, reason: "wrong-address" });
  });

  it("REV2-5: one turn cannot hold every session: it is held to 4, and another turn can still open", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions();
    for (let index = 0; index < 4; index += 1) expect(await open({ generation: "gen-A" })).toMatchObject({ ok: true });
    expect(await open({ generation: "gen-A" })).toMatchObject({ ok: false, reason: "server-error" });
    expect(await open({ generation: "gen-B" })).toMatchObject({ ok: true });
    expect(sessions.size).toBe(5);
    // closing one of the turn's sessions frees its slot
    const one = await open({ generation: "gen-C" });
    if (!one.ok) throw new Error("open");
    sessions.closeSession(one.sessionId);
    expect(await open({ generation: "gen-C" })).toMatchObject({ ok: true });
  });

  it("limits how many sessions are open at once", async () => {
    // (the per-turn cap is lifted here so the global one is what is tested)
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions({ max: 2, maxPerGeneration: 10 });
    expect(await open()).toMatchObject({ ok: true });
    expect(await open()).toMatchObject({ ok: true });
    expect(await open()).toMatchObject({ ok: false });
  });

  it("N1: a call refuses a session opened for another origin or another local confirmation, and posts nothing", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const other = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    try {
      sessions = new RemoteSseSessions();
      const message = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
      const moved = await open();
      if (!moved.ok) throw new Error("open");
      expect(await sessions.call(moved.sessionId, "legacy", "gen-1", message, { ...current(), dialUrl: other.mcpUrl, headers: { "x-api-key": "KEY-B" } })).toMatchObject({ ok: false, reason: "wrong-address", status: 404 });
      expect(sessions.has(moved.sessionId)).toBe(false);
      const reconfirmed = await open();
      if (!reconfirmed.ok) throw new Error("open");
      expect(await sessions.call(reconfirmed.sessionId, "legacy", "gen-1", message, { ...current(), confirmed: "local-network" })).toMatchObject({ ok: false, status: 404 });
      expect(await sessions.call(reconfirmed.sessionId, "legacy", "gen-1", message, { ...current(), confirmed: null })).toMatchObject({ ok: false, status: 404 });
      expect(fake.requests.filter((entry) => entry.path === "/messages")).toHaveLength(0);
      expect(other.requests).toHaveLength(0);
      // the same origin on another path is still the server the session was opened on
      const kept = await open();
      if (!kept.ok) throw new Error("open");
      expect(await sessions.call(kept.sessionId, "legacy", "gen-1", message, { ...current(), dialUrl: `${fake.origin}/elsewhere` })).toMatchObject({ ok: true });
    } finally {
      await other.close();
    }
  });

  it("N1: closeName closes every session of that server, in every turn, and no other", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions();
    const one = await open();
    const two = await open({ generation: "gen-2" });
    const keep = await open({ name: "other" });
    if (!one.ok || !two.ok || !keep.ok) throw new Error("open");
    sessions.closeName("legacy");
    expect(sessions.has(one.sessionId)).toBe(false);
    expect(sessions.has(two.sessionId)).toBe(false);
    expect(sessions.has(keep.sessionId)).toBe(true);
    expect(await sessions.call(one.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 1, method: "ping" }, current())).toMatchObject({ ok: false, status: 404 });
  });

  it("L-a: opens that race each other are held to the per-turn cap and the global cap", async () => {
    // A legacy server that announces its endpoint only after a pause, so every
    // open is in flight at once.
    const streams: http.ServerResponse[] = [];
    const slow = http.createServer((req, res) => {
      if (req.method !== "GET") { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      streams.push(res);
      setTimeout(() => res.write("event: endpoint\ndata: /msg\n\n"), 150);
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/sse`;
    try {
      sessions = new RemoteSseSessions({ isLive: () => true, sweepMs: 60_000 });
      const racing = await Promise.all(Array.from({ length: 10 }, () => openSession({ name: "svc", generation: "gen-A", url, headers: {}, confirmed: "this-computer" })));
      expect(racing.filter((result) => result.ok)).toHaveLength(4);
      expect(sessions.size).toBe(4);
      // a refused open leaves no reservation behind: another turn still gets its own four
      const other = await Promise.all(Array.from({ length: 6 }, () => openSession({ name: "svc", generation: "gen-B", url, headers: {}, confirmed: "this-computer" })));
      expect(other.filter((result) => result.ok)).toHaveLength(4);
      sessions.closeAll();
      sessions = new RemoteSseSessions({ max: 3, maxPerGeneration: 10 });
      const global = await Promise.all(Array.from({ length: 8 }, (_, index) => openSession({ name: "svc", generation: `gen-${index}`, url, headers: {}, confirmed: "this-computer" })));
      expect(global.filter((result) => result.ok)).toHaveLength(3);
      expect(sessions.size).toBe(3);
      // a failed open gives its slot back
      sessions.closeAll();
      sessions = new RemoteSseSessions({ maxPerGeneration: 1 });
      expect(await openSession({ name: "svc", generation: "gen-F", url: `http://127.0.0.1:1/sse`, headers: {}, confirmed: "this-computer" })).toMatchObject({ ok: false });
      expect(await openSession({ name: "svc", generation: "gen-F", url, headers: {}, confirmed: "this-computer" })).toMatchObject({ ok: true });
    } finally {
      for (const stream of streams) stream.destroy();
      slow.closeAllConnections();
      await new Promise((resolve) => slow.close(() => resolve(undefined)));
    }
  });

  it("re-judges the address on every post: a confirmation that does not match never connects", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions();
    expect(await open({ confirmed: "local-network" })).toMatchObject({ ok: false, reason: "address-changed" });
    expect(fake.requests).toHaveLength(0);
  });

  it("retains the opening generation's budget when a later call has no ambient owner", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    sessions = new RemoteSseSessions();
    const opened = await open();
    if (!opened.ok) throw new Error("open");
    const budget = upstream.budget("gen-1");
    expect(budget.counts.bytes).toBeGreaterThan(0);
    // "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, the opening generation's budget was
    // exhausted with the 4096 attempt limit; now it is sealed by a work crossing above the whole work limit, which still refuses.
    expect(() => budget.charge({ work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
    await expect(sessions.call(opened.sessionId, "legacy", "gen-1", { jsonrpc: "2.0", id: 1, method: "tools/list" }, current()))
      .rejects.toMatchObject({ code: "MEMORY_CONTEXT_REVOKED" });
    expect(sessions.size).toBe(0);
    expect(fake.requests.filter(entry => entry.path === "/messages")).toHaveLength(0);
  });
});
