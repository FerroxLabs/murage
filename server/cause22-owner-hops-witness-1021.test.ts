// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 cause22 WITNESS (computer-use size caps; Sean STANDING, MAIN-RULING local-memory-budget 2026-11-22T03:06Z: no local memory or
// size cap may stop, refuse, truncate or delay an owner turn). Owners: this witness belongs to lane witness-cause22; the hops it drives
// belong to the cause22 caps lanes (cause22-caps-fable, cause22-caps-opus), as listed in cause22-caps-fable/CAPS-INVENTORY.md.
// One table: a 20 MiB screenshot-sized tool result is pushed through EVERY owner-turn hop that ended the turn (or sealed its mount) on
// c187b11166. Each row FAILS when that hop ends the turn: the turn refused, the mount sealed (terminal refusal / relay failed), or the
// next call of the same turn not answered. Each row asserts its own "not ended" line, so a receipt names the hop.
//
// Real code on every hop: a REAL spawned child running the real proxy-turn-release.ts and the real remote-mcp-proxy.ts transport
// (testing/cause22-witness-child.fixture.ts), the real release authority/ingress/fence/SQLite ledger/release budget of a bound owner
// turn, the real CliMountRelay with its unix socket, the real handleModelGateway over loopback. Stand-ins: the upstream byte sources
// (tool server, provider), the mount child process of the relay row and the CLI process. The release door's HTTP shell lives inline in
// index.ts on the base and on one racer; `door` below uses turn-release-door.ts when it exists, else the authority's own
// bodyCap/answer when it has them, else the base's inline code. All decisions stay in the authority.
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { brokerAsk, claudeReply, cleanupPermissionHops, closeReplyServers, permission } from "./testing/cause22-permission-hops.fixture.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, decodeReleaseEnvelope } from "./consuming-turn-ingress.ts";
import { denyConsumingHttp, registerConsumingDescriptor } from "./consuming-turn-response.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import * as refusalLine from "./ledger-refusal-line.ts";
import { readBody } from "./read-body.ts";
import { ModelSignIns } from "./model-signin.ts";
import { gatewayBaseUrl, handleModelGateway } from "./model-gateway.ts";
import { issueGatewayTurnCredential, revokeGatewayTurnCredentials } from "./model-gateway-release.ts";
import type { ProviderCatalog } from "../shared/provider-connections.ts";
import { createMcpMountAdmission } from "./drivers/mcp-mounts.ts";
import { createTurnCredentialStore } from "./drivers/turn-credentials.ts";
import type { LineageVerdict } from "./memory/lineage-types.ts";
import type { SendTurnInput } from "./contracts.ts";

vi.mock("./procs.ts", async original => ({
  ...await original<typeof import("./procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
vi.mock("./memory/memory-revocation.ts", async original => ({
  ...await original<typeof import("./memory/memory-revocation.ts")>(),
  wakeMemoryRevocation: () => {},
}));
const { CliMountRelay, RelayedMount } = await import("./drivers/cli-mount-relay.ts");

const MIB = 1024 * 1024, PIECE = 64 * 1024, SHOT = 20 * MIB;
const CHILD = fileURLToPath(new URL("./testing/cause22-witness-child.fixture.ts", import.meta.url));
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const closeServer = (server: Server) => () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); });
const plainJson = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
function quiet() { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); }
/** One owner turn: the turn's budget bound with the owner keep, as the index.ts binders bind an owner's direct turn. */
function ownerTurn() {
  const refusals: LineageVerdict[] = [];
  const fixture = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { refusals.push(verdict); }, continuePending: () => true });
  cleanups.push(() => fixture.close());
  return { fixture, refusals };
}

// ---- the release door (index.ts /api/internal/turn-release/v1/verdict) ---------------------------------------------------------------
type Authority = ReturnType<typeof createProxyReleaseAuthority> & {
  bodyCap?(claim: unknown): number; answer?(claim: unknown, body: unknown): { payload: unknown; ownerTurn: boolean } };
type Door = (req: IncomingMessage, res: ServerResponse, ports: { capabilities: InternalCapabilities; authority: Authority; json: typeof plainJson }) => Promise<void>;
const OWNER_TURN_HEADER = (refusalLine as Record<string, unknown>).OWNER_TURN_HEADER as string | undefined;
const inlineDoor: Door = async (req, res, { capabilities, authority, json }) => {
  const claim = capabilities.resolve(req.headers.authorization);
  if (req.method !== "POST" || !claim || !capabilities.releaseControl(claim)) { if (claim) authority.seal(claim); return denyConsumingHttp(res); }
  try {
    const body = await readBody(req, authority.bodyCap ? authority.bodyCap(claim) : 16 * 1024 * 1024 + 1024);
    if (authority.answer) {
      const answer = authority.answer(claim, body);
      if (answer.ownerTurn && OWNER_TURN_HEADER) res.setHeader(OWNER_TURN_HEADER, "1");
      return json(res, 200, answer.payload);
    }
    if (body && typeof body === "object" && (body as { operation?: unknown }).operation === "upstream") { authority.reserveUpstream(claim, body); return json(res, 200, { reserved: true }); }
    return json(res, 200, authority.verdict(claim, body));
  } catch (error) { authority.seal(claim); return denyConsumingHttp(res, undefined, error); }
};
const doorModule = "./turn-release-door.ts";
const door: Door = await import(/* @vite-ignore */ doorModule).then(module => module.handleTurnReleaseDoor as Door, () => inlineDoor);

// ---- upstream byte sources -------------------------------------------------------------------------------------------------------------
/** `/body?bytes=N` one JSON body (an MCP tools/call result whose text is N bytes); `/sse?bytes=N` one SSE event of N bytes, then one small. */
async function upstream() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const bytes = Number(url.searchParams.get("bytes") ?? 0);
    const sse = url.pathname === "/sse";
    res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
    res.write(sse ? "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"content\":[{\"type\":\"image\",\"data\":\"" : "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"content\":[{\"type\":\"image\",\"data\":\"");
    const piece = Buffer.alloc(PIECE, 0x41);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        const size = Math.min(piece.length, bytes - sent); sent += size;
        if (!res.write(piece.subarray(0, size))) { res.once("drain", pump); return; }
      }
      res.end(sse ? "\"}]}}\n\ndata: {\"done\":true}\n\n" : "\"}]}}");
    };
    res.on("error", () => {}); pump();
  });
  const port = await listen(server);
  cleanups.push(closeServer(server));
  return `http://127.0.0.1:${port}`;
}

// ---- hop rig 1: a spawned proxy child admitted to the owner's turn ---------------------------------------------------------------------
async function proxy(plan: Array<Record<string, unknown>>) {
  quiet();
  const { fixture, refusals } = ownerTurn();
  const capabilities = new InternalCapabilities(); capabilities.begin(fixture.binding.identity.botId, fixture.turn.threadId, fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities) as Authority;
  const instance = authority.register(fixture.binding, registerConsumingDescriptor("proxy:remoteMcp:frame", "body"), () => []);
  // the engine's calls the child answers, as the relay forwards them (ingress.request): id 0 is `initialize`, the last one the next call
  for (const id of [0, ...plan.filter(step => step.op === "frame").map(step => step.id as number)]) {
    instance.ingress.request(JSON.stringify({ jsonrpc: "2.0", id, method: id === 0 ? "initialize" : "tools/call", params: {} }), () => {});
  }
  const server = createServer((req, res) => { void door(req, res, { capabilities, authority, json: plainJson }); });
  const port = await listen(server);
  cleanups.push(closeServer(server));
  const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD], { stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token, MURAGE_RELEASE_URL: `http://127.0.0.1:${port}`, FIXTURE_PLAN: JSON.stringify(plan) } });
  cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const frames: Array<{ id?: number; resultBytes?: number }> = [];
  const reports: Array<Record<string, any>> = [];
  let terminal: { reason?: string } | undefined, relayRefused: string | undefined, tail: Buffer[] = [];
  child.stderr!.resume();
  child.stdout!.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end < 0) { if (start < chunk.length) tail.push(chunk.subarray(start)); break; }
      const line = Buffer.concat([...tail, chunk.subarray(start, end)]).toString("utf8"); tail = []; start = end + 1;
      try {
        // the mount relay's part (mcp-mounts.ts accept): decode at the trusted ingress, then the fenced delivery to the engine
        const ingress = instance.ingress as { ownerTurn?: boolean; ownerKept?: boolean };
        const envelope = (decodeReleaseEnvelope as (text: string, owner?: boolean) => ReturnType<typeof decodeReleaseEnvelope>)(line, ingress.ownerTurn === true || ingress.ownerKept === true);
        instance.ingress.deliver(envelope, frame => {
          const rpc = JSON.parse(frame);
          frames.push({ id: rpc.id, ...(rpc.result?.content ? { resultBytes: String(rpc.result.content[0]?.text ?? "").length } : {}) });
        });
        if (child.connected) child.send({ type: "turn-release-ack", instanceId: envelope.instanceId, sequence: envelope.sequence });
      } catch (error) { relayRefused = String((error as Error).message); child.kill("SIGKILL"); return; }
    }
  });
  await new Promise<void>(resolve => {
    child.on("message", (message: any) => {
      if (message?.type === "fixture-report") { reports.push(message); if (message.done) resolve(); }
      if (message?.type === "turn-release-terminal") terminal = message;
    });
    child.once("exit", () => resolve());
  });
  return { refusals, terminal, relayRefused, step: (index: number) => reports.find(entry => entry.step === index),
    next: frames.find(frame => frame.id === 99)?.resultBytes };
}
/** The shot, then the next call of the same turn (id 99, 64 bytes). */
const thenNext = (shot: Record<string, unknown>) => [shot, { op: "frame", id: 99, bytes: 64 }];

// ---- hop rig 2: the mount relay of the owner's CLI turn ----------------------------------------------------------------------------------
async function relayed() {
  const bound = RelayedMount.pendingWaitMs;
  RelayedMount.pendingWaitMs = 40; cleanups.push(() => { RelayedMount.pendingWaitMs = bound; });
  quiet();
  const { fixture: f, refusals } = ownerTurn();
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "take a screenshot", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" },
    releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawnChild = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough({ highWaterMark: 256 * MIB }), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { computer: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawnChild);
  cleanups.push(() => relay.finish());
  const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, pid: undefined }) as unknown as ChildProcess;
  const failed = vi.fn();
  relay.attach(cli, failed);
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: relay.ticket, server: "computer" }) + "\n");
  const engine: Array<{ id?: number; resultBytes?: number }> = [];
  let tail: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end < 0) { if (start < chunk.length) tail.push(chunk.subarray(start)); break; }
      const line = JSON.parse(Buffer.concat([...tail, chunk.subarray(start, end)]).toString("utf8")); tail = []; start = end + 1;
      engine.push({ id: line.id, ...(line.result ? { resultBytes: String(line.result.content?.[0]?.text ?? "").length } : {}) });
    }
  });
  const forwarded = new Set<number>();
  let childTail: Buffer[] = [];
  children[0]!.stdin!.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end < 0) { if (start < chunk.length) childTail.push(chunk.subarray(start)); break; }
      forwarded.add(JSON.parse(Buffer.concat([...childTail, chunk.subarray(start, end)]).toString("utf8")).id); childTail = []; start = end + 1;
    }
  });
  const child = children[0]!;
  const stopped = () => f.refusals > 0 || failed.mock.calls.length > 0;
  const call = async (id: number) => {
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "screenshot", arguments: {} } }) + "\n");
    await vi.waitFor(() => expect(forwarded.has(id) || stopped()).toBe(true), { timeout: 10_000, interval: 5 });
  };
  /** the mount child answers `id` with a result of `bytes` text, in 64 KiB pieces as a pipe delivers them */
  const answer = async (id: number, bytes: number) => {
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "s".repeat(bytes) }] } }) + "\n");
    for (let at = 0; at < frame.length; at += PIECE) child.stdout!.emit("data", frame.subarray(at, at + PIECE));
    await vi.waitFor(() => expect(engine.some(line => line.id === id) || stopped()).toBe(true), { timeout: 60_000, interval: 5 });
    return engine.find(line => line.id === id)?.resultBytes;
  };
  return { refusals, failed, call, answer, stopped, sealed: () => relay.mounts.get("computer")!.mount.ingress.sealed, finish: () => relay.finish() };
}

// ---- hop rig 3: the model gateway of the owner's turn -------------------------------------------------------------------------------------
async function gateway(first: () => Response) {
  quiet();
  const { fixture, refusals } = ownerTurn();
  const entry = (over: Record<string, unknown> = {}) => ({ provider: "chatgpt", connectionId: "signin-chatgpt", revision: "rev-1", state: "connected",
    accessToken: "fixture-plan-token", accountId: "acct-fixture", expiresAt: Date.now() + 3_600_000, ...over });
  const signIns = new ModelSignIns({ env: {} });
  signIns.apply({ type: "murage:model-signin", entries: [entry()] });
  const catalog = (id: string): ProviderCatalog => ({ connectionId: id, stale: false, assurance: "catalog-only", models: [] }) as unknown as ProviderCatalog;
  let calls = 0;
  const after = [{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "the next answer" }] } },
    { type: "response.completed", response: { id: "resp_next", status: "completed", output: [] } }];
  const fetchStub = (async () => ++calls === 1 ? first() : new Response(after.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const server: Server = createServer((req, res) => { void handleModelGateway(req, res, new URL(req.url ?? "/", "http://127.0.0.1").pathname, { signIns, catalog, fetch: fetchStub }); });
  const port = await listen(server);
  const key = issueGatewayTurnCredential("signin-chatgpt", fixture.binding);
  cleanups.push(async () => { revokeGatewayTurnCredentials(fixture.binding.identity.dispatchGeneration); await closeServer(server)(); });
  const post = () => fetch(`${gatewayBaseUrl(port, "signin-chatgpt")}/responses`,
    { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "look" }) });
  const shot = await post(); await shot.arrayBuffer().catch(() => undefined);
  const next = await post();
  return { refusals, refused: fixture.budget.refused, shotStatus: shot.status, nextStatus: next.status, nextText: await next.text() };
}
/** One provider body (status 200 SSE or an error status) carrying `bytes` of payload, in 64 KiB pieces. */
const providerBody = (status: number, sse: boolean, bytes: number) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(Buffer.from(sse ? "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"" : "{\"error\":{\"message\":\""));
  for (let sent = 0; sent < bytes; sent += PIECE) controller.enqueue(Buffer.alloc(Math.min(PIECE, bytes - sent), 0x41));
  controller.enqueue(Buffer.from(sse ? "\"}]}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[]}}\n\ndata: [DONE]\n\n" : "\"}}"));
  controller.close();
} }), { status, headers: { "content-type": sse ? "text/event-stream" : "application/json" } });

// ---- the table: one row per hop, each with its own "the hop did not end the turn" assertion ---------------------------------------------
const HOPS: Array<[string, string, (n: number) => Promise<void>]> = [
  ["H1", "proxy-turn-release.ts:183 releaseProxyFrame 8 MiB frame", async n => {
    const p = await proxy(thenNext({ op: "frame", id: 1, bytes: n }));
    expect(p.terminal?.reason, "H1 releaseProxyFrame:183 ended the owner turn's mount on a 20 MiB result").toBeUndefined();
    expect([p.refusals, p.relayRefused, p.next], "H1 the turn is not refused and its next call is answered").toEqual([[], undefined, 64]);
  }],
  ["H2", "proxy-turn-release.ts:250 proxyUpstreamResponse 8 MiB body", async n => {
    const base = await upstream();
    const p = await proxy(thenNext({ op: "fetch", url: `${base}/body?bytes=${n}` }));
    expect(p.terminal?.reason, "H2 proxyUpstreamResponse:250 ended the owner turn's mount on a 20 MiB body").toBeUndefined();
    expect([p.refusals, p.step(0)?.bytes > n, p.next], "H2 every byte passed, the turn is not refused, its next call is answered").toEqual([[], true, 64]);
  }],
  ["H3", "proxy-turn-release.ts:252 proxyUpstreamResponse 1 MiB SSE event", async n => {
    const base = await upstream();
    const p = await proxy(thenNext({ op: "fetch", url: `${base}/sse?bytes=${n}` }));
    expect(p.terminal?.reason, "H3 proxyUpstreamResponse:252 ended the owner turn's mount on a 20 MiB SSE event").toBeUndefined();
    expect([p.refusals, p.step(0)?.bytes > n, p.next], "H3 every byte passed, the turn is not refused, its next call is answered").toEqual([[], true, 64]);
  }],
  ["H4", "drivers/remote-mcp-proxy.ts:136 gatedFetch 8 MiB relay body", async n => {
    const base = await upstream();
    const p = await proxy(thenNext({ op: "remote", url: `${base}/body?bytes=${n}` }));
    expect(p.terminal?.reason, "H4 remote-mcp-proxy gatedFetch:136 ended the owner turn's mount on a 20 MiB relay body").toBeUndefined();
    expect([p.refusals, p.step(0)?.bytes > n, p.next], "H4 every byte passed, the turn is not refused, its next call is answered").toEqual([[], true, 64]);
  }],
  ["H5", "drivers/remote-mcp-proxy.ts:138 gatedFetch 1 MiB relay SSE event", async n => {
    const base = await upstream();
    const p = await proxy(thenNext({ op: "remote", url: `${base}/sse?bytes=${n}` }));
    expect(p.terminal?.reason, "H5 remote-mcp-proxy gatedFetch:138 ended the owner turn's mount on a 20 MiB relay SSE event").toBeUndefined();
    expect([p.refusals, p.step(0)?.bytes > n, p.next], "H5 every byte passed, the turn is not refused, its next call is answered").toEqual([[], true, 64]);
  }],
  ["H6", "drivers/cli-mount-relay.ts:172 2 MiB stdio line", async n => {
    const r = await relayed();
    await r.call(1);
    const shot = await r.answer(1, n);
    expect(r.stopped(), "H6 cli-mount-relay:172 ended the owner turn on a 20 MiB stdio result line").toBe(false);
    expect([shot, r.refusals, r.sealed()], "H6 the whole result reached the engine, nothing refused or sealed").toEqual([n, [], false]);
    await r.call(2);
    expect(await r.answer(2, 64), "H6 the next call of the same turn is answered").toBe(64);
    await expect(r.finish(), "H6 the turn completes").resolves.toBe(true);
  }],
  ["H7", "model-gateway.ts:387 readLimited 64 KiB provider error body", async n => {
    const g = await gateway(() => providerBody(500, false, n));
    expect([g.refusals, g.refused], "H7 model-gateway readLimited:387 ended the owner turn on a 20 MiB provider error body").toEqual([[], false]);
    expect([g.shotStatus, g.nextStatus, g.nextText.includes("the next answer")], "H7 that request fails with the provider's status; the next is answered").toEqual([500, 200, true]);
  }],
  ["H8", "model-gateway-translate.ts:127-151 SSE parser 1 MiB event (gateway SSE caps)", async n => {
    const g = await gateway(() => providerBody(200, true, n));
    expect([g.refusals, g.refused], "H8 the gateway's SSE caps ended the owner turn on a 20 MiB provider SSE event").toEqual([[], false]);
    expect([g.shotStatus, g.nextStatus, g.nextText.includes("the next answer")], "H8 the 20 MiB answer is delivered; the next is answered").toEqual([200, 200, true]);
  }],
];

it.each(HOPS)("%s owner turn: a 20 MiB screenshot-sized result passes %s; the turn is not ended", async (_row, _hop, run) => { await run(SHOT); }, 240_000);
// Control: the same rows with a 32 KiB result (under every cap, the 64 KiB error body included) pass on the base, so a RED row above is
// its hop's size cap, never the rig.
it.each(HOPS)("%s control: a 32 KiB result passes %s on any build", async (_row, _hop, run) => { await run(32 * 1024); }, 120_000);

// ---- r3 (lane cause22-caps-fable, MAIN 2026-11-22T10:32:17Z): the permission rows --------------------------------------------------------
// One row per place where the SIZE of a permission reply (or of the ask it answers) ended, hung or mis-answered the owner's turn
// (cause22-caps-fable-r3/CAPS-INVENTORY.md section A). `over`: the reply or ask is over that hop's cap; the row fails when the hop
// ends the turn or does not deny that ONE request. The control runs the same row under the cap and must be allowed on any build.
afterEach(cleanupPermissionHops);
afterAll(closeReplyServers);
const REPLY_TOO_LARGE = "That reply was too large to deliver, so nothing was confirmed. Ask for a smaller change and try again.";
const ANSWER_TOO_LARGE = "Murage: the answer to this request was too large to pass on (over 64 MiB), so skip this action";
const PERMISSION_HOPS: Array<[string, string, (over: boolean) => Promise<void>]> = [
  ["H9", "drivers/claude.ts allowFits (managed output cap 25000 on the MCP reply, a 1 MiB changed allow) -> respondToRequest -> decision/implementation.ts send", async over => {
    const t = await claudeReply("write", over ? MIB : 12);
    expect([t.status, t.ends], "H9 a changed allow over the managed output cap interrupted the owner's turn (the engine must end it itself)").toEqual(["settled", [{ ok: true, stopReason: "end_turn" }]]);
    expect([t.permission, t.written, t.cards], "H9 that one request is denied (nothing written, no card); under the cap it is allowed and written").toEqual(over ? [["permission: denied"], null, 0] : [["permission: allowed"], 12, 0]);
    expect(t.texts.filter(text => text === REPLY_TOO_LARGE).length, "H9 the owner reads the fixed too-large line once, and only when over the cap").toBe(over ? 1 : 0);
  }],
  // r4 (ASTRA 083fb93124): this row's server has NO managed output cap, so the hook relay's 4 MiB - 1024 is the only cap the 5 MiB allow
  // can meet. If the SDK hook is not registered, or its ask is not marked out of band, the allow is delivered and line 2 says "allowed".
  ["H10", "drivers/claude.ts allowFits (4 MiB - 1024 on the SDK hook relay, drivers/claude-bash-hook.ts:69; no managed cap) -> respondToRequest -> decision send", async over => {
    const t = await claudeReply("hook", over ? 5 * MIB : 12);
    expect([t.status, t.ends], "H10 a changed allow over the SDK hook relay cap interrupted the owner's turn (the engine must end it itself)").toEqual(["settled", [{ ok: true, stopReason: "end_turn" }]]);
    expect([t.permission, t.cards], "H10 that one command is denied by the SDK hook relay cap alone (no managed cap in this server); under the cap it is allowed").toEqual([[over ? "permission: denied" : "permission: allowed"], 0]);
    expect(t.texts.filter(text => text === REPLY_TOO_LARGE).length, "H10 the owner reads the fixed too-large line once, and only when over the cap").toBe(over ? 1 : 0);
  }],
  // MAIN-RULING cause22-no-transport-caps (1.0.21): the broker ask line has no size cap, so the 70 MiB ask is read whole and gets the owner's decision.
  ["H11", "drivers/claude.ts permission broker ask line (no size cap: a 70 MiB ask is read whole and asked)", async over => {
    const b = await brokerAsk(over ? 70 : 1);
    expect([b.closed, b.answers.get("small-2")?.behavior], "H11 the broker socket stays open and the next ask is allowed").toEqual([false, "allow"]);
    expect(b.answers.get("big-1"), `H11 the owner's allow is delivered for an ask of ${over ? 70 : 1} MiB, never a size denial`).toEqual({ behavior: "allow", message: "Owner decision" });
  }],
  ["H12", "permission-proxy.ts MCP reply (JSON inside JSON) vs proxy-turn-release.ts releaseProxyFrame 64 MiB ceiling", async over => {
    const p = await permission(true, [{ id: 1, inputBytes: 64 }, { id: 2, inputBytes: 64 }], [over ? 40 * MIB : 32 * 1024, 16], '\\"', door as never);
    expect([p.terminal, p.refusals, p.relayRefused], "H12 the owner's permission mount is not sealed or refused").toEqual([undefined, [], undefined]);
    expect([p.answer(1)?.error, p.answer(1)?.decision?.behavior, p.answer(1)?.decision?.message], "H12 a reply over the ceiling once escaped is a permission deny with the fixed note, not a tool error; under it the allow passes").toEqual(over ? [undefined, "deny", ANSWER_TOO_LARGE] : [undefined, "allow", undefined]);
    expect(p.answer(2)?.decision?.behavior, "H12 the next request of the same turn is allowed").toBe("allow");
  }],
];
it.each(PERMISSION_HOPS)("%s owner turn: a permission reply or ask over the cap at %s denies that one request; the turn is not ended", async (_row, _hop, run) => { await run(true); }, 300_000);
// Control: the same rows under the cap are allowed on any build, so a RED row above is its hop's size cap, never the rig.
it.each(PERMISSION_HOPS)("%s control: under the cap the request is allowed at %s on any build", async (_row, _hop, run) => { await run(false); }, 300_000);
