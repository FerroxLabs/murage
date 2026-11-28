// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.21 cause22 GROUP D (lane cause22-mem; owners: this lane owns memory/release-budget.ts, memory/upstream-reader.ts and the
// drivers/mcp-mounts.ts rows; group A owns cli-mount-relay.ts, group C consuming-turn-ingress.ts, MAIN the merge).
// MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap ends, seals or refuses a turn, owner AND
// non-owner. Real evidence (2026-11-22T02:37Z): "swallowed error site=release.reserveUpstream code=MEMORY_CONTEXT_REVOKED
// fence=checking/retained-budget" then "ledger refusal cause=checking:retained-budget": a real turn was sealed by the release budget.
// Rows (one per deleted site, SITES.md; each enters through the production function the finding names; RED base e1767b8540, the
// lane's parent, which already ships the extracted door):
//  R1  bytes (release-budget.ts:5) + per-byte door work: 40 reports of 2 MiB through handleTurnReleaseDoor (index.ts:30666 runs it).
//  S1  attempts (release-budget.ts:5, 4096): 5,000 calls of one non-owner turn through relayMcpCall over a legacy SSE server
//      (mcp-relay.ts:184, run by the relay route inside withUpstreamOwner as index.ts:30696), no accepted release between them.
//  S2  per-byte SSE work (upstream-reader.ts): 20 answers of 900 KiB (18 MiB, each under the 1 MiB event cap) through the same path.
//  S3  SSE event cap (upstream-reader.ts, 1 MiB): one 3 MiB answer through the same path.
//  I1  collected-body cap (upstream-reader.ts, 8 MiB): a 10 MiB image stream through readImageStreamResponse (image-generation.ts:325,
//      called at :1090 with these options) on a non-owner turn.
//  I2  owner ceiling (upstream-reader.ts, 64 MiB): a 70 MiB image stream through readImageStreamResponse on the owner's own turn.
//  M1/M2 regression rows for the mcp-mounts path (accepted releases renewed the base window, so they are not base-RED proof).
// Real fence, real SQLite ledger, real release budget, real ingress, real mcp-mounts admission and mount relay line path; only the mount
// child and the CLI process are stand-ins (as cause22-owner-mount-budget-1021.test.ts). S/I rows: real fetch over loopback servers.
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { refuseConsumingTurn, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { handleTurnReleaseDoor } from "../turn-release-door.ts";
import { TURN_RELEASE_VERDICT_PATH } from "../proxy-turn-release.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import type { LineageVerdict } from "../memory/lineage-types.ts";
import { withUpstreamOwner } from "../memory/upstream-reader.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { relayMcpCall, type RelayContext } from "../mcp-relay.ts";
import type { StoredRemoteMcpServer } from "../mcp-registry.ts";
import { RemoteSseSessions } from "../remote-mcp-sse-sessions.ts";
import { startFakeRemoteMcp } from "../testing/fake-remote-mcp.ts";
import { IMAGE_RESPONSE_MAX_BYTES, imageResponseCap, readImageStreamResponse } from "../image-generation.ts";
import type { SendTurnInput } from "../contracts.ts";

vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
vi.mock("../memory/memory-revocation.ts", async original => ({
  ...await original<typeof import("../memory/memory-revocation.ts")>(),
  wakeMemoryRevocation: () => {},
}));
const { CliMountRelay } = await import("./cli-mount-relay.ts");
const door = handleTurnReleaseDoor;

const MIB = 1024 * 1024, PIECE = 64 * 1024;
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "computer" } });
const result = (id: number, bytes: number) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "s".repeat(bytes) }] } }) + "\n");

/** One mounted NON-owner turn attached to its CLI: the fake engine is the relay socket, the fake tool server is the mount child. */
async function mounted() {
  const verdicts: LineageVerdict[] = [];
  const f = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); } });
  cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "use the computer", warmIdentity: { botId: f.binding.identity.botId, audience: "non-owner" },
    releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { computer: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawn);
  cleanups.push(() => relay.finish());
  const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, pid: undefined }) as unknown as ChildProcess;
  const failed = vi.fn();
  relay.attach(cli, failed);
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: relay.ticket, server: "computer" }) + "\n");
  // the engine side: complete lines only; the size of each reply's text it was given
  const answered = new Map<number, number>();
  let tail = "";
  socket.on("data", chunk => {
    tail += String(chunk);
    const lines = tail.split("\n"); tail = lines.pop()!;
    for (const line of lines) if (line) {
      const rpc = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } };
      if (typeof rpc.id === "number") answered.set(rpc.id, rpc.result?.content?.[0]?.text?.length ?? -1);
    }
  });
  const forwarded: number[] = [];
  let childTail = "";
  children[0]!.stdin!.on("data", chunk => {
    childTail += String(chunk);
    const lines = childTail.split("\n"); childTail = lines.pop()!;
    for (const line of lines) if (line) forwarded.push(JSON.parse(line).id);
  });
  const child = children[0]!;
  const stopped = () => f.refusals > 0 || failed.mock.calls.length > 0 || verdicts.length > 0;
  return { f, relay, failed, socket, answered, forwarded, verdicts, stopped,
    ingress: () => relay.mounts.get("computer")!.mount.ingress,
    /** the mount child writes one tool result, in 64 KiB pieces as a pipe delivers it */
    emit: (frame: Buffer) => { for (let at = 0; at < frame.length; at += PIECE) child.stdout!.emit("data", frame.subarray(at, at + PIECE)); },
  };
}

/** `count` tool calls in batches of `batch` (each batch forwarded, then answered), each result `bytes` of text. Stops at the first stop. */
async function toolTurn(r: Awaited<ReturnType<typeof mounted>>, count: number, bytes: number, batch: number) {
  let released = 0;
  for (let first = 1; first <= count && !r.stopped(); first += batch) {
    const last = Math.min(count, first + batch - 1);
    for (let id = first; id <= last; id++) r.socket.write(request(id) + "\n");
    await vi.waitFor(() => expect(r.forwarded.length >= last || r.stopped()).toBe(true), { timeout: 30_000, interval: 5 });
    if (r.stopped()) break;
    for (let id = first; id <= last; id++) {
      const frame = result(id, bytes);
      r.emit(frame);
      await vi.waitFor(() => expect(r.answered.has(id) || r.stopped()).toBe(true), { timeout: 10_000, interval: 1 });
      if (r.stopped()) break;
      released += frame.length;
    }
  }
  return released;
}

it("R1 release-budget via the release door (release.reserveUpstream, the Mac log's site): 40 screenshots of 2 MiB (80 MiB) reported by a proxy on a non-owner turn are all reserved and the turn stays open", async () => {
  const refusals: LineageVerdict[] = [];
  const f = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { refusals.push(verdict); } });
  cleanups.push(() => f.close());
  const capabilities = new InternalCapabilities(); capabilities.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities);
  const instance = authority.register(f.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => { void door(req, res, { capabilities, authority, json }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const SHOTS = 40, SHOT = 2 * MIB;
  const statuses: number[] = [];
  // the request a spawned proxy makes for each chunk it read upstream (proxy-turn-release.ts reserveProxyUpstream), byte for byte
  for (let shot = 0; shot < SHOTS; shot++) {
    const response = await fetch(new URL(TURN_RELEASE_VERDICT_PATH, base), { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${instance.token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "upstream", instanceId: instance.instanceId, bytes: SHOT }) });
    await response.body?.cancel().catch(() => {});
    statuses.push(response.status);
    if (!response.ok) break;
  }
  expect(statuses, "every report of the 80 MiB turn is reserved (the base refused it as checking:retained-budget)").toEqual(Array(SHOTS).fill(200));
  expect(refusals, "no ledger refusal").toEqual([]);
  expect(f.refusals).toBe(0);
  expect(instance.ingress.sealed, "the proxy's ingress stays open").toBe(false);
  expect(f.budget.counts.bytes, "the bytes are counted, never limited").toBe(SHOTS * SHOT);
}, 120_000);

it("M1 release-budget bytes + mcp-mounts: a non-owner turn that releases more than 64 MiB (50 screenshots of 1.5 MiB) completes, every reply whole", async () => {
  const r = await mounted();
  const SHOTS = 50, SHOT = 1.5 * MIB;
  const released = await toolTurn(r, SHOTS, SHOT, 10);
  expect(r.verdicts, "no refusal: the byte budget is gone").toEqual([]);
  expect(r.f.refusals).toBe(0);
  expect(r.answered.size, "every screenshot reached the engine").toBe(SHOTS);
  expect([...r.answered.values()].every(length => length === SHOT), "each one whole").toBe(true);
  expect(released, "the turn released more than 64 MiB").toBeGreaterThan(64 * MIB);
  expect(r.f.budget.counts.bytes, "bytes are still counted").toBeGreaterThan(64 * MIB);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  await expect(r.relay.finish(), "the turn completes").resolves.toBe(true);
}, 300_000);

it("M2 release-budget attempts + mcp-mounts: a non-owner turn that releases 5,000 replies (over the old 4096 attempt count) completes", async () => {
  const r = await mounted();
  const CALLS = 5000;
  await toolTurn(r, CALLS, 64, 1000);
  expect(r.verdicts, "no refusal: the attempt count is gone").toEqual([]);
  expect(r.f.refusals).toBe(0);
  expect(r.answered.size, "every reply reached the engine").toBe(CALLS);
  expect(r.f.budget.counts.attempts, "attempts are still counted").toBeGreaterThan(4096);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  await expect(r.relay.finish(), "the turn completes").resolves.toBe(true);
}, 300_000);

/** The turn's upstream scope exactly as the relay route builds it (index.ts:30696): the turn's open budgets, refusing through
 * refuseConsumingTurn. `owner` binds the owner's own turn the production way (bindRetainedTurn via prepareRetainedFence). */
function turnScope(owner = false) {
  const refusals: LineageVerdict[] = [];
  const f = consumingFixture(undefined, { botId: randomUUID(), ownerTurn: owner, onRefused: verdict => { refusals.push(verdict); } });
  cleanups.push(() => f.close());
  const run = <T>(work: () => Promise<T>) => withUpstreamOwner({ budgets: checkedOpenTurns(f.binding.turn).map(member => member.budget!),
    refuse: verdict => refuseConsumingTurn(f.binding, verdict) }, work);
  return { f, refusals, run };
}
const outcomeOf = (error: { code?: string } | undefined) => error?.code ?? "error";

/** One NON-owner turn talking to a legacy HTTP+SSE MCP server through relayMcpCall (mcp-relay.ts), the function the relay route calls
 * for every engine message; the session is opened by the turn's own initialize, as the engine does. */
async function relayTurn(padBytes = 0, transport: "sse" | "http" = "sse", owner = false, respondWith: "json" | "sse" = "json") {
  const t = turnScope(owner);
  const fake = await startFakeRemoteMcp({ auth: "none", transport, respondWith, toolResultPadBytes: padBytes });
  const sessions = new RemoteSseSessions();
  cleanups.push(async () => { sessions.closeAll(); await fake.close(); });
  const server: StoredRemoteMcpServer = { url: fake.mcpUrl, auth: "none", headers: {}, enabled: true, local: "this-computer", transport };
  let sessionId: string | undefined;
  const call = (message: Record<string, unknown>) => t.run(() => relayMcpCall({ name: "svc", server, message, sessionId,
    generation: t.f.binding.identity.dispatchGeneration, postTokenRejected: () => false, sseSessions: sessions, tokenWaitMs: 400 } satisfies RelayContext));
  const init = await call({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  if (!init.ok || transport === "sse" && !init.sessionId) throw new Error("setup: the MCP session did not open");
  sessionId = init.sessionId;
  /** `count` echo calls one after another; the text length of each whole answer, or the first failure (a lost or short answer is one). */
  const echo = async (count: number) => {
    const texts: number[] = [];
    for (let id = 1; id <= count; id++) {
      const outcome = await call({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { text: "ok" } } })
        .then(result => result.ok ? result : `failed:${result.body.code}`, outcomeOf);
      if (typeof outcome === "string") return { texts, failure: outcome };
      let length = -1;
      try { length = (JSON.parse(String(outcome.body)) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text.length; } catch { /* below */ }
      if (length !== 2 + padBytes) return { texts, failure: `answer-lost:${length}` };
      texts.push(length);
    }
    return { texts, failure: null };
  };
  return { ...t, echo, call };
}

it("S1 release-budget attempts via relayMcpCall (legacy SSE): a non-owner turn makes 5,000 calls (over the old 4096 attempt count) with no accepted release, and every one is answered", async () => {
  const t = await relayTurn();
  const CALLS = 5000;
  const { texts, failure } = await t.echo(CALLS);
  expect({ answered: texts.length, failure }, "every call is answered (the base refused the 4097th attempt as checking:retained-budget)")
    .toEqual({ answered: CALLS, failure: null });
  expect(t.refusals, "no ledger refusal").toEqual([]);
  expect(t.f.budget.acceptedReleases, "no release of this turn was accepted: the base's no-renewal case").toBe(0);
  expect(t.f.budget.refused).toBe(false);
  expect(t.f.budget.counts.attempts, "attempts are still counted").toBeGreaterThan(4096);
}, 240_000);

it("S2 upstream-reader SSE work via relayMcpCall (legacy SSE): 20 answers of 900 KiB (18 MiB, each under the old 1 MiB event cap) on a non-owner turn are all delivered whole", async () => {
  const PAD = 900 * 1024, CALLS = 20;
  const t = await relayTurn(PAD);
  const { texts, failure } = await t.echo(CALLS);
  expect({ answered: texts.length, failure }, "every answer is delivered (the base charged one work unit per SSE byte and refused past 16 Mi work)")
    .toEqual({ answered: CALLS, failure: null });
  expect(texts.every(length => length === 2 + PAD), "each one whole").toBe(true);
  expect(t.refusals).toEqual([]);
  expect(t.f.budget.acceptedReleases).toBe(0);
  expect(t.f.budget.refused).toBe(false);
}, 120_000);

it("S3 upstream-reader SSE event via relayMcpCall (legacy SSE): one 3 MiB answer (a screenshot) on a non-owner turn is delivered whole", async () => {
  const PAD = 3 * MIB;
  const t = await relayTurn(PAD);
  const { texts, failure } = await t.echo(1);
  expect({ texts, failure }, "the answer is delivered whole (the base refused an SSE event over 1 MiB)").toEqual({ texts: [2 + PAD], failure: null });
  expect(t.refusals).toEqual([]);
  expect(t.f.budget.refused).toBe(false);
}, 120_000);

/** An image provider's SSE answer: `padBytes` of keepalive comments, then one completed image, read by readImageStreamResponse
 * (image-generation.ts) with the options its only caller passes (image-generation.ts:1090). */
async function imageTurn(padBytes: number, owner: boolean) {
  const t = turnScope(owner);
  const image = Buffer.from("a tiny image").toString("base64");
  const keepalive = `: ${"k".repeat(64 * 1024 - 4)}\n\n`;
  const body = Buffer.from(keepalive.repeat(Math.ceil(padBytes / keepalive.length))
    + `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: image })}\n\ndata: [DONE]\n\n`);
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(body); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const outcome = await t.run(async () => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const result = await readImageStreamResponse(response, { maxEventBytes: imageResponseCap(1), maxTotalBytes: IMAGE_RESPONSE_MAX_BYTES, expected: 1 });
    return result.data[0]?.b64_json === image ? "image" : "wrong-image";
  }).catch(outcomeOf);
  return { ...t, outcome, bytes: body.length };
}

it("I1 upstream-reader collection via readImageStreamResponse: a 10 MiB image stream on a non-owner turn is read to its image (no 8 MiB collected-body cap)", async () => {
  const t = await imageTurn(10 * MIB, false);
  expect(t.outcome, "the image arrives (the base refused a collected body over 8 MiB)").toBe("image");
  expect(t.refusals).toEqual([]);
  expect(t.f.budget.refused).toBe(false);
  expect(t.f.budget.counts.bytes, "the bytes are counted").toBe(t.bytes);
}, 120_000);

it("I2 upstream-reader owner ceiling via readImageStreamResponse: a 70 MiB image stream on the owner's own turn is read to its image (no 64 MiB cut)", async () => {
  const t = await imageTurn(70 * MIB, true);
  expect(t.f.budget.ownerKept, "setup: the owner's own turn").toBe(true);
  expect(t.outcome, "the image arrives (the base cut a collected body over 64 MiB on the owner turn)").toBe("image");
  expect(t.refusals).toEqual([]);
  expect(t.f.budget.refused).toBe(false);
}, 120_000);

// r3 rows (ASTRA PRECHECK 7c9a7bcd99): one per deleted site whose base RED R1/I2 did not isolate.
//  B1  bytes (release-budget.ts:5, 64 MiB) alone: streamable HTTP answers are read in "collection" mode (mcp-relay.ts readAll), which
//      on the base charged bytes but no per-byte work, so ten 7 MiB JSON answers (70 MiB, each under the 8 MiB body cap) could only be
//      refused by the byte budget.
//  O1  owner SSE event ceiling (upstream-reader.ts, 64 MiB for one event): one 64.5 MiB answer as a streamed SSE event (mcp-relay.ts
//      :305, the only non-collected SSE read here) on the owner's own turn; under the owner's 65 MiB guarded answer limit (mcp-relay.ts
//      :260, group A), so only the deleted event ceiling could cut it on the base.
it("B1 release-budget bytes via relayMcpCall (streamable HTTP, collected answers): ten 7 MiB answers (70 MiB, each under the old 8 MiB body cap) on a non-owner turn are all delivered whole", async () => {
  const PAD = 7 * MIB, CALLS = 10;
  const t = await relayTurn(PAD, "http");
  const { texts, failure } = await t.echo(CALLS);
  expect({ answered: texts.length, failure }, "every answer is delivered (the base refused past 64 MiB of bytes as checking:retained-budget)")
    .toEqual({ answered: CALLS, failure: null });
  expect(t.refusals, "no ledger refusal").toEqual([]);
  expect(t.f.budget.acceptedReleases, "no release of this turn was accepted: the base's no-renewal case").toBe(0);
  expect(t.f.budget.refused).toBe(false);
  expect(t.f.budget.counts.bytes, "the bytes are counted, never limited").toBeGreaterThan(64 * MIB);
}, 240_000);

it("O1 upstream-reader owner SSE event ceiling via relayMcpCall (streamable HTTP, streamed SSE answer): one 64.5 MiB event on the owner's own turn is delivered whole (no 64 MiB cut)", async () => {
  const PAD = 64 * MIB + 512 * 1024;
  const t = await relayTurn(PAD, "http", true, "sse");
  expect(t.f.budget.ownerKept, "setup: the owner's own turn").toBe(true);
  const outcome = await t.call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "ok" } } })
    .then(async result => {
      if (!result.ok) return `failed:${result.body.code}`;
      const chunks: Buffer[] = [];
      for await (const chunk of result.body as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks).toString().split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
      try { return (JSON.parse(data) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text.length; } catch { return "answer-lost"; }
    }).catch(outcomeOf);
  expect(outcome, "the answer is delivered whole (the base cut one SSE event over 64 MiB on the owner turn)").toBe(2 + PAD);
  expect(t.refusals).toEqual([]);
  expect(t.f.budget.refused).toBe(false);
}, 240_000);
