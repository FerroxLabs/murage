import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { baselineModule } from "../testing/baseline-contract.ts";
const { createConsumingIngress } = await baselineModule<typeof import("../consuming-turn-ingress.ts")>(new URL("../consuming-turn-ingress.ts", import.meta.url), "VPS frames require final server-owned acceptance");
const { bindConsumingTurn } = await baselineModule<typeof import("../consuming-turn-response.ts")>(new URL("../consuming-turn-response.ts", import.meta.url), "VPS delivery must capture the exact consuming generation");
const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
import { VPS_MCP_RELAY_PATH, createVpsMcpRelay, type VpsMcpBinding, type VpsMcpChild } from "./vps-mcp-relay.ts";
const ALIAS = "secret-host-alias", CONTAINER = "murage-vps-bot-a";
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); killed: string[] = []; written: string[] = [];
  constructor() { super(); this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk.toString())); }
  kill(signal?: string) { this.killed.push(signal ?? "SIGTERM"); return true; }
}
const servers: Server[] = [], sockets: WebSocket[] = [], fixtures: ReturnType<typeof consumingFixture>[] = [];
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await tick();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  fixtures.splice(0).forEach(f => f.close());
});
async function rig(over: { binding?: VpsMcpBinding | null; pingMs?: number; spawnFail?: boolean } = {}) {
  const f = consumingFixture(); fixtures.push(f);
  const caps = new InternalCapabilities(), generation = f.binding.identity.dispatchGeneration;
  caps.begin("B", "T", generation);
  const token = caps.mint({ botId: "B", threadId: "T", generation, kind: "computer", depth: 0, skillAuthoring: false });
  const agentsToken = caps.mint({ botId: "B", threadId: "T", generation, kind: "agents", depth: 0, skillAuthoring: false });
  caps.begin("other", "other", "other");
  const otherToken = caps.mint({ botId: "other", threadId: "other", generation: "other", kind: "computer", depth: 0, skillAuthoring: false });
  const binding = bindConsumingTurn({ ...f.binding, isCurrent: () => f.binding.isCurrent() && caps.activeGeneration("T") === generation });
  const downstream = createConsumingIngress(binding, "fixture-child");
  let container = over.binding === undefined ? { alias: ALIAS, container: CONTAINER } : over.binding;
  const children: FakeChild[] = [], spawned: Array<{ command: string; args: string[] }> = [], logs: string[] = [];
  const handler = createVpsMcpRelay({
    resolveClaim: header => caps.resolve(header), isActive: claim => caps.isActive(claim), boundContainer: () => container,
    admit: claim => claim.botId === "B" && container ? { binding, downstream, instanceId: "fixture-relay", container } : undefined,
    spawn: (command, args) => { if (over.spawnFail) throw new Error(`private ${ALIAS} ${token}`); const child = new FakeChild(); children.push(child); spawned.push({ command, args }); return child as unknown as VpsMcpChild; },
    log: line => logs.push(line), pingMs: over.pingMs ?? 30, killGraceMs: 10,
  });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => { void handler(req, socket, head, new URL(req.url ?? "/", "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const connect = (credential: string | null, path = VPS_MCP_RELAY_PATH) => new Promise<{ ws: WebSocket; status?: number }>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} }); sockets.push(ws);
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => { res.resume(); resolve({ ws, status: res.statusCode }); });
    ws.once("error", () => resolve({ ws, status: 0 }));
  });
  return { f, caps, token, agentsToken, otherToken, children, spawned, logs, connect, setBinding: (value: VpsMcpBinding | null) => { container = value; } };
}
const nextMessage = (ws: WebSocket) => new Promise<string>(resolve => ws.once("message", data => resolve(data.toString())));
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>(resolve => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
const request = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
const response = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, result: {} });
// control migration: complete JSON-RPC frames now carry request ids known to the bound ingress.
it("bridges JSON-RPC lines both ways using docker argv", async () => {
  const t = await rig(), { ws } = await t.connect(t.token);
  expect(t.spawned[0]!.command).toBe("docker"); expect(t.spawned[0]!.args.slice(0, 2)).toEqual(["-H", `ssh://${ALIAS}`]); expect(t.spawned[0]!.args).toContain(CONTAINER);
  ws.send(request(1)); await tick(); expect(t.children[0]!.written).toEqual([request(1) + "\n"]);
  const got = nextMessage(ws), line = response(1);
  t.children[0]!.stdout.write(line.slice(0, 12)); t.children[0]!.stdout.write(line.slice(12) + "\n"); expect(await got).toBe(line);
  ws.send(request(2)); await tick(); const next = nextMessage(ws); t.children[0]!.stdout.write(response(2) + "\n"); expect(await next).toBe(response(2));
});
// red-at-4df086541: fixed no-content denial replaces route/status diagnostics.
it.each(["missing", "invalid", "wrong-kind", "other-bot", "wrong-path", "unbound"])("refuses %s without leaking anything", async mode => {
  const t = await rig(); if (mode === "unbound") t.setBinding(null);
  const credential = mode === "missing" ? null : mode === "invalid" ? "nope" : mode === "wrong-kind" ? t.agentsToken : mode === "other-bot" ? t.otherToken : t.token;
  expect((await t.connect(credential, mode === "wrong-path" ? VPS_MCP_RELAY_PATH + "/extra" : VPS_MCP_RELAY_PATH)).status).toBe(409);
  expect(t.spawned).toHaveLength(0); expect(t.logs.join()).not.toContain(ALIAS); expect(t.logs.join()).not.toContain(t.token);
});
// red-at-4df086541: replacing a live connection is no longer a way to retarget a lease.
it("a second connection cannot steal the first connection's generation", async () => {
  const t = await rig(), first = (await t.connect(t.token)).ws, done = closed(first);
  expect((await t.connect(t.token)).status).toBe(409); expect((await done).code).toBe(1008);
  expect(t.children).toHaveLength(1); expect(t.children[0]!.killed).toContain("SIGTERM"); expect(t.f.refusals).toBe(1);
});
// red-at-4df086541: socket EOF and child exit seal before any subsequent content.
it.each(["socket", "child"])("kills and seals on %s closure", async mode => {
  const t = await rig(), { ws } = await t.connect(t.token), done = closed(ws);
  if (mode === "socket") ws.close(); else t.children[0]!.emit("exit", 0);
  await done; await tick(); expect(t.children[0]!.killed).toContain("SIGTERM"); expect(t.f.refusals).toBe(1);
});
// red-at-4df086541: malformed input and overflow were bound terminal failures (superseded below by cause22-no-transport-caps).
// MAIN-RULING cause22-no-transport-caps (2026-11-22T14:29:39Z): "NO transport size or count caps at all ... DELETE MAX_REQUEST_BYTES ..."; the
// relay's 8 MiB message/line cap is deleted, so "oversize-input" and "oversize-output" no longer close (cause22-cli-caps-witness-1021 V1/V2).
// The same ruling: "Keep all error handling, so a malformed line still gets a JSON-RPC error and the hop lives" (was: closes on %s).
it.each(["binary", "multiline"])("answers %s with a JSON-RPC error and stays open", async mode => {
  const t = await rig(), { ws } = await t.connect(t.token), answer = nextMessage(ws);
  if (mode === "binary") ws.send(Buffer.from([1, 2, 3]), { binary: true });
  if (mode === "multiline") ws.send("{}\n{}");
  expect(JSON.parse(await answer).error.code).toBe(-32700);
  expect(ws.readyState).toBe(WebSocket.OPEN); expect(t.children[0]!.killed).toEqual([]); expect(t.f.refusals).toBe(0);
});
// control migration: ping/pong stays context-free, but generation liveness is additional authority.
it("pings when idle and ends a relay whose turn is gone", async () => {
  const t = await rig(), { ws } = await t.connect(t.token);
  await new Promise<void>(resolve => ws.once("ping", () => resolve())); const done = closed(ws); t.caps.revokeBot("B");
  expect((await done).code).toBe(1008); expect(t.children[0]!.killed).toContain("SIGTERM");
});
// red-at-4df086541: failure text is fixed; private spawn errors never become tool content.
it("sends no host, alias or token when spawn fails", async () => {
  const t = await rig({ spawnFail: true }), { ws } = await t.connect(t.token);
  const result = await closed(ws); expect(result.reason).toBe(LEDGER_REFUSAL_LINE); expect(t.f.refusals).toBe(1);
  expect(t.logs.join()).not.toContain(ALIAS); expect(t.logs.join()).not.toContain(t.token);
});
// red-at-4df086541: exercise the real ws.send boundary, not only the frame helper.
it("T-VPS-WS-RELEASE flip-only revoke between real response frames", async () => {
  const t = await rig(), { ws } = await t.connect(t.token);
  ws.send(request(1)); await tick(); const first = nextMessage(ws); t.children[0]!.stdout.write(response(1) + "\n"); expect(await first).toBe(response(1));
  ws.send(request(2)); await tick(); t.f.flip(); const frames: string[] = []; ws.on("message", data => frames.push(data.toString())); const done = closed(ws);
  t.children[0]!.stdout.write(response(2) + "\n"); await done;
  expect(frames).toEqual([]); expect(t.f.refusals).toBe(1);
});
