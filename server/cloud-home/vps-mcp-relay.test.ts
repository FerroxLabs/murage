import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { VPS_MCP_RELAY_PATH, createVpsMcpRelay, type VpsMcpBinding, type VpsMcpChild } from "./vps-mcp-relay.ts";

const ALIAS = "secret-host-alias";
const CONTAINER = "murage-vps-bot-a";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed: string[] = [];
  written: string[] = [];
  constructor() { super(); this.stdin.on("data", (d: Buffer) => this.written.push(d.toString())); }
  kill(signal?: string) { this.killed.push(signal ?? "SIGTERM"); return true; }
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.terminate(); } catch { /* gone */ } }
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(null)); })));
});

async function rig(over: { binding?: VpsMcpBinding | null; max?: number; pingMs?: number } = {}) {
  const caps = new InternalCapabilities();
  caps.begin("bot-a", "thread-a", "gen-a");
  const token = caps.mint({ botId: "bot-a", threadId: "thread-a", generation: "gen-a", kind: "computer", depth: 0, skillAuthoring: false });
  const agentsToken = caps.mint({ botId: "bot-a", threadId: "thread-a", generation: "gen-a", kind: "agents", depth: 0, skillAuthoring: false });
  caps.begin("bot-b", "thread-b", "gen-b");
  const otherToken = caps.mint({ botId: "bot-b", threadId: "thread-b", generation: "gen-b", kind: "computer", depth: 0, skillAuthoring: false });
  const children: FakeChild[] = [];
  const spawned: Array<{ command: string; args: string[] }> = [];
  const logs: string[] = [];
  let binding: VpsMcpBinding | null = over.binding === undefined ? { alias: ALIAS, container: CONTAINER } : over.binding;
  const handler = createVpsMcpRelay({
    resolveClaim: (h) => caps.resolve(h),
    isActive: (c) => caps.isActive(c),
    boundContainer: (bot) => (bot === "bot-a" || bot === "bot-b" ? binding : null),
    spawn: (command, args) => { const c = new FakeChild(); children.push(c); spawned.push({ command, args }); return c as unknown as VpsMcpChild; },
    log: (l) => logs.push(l),
    maxMessageBytes: over.max ?? 1024,
    pingMs: over.pingMs ?? 30_000,
    killGraceMs: 10,
  });
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handler(req, socket, head, url).then((took) => { if (!took) socket.destroy(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const connect = (tok: string | null, path = VPS_MCP_RELAY_PATH) => new Promise<{ ws: WebSocket; status?: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    sockets.push(ws);
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_q, res) => { resolve({ ws, status: res.statusCode }); res.resume(); });
    ws.once("error", () => resolve({ ws, status: 0 }));
  });
  return { caps, token, agentsToken, otherToken, children, spawned, logs, connect, setBinding: (b: VpsMcpBinding | null) => { binding = b; } };
}
const nextMessage = (ws: WebSocket) => new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.once("close", (code, reason) => r({ code, reason: reason.toString() })));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("vps mcp relay", () => {
  it("bridges JSON-RPC lines both ways using docker argv", async () => {
    const t = await rig();
    const { ws } = await t.connect(t.token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.command).toBe("docker");
    expect(t.spawned[0]!.args.slice(0, 2)).toEqual(["-H", `ssh://${ALIAS}`]);
    expect(t.spawned[0]!.args).toContain(CONTAINER);
    ws.send('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await tick();
    expect(t.children[0]!.written.join("")).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    const got = nextMessage(ws);
    t.children[0]!.stdout.write('{"id":1}\n{"id":');
    expect(await got).toBe('{"id":1}');
    const second = nextMessage(ws);
    t.children[0]!.stdout.write('2}\n');
    expect(await second).toBe('{"id":2}');
  });

  it("refuses missing, wrong-kind and unbound callers without leaking anything", async () => {
    const t = await rig();
    expect((await t.connect(null)).status).toBe(401);
    expect((await t.connect("nope")).status).toBe(401);
    expect((await t.connect(t.agentsToken)).status).toBe(403);
    expect((await t.connect(t.token, `${VPS_MCP_RELAY_PATH}/extra`)).status).toBe(404);
    t.setBinding(null);
    expect((await t.connect(t.token)).status).toBe(404);
    expect(t.spawned).toHaveLength(0);
    const text = t.logs.join("\n");
    expect(text).not.toContain(t.token);
    expect(text).not.toContain(ALIAS);
  });

  it("serves only the bot the token belongs to and refuses an ended turn", async () => {
    const t = await rig();
    const { ws } = await t.connect(t.otherToken);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    t.caps.revokeBot("bot-b");
    expect((await t.connect(t.otherToken)).status).toBe(401);
  });

  it("a second connection closes the first, and the first child is killed", async () => {
    const t = await rig();
    const first = (await t.connect(t.token)).ws;
    const firstClosed = closed(first);
    const second = (await t.connect(t.token)).ws;
    expect((await firstClosed).code).toBe(4000);
    expect(t.children[0]!.killed).toContain("SIGTERM");
    expect(second.readyState).toBe(WebSocket.OPEN);
    expect(t.children).toHaveLength(2);
  });

  it("kills the child when the socket closes and closes the socket when the child exits", async () => {
    const t = await rig();
    const a = (await t.connect(t.token)).ws;
    a.close();
    await tick(60);
    expect(t.children[0]!.killed).toContain("SIGTERM");
    const b = (await t.connect(t.token)).ws;
    const done = closed(b);
    t.children[1]!.emit("exit", 0);
    expect((await done).code).toBe(1000);
  });

  it("closes on binary, multi-line and oversize input", async () => {
    const t = await rig({ max: 64 });
    const bin = (await t.connect(t.token)).ws;
    const c1 = closed(bin); bin.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await c1).code).toBe(1003);
    const multi = (await t.connect(t.token)).ws;
    const c2 = closed(multi); multi.send("{}\n{}");
    expect((await c2).code).toBe(1008);
    const big = (await t.connect(t.token)).ws;
    const c3 = closed(big); big.send("x".repeat(200));
    expect((await c3).code).toBe(1009);
    const out = (await t.connect(t.token)).ws;
    const c4 = closed(out); t.children[3]!.stdout.write(`${"y".repeat(200)}\n`);
    expect((await c4).code).toBe(1009);
  });

  it("pings when idle and ends a relay whose turn is gone", async () => {
    const t = await rig({ pingMs: 30 });
    const { ws } = await t.connect(t.token);
    const pinged = new Promise((r) => ws.once("ping", () => r(true)));
    expect(await pinged).toBe(true);
    const done = closed(ws);
    t.caps.revokeBot("bot-a");
    expect((await done).code).toBe(1008);
    expect(t.children[0]!.killed).toContain("SIGTERM");
  });

  it("sends no host, alias or token in close reasons when the spawn fails", async () => {
    const caps = new InternalCapabilities();
    caps.begin("bot-a", "thread-a", "gen-a");
    const token = caps.mint({ botId: "bot-a", threadId: "thread-a", generation: "gen-a", kind: "computer", depth: 0, skillAuthoring: false });
    const logs: string[] = [];
    const handler = createVpsMcpRelay({
      resolveClaim: (h) => caps.resolve(h), isActive: (c) => caps.isActive(c),
      boundContainer: () => ({ alias: ALIAS, container: CONTAINER }),
      spawn: () => { throw new Error(`boom ${ALIAS} ${token}`); }, log: (l) => logs.push(l),
    });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => { void handler(req, socket, head, new URL(req.url ?? "/", "http://x")); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    servers.push(server);
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${VPS_MCP_RELAY_PATH}`, { headers: { authorization: `Bearer ${token}` } });
    sockets.push(ws);
    const c = await closed(ws);
    expect(c.reason).toBe("unavailable");
    expect(logs.join("\n")).not.toContain(ALIAS);
    expect(logs.join("\n")).not.toContain(token);
    vi.restoreAllMocks();
  });
});
