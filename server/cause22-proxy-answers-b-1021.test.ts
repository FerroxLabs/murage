// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22, binding): NO transport size or count caps at all. Group A witness rows
// for the answer side of the hops that had no row of their own (SITES #14, #15, #16, #19, #24c). Each row pushes a real item of
// 20 MiB or more through the hop's production entry and proves the whole item arrives and the next call is served.
// Owners: lane cause22-main-fable owns these rows and the hops they drive (drivers/browser-extension-mcp.ts,
// drivers/headless-browser-proxy.ts, host-computer-broker.ts, drivers/remote-mcp-proxy.ts, mcp-relay.ts); group C (lane cause22-cli)
// owns the ingress behind the release door; group D (lane cause22-mem) owns memory/upstream-reader.ts and the release budget.
//   E1  spawned browser extension MCP (runBrowserExtensionMcp), a loopback extension endpoint answering 20 MiB.
//   H1  spawned headless browser proxy (runHeadlessBrowserProxy), a real engine child answering one 20 MiB line.
//   H2  the same spawned proxy reading a 20 MiB authority answer from its control route (boundedJson).
//   K1  the host computer broker (HostComputerBroker.dispatch, its own engine start), a real driver child answering 20 MiB.
//   M1/M2  spawned remote MCP proxy (remote-mcp-proxy.ts main), a loopback relay route answering 20 MiB as JSON / as one SSE event.
//   M3  the same spawned proxy when the relay route forgot the session: the 20 MiB answer to the proxy's own initialize (answerIn).
//   L1/L2  the relay itself (mcp-relay.ts relayMcpCall), a loopback MCP server answering 24 MiB as JSON / as SSE.
// The proxy rows and the relay rows run on the owner's turn: other turns are still bounded by the ingress (group C) and by the
// release budget's marks (group D) until those groups' deletions are merged.
// RED on c187b11166: the 8/16 MiB answer caps, the 1 MiB event cap and the 20 MiB fetch ceiling fail the call or seal the proxy.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HostComputerBroker } from "./host-computer-broker.ts";
import { relayMcpCall, type RelayContext } from "./mcp-relay.ts";
import type { StoredRemoteMcpServer } from "./mcp-registry.ts";
import { RemoteSseSessions } from "./remote-mcp-sse-sessions.ts";
import { runBoundBridge } from "./testing/bound-proxy-fixture.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";
import { upstreamOwnerFixture } from "./testing/upstream-owner-fixture.ts";

const MiB = 1024 * 1024;
const ITEM = 20 * MiB;
type Reply = { id?: unknown; result?: { isError?: boolean; content?: Array<{ text?: string }> } & Record<string, unknown>; error?: { message?: string } };
const parse = (frames: string[]) => frames.map((frame) => { try { return JSON.parse(frame) as Reply; } catch { return { id: frame } as Reply; } });
const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const env = { MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "B", MURAGE_THREAD_ID: "T" };

/** Writes head + `bytes` of "x" + tail to the response, honouring backpressure. */
function pump(res: ServerResponse, head: string, bytes: number, tail: string): void {
  res.write(head);
  const piece = Buffer.alloc(64 * 1024, 0x78); let sent = 0;
  const more = () => { while (sent < bytes) { sent += piece.length; if (!res.write(piece)) { res.once("drain", more); return; } } res.end(tail); };
  res.on("error", () => {}); more();
}
async function loopback(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ url: string; port: number; close(): void }> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; }).on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => { server.closeAllConnections(); server.close(); } };
}
/** Runs a spawned proxy behind the real release door on the owner's turn; a fixture failure becomes one unparsable frame. */
const bound = (script: string, role: string, requests: string[], extra: Record<string, string>) =>
  runBoundBridge(script, requests, requests.length, false, { role, env: { ...env, ...extra }, owner: true, delays: requests.map((_, index) => index ? 2_000 : 0), timeoutMs: 90_000 })
    .catch((error: unknown) => [`fixture: ${String(error)}`]);

// A real engine child: answers initialize, then every tools/call; the call named in BIG (or the first call) gets a 20 MiB text.
const engineChild = `let buf='',calls=0;process.stdin.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);
  if(m.id===undefined)continue;
  let result={};
  if(m.method==='tools/call'){calls++;result={content:[{type:'text',text:calls===1?'x'.repeat(${ITEM}):'small'}],calls};}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`;

describe("cause22-no-transport-caps: a 20 MiB answer passes the remaining group A proxy hops and the turn goes on", () => {
  it("E1 browser extension MCP answer (browser-extension-mcp.ts boundedResponse): a 20 MiB extension answer reaches the engine whole and the next call is answered", async () => {
    const control = await loopback((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); pump(res, '{"content":[{"type":"text","text":"', ITEM, '"}]}'); });
    try {
      const script = `const m=await import('./server/drivers/browser-extension-mcp.ts');void m.runBrowserExtensionMcp({config:{endpoint:'${control.url}/api/browser-extension/mcp',clientId:'paired_client',token:'a'.repeat(43)}});`;
      const frames = await bound(script, "browser-extension", [rpc(0, "initialize"), rpc(1, "tools/call", { name: "agent_browser_snapshot", arguments: {} }), rpc(2, "initialize")], {});
      const replies = parse(frames), at = replies.findIndex((reply) => reply.id === 1);
      expect([replies.map((reply) => reply.id).sort(), replies[at]?.error, replies[at]?.result?.isError, at < 0 ? 0 : Buffer.byteLength(frames[at]!) >= ITEM],
        "E1: every call is answered, the 20 MiB answer is not an error and every byte of it reached the engine").toEqual([[0, 1, 2], undefined, undefined, true]);
    } finally { control.close(); }
  }, 180_000);

  it("H1 headless browser proxy answer (headless-browser-proxy.ts startHeadlessEngine splitter, clean): a 20 MiB engine line reaches the engine whole and the same engine child serves the next call", async () => {
    const control = await loopback((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.method === "DELETE" ? { closed: true } : { held: false, spec: { command: process.execPath, args: ["-e", engineChild], env: {} } }));
    });
    try {
      const script = "const m=await import('./server/drivers/headless-browser-proxy.ts');void m.runHeadlessBrowserProxy();";
      const snapshot = (id: number) => rpc(id, "tools/call", { name: "agent_browser_snapshot", arguments: {} });
      const frames = await bound(script, "headlessBrowser", [rpc(0, "initialize"), snapshot(1), snapshot(2)], { MURAGE_CONTROL_URL: control.url });
      const replies = parse(frames), at = replies.findIndex((reply) => reply.id === 1), next = replies.find((reply) => reply.id === 2);
      expect([replies.map((reply) => reply.id).sort(), replies[at]?.result?.isError, replies[at]?.result?.content?.[0]?.text?.length, next?.result?.content?.[0]?.text, next?.result?.calls],
        "H1: every call is answered, the 20 MiB engine answer arrived whole and the same engine child (its second call) answered the next one").toEqual([[0, 1, 2], undefined, ITEM, "small", 2]);
    } finally { control.close(); }
  }, 180_000);

  it("H2 headless browser proxy authority answer (headless-browser-proxy.ts createHeadlessAuthorityReader -> boundedJson): a 20 MiB authority answer from the control route is read whole, the engine it names is started, and the next call is served", async () => {
    let bigSent = 0;
    const control = await loopback((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "DELETE") { res.end(JSON.stringify({ closed: true })); return; }
      const tail = `","held":false,"spec":${JSON.stringify({ command: process.execPath, args: ["-e", engineChild], env: {} })}}`;
      // the first authority answer is 20 MiB; the engine's spec comes after the large field, so only a whole read finds it
      if (bigSent === 0) { res.once("finish", () => { bigSent++; }); pump(res, '{"note":"', ITEM, tail); }
      else res.end(`{"note":"${tail}`);
    });
    try {
      const script = "const m=await import('./server/drivers/headless-browser-proxy.ts');void m.runHeadlessBrowserProxy();";
      const snapshot = (id: number) => rpc(id, "tools/call", { name: "agent_browser_snapshot", arguments: {} });
      const frames = await bound(script, "headlessBrowser", [rpc(0, "initialize"), snapshot(1), snapshot(2)], { MURAGE_CONTROL_URL: control.url });
      const replies = parse(frames), first = replies.find((reply) => reply.id === 1), next = replies.find((reply) => reply.id === 2);
      expect([replies.map((reply) => reply.id).sort(), bigSent, first?.result?.isError, first?.result?.calls, next?.result?.content?.[0]?.text, next?.result?.calls],
        "H2: the 20 MiB authority answer was sent and read whole (the engine it names answered the call) and the same engine answered the next call").toEqual([[0, 1, 2], 1, undefined, 1, "small", 2]);
    } finally { control.close(); }
  }, 180_000);

  it("K1 host computer broker answer (host-computer-broker.ts startHostEngine -> startHeadlessEngine splitter): a 20 MiB driver answer is returned whole and the broker serves the next call", async () => {
    const broker = new HostComputerBroker();
    const spec = { command: process.execPath, args: ["-e", engineChild], env: {} };
    const big = await broker.dispatch(spec, "tools/call", { name: "big" }, () => true).catch((error: unknown) => ({ failed: String(error) }));
    const after = await broker.dispatch(spec, "tools/list", {}, () => true).catch((error: unknown) => ({ failed: String(error) }));
    expect([(big as { failed?: string }).failed, (big as Reply["result"])?.content?.[0]?.text?.length, (after as { failed?: string }).failed],
      "K1: the 20 MiB driver answer is returned whole, not a refusal, and the next call is served").toEqual([undefined, ITEM, undefined]);
  }, 120_000);

  for (const [row, sse] of [["M1 remote MCP proxy JSON answer (remote-mcp-proxy.ts gatedFetch body, readBounded)", false], ["M2 remote MCP proxy SSE answer (remote-mcp-proxy.ts gatedFetch event, streamAnswer)", true]] as const) {
    it(`${row}: a 20 MiB tool result from the relay route reaches the engine whole and the next call is answered`, async () => {
      const posted: string[] = [];
      const control = await loopback((req, res, body) => {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string; params?: { name?: string } };
        posted.push(`${req.url} ${message.method}`);
        const answer = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        if (message.id === undefined) { res.writeHead(202).end(); return; }
        if (message.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" }); res.end(answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } })); return; }
        if (message.method !== "tools/call" || message.params?.name !== "big") { res.writeHead(200, { "content-type": "application/json" }); res.end(answer(message.method === "tools/call" ? { content: [{ type: "text", text: "small" }] } : {})); return; }
        const head = `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"content":[{"type":"text","text":"`, tail = '"}]}}';
        if (sse) { res.writeHead(200, { "content-type": "text/event-stream" }); pump(res, `event: message\ndata: ${head}`, ITEM, `${tail}\n\n`); }
        else { res.writeHead(200, { "content-type": "application/json" }); pump(res, head, ITEM, tail); }
      });
      try {
        const script = "process.argv.push('--server','fixture');await import('./server/drivers/remote-mcp-proxy.ts');";
        const frames = await bound(script, "remoteMcp", [
          rpc(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } }),
          rpc(1, "tools/call", { name: "big", arguments: {} }), rpc(2, "tools/call", { name: "after", arguments: {} }),
        ], { MURAGE_HARNESS_URL: control.url, MURAGE_MCP_TOKEN: "turn-token-0123" });
        const replies = parse(frames), at = replies.findIndex((reply) => reply.id === 1), next = replies.find((reply) => reply.id === 2);
        expect([replies.map((reply) => reply.id).sort(), replies[at]?.error, replies[at]?.result?.isError, replies[at]?.result?.content?.[0]?.text?.length, next?.result?.content?.[0]?.text, posted.filter((entry) => entry === "/api/internal/mcp-remote/fixture tools/call").length],
          `${row}: every call is answered, the 20 MiB result arrived whole and the next call went to the relay route and was answered`).toEqual([[0, 1, 2], undefined, undefined, ITEM, "small", 2]);
      } finally { control.close(); }
    }, 180_000);
  }

  it("M3 remote MCP proxy reopened session (remote-mcp-proxy.ts openAutomatic -> answerIn): the relay route forgot the session, the 20 MiB answer to the proxy's own initialize is read whole, and the call and the next call are answered on the new session", async () => {
    let live = "", opened = 0, reopenSent = 0;
    const control = await loopback((req, res, body) => {
      const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
      if (message.method === "initialize") {
        live = `sess-${++opened}`;
        const result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } };
        if (opened === 1) return json(200, { jsonrpc: "2.0", id: message.id, result }, { "mcp-session-id": live });
        // the proxy's own initialize (the reopen): one 20 MiB SSE event, read by answerIn
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": live });
        res.once("finish", () => { reopenSent++; });
        return pump(res, `event: message\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"version":"1","name":"`, ITEM, '"}}}\n\n');
      }
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      // the relay answers every call on a session it does not hold the same way, the proxy's ping included
      if (req.headers["mcp-session-id"] !== live) return json(502, { code: "session-gone", error: "no such session" });
      return json(200, { jsonrpc: "2.0", id: message.id, result: message.method === "tools/call" ? { content: [{ type: "text", text: `ok ${live}` }] } : {} });
    });
    try {
      const script = "process.argv.push('--server','fixture');await import('./server/drivers/remote-mcp-proxy.ts');";
      // the first call arrives after the relay dropped the session the engine opened
      const forget = setTimeout(() => { live = "sess-gone"; }, 1_000);
      const frames = await bound(script, "remoteMcp", [
        rpc(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } }),
        rpc(1, "tools/call", { name: "echo", arguments: {} }), rpc(2, "tools/call", { name: "echo", arguments: {} }),
      ], { MURAGE_HARNESS_URL: control.url, MURAGE_MCP_TOKEN: "turn-token-0123" });
      clearTimeout(forget);
      const replies = parse(frames), first = replies.find((reply) => reply.id === 1), next = replies.find((reply) => reply.id === 2);
      expect([replies.map((reply) => reply.id).sort(), opened, reopenSent, first?.error, first?.result?.content?.[0]?.text, next?.result?.content?.[0]?.text],
        "M3: the session was reopened once, its 20 MiB initialize answer was sent and read whole, and both calls were answered on the new session").toEqual([[0, 1, 2], 2, 1, undefined, "ok sess-2", "ok sess-2"]);
    } finally { control.close(); }
  }, 180_000);
});

describe("cause22-no-transport-caps: the remote MCP relay passes a tool result over the old 20 MiB fetch ceiling", () => {
  const PAD = 24 * MiB;
  let fake: FakeRemoteMcp | undefined;
  const sessions = new RemoteSseSessions();
  afterEach(async () => { sessions.closeAll(); await fake?.close(); fake = undefined; });
  const read = async (body: unknown): Promise<string> => {
    if (typeof body === "string") return body;
    if (Buffer.isBuffer(body)) return body.toString("utf8");
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  };

  for (const [row, respondWith] of [["L1 relay JSON answer (mcp-relay.ts viaStreamableHttp guardedRequest, readAll)", "json"], ["L2 relay SSE answer (mcp-relay.ts viaStreamableHttp guardedRequest, stream)", "sse"]] as const) {
    it(`${row}: a 24 MiB tool result is relayed whole on the owner's turn and the next call is relayed`, async () => {
      fake = await startFakeRemoteMcp({ auth: "none", transport: "http", respondWith, toolResultPadBytes: PAD });
      const upstream = upstreamOwnerFixture();
      upstream.budget("gen-1").keepOwner(() => {});
      const server: StoredRemoteMcpServer = { url: fake.mcpUrl, auth: "none", headers: {}, enabled: true, local: "this-computer", transport: "http" } as StoredRemoteMcpServer;
      const context = (message: Record<string, unknown>, sessionId?: string): RelayContext => ({ name: "svc", server, message, generation: "gen-1", postTokenRejected: () => false, sseSessions: sessions, tokenWaitMs: 400, ...(sessionId ? { sessionId } : {}) });
      const call = (id: number, text: string, sessionId?: string) => upstream.run("gen-1", async () => {
        const relayed = await relayMcpCall(context({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { text } } }, sessionId));
        return relayed.ok ? { ok: true, text: await read(relayed.body).catch((error: unknown) => `read failed: ${String(error)}`) } : { ok: false, text: JSON.stringify(relayed.body) };
      });
      const init = await upstream.run("gen-1", async () => {
        const relayed = await relayMcpCall(context({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
        if (relayed.ok) await read(relayed.body);
        return relayed;
      });
      expect(init.ok, "setup: initialize is relayed").toBe(true);
      const sessionId = init.ok ? init.sessionId : undefined;
      const big = await call(2, "a", sessionId), next = await call(3, "b", sessionId);
      expect([big.ok, big.text.length >= PAD, big.text.includes(`a${"x".repeat(64)}`), next.ok],
        `${row}: the 24 MiB answer is relayed whole (not a size refusal: ${big.ok ? "" : big.text.slice(0, 200)}) and the next call is relayed`).toEqual([true, true, true, true]);
    }, 180_000);
  }
});
