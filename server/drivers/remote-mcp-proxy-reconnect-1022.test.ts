// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-connparity (MAIN-RULING SEAN 2026-11-25; field: metricool dropped 208 times, 96 `server/discover
// code=wrong-address`). The real stdio proxy, spawned as an engine spawns it, against a stand-in for the harness
// relay (the fixture of remote-mcp-proxy.test.ts).
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundProxyState, spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "remote-mcp-proxy.ts");
let server: Server | null = null;
let child: ChildProcessWithoutNullStreams | null = null;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close"); child.kill(); await closed;
  }
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

type Posted = { body: Record<string, any>; session: string };
type Answer = { status?: number; contentType?: string; body?: string; headers?: Record<string, string>; custom?: (res: ServerResponse) => void };

async function start(answer: (posted: Posted, all: Posted[]) => Answer) {
  const posted: Posted[] = [];
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry: Posted = { body: raw ? JSON.parse(raw) : {}, session: String(req.headers["mcp-session-id"] ?? "") };
    posted.push(entry);
    const reply = answer(entry, posted);
    if (reply.custom) return reply.custom(res);
    res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json", ...(reply.headers ?? {}) });
    res.end(reply.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  child = await spawnBoundProxy("remoteMcp", process.execPath, ["--experimental-strip-types", ENTRY, "--server", "metrics"], {
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "", MURAGE_HARNESS_URL: `http://127.0.0.1:${port}`, MURAGE_MCP_TOKEN: "turn-token-0123" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const queue: Array<Record<string, any>> = [];
  const waiters: Array<(value: Record<string, any>) => void> = [];
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(frame); else queue.push(frame);
  });
  /** The next frame on stdout, or null when the proxy writes nothing within `ms` (a sealed mount answers nothing). */
  const next = (ms = 8_000) => new Promise<Record<string, any> | null>((resolve) => {
    const queued = queue.shift();
    if (queued) return resolve(queued);
    const timer = setTimeout(() => { const at = waiters.indexOf(take); if (at >= 0) waiters.splice(at, 1); resolve(null); }, ms);
    const take = (frame: Record<string, any>) => { clearTimeout(timer); resolve(frame); };
    waiters.push(take);
  });
  const write = (message: object) => child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return { posted, next, write };
}

const hello = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } };
let sessions = 0;
const opened = (entry: Posted): Answer => ({ headers: { "mcp-session-id": `sess-${++sessions}` }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "metrics", version: "1" } } }) });
const ran = (entry: Posted): Answer => ({ body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { content: [{ type: "text", text: `ran on ${entry.session}` }] } }) });
const dropped502 = { status: 502, body: JSON.stringify({ code: "unreachable", error: "metrics.example did not accept the connection. Check the link, or try again in a moment." }) };

describe("q1022-connparity: a dropped transport reconnects within the turn", () => {
  it("W3 a tool call whose server dropped (the relay's own 502) fails alone; the next call in the same turn reconnects and runs", async () => {
    let calls = 0;
    const { next, write, posted } = await start((entry) => {
      if (entry.body.method === "initialize") return opened(entry);
      if (entry.body.method === "tools/call") return ++calls === 1 ? dropped502 : ran(entry);
      return { status: 202 };
    });
    write(hello);
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "metrics" } } });
    write({ method: "notifications/initialized" });
    write({ id: 2, method: "tools/call", params: { name: "report", arguments: {} } });
    const first = await next();
    expect(first).toMatchObject({ id: 2, result: { isError: true } });
    expect(first!.result.content[0].text).toMatch(/cannot tell whether it ran/);
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    const second = await next();
    expect(second).toMatchObject({ id: 3, result: { content: [{ type: "text", text: expect.stringMatching(/^ran on sess-/) }] } });
    // it reconnected: a second initialize opened a new session, and the retried call ran on it
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(2);
    const [droppedOn, ranOn] = posted.filter((entry) => entry.body.method === "tools/call").map((entry) => entry.session);
    expect(ranOn).not.toBe(droppedOn);
    expect(second!.result.content[0].text).toBe(`ran on ${ranOn}`);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  it("W3b a tool call whose answer stream ended with no answer fails alone; the next call reconnects and runs", async () => {
    let calls = 0;
    const { next, write, posted } = await start((entry) => {
      if (entry.body.method === "initialize") return opened(entry);
      if (entry.body.method === "tools/call" && ++calls === 1) {
        return { custom: (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(": keepalive\n\n"); } };
      }
      if (entry.body.method === "tools/call") return ran(entry);
      return { status: 202 };
    });
    write(hello);
    await next();
    write({ method: "notifications/initialized" });
    write({ id: 2, method: "tools/call", params: { name: "report", arguments: {} } });
    expect(await next()).toMatchObject({ id: 2, result: { isError: true, content: [{ text: expect.stringMatching(/cannot tell whether it ran/) }] } });
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    expect(await next()).toMatchObject({ id: 3, result: { content: [{ type: "text", text: expect.stringMatching(/^ran on sess-/) }] } });
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(2);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  it("W3c a 5xx that is not the relay's own answer still seals (nothing of it reaches the engine)", async () => {
    const { next, write } = await start((entry) => {
      if (entry.body.method === "initialize") return opened(entry);
      return { status: 502, body: "<html>upstream page</html>" };
    });
    write(hello);
    await next();
    write({ id: 2, method: "tools/call", params: { name: "report", arguments: {} } });
    expect(await next(1_500)).toBeNull();
    expect(boundProxyState(child!)).toMatchObject({ sealed: true, refusals: 1 });
  });
});

/** A relay answer that starts (headers and part of a body) and then breaks: the connection is destroyed mid-body. */
const breaks = (contentType: string, partial: string): Answer => ({ custom: (res) => {
  res.writeHead(200, { "content-type": contentType });
  res.write(partial);
  setTimeout(() => res.destroy(), 30);
} });

// MAIN-RULING 2026-11-25T17:42:59Z CONNPARITY-1022: an upstream SSE stream that breaks mid-call reconnects once through
// the relay, then fails the call with a clear named error; it never seals the connector.
describe("q1022-connparity: a stream that breaks mid-call reconnects once, fails the call by name, never seals", () => {
  async function broken(first: Answer, again: (entry: Posted) => Answer = opened, shook: (nth: number) => Answer = () => ({ status: 202 })) {
    let calls = 0;
    let inits = 0;
    let shakes = 0;
    const started = await start((entry) => {
      if (entry.body.method === "initialize") return ++inits === 1 ? opened(entry) : again(entry);
      if (entry.body.method === "tools/call") return ++calls === 1 ? first : ran(entry);
      if (entry.body.method === "notifications/initialized") return shook(++shakes);
      return { status: 202 };
    });
    started.write(hello);
    expect(await started.next()).toMatchObject({ id: 1, result: { serverInfo: { name: "metrics" } } });
    started.write({ method: "notifications/initialized" });
    started.write({ id: 2, method: "tools/call", params: { name: "report", arguments: {} } });
    return started;
  }

  it("W5 the SSE answer of a tool call breaks mid-stream: one reconnect through the relay, the call fails as stream-broke, the next call runs", async () => {
    const { next, write, posted } = await broken(breaks("text/event-stream", "event: message\ndata: {\"jsonrpc\":\"2.0\","));
    const first = await next();
    expect(first).toMatchObject({ id: 2, result: { isError: true } });
    expect(first!.result.content[0].text).toMatch(/^stream-broke: .*cannot tell whether the call ran/);
    // reconnected once through the relay before the call was failed
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(2);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    const second = await next();
    const [brokeOn, ranOn] = posted.filter((entry) => entry.body.method === "tools/call").map((entry) => entry.session);
    expect(second).toMatchObject({ id: 3, result: { content: [{ type: "text", text: `ran on ${ranOn}` }] } });
    // the next call ran on the session the reconnect opened, not on the broken one
    expect(ranOn).not.toBe(brokeOn);
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(2);
  });

  it("W5b the JSON answer of a tool call breaks mid-body: the same (one reconnect, stream-broke, not sealed, the next call runs)", async () => {
    const { next, write, posted } = await broken(breaks("application/json", "{\"jsonrpc\":\"2.0\",\"id\":2,"));
    const first = await next();
    expect(first).toMatchObject({ id: 2, result: { isError: true } });
    expect(first!.result.content[0].text).toMatch(/^stream-broke: /);
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(2);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    expect(await next()).toMatchObject({ id: 3, result: { content: [{ type: "text", text: expect.stringMatching(/^ran on sess-/) }] } });
  });

  it("W5c the reconnect's own answer breaks too: the call still fails as stream-broke, nothing seals, the next call reconnects and runs", async () => {
    let reopenBreaks = 1;
    const { next, write, posted } = await broken(breaks("text/event-stream", "event: message\n"),
      (entry) => reopenBreaks-- > 0 ? breaks("text/event-stream", "event: message\n") : opened(entry));
    const first = await next();
    expect(first).toMatchObject({ id: 2, result: { isError: true } });
    expect(first!.result.content[0].text).toMatch(/^stream-broke: /);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    expect(await next()).toMatchObject({ id: 3, result: { content: [{ type: "text", text: expect.stringMatching(/^ran on sess-/) }] } });
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(3);
  });

  // ASTRA/OPUS 4ed978c679 H2: the ONE reconnect after a break has three more ways to fail besides its own answer
  // breaking (W5c). One row per site in openAutomatic; none may seal, and the next call reconnects and runs.
  // The last two rows (OPUS self-review H-B): the reconnect itself opens, and its handshake (the second
  // notifications/initialized) is what fails.
  const reconnectFails: Array<[string, string, "open" | "handshake", () => Answer]> = [
    ["W5d", "answers HTTP ok but its stream ends with no answer frame", "open",
      () => ({ custom: (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(": keepalive\n\n"); } })],
    ["W5e", "gets a 5xx that is not the relay's own answer", "open",
      () => ({ status: 502, body: "<html>upstream page</html>" })],
    ["W5f", "is rejected (the connection is dropped before any answer)", "open",
      () => ({ custom: (res) => { res.destroy(); } })],
    ["W5g", "opens, and its handshake gets a 5xx that is not the relay's own answer", "handshake",
      () => ({ status: 502, body: "<html>upstream page</html>" })],
    ["W5h", "opens, and its handshake is rejected (the connection is dropped before any answer)", "handshake",
      () => ({ custom: (res) => { res.destroy(); } })],
  ];
  it.each(reconnectFails)("%s the reconnect %s: the call still fails as stream-broke, nothing seals, the next call reconnects and runs", async (_id, _what, at, failure) => {
    let reopenFails = 1;
    const { next, write, posted } = await broken(breaks("text/event-stream", "event: message\n"),
      (entry) => at === "open" && reopenFails-- > 0 ? failure() : opened(entry),
      (nth) => at === "handshake" && nth === 2 ? failure() : { status: 202 });
    const first = await next();
    // never the seal (a sealed mount answers nothing): the call is failed by name
    expect(first?.result?.content?.[0]?.text ?? "sealed: no answer").toMatch(/^stream-broke: .*cannot tell whether the call ran/);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    expect(await next()).toMatchObject({ id: 3, result: { content: [{ type: "text", text: expect.stringMatching(/^ran on sess-/) }] } });
    // the broken call's one reconnect, then the next call's own
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(3);
  });

  // ASTRA 49dd8dd7dd: the reconnect opens, its notifications/initialized meets the relay's session-gone, and the ping that
  // checks it is rejected. That ping is part of the same one reconnect: it never seals either.
  it("W5i the reconnect's handshake meets session-gone and its ping is rejected: stream-broke, nothing seals, the next call runs", async () => {
    let calls = 0, notes = 0, pings = 0;
    const { next, write } = await start((entry) => {
      const method = entry.body.method;
      if (method === "initialize") return opened(entry);
      if (method === "tools/call") return ++calls === 1 ? breaks("text/event-stream", "event: message\n") : ran(entry);
      if (method === "notifications/initialized") return ++notes === 2 ? { status: 404, body: JSON.stringify({ code: "session-gone", error: "That session is no longer held." }) } : { status: 202 };
      if (method === "ping" && ++pings === 1) return { custom: (res) => res.socket?.destroy() };
      return { status: 202 };
    });
    write(hello);
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "metrics" } } });
    write({ method: "notifications/initialized" });
    write({ id: 2, method: "tools/call", params: { name: "report", arguments: {} } });
    const first = await next();
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    const second = await next();
    expect({ first: first?.result?.content?.[0]?.text ?? null, pinged: pings, sealed: boundProxyState(child!).sealed, second: second?.result?.content?.[0]?.text ?? null })
      .toEqual({ first: expect.stringMatching(/^stream-broke: /), pinged: 1, sealed: false, second: expect.stringMatching(/^ran on sess-/) });
  });

  // q1023-connparity-fix (ASTRA 14d1f27d48 High 3): the relay's own answer that a legacy SSE server's stream broke under
  // the call (mcp-relay.ts viaSse, code stream-broke). The same break, the same treatment as W5: one reconnect now, the
  // call fails by name, nothing seals, and the next call runs on the session that reconnect opened.
  it("W5j the relay answers a tool call with its stream-broke decision (a legacy SSE stream broke): one reconnect now, stream-broke, nothing seals, the next call runs", async () => {
    const { next, write, posted } = await broken({ status: 502, body: JSON.stringify({ code: "stream-broke", error: "The connection to this server broke before it answered. Try again in a moment." }) });
    const first = await next();
    const reconnectedBeforeNextCall = posted.filter((entry) => entry.body.method === "initialize").length;
    write({ id: 3, method: "tools/call", params: { name: "report", arguments: {} } });
    const second = await next();
    expect({ first: first?.result?.content?.[0]?.text ?? "sealed: no answer", reconnectedBeforeNextCall, sealed: boundProxyState(child!).sealed, refusals: boundProxyState(child!).refusals,
      second: second?.result?.content?.[0]?.text ?? null, initializes: posted.filter((entry) => entry.body.method === "initialize").length })
      .toEqual({ first: expect.stringMatching(/^stream-broke: .*cannot tell whether the call ran/), reconnectedBeforeNextCall: 2, sealed: false, refusals: 0,
        second: "ran on sess-" + sessions, initializes: 2 });
  });
});

describe("q1022-connparity: Claude Code's server/discover probe never reaches the link server", () => {
  it("W2 server/discover before initialize is answered here as an unknown method; nothing is posted; initialize and tools/list go on", async () => {
    const { next, write, posted } = await start((entry) => {
      if (entry.body.method === "initialize") return opened(entry);
      if (entry.body.method === "tools/list") return { body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { tools: [{ name: "report" }] } }) };
      // what a stateful link server and the relay answer a request with no session
      return { status: 400, body: JSON.stringify({ code: "wrong-address", error: "Nothing at this address answers as an MCP server. Check that you copied the whole link." }) };
    });
    write({ id: 0, method: "server/discover", params: {} });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 0, error: { code: -32601, message: "Method not found: server/discover" } });
    expect(posted.map((entry) => entry.body.method)).not.toContain("server/discover");
    write(hello);
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "metrics" } } });
    write({ id: 2, method: "tools/list", params: {} });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "report" }] } });
    // never later either (a probe held until the session opened would be posted after initialize)
    expect(posted.map((entry) => entry.body.method)).not.toContain("server/discover");
  });
});
