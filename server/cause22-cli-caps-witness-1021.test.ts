// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MAIN-RULING cause22-no-transport-caps (2026-11-22T14:29:39Z, replaces cause22-one-rule's per-site cut answers): NO transport size
// or count caps; a large real item passes through each hop and the turn completes. Group C of MAIN cause22 SPLIT (owner: lane
// cause22-cli; group A = cause22-main-b owns cli-mount-relay.ts, the proxies and the shared helper). One row per hop class:
//   C1 drivers/chat-mcp-client.ts frame count (was :533)            real ChatMcpConnection + RelayedMount + owner ingress
//   G1 model-gateway.ts translator bounds, owner turn                real gateway on a loopback socket (20 MiB streamed event)
//   G2 model-gateway.ts error body (was a refusal past 64 KiB)       same, every turn
//   G3 model-gateway.ts engine request body (was 400 past 64 MiB)    same, every turn
//   V1 cloud-home/vps-mcp-relay.ts child line (was 8 MiB)            real relay, real WebSocket upgrade
//   V2 cloud-home/vps-mcp-relay.ts engine message (was 8 MiB)        same
//   V3 consuming-turn-ingress.ts calls in flight (was 4096 -> seal, :107/:166)   through the VPS relay
//   V4 consuming-turn-ingress.ts server requests in flight (was 4096 -> seal, :193)   through the VPS relay
//   R1-R5 cloud-home/vps-mcp-relay.ts malformed input ("a malformed line still gets a JSON-RPC error and the hop lives")   same relay
//   R6 cloud-home/vps-mcp-relay.ts a malformed reply to a call in flight is answered for that call (Astra precheck High on 4beedd241c)
//   B1-B2 cloud-home/vps-mcp-relay.ts backpressure (a frame still queued in either direction ended the relay)   same relay
//   V5-V6 cloud-home/vps-relay-mcp.ts the turn-side client (was 8 MiB maxPayload :48 and stdin line :91)   the REAL client, spawned
//   D1-D2 turn-release-door.ts:46 + consuming-turn-ingress.ts verdict/reserveUpstream + mcp-mounts.ts:160 accept   real door, real mount
//   G4-G5 model-gateway.ts collected (not streamed) answer: collectResponse :372 and the parser :367   real gateway
// Only the tool server and the model provider are stand-ins. On c187b11166 each row fails at its behavioral assertion.
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { createConsumingIngress, createProxyReleaseAuthority, frameDigest } from "./consuming-turn-ingress.ts";
import { bindConsumingTurn } from "./consuming-turn-response.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { admittedMcpMount, createMcpMountAdmission } from "./drivers/mcp-mounts.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { denyConsumingHttp } from "./consuming-turn-response.ts";
import { readBody } from "./read-body.ts";
import { ModelSignIns } from "./model-signin.ts";
import { gatewayBaseUrl, handleModelGateway } from "./model-gateway.ts";
import { issueGatewayTurnCredential, revokeGatewayTurnCredentials } from "./model-gateway-release.ts";
import type { ProviderCatalog } from "../shared/provider-connections.ts";
import type { LineageVerdict } from "./memory/lineage-types.ts";
import { VPS_MCP_RELAY_PATH, createVpsMcpRelay, type VpsMcpChild } from "./cloud-home/vps-mcp-relay.ts";

vi.mock("./procs.ts", async original => ({
  ...await original<typeof import("./procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
const { ChatMcpConnection, ChatMcpDescendants, chatMcpTeardown } = await import("./drivers/chat-mcp-client.ts");

const MIB = 1024 * 1024;
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (test: () => boolean, ms: number) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); };
const owner = (botId: string = randomUUID()) => ({ botId, continuePending: () => true, ownerTurn: true });

it("C1 chat-mcp-client.ts frame count (was :533, MAIN 18:15Z): 12,000 frames from one tool server, then every call still resolves with its reply, the third a 20 MiB one; the connection, mount and child stay up", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = consumingFixture(undefined, owner());
  cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const mount = admittedMcpMount(admission.mount({ command: "fixture-mcp", args: [], env: {} }));
  const kill = vi.fn();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough({ highWaterMark: 256 * MIB }), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn(), kill }) as unknown as ChildProcess;
  const descendants = new ChatMcpDescendants(child);
  const connection = new ChatMcpConnection("computer", child, chatMcpTeardown(child, descendants), descendants, mount);
  cleanups.push(() => connection.close());
  const ids: number[] = [];
  child.stdin!.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) { const rpc = JSON.parse(line); if (typeof rpc.id === "number") ids.push(rpc.id); } });
  const reply = (id: number, text: string) => child.stdout!.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }) + "\n"));
  const note = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) + "\n");
  for (let n = 0; n < 12_000; n++) child.stdout!.emit("data", note);
  for (const [n, text] of ["first", "second", "t".repeat(20 * MIB)].entries()) {
    const call = connection.callTool("t", {}, {}).then(result => `resolved:${result.text.length}:${result.text.slice(0, 6)}`, (error: Error) => error.message);
    await until(() => ids.length === n + 1 || connection.closed, 10_000);
    if (ids[n] !== undefined) reply(ids[n]!, text);
    const settled = await Promise.race([call, new Promise<string>(resolve => setTimeout(() => resolve("unsettled"), 5_000))]);
    expect(settled, `call ${n + 1} after 12,000 frames resolves with its own reply`).toBe(`resolved:${text.length}:${text.slice(0, 6)}`);
  }
  expect(connection.closed, "the connection stays open").toBe(false);
  expect(mount.ingress.sealed, "the mount is not sealed").toBe(false);
  expect(kill, "the tool server is not killed").not.toHaveBeenCalled();
  expect(f.refusals, "the turn is not refused").toBe(0);
}, 120_000);

const entry = (over: Record<string, unknown> = {}) => ({ provider: "chatgpt", connectionId: "signin-chatgpt", revision: "rev-1", state: "connected", accessToken: "fixture-plan-token", accountId: "fixture-account", expiresAt: Date.now() + 3_600_000, ...over });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const answer = (text: string) => [{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text }] } },
  { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }];
async function gateway(upstream: (n: number) => Response, isOwner = true) {
  const warned: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(" ").slice(0, 300)); });
  const verdicts: LineageVerdict[] = [];
  const fixture = consumingFixture(undefined, { ...(isOwner ? owner() : { botId: randomUUID() }), onRefused: verdict => { verdicts.push(verdict); } });
  const signIns = new ModelSignIns({ env: {} });
  signIns.apply({ type: "murage:model-signin", entries: [entry()] });
  const catalog = (id: string): ProviderCatalog => ({ connectionId: id, stale: false, assurance: "catalog-only", models: [] }) as unknown as ProviderCatalog;
  let calls = 0;
  const fetchStub = (async () => upstream(++calls)) as unknown as typeof fetch;
  const server: Server = createServer((req, res) => { void handleModelGateway(req, res, new URL(req.url ?? "/", "http://127.0.0.1").pathname, { signIns, catalog, fetch: fetchStub }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const key = issueGatewayTurnCredential("signin-chatgpt", fixture.binding);
  cleanups.push(async () => {
    revokeGatewayTurnCredentials(fixture.binding.identity.dispatchGeneration);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.close();
  });
  const port = (server.address() as { port: number }).port;
  const post = (route: string, body: unknown) => fetch(`${gatewayBaseUrl(port, "signin-chatgpt")}/${route}`,
    { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(res => res, () => undefined); // undefined: the gateway reset the request before any answer
  /** the whole body, or "RESET" when the stream was torn down instead of ended */
  const body = (res: Response | undefined) => res ? res.text().catch(() => "RESET") : Promise.resolve("RESET");
  return { fixture, verdicts, post, body };
}

it("G1 model-gateway.ts translator bounds: one 20 MiB event streams through the chat translation and the next request of the turn is answered", async () => {
  const big = "b".repeat(20 * MIB);
  const g = await gateway(n => n === 1 ? sse([{ type: "response.output_text.delta", delta: big }, { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }]) : sse(answer("after the big one")));
  const streamed = await g.post("chat/completions", { model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] });
  expect(streamed?.status, "the stream is answered").toBe(200);
  const text = await g.body(streamed);
  expect(text.length, "every byte of the 20 MiB event reaches the engine").toBeGreaterThan(20 * MIB);
  expect(text.endsWith("data: [DONE]\n\n"), "the stream ends cleanly").toBe(true);
  expect(g.verdicts, "the turn is not refused").toEqual([]);
  const next = await g.post("chat/completions", { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
  expect(next?.status, "the next request of the same turn is answered").toBe(200);
  expect(JSON.stringify(await next!.json())).toContain("after the big one");
}, 240_000);

it("G2 model-gateway.ts error body, any turn: a 200 KiB provider error body fails that request with the provider's status; the turn is not refused and its next request is answered", async () => {
  const g = await gateway(n => n === 1 ? new Response(JSON.stringify({ error: { message: "m".repeat(200 * 1024) } }), { status: 500, headers: { "content-type": "application/json" } })
    : sse(answer("after the error")), false);
  const failed = await g.post("responses", { model: "gpt-5.5", input: "hi" });
  expect(failed?.status, "the request fails with the provider's own status, not a refusal").toBe(500);
  expect(g.verdicts, "a large error body does not refuse the turn").toEqual([]);
  const next = await g.post("responses", { model: "gpt-5.5", input: "hi" });
  expect(next?.status, "the next request of the same turn is answered").toBe(200);
  expect(JSON.stringify(await next!.json())).toContain("after the error");
}, 120_000);

class FakeChild extends EventEmitter {
  stdin: Writable; stdout = new PassThrough(); killed: string[] = []; written: Array<{ id?: unknown; bytes: number; error?: { message?: string } }> = [];
  #tail = "";
  /** `slowStdin`: a pipe with node's default 16 KiB mark whose reader takes 300 ms per chunk (a busy docker exec), so a large write leaves
   * stdin draining for that long. */
  constructor(slowStdin = false) {
    super();
    const read = (chunk: Buffer) => {
      const lines = (this.#tail + chunk.toString("utf8")).split("\n"); this.#tail = lines.pop()!;
      for (const line of lines) { const rpc = JSON.parse(line); this.written.push({ id: rpc.id, bytes: line.length, error: rpc.error }); }
    };
    this.stdin = slowStdin ? new Writable({ write: (chunk: Buffer, _encoding, done) => { read(chunk); setTimeout(done, 300); } })
      : new PassThrough({ highWaterMark: 256 * MIB }).on("data", read);
  }
  kill(signal?: string) { this.killed.push(signal ?? "SIGTERM"); return true; }
}
/** The real VPS relay behind a real WebSocket upgrade, for one turn (not the owner's: no cap is left on any turn). */
async function vps(isOwner = false, slowStdin = false, connect = true, pingMs = 60_000) {
  const f = consumingFixture(undefined, isOwner ? owner("B") : undefined); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(), generation = f.binding.identity.dispatchGeneration;
  caps.begin("B", "T", generation);
  const token = caps.mint({ botId: "B", threadId: "T", generation, kind: "computer", depth: 0, skillAuthoring: false });
  const binding = bindConsumingTurn({ ...f.binding, isCurrent: () => f.binding.isCurrent() && caps.activeGeneration("T") === generation });
  const downstream = createConsumingIngress(binding, "fixture-child");
  const container = { alias: "fixture-alias", container: "fixture-container" };
  const children: FakeChild[] = [];
  const handler = createVpsMcpRelay({
    resolveClaim: header => caps.resolve(header), isActive: claim => caps.isActive(claim), boundContainer: () => container,
    admit: claim => claim.botId === "B" ? { binding, downstream, instanceId: "fixture-relay", container } : undefined,
    spawn: () => { const child = new FakeChild(slowStdin); children.push(child); return child as unknown as VpsMcpChild; },
    log: () => {}, pingMs, killGraceMs: 10,
  });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => { void handler(req, socket, head, new URL(req.url ?? "/", "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // connect=false: the test's own socket is not opened (the spawned client of V5/V6 is the only one, so it is children[0])
  const ws = new WebSocket(connect ? `ws://127.0.0.1:${port}${VPS_MCP_RELAY_PATH}` : "ws://127.0.0.1:1", { headers: { authorization: `Bearer ${token}` }, maxPayload: 256 * MIB });
  cleanups.push(async () => { ws.terminate(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let closed: number | undefined;
  ws.on("close", code => { closed = connect ? code : closed; }); ws.on("error", () => {});
  if (connect) await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("unexpected-response", () => reject(new Error("refused"))); });
  const received: Array<{ id?: unknown; error?: { message?: string; code?: number }; bytes: number; method?: string }> = [];
  ws.on("message", data => { const text = data.toString(); const rpc = JSON.parse(text); received.push({ id: rpc.id, error: rpc.error, bytes: text.length, method: rpc.method }); });
  const call = (id: number, text = "") => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "computer", arguments: { text } } }));
  const reply = (id: number, bytes: number) => {
    const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "s".repeat(bytes) }] } }) + "\n");
    for (let at = 0; at < line.length; at += 64 * 1024) children[0]!.stdout.write(line.subarray(at, at + 64 * 1024));
  };
  const got = (id: unknown) => until(() => received.some(entry => entry.id === id) || closed !== undefined, 60_000).then(() => received.find(entry => entry.id === id));
  const forwarded = (id: number) => until(() => children[0]?.written.some(entry => entry.id === id) || closed !== undefined, 60_000).then(() => children[0]?.written.find(entry => entry.id === id));
  return { f, ws, children, received, call, reply, got, forwarded, token, port, get closed() { return closed; } };
}

it("V1 vps-mcp-relay.ts child line: a 20 MiB reply reaches the turn whole; socket and child stay up and the next call goes through", async () => {
  const v = await vps();
  v.call(1); expect((await v.forwarded(1))?.id).toBe(1);
  v.reply(1, 20 * MIB);
  const big = await v.got(1);
  expect(v.closed, "the socket is not closed by the large reply").toBeUndefined();
  expect(big?.bytes ?? 0, "the 20 MiB reply is delivered whole").toBeGreaterThan(20 * MIB);
  expect(v.children[0]!.killed, "the tool server is not stopped").toEqual([]);
  v.call(2); expect((await v.forwarded(2))?.id, "the next call reaches the same tool server").toBe(2);
  v.reply(2, 16);
  expect((await v.got(2))?.error, "and its reply is delivered").toBeUndefined();
  expect(v.f.refusals, "the turn is not refused").toBe(0);
}, 240_000);

// The owner's turn: a 20 MiB engine message is charged to the turn's release budget, which only the owner's turn keeps (local-memory-budget).
it("V2 vps-mcp-relay.ts engine message, owner turn: a 20 MiB call reaches the tool server whole and its reply comes back; the next call goes through", async () => {
  const v = await vps(true);
  v.call(1, "a".repeat(20 * MIB));
  const sent = await v.forwarded(1);
  expect(v.closed, "the socket is not closed by the large call").toBeUndefined();
  expect(sent?.bytes ?? 0, "the whole 20 MiB call reached the tool server").toBeGreaterThan(20 * MIB);
  v.reply(1, 16);
  expect((await v.got(1))?.error, "its reply is delivered").toBeUndefined();
  v.call(2); expect((await v.forwarded(2))?.id, "the next call reaches the same tool server").toBe(2);
  expect(v.f.refusals).toBe(0);
}, 240_000);

it("V3 consuming-turn-ingress.ts calls in flight (:107/:166): 5,000 calls in flight all reach the tool server; nothing is sealed and each is answered", async () => {
  const v = await vps();
  for (let id = 1; id <= 5000; id++) v.call(id);
  await until(() => (v.children[0]?.written.length ?? 0) >= 5000 || v.closed !== undefined, 60_000);
  expect(v.closed, "the socket is not closed by the count").toBeUndefined();
  expect(v.children[0]!.written.length, "all 5,000 calls reach the tool server").toBe(5000);
  v.reply(5000, 16);
  expect((await v.got(5000))?.error, "the last call is answered").toBeUndefined();
  expect(v.f.refusals).toBe(0);
}, 240_000);

it("V4 consuming-turn-ingress.ts server requests in flight (:193): 5,000 requests from the tool server all reach the turn; the next call goes through", async () => {
  const v = await vps();
  for (let n = 1; n <= 5000; n++) v.children[0]!.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: `s${n}`, method: "ping" }) + "\n");
  await until(() => v.received.length >= 5000 || v.closed !== undefined, 60_000);
  expect(v.closed, "the socket is not closed by the count").toBeUndefined();
  expect(v.received.length, "all 5,000 server requests reach the turn").toBe(5000);
  v.call(1); expect((await v.forwarded(1))?.id, "the next call reaches the same tool server").toBe(1);
  v.reply(1, 16);
  expect((await v.got(1))?.error, "and its reply is delivered").toBeUndefined();
  expect(v.f.refusals).toBe(0);
}, 240_000);

it("G3 model-gateway.ts engine request body, owner turn (the release budget charges it): a 70 MiB request (the whole conversation) is read and answered; the turn goes on", async () => {
  const g = await gateway(() => sse(answer("read it all")));
  const big = await g.post("responses", { model: "gpt-5.5", input: "c".repeat(70 * MIB) });
  expect(big?.status, "a request over 64 MiB is answered, never a 400").toBe(200);
  expect(JSON.stringify(await big!.json())).toContain("read it all");
  expect(g.verdicts, "the turn is not refused").toEqual([]);
}, 240_000);

// MAIN-RULING cause22-no-transport-caps: "Keep all error handling, so a malformed line still gets a JSON-RPC error and the hop lives".
// One row per malformed-input site of the relay (SITES.md R1-R5); each enters through the real WebSocket / child stdout.
const malformed: Array<[string, (v: Awaited<ReturnType<typeof vps>>) => void, { id: unknown; code: number } | "dropped"]> = [
  ["R1 a binary message", v => v.ws.send(Buffer.from([1, 2, 3]), { binary: true }), { id: null, code: -32700 }],
  ["R2 a message that is not JSON", v => v.ws.send("{not json"), { id: null, code: -32700 }],
  ["R3 a message holding a raw line break", v => v.ws.send(`{"jsonrpc":"2.0",\n"id":7,"method":"tools/list"}`), { id: 7, code: -32600 }],
  ["R4 JSON that is not one JSON-RPC frame", v => v.ws.send(JSON.stringify({ id: 8, method: "tools/list" })), { id: 8, code: -32600 }],
  ["R5 a malformed line from the tool server", v => v.children[0]!.stdout.write("not json from the tool server\n"), "dropped"],
];
it.each(malformed)("%s: answered with a JSON-RPC error (from the tool server: dropped); the relay lives and the next call is answered", async (site, send, expected) => {
  const v = await vps();
  send(v);
  if (expected === "dropped") {
    v.call(1); expect((await v.forwarded(1))?.id, `${site}: the call after the malformed line reaches the same tool server`).toBe(1);
  } else {
    const answer = await v.got(expected.id);
    expect(answer?.error?.code, `${site}: the malformed message is answered with a JSON-RPC error`).toBe(expected.code);
    v.call(1); expect((await v.forwarded(1))?.id, `${site}: the next call reaches the same tool server`).toBe(1);
  }
  v.reply(1, 16);
  const reply = await v.got(1);
  expect(reply && !reply.error ? reply.id : reply, `${site}: and its reply is delivered`).toBe(1);
  expect(v.closed, "the socket stays open").toBeUndefined();
  expect(v.children[0]!.killed, "the tool server is not stopped").toEqual([]);
  expect(v.children[0]!.written.map(entry => entry.id), `${site}: only the well-formed call reached the tool server`).toEqual([1]);
  expect(v.f.refusals, "the turn is not refused").toBe(0);
}, 120_000);

it("B1 vps-mcp-relay.ts socket backpressure: an 8 MiB reply and a server request read in one chunk both reach the turn; the relay lives", async () => {
  const v = await vps();
  v.call(1); expect((await v.forwarded(1))?.id).toBe(1);
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "s".repeat(8 * MIB) }] } });
  v.children[0]!.stdout.write(Buffer.from(`${big}\n${JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "ping" })}\n`));
  const ping = await v.got("s1");
  expect(ping?.method, "the request behind a frame still being sent reaches the turn").toBe("ping");
  expect((await v.got(1))?.bytes ?? 0, "the 8 MiB reply is delivered whole").toBeGreaterThan(8 * MIB);
  expect(v.closed, "the socket stays open").toBeUndefined();
  expect(v.f.refusals, "the turn is not refused").toBe(0);
}, 120_000);

it("B2 vps-mcp-relay.ts child stdin backpressure: a call sent while a 256 KiB call is still draining into the tool server reaches it; the relay lives", async () => {
  const v = await vps(false, true);
  v.call(1, "a".repeat(256 * 1024)); v.call(2);
  const second = await v.forwarded(2);
  expect(second?.id, "the call behind a draining write reaches the tool server").toBe(2);
  expect(v.children[0]!.written.map(entry => entry.id), "both calls, in order").toEqual([1, 2]);
  v.reply(2, 16);
  const reply = await v.got(2);
  expect(reply && !reply.error ? reply.id : reply, "and its reply is delivered").toBe(2);
  expect(v.closed, "the socket stays open").toBeUndefined();
  expect(v.f.refusals, "the turn is not refused").toBe(0);
}, 120_000);

// Malformed replies that still name the call: no "jsonrpc", and a "method" member that is not a request's (Astra precheck pass 2).
const malformedReplies: Array<[string, Record<string, unknown>]> = [
  ["R6 no jsonrpc", { id: 1, result: { content: [] } }],
  ["R6b a method member that is not a request's", { jsonrpc: "2.0", id: 1, result: {}, method: null }],
  ["R6c a result next to a request's method", { jsonrpc: "2.0", id: 1, result: {}, method: "tools/call" }],
];
it.each(malformedReplies)("%s: vps-mcp-relay.ts a malformed reply to a call in flight gets that call a JSON-RPC error (not left pending); the relay lives and the next call is answered", async (row, malformedReply) => {
  const v = await vps();
  v.call(1); expect((await v.forwarded(1))?.id).toBe(1);
  v.children[0]!.stdout.write(JSON.stringify(malformedReply) + "\n");
  const answer = await v.got(1);
  expect(answer?.error?.code, `${row}: the call the malformed reply was meant for is answered with a JSON-RPC error`).toBe(-32603);
  v.call(2); expect((await v.forwarded(2))?.id, "the next call reaches the same tool server").toBe(2);
  v.reply(2, 16);
  const reply = await v.got(2);
  expect(reply && !reply.error ? reply.id : reply, "and its reply is delivered").toBe(2);
  expect(v.closed, "the socket stays open").toBeUndefined();
  expect(v.f.refusals, "the turn is not refused").toBe(0);
}, 120_000);

// Astra ffbc0af7af High 1: the turn-side client the own-server mount launches (index.ts:17445 SPAWNED_PROXIES.vpsRelayMcp; runMcpBridge
// spawns this same file with "pipe", vps-relay-mcp.ts:41) is spawned for real and dialled into the real relay with the turn's token.
async function vpsClient(isOwner = false) {
  const v = await vps(isOwner, false, false);
  const client = spawn(process.execPath, [SPAWNED_PROXIES.vpsRelayMcp, "pipe"], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MURAGE_CONTROL_URL: `http://127.0.0.1:${v.port}`, MURAGE_CONTROL_TOKEN: v.token } });
  cleanups.push(() => { if (client.exitCode === null) client.kill("SIGKILL"); });
  let exited: number | null | undefined;
  client.on("exit", code => { exited = code; });
  client.stderr!.resume(); client.stdin!.on("error", () => {}); // a client that ended (the base) closes its stdin under the write
  const lines: Array<{ id?: unknown; error?: unknown; bytes: number }> = [];
  let tail: Buffer[] = [];
  client.stdout!.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let end; (end = chunk.indexOf(10, start)) >= 0; start = end + 1) {
      const text = Buffer.concat([...tail, chunk.subarray(start, end)]).toString("utf8"); tail = [];
      const rpc = JSON.parse(text); lines.push({ id: rpc.id, error: rpc.error, bytes: text.length });
    }
    if (start < chunk.length) tail.push(chunk.subarray(start));
  });
  await until(() => v.children.length > 0 || exited !== undefined, 30_000);
  expect(v.children.length, "the spawned client opened the relay").toBe(1);
  const send = (id: number, text = "") => client.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "computer", arguments: { text } } }) + "\n");
  const out = (id: unknown) => until(() => lines.some(line => line.id === id) || exited !== undefined, 60_000).then(() => lines.find(line => line.id === id));
  return { ...v, client, send, out, get exited() { return exited; } };
}

it("V5 vps-relay-mcp.ts client (was maxPayload 8 MiB, :48): a 20 MiB reply reaches the engine side of the spawned client whole; the client lives and the next call is answered", async () => {
  const c = await vpsClient();
  c.send(1); expect((await c.forwarded(1))?.id).toBe(1);
  c.reply(1, 20 * MIB);
  const big = await c.out(1);
  expect(big?.bytes ?? 0, "the 20 MiB reply reaches the engine through the client whole").toBeGreaterThan(20 * MIB);
  expect(c.exited, "the client did not end").toBeUndefined();
  c.send(2); expect((await c.forwarded(2))?.id, "the next call reaches the same tool server").toBe(2);
  c.reply(2, 16);
  expect((await c.out(2))?.error, "and its reply is delivered").toBeUndefined();
  expect(c.f.refusals, "the turn is not refused").toBe(0);
}, 240_000);

it("V6 vps-relay-mcp.ts client stdin (was an 8 MiB partial line, :91), owner turn: a 20 MiB call from the engine reaches the tool server whole; the client lives", async () => {
  const c = await vpsClient(true);
  c.send(1, "a".repeat(20 * MIB));
  const sent = await c.forwarded(1);
  expect(sent?.bytes ?? 0, "the whole 20 MiB call reached the tool server").toBeGreaterThan(20 * MIB);
  expect(c.exited, "the client did not end").toBeUndefined();
  c.reply(1, 16);
  expect((await c.out(1))?.error, "its reply is delivered").toBeUndefined();
  expect(c.f.refusals).toBe(0);
}, 240_000);

// Astra ffbc0af7af High 2a: the authenticated release door. The door is the handler index.ts runs (turn-release-door.ts; c187b11166 has
// it inline in index.ts, so `baseDoor` is that code there and is used only when the module does not exist). D2 runs on a turn that
// is not the owner's, D1 on the owner's (other turns keep the door's body limit). The engine's call is registered as the mount relay forwards it; the envelope is accepted by the real
// mcp-mounts.ts accept (decodeReleaseEnvelope + fenced delivery), as the relay does with the child's printed line.
type DoorPorts = { capabilities: InternalCapabilities; authority: ReturnType<typeof createProxyReleaseAuthority>; json: (res: import("node:http").ServerResponse, status: number, body: unknown) => void };
type Door = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, ports: DoorPorts) => Promise<void>;
const baseDoor: Door = async (req, res, { capabilities, authority, json }) => {
  const claim = capabilities.resolve(req.headers.authorization);
  if (req.method !== "POST" || !claim || !capabilities.releaseControl(claim)) { if (claim) authority.seal(claim); return denyConsumingHttp(res); }
  try {
    const body = await readBody(req, 16 * 1024 * 1024 + 1024);
    if (body && typeof body === "object" && (body as { operation?: unknown }).operation === "upstream") { authority.reserveUpstream(claim, body); return json(res, 200, { reserved: true }); }
    return json(res, 200, authority.verdict(claim, body));
  } catch (error) { authority.seal(claim); return denyConsumingHttp(res, undefined, error); }
};
const releaseDoor: Door = await import("./turn-release-door.ts").then(module => module.handleTurnReleaseDoor as Door, () => baseDoor);
async function door(isOwner = false) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = consumingFixture(undefined, isOwner ? owner() : { botId: randomUUID() }); cleanups.push(() => f.close());
  const capabilities = new InternalCapabilities(); capabilities.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities);
  const server = createServer((req, res) => { void releaseDoor(req, res, { capabilities, authority, json: (r, status, body) => {
    r.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); r.end(JSON.stringify(body)); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admission = createMcpMountAdmission(f.binding, authority, url);
  cleanups.push(() => admission.dispose());
  const entry = admission.mount({ command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} }) as { env: Record<string, string> };
  const mount = admittedMcpMount(entry);
  const instanceId = entry.env.MURAGE_RELEASE_INSTANCE!, token = entry.env.MURAGE_RELEASE_TOKEN!;
  const post = (body: unknown) => fetch(`${url}/api/internal/turn-release/v1/verdict`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then(async res => ({ status: res.status, body: await res.text() }), () => ({ status: 0, body: "RESET" }));
  let sequence = 0;
  /** The child's verdict request for `frame` (proxy-turn-release.ts:161), then the mount relay's acceptance of the envelope it gets. */
  const release = async (frame: string, requestId: number | null) => {
    const answered = await post({ instanceId, sequence: ++sequence, descriptor: "proxy:memory:frame", requestId, bytes: Buffer.byteLength(frame), digest: frameDigest(frame), frame });
    if (answered.status !== 200) return { status: answered.status, delivered: undefined as string | undefined };
    let delivered: string | undefined;
    try { mount.accept(answered.body, written => { delivered = written; }); } catch (error) { return { status: 200, accept: (error as Error).message, delivered }; }
    return { status: 200, delivered };
  };
  const call = (id: number) => mount.ingress.request(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {} }), () => {});
  const result = (id: number, bytes: number) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "d".repeat(bytes) }] } });
  return { f, mount, post, release, call, result, instanceId };
}

// D1 is the owner's turn: a turn that is not the owner's keeps the door's 16 MiB + 1024 limit (MAIN 2026-11-22T20:25:47Z item 3, group A;
// witnessed by cause22-owner-caps-proxy-1021.test.ts D2), so a 20 MiB reply is read whole only on the owner's turn.
it("D1 turn-release-door.ts:46 verdict, owner turn: a 20 MiB reply is read by the door, issued, and accepted by the mount; the engine gets it whole and the next reply follows", async () => {
  const d = await door(true);
  d.call(1); d.call(2);
  const big = await d.release(d.result(1, 20 * MIB), 1);
  expect(big.status, "the door answers the 20 MiB verdict request with its envelope").toBe(200);
  expect(big.delivered?.length ?? 0, "the mount accepted the envelope and the engine got every byte").toBeGreaterThan(20 * MIB);
  expect(d.mount.ingress.sealed, "the mount is not sealed").toBe(false);
  const next = await d.release(d.result(2, 16), 2);
  expect(next.delivered, "the next reply of the same mount follows").toBe(d.result(2, 16));
  expect(d.f.refusals, "the turn is not refused").toBe(0);
}, 240_000);

it("D2 turn-release-door.ts upstream reservation (was the 8 MiB item cap, consuming-turn-ingress.ts reserveUpstream), any turn: a 12 MiB read is reserved at the door; the mount lives and its reply follows", async () => {
  const d = await door();
  d.call(1);
  const reserved = await d.post({ operation: "upstream", instanceId: d.instanceId, bytes: 12 * MIB });
  expect(reserved.status, "the door reserves a 12 MiB upstream read").toBe(200);
  expect(reserved.body).toBe(JSON.stringify({ reserved: true }));
  expect(d.mount.ingress.sealed, "the mount is not sealed").toBe(false);
  const next = await d.release(d.result(1, 16), 1);
  expect(next.delivered, "the reply after the read is released").toBe(d.result(1, 16));
  expect(d.f.refusals, "the turn is not refused").toBe(0);
}, 120_000);

// Astra ffbc0af7af High 2b: the gateway's collected answer (the engine did not ask for a stream). The
// owner's turn: every other turn is still refused by the release budget's upstream reader (memory/upstream-reader.ts:53/:60, 8 MiB
// collected body / 1 MiB event; OPEN NO-OWNER since round 1, owners cause22-mountbudget), which sits in front of these two sites.
// On c187b11166 the gateway applied its 1 MiB parser and 8 MiB collection bounds to the owner's turn too.
it("G4 model-gateway.ts collectResponse (:372), owner turn: forty 512 KiB answer items (20 MiB) are collected into one chat completion; the next request is answered", async () => {
  const items = Array.from({ length: 40 }, (_, n) => ({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: String(n % 10).repeat(512 * 1024) }] } }));
  const g = await gateway(n => n === 1 ? sse([...items, { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }]) : sse(answer("after the big one")));
  const collected = await g.post("chat/completions", { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
  expect(collected?.status, "the collected answer is sent").toBe(200);
  const content = (await collected!.json() as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
  expect(content?.length ?? 0, "every byte of the 20 MiB answer reaches the engine").toBe(40 * 512 * 1024);
  expect(g.verdicts, "the turn is not refused").toEqual([]);
  const next = await g.post("chat/completions", { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
  expect(next?.status, "the next request of the same turn is answered").toBe(200);
  expect(JSON.stringify(await next!.json())).toContain("after the big one");
}, 240_000);

it("G5 model-gateway.ts collected answer's event parser (:367), owner turn: one 20 MiB answer event is collected whole; the next request is answered", async () => {
  const g = await gateway(n => n === 1 ? sse(answer("e".repeat(20 * MIB))) : sse(answer("after the big one")));
  const collected = await g.post("responses", { model: "gpt-5.5", input: "hi" });
  expect(collected?.status, "the collected answer is sent").toBe(200);
  expect((await g.body(collected)).length, "every byte of the 20 MiB event reaches the engine").toBeGreaterThan(20 * MIB);
  expect(g.verdicts, "the turn is not refused").toEqual([]);
  const next = await g.post("responses", { model: "gpt-5.5", input: "hi" });
  expect(next?.status, "the next request of the same turn is answered").toBe(200);
  expect(JSON.stringify(await next!.json())).toContain("after the big one");
}, 240_000);

// ---- Round 4 (ASTRA a0604a605a High 2; same ruling). The heartbeat (vps-mcp-relay.ts ping interval) ended the relay when the pong of its
// last ping had not come back, though that ping can still be queued behind data the turn has not read yet: in ws (B3, 48 MiB queued) or
// in the kernel's socket buffers (B4, 64 KiB; ws.bufferedAmount is 0 there). The turn's own socket is paused for five heartbeats, as a
// slow engine does; nothing else about the turn changes, so the relay must live and deliver everything once the turn reads again.
const busy = async (v: Awaited<ReturnType<typeof vps>>, notifications: number, bytes: number) => {
  v.call(1); expect((await v.forwarded(1))?.id).toBe(1);
  const socket = (v.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  socket.pause();
  for (let n = 1; n <= notifications; n++) v.children[0]!.stdout.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "n".repeat(bytes) } }) + "\n"));
  await new Promise(resolve => setTimeout(resolve, 100)); expect(v.closed, "before any heartbeat: the relay lives while data waits unread (c187b11166 ended it here on ws.bufferedAmount)").toBeUndefined(); await new Promise(resolve => setTimeout(resolve, 650)); v.reply(1, 16); // then the reply comes while a ping waits for its pong
  await new Promise(resolve => setTimeout(resolve, 750)); // five 300 ms heartbeats in all, none answered: the turn does not read
  socket.resume();
  await until(() => (v.received.some(entry => entry.id === 1) && v.received.filter(entry => entry.method === "notifications/message").length === notifications) || v.closed !== undefined, 60_000);
  await new Promise(resolve => setTimeout(resolve, 1_000)); // three more heartbeats, now answered
};
it("B3 vps-mcp-relay.ts heartbeat behind 48 MiB queued in ws: a turn that does not read for five heartbeats is not ended; everything queued arrives once it reads", async () => {
  const v = await vps(false, false, true, 300);
  await busy(v, 12, 4 * MIB);
  expect(v.closed, "the relay is not ended while its ping waits behind data the turn has not read").toBeUndefined();
  expect(((found) => [found?.id, found?.error])(v.received.find(entry => entry.id === 1)), "the reply queued behind 48 MiB is delivered").toEqual([1, undefined]);
  expect(v.received.filter(entry => entry.method === "notifications/message" && entry.bytes > 4 * MIB).length, "all 12 messages arrived whole").toBe(12);
  v.call(2); expect((await v.forwarded(2))?.id, "the next call reaches the tool server").toBe(2); v.reply(2, 16);
  expect(((found) => [found?.id, found?.error])(await v.got(2)), "the next call is answered").toEqual([2, undefined]);
  expect(v.children[0]!.killed, "the tool server is not stopped").toEqual([]);
  expect(v.f.refusals, "the turn is not refused").toBe(0);
}, 240_000);
it("B4 vps-mcp-relay.ts heartbeat behind data queued in the kernel (ws.bufferedAmount 0): a turn that does not read for five heartbeats is not ended; its reply arrives once it reads", async () => {
  const v = await vps(false, false, true, 300);
  await busy(v, 1, 64 * 1024);
  expect(v.closed, "the relay is not ended while its ping waits unread in the socket").toBeUndefined();
  expect(((found) => [found?.id, found?.error])(v.received.find(entry => entry.id === 1)), "the reply is delivered").toEqual([1, undefined]);
  v.call(2); expect((await v.forwarded(2))?.id, "the next call reaches the tool server").toBe(2); v.reply(2, 16);
  expect(((found) => [found?.id, found?.error])(await v.got(2)), "the next call is answered").toEqual([2, undefined]);
  expect(v.children[0]!.killed, "the tool server is not stopped").toEqual([]);
  expect(v.f.refusals, "the turn is not refused").toBe(0);
}, 240_000);

// D3 (ASTRA a0604a605a High 1, MAIN 18:5xZ item 1): the release envelope line's own size check (decodeReleaseEnvelope, was
// UPSTREAM_COLLECTION_MAX * 2 + 1024 on c187b11166, deleted in round 1). D1 cannot show it on a base: there the door and the frame check
// refuse a 20 MiB reply first. Here the reply is 3 MiB (under every base limit, so the real door issues it on c187b11166 too) and the
// line the mount reads is the same envelope with the reply's text written as \u escapes: 18 MiB of valid JSON naming the same frame.
// drivers/mcp-mounts.ts accept takes any valid JSON line; the shipped proxy prints plain JSON, so this is the decoder's own limit, alone.
it("D3 consuming-turn-ingress.ts release envelope line over 16 MiB + 1024 around a 3 MiB reply, any turn: the door issues it, the 18 MiB line is accepted by the mount and the reply delivered whole; the next reply follows", async () => {
  const d = await door();
  d.call(1); d.call(2);
  const frame = d.result(1, 3 * MIB);
  const answered = await d.post({ instanceId: d.instanceId, sequence: 1, descriptor: "proxy:memory:frame", requestId: 1, bytes: Buffer.byteLength(frame), digest: frameDigest(frame), frame });
  expect(answered.status, "the door issues the 3 MiB reply's envelope").toBe(200);
  const line = answered.body.replace("d".repeat(3 * MIB), "\\u0064".repeat(3 * MIB));
  expect([Buffer.byteLength(line) > 16 * MIB + 1024, JSON.parse(line).frame === frame], "the line is over 16 MiB + 1024 bytes and names the same frame").toEqual([true, true]);
  let delivered: string | undefined, refused: string | undefined;
  try { d.mount.accept(line, written => { delivered = written; }); } catch (error) { refused = (error as Error).message || "refused"; }
  expect(refused, "the line is not refused for its size").toBeUndefined();
  expect(delivered, "the reply inside it reaches the engine whole").toBe(frame);
  expect(d.mount.ingress.sealed, "the mount is not sealed").toBe(false);
  const small = d.result(2, 16), issued = await d.post({ instanceId: d.instanceId, sequence: 2, descriptor: "proxy:memory:frame", requestId: 2, bytes: Buffer.byteLength(small), digest: frameDigest(small), frame: small });
  let after: string | undefined; if (issued.status === 200) d.mount.accept(issued.body, written => { after = written; });
  expect(after, "the next reply of the same mount follows").toBe(small);
  expect(d.f.refusals, "the turn is not refused").toBe(0);
}, 240_000);
