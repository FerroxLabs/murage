// G34: a server that lists its tools to anyone but refuses every call without a
// sign-in must not show Connected. The probe sends one tools/call for a name no
// conforming server defines, and only a 401 from a protected-resource source
// turns the verdict into needs-sign-in.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeRemoteMcp, SIGN_IN_CHECK_TOOL } from "./remote-mcp-client.ts";

interface Opts {
  /** What a tools/call gets. */
  call: "401-resource-metadata" | "401-plain" | "rpc-32602" | "403";
  prm?: boolean;
  nextCursor?: string;
  toolCount?: number;
  endpoint?: string;
  listedCheck?: boolean;
  onMetadata?: () => void;
}

interface Fake { url: string; calls: number; paths: string[]; close(): Promise<void> }
let fake: Fake | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

function start(opts: Opts): Promise<Fake> {
  let sseOut: ServerResponse | undefined;
  const state: Fake = { url: "", calls: 0, paths: [], close: async () => undefined };
  const tools = Array.from({ length: opts.toolCount ?? 2 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" } }));
  if (opts.listedCheck) tools.push({ name: SIGN_IN_CHECK_TOOL, inputSchema: { type: "object" } });
  const answer = (method: string, id: unknown): { status: number; headers?: Record<string, string>; frame?: unknown } => {
    if (method === "initialize") return { status: 200, frame: { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "f", version: "1" } } } };
    if (method === "notifications/initialized") return { status: 202 };
    if (method === "tools/list") return { status: 200, frame: { jsonrpc: "2.0", id, result: { tools, ...(opts.nextCursor !== undefined ? { nextCursor: opts.nextCursor } : {}) } } };
    if (method === "tools/call") {
      state.calls += 1;
      if (opts.call === "401-resource-metadata") return { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${state.url.replace(/\/mcp.*$/, "")}/.well-known/oauth-protected-resource"` } };
      if (opts.call === "401-plain") return { status: 401, headers: { "www-authenticate": "Bearer" } };
      if (opts.call === "403") return { status: 403 };
      return { status: 200, frame: { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } } };
    }
    return { status: 200, frame: { jsonrpc: "2.0", id, result: {} } };
  };
  const server = http.createServer((req, res) => {
    state.paths.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      opts.onMetadata?.();
      if (!opts.prm) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: state.url, authorization_servers: ["https://auth.example"] }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/sse")) {
      sseOut = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: endpoint\ndata: ${opts.endpoint ?? "/messages"}\n\n`);
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const frame = JSON.parse(body) as { method: string; id?: unknown };
      const out = answer(frame.method, frame.id);
      if (req.url?.startsWith("/messages")) {
        res.writeHead(out.status === 200 ? 202 : out.status, out.headers).end();
        if (out.status === 200 && out.frame) sseOut?.write(`event: message\ndata: ${JSON.stringify(out.frame)}\n\n`);
        return;
      }
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) }).end(out.frame ? JSON.stringify(out.frame) : "");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    state.close = () => new Promise((done) => { sseOut?.end(); server.closeAllConnections(); server.close(() => done()); });
    resolve(state);
  }));
}

const local = { confirmed: "this-computer" as const };

describe("G34 sign-in check after a good tools/list", () => {
  it("the check name is outside the MCP tool-name characters", () => {
    expect(/^[A-Za-z0-9_.-]+$/.test(SIGN_IN_CHECK_TOOL)).toBe(false);
  });
  it("lists to anyone, 401s calls with resource_metadata: needs-sign-in (base said Connected)", async () => {
    fake = await start({ call: "401-resource-metadata" });
    const result = await probeRemoteMcp({ url: fake.url, ...local });
    expect(result).toMatchObject({ ok: false, reason: "needs-sign-in", signIn: { host: "127.0.0.1" } });
    expect(fake.calls).toBe(1);
  });
  it("a plain 401 with an RFC 9728 document: needs-sign-in", async () => {
    fake = await start({ call: "401-plain", prm: true });
    expect(await probeRemoteMcp({ url: fake.url, ...local })).toMatchObject({ ok: false, reason: "needs-sign-in" });
  });
  it("keeps a cancellation that arrives during protected-resource discovery", async () => {
    const controller = new AbortController();
    fake = await start({ call: "401-plain", onMetadata: () => controller.abort() });
    expect(await probeRemoteMcp({ url: fake.url, ...local, signal: controller.signal })).toMatchObject({ ok: false, reason: "cancelled" });
    expect(fake.calls).toBe(1);
  });
  it("a 401 with no protected-resource source keeps Connected", async () => {
    fake = await start({ call: "401-plain" });
    expect(await probeRemoteMcp({ url: fake.url, ...local })).toMatchObject({ ok: true, transport: "http" });
    expect(fake.calls).toBe(1);
  });
  it("JSON-RPC -32602 and a 403 keep Connected", async () => {
    fake = await start({ call: "rpc-32602" });
    expect(await probeRemoteMcp({ url: fake.url, ...local })).toMatchObject({ ok: true });
    await fake.close();
    fake = await start({ call: "403", prm: true });
    expect(await probeRemoteMcp({ url: fake.url, ...local })).toMatchObject({ ok: true });
  });
  it("a probe with a key, a bearer, a key in the link or a saved link secret sends no call", async () => {
    fake = await start({ call: "401-resource-metadata" });
    await probeRemoteMcp({ url: fake.url, headers: { "x-api-key": "fixture" }, ...local });
    await probeRemoteMcp({ url: fake.url, bearer: "fixture", ...local });
    await probeRemoteMcp({ url: `${fake.url}?api_key=fixture`, ...local });
    await probeRemoteMcp({ url: fake.url, urlSecret: true, ...local });
    expect(fake.calls).toBe(0);
  });
  it("a list with a further page or at the probe's limit sends no call", async () => {
    fake = await start({ call: "401-resource-metadata", nextCursor: "page-2" });
    expect(await probeRemoteMcp({ url: fake.url, ...local })).toMatchObject({ ok: true, toolsMore: true });
    await fake.close();
    fake = await start({ call: "401-resource-metadata", toolCount: 100 });
    expect(await probeRemoteMcp({ url: fake.url, ...local })).toMatchObject({ ok: true });
    expect(fake.calls).toBe(0);
  });
  it.each([{ nextCursor: "" }, { listedCheck: true }])("does not call when the complete list is unproven or lists the check name (%j)", async guard => {
    fake = await start({ call: "401-resource-metadata", ...guard });
    expect(await probeRemoteMcp({ url: fake.url, ...local })).toMatchObject({ ok: true });
    expect(fake.calls).toBe(0);
  });
  it.each(["/messages?session=fixture", "/messages/fixture"])("legacy SSE sends no check to an opaque endpoint (%s)", async endpoint => {
    fake = await start({ call: "401-resource-metadata", endpoint });
    const url = fake.url.replace(/\/mcp$/, "/sse");
    expect(await probeRemoteMcp({ url, transport: "sse", ...local })).toMatchObject({ ok: true });
    expect(fake.calls).toBe(0);
  });
  it("legacy SSE: a 401 on the POST of the call is needs-sign-in", async () => {
    fake = await start({ call: "401-resource-metadata" });
    const url = fake.url.replace(/\/mcp$/, "/sse");
    expect(await probeRemoteMcp({ url, transport: "sse", ...local })).toMatchObject({ ok: false, reason: "needs-sign-in" });
    expect(fake.calls).toBe(1);
  });
});
