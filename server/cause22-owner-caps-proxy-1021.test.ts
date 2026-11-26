// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 cause22 caps (Sean STANDING, MAIN-RULING local-memory-budget: an owner turn is never stopped, refused or sealed by a size or
// memory cap). Owners: lane cause22-caps owns the owner-turn behaviour of the proxy child's caps (proxy-turn-release.ts:
// releaseProxyFrame, the release queue, proxyFetch / proxyUpstreamResponse, collectProxyUpstream), of the release door
// (turn-release-door.ts: body bound, owner header) and of the authority behind it (consuming-turn-ingress.ts); CAPS-INVENTORY rows
// A5-A8, A11, B1-B7.
// Nothing under test is replaced: a REAL spawned child running the real proxy-turn-release.ts (testing/cause22-proxy-child.fixture.ts)
// with the release environment the mount admission gives one; the REAL release door handler index.ts runs (handleTurnReleaseDoor) on a
// loopback socket; the real release authority, ingress, fence, SQLite ledger and release budget of a bound turn. This file stands in
// only for the mount relay's two lines of work: it hands each envelope the child prints to the real ingress (decode + deliver) and
// acknowledges it over IPC. Whose turn it is comes from the budget alone (the owner keep), through the door's own header.
// On c187b11166 every owner case below sealed the mount (the door is inline in index.ts there; `baseDoor` is that code, used only
// when turn-release-door.ts does not exist, so the same cases fail there on their assertions).
import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, decodeReleaseEnvelope } from "./consuming-turn-ingress.ts";
import { denyConsumingHttp, registerConsumingDescriptor } from "./consuming-turn-response.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { RELEASE_LIMITS } from "./memory/release-budget.ts";
import { readBody } from "./read-body.ts";

const MIB = 1024 * 1024;
// The fixed line of owner-turn-caps.ts, pinned by its words (this file also runs on the base, where that module does not exist).
const CHILD = fileURLToPath(new URL("./testing/cause22-proxy-child.fixture.ts", import.meta.url));
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const plainJson = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
type Authority = ReturnType<typeof createProxyReleaseAuthority>;
type Door = (req: IncomingMessage, res: ServerResponse, ports: { capabilities: InternalCapabilities; authority: Authority; json: typeof plainJson }) => Promise<void>;
/** The route as c187b11166 has it inline in index.ts (base runs only). */
const baseDoor: Door = async (req, res, { capabilities, authority, json }) => {
  const claim = capabilities.resolve(req.headers.authorization);
  if (req.method !== "POST" || !claim || !capabilities.releaseControl(claim)) { if (claim) authority.seal(claim); return denyConsumingHttp(res); }
  try {
    const body = await readBody(req, 16 * 1024 * 1024 + 1024);
    if (body && typeof body === "object" && (body as { operation?: unknown }).operation === "upstream") { authority.reserveUpstream(claim, body); return json(res, 200, { reserved: true }); }
    return json(res, 200, authority.verdict(claim, body));
  } catch (error) { authority.seal(claim); return denyConsumingHttp(res, undefined, error); }
};
const door: Door = await import("./turn-release-door.ts").then(module => module.handleTurnReleaseDoor as Door, () => baseDoor);

/** The upstream a proxy reads: `/body?bytes=N` one plain body, `/sse?bytes=N` one SSE event of N bytes and a small one after it. */
async function upstream() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const bytes = Number(url.searchParams.get("bytes") ?? 0);
    const sse = url.pathname === "/sse";
    res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/octet-stream" });
    if (sse) res.write("event: message\ndata: ");
    const piece = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        const size = Math.min(piece.length, bytes - sent); sent += size;
        if (!res.write(piece.subarray(0, size))) { res.once("drain", pump); return; }
      }
      res.end(sse ? "\n\ndata: {\"done\":true}\n\n" : undefined);
    };
    res.on("error", () => {}); pump();
  });
  const port = await listen(server);
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  return `http://127.0.0.1:${port}`;
}

/** One bound turn, its real release door, and one spawned proxy child admitted to it. `owner`: the turn's budget is bound with the
 * owner keep, as index.ts binds an owner turn. `afterReady` runs once, after the child's first frame was delivered and before it is
 * acknowledged (so before the child's plan starts). */
async function proxy(owner: boolean, plan: Array<Record<string, unknown>>, afterReady?: (turn: ReturnType<typeof consumingFixture>) => void, cold = false) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const refusals: unknown[] = [];
  const fixture = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { refusals.push(verdict); }, ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => fixture.close());
  const capabilities = new InternalCapabilities(); capabilities.begin(fixture.binding.identity.botId, fixture.turn.threadId, fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
  // the engine's calls the child will answer, as the relay forwards them (ingress.request): id 0 is `initialize`
  for (const id of [0, ...plan.filter(step => step.op === "frame").map(step => step.id as number)]) {
    instance.ingress.request(JSON.stringify({ jsonrpc: "2.0", id, method: id === 0 ? "initialize" : "tools/call", params: {} }), () => {});
  }
  const server = createServer((req, res) => { void door(req, res, { capabilities, authority, json: plainJson }); });
  const port = await listen(server);
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  const child: ChildProcess = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token, MURAGE_RELEASE_URL: `http://127.0.0.1:${port}`, FIXTURE_PLAN: JSON.stringify(plan), ...(cold ? { FIXTURE_COLD: "1" } : {}) } });
  cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  // what the engine was given: each delivered frame (its id, method, error and the size of its result text), in order
  const frames: Array<{ id?: number; method?: string; error?: { code?: number; message?: string }; resultBytes?: number; progress?: number; padBytes?: number }> = [];
  const reports: Array<Record<string, any>> = [];
  let terminal: { reason?: string; frame?: { error?: { message?: string; data?: { code?: string } } } } | undefined, relayRefused: string | undefined, tail: Buffer[] = [], ready = false;
  child.stderr!.resume();
  child.stdout!.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end < 0) { if (start < chunk.length) tail.push(chunk.subarray(start)); break; }
      const line = Buffer.concat([...tail, chunk.subarray(start, end)]).toString("utf8"); tail = []; start = end + 1;
      try {
        // the mount relay's part (mcp-mounts.ts accept): decode at the trusted ingress, then the fenced delivery to the engine
        const envelope = decodeReleaseEnvelope(line, (instance.ingress as { ownerTurn?: boolean }).ownerTurn === true);
        instance.ingress.deliver(envelope, frame => {
          const rpc = JSON.parse(frame);
          frames.push({ id: rpc.id, method: rpc.method, error: rpc.error, progress: rpc.params?.progress, padBytes: typeof rpc.params?.pad === "string" ? rpc.params.pad.length : undefined,
            ...(rpc.result?.content ? { resultBytes: String(rpc.result.content[0]?.text ?? "").length } : {}) });
        });
        if (!ready) { ready = true; afterReady?.(fixture); }
        if (child.connected) child.send({ type: "turn-release-ack", instanceId: envelope.instanceId, sequence: envelope.sequence });
      } catch (error) { relayRefused = String((error as Error).message); child.kill("SIGKILL"); return; }
    }
  });
  const done = new Promise<void>(resolve => {
    child.on("message", (message: any) => {
      if (message?.type === "fixture-report") { reports.push(message); if (message.done) resolve(); }
      if (message?.type === "turn-release-terminal") terminal = message;
    });
    child.once("exit", () => resolve());
  });
  return { frames, reports, done, fixture, refusals, get terminal() { return terminal; }, get relayRefused() { return relayRefused; },
    step: (index: number) => reports.find(entry => entry.step === index) };
}

it("P1 owner turn: one 20 MiB frame passes the proxy's 8 MiB frame cap and its 16 MiB verdict-answer cap whole; the mount is not sealed", async () => {
  const p = await proxy(true, [{ op: "frame", id: 1, bytes: 20 * MIB }, { op: "frame", id: 2, bytes: 64 }]);
  await p.done;
  expect(p.terminal, "a 20 MiB frame does not seal the owner's mount").toBeUndefined();
  expect(p.relayRefused, "the ingress took the envelope").toBeUndefined();
  expect(p.refusals, "the owner's turn was not refused").toEqual([]);
  expect(p.step(0), "the frame was released").toEqual(expect.objectContaining({ released: 1 }));
  expect(p.frames.find(frame => frame.id === 1)?.resultBytes, "every byte reached the relay side").toBe(20 * MIB);
  expect(p.frames.find(frame => frame.id === 2)?.resultBytes, "the next frame of the same turn follows").toBe(64);
}, 240_000);

it("P2 owner turn: a 20 MiB upstream body streams through the proxy whole; every byte is reserved first", async () => {
  const base = await upstream();
  const p = await proxy(true, [{ op: "fetch", url: `${base}/body?bytes=${20 * MIB}` }, { op: "frame", id: 3, bytes: 64 }]);
  await p.done;
  expect(p.terminal, "a large read does not seal the owner's mount").toBeUndefined();
  expect(p.step(0)?.bytes, "the whole 20 MiB body was passed on").toBe(20 * MIB);
  expect(p.refusals, "the owner's turn was not refused at the door").toEqual([]);
  expect(p.fixture.budget.windows > 1 || p.fixture.budget.counts.bytes >= 20 * MIB, "every upstream byte was charged to the turn's budget at the real door").toBe(true);
  expect(p.frames.find(frame => frame.id === 3)?.resultBytes).toBe(64);
}, 240_000);

it("P2b owner turn: one 20 MiB SSE event streams through the proxy whole (no event size cap)", async () => {
  const base = await upstream();
  const p = await proxy(true, [{ op: "fetch", url: `${base}/sse?bytes=${20 * MIB}` }, { op: "frame", id: 3, bytes: 64 }]);
  await p.done;
  expect(p.terminal, "a large event does not seal the owner's mount").toBeUndefined();
  expect(p.step(0)?.bytes, "the whole SSE answer was passed on").toBeGreaterThan(20 * MIB);
  expect(p.frames.find(frame => frame.id === 3)?.resultBytes).toBe(64);
}, 240_000);

it("P3 owner turn: a 20 MiB collected output is collected whole (no collection cap)", async () => {
  const p = await proxy(true, [{ op: "collect", bytes: 20 * MIB }, { op: "frame", id: 3, bytes: 64 }]);
  await p.done;
  expect(p.terminal, "a 20 MiB collection does not seal the owner's mount").toBeUndefined();
  expect(p.step(0)?.bytes, "the whole output was collected").toBe(20 * MIB);
  expect(p.frames.find(frame => frame.id === 3)?.resultBytes).toBe(64);
}, 240_000);

it("P4 owner turn: 200 frames handed over at once pass the 64-frame queue cap and arrive in order", async () => {
  const p = await proxy(true, [{ op: "burst", count: 200 }]);
  await p.done;
  expect(p.terminal, "a full queue does not seal the owner's mount").toBeUndefined();
  expect(p.frames.filter(frame => frame.method === "notifications/progress").map(frame => frame.progress), "every frame, in order").toEqual(Array.from({ length: 200 }, (_, n) => n));
  expect(p.frames.at(-1)?.method).toBe("notifications/message");
}, 240_000);

it("P10 owner turn: 10 frames of 2 MiB handed over at once (20 MiB waiting, far under 64 frames, each far under 8 MiB) pass the queue's aggregate-byte cap whole and in order", async () => {
  // SITES #11, the byte half of the queue cap: on c187b11166 the fifth waiting frame crossed 8 MiB queued and sealed the mount (queue-cap).
  const p = await proxy(true, [{ op: "burst", count: 10, padBytes: 2 * MIB }]);
  await p.done;
  expect(p.terminal, "20 MiB waiting in the queue does not seal the owner's mount").toBeUndefined();
  expect(p.refusals, "the owner's turn was not refused").toEqual([]);
  const progress = p.frames.filter(frame => frame.method === "notifications/progress");
  expect(progress.map(frame => frame.progress), "every frame, in order").toEqual(Array.from({ length: 10 }, (_, n) => n));
  expect(progress.map(frame => frame.padBytes), "every byte of every frame").toEqual(Array.from({ length: 10 }, () => 2 * MIB));
  expect(p.frames.at(-1)?.method, "the frame after the burst follows").toBe("notifications/message");
}, 240_000);

it("P7 a non-owner turn's budget stop at the real door reaches the proxy child as the budget line (the door's own 409 and header); any other refusal keeps the context line", async () => {
  const base = await upstream();
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the child's next upstream
  // reserve (bytes + 1 work) crossed a nearly full window; a reserve is never refused for size now. So the window's work is filled exactly
  // and the child's next frame is the stop: its verdict's own bookkeeping work crosses the window at the same door.
  // a fresh window of the turn's budget that holds no accepted release and is full: the child's next verdict crosses it
  const budget = await proxy(false, [{ op: "frame", id: 1, bytes: 16 }], turn => {
    turn.budget.charge({ statements: RELEASE_LIMITS.statements - turn.budget.counts.statements });
    turn.budget.charge({ statements: 1 });
    turn.budget.charge({ work: RELEASE_LIMITS.work - turn.budget.counts.work });
  });
  await budget.done;
  expect(budget.refusals, "the turn's own budget refused it").toEqual([{ state: "checking", reason: "retained-budget" }]);
  expect(budget.terminal?.frame?.error?.message, "the engine is told the budget line").toBe("I stopped this turn because it grew past a safety limit. Nothing was removed from memory.");
  // any other refusal at the door (the generation was displaced): no budget word, the context line
  const other = await proxy(false, [{ op: "fetch", url: `${base}/body?bytes=${64 * 1024}` }], turn => { turn.replace(); });
  await other.done;
  expect(other.terminal?.frame?.error?.message, "any other refusal keeps the context line").toBe("I stopped this turn because some of its context is no longer available.");
}, 120_000);

it("P8 owner turn, before the door's first answer: 200 frames handed over at once (no frame released yet, so the child was never told whose turn it is) pass the 64-frame queue cap and arrive in order", async () => {
  const p = await proxy(true, [{ op: "burst", count: 200 }], undefined, true);
  await p.done;
  expect(p.terminal, "a full queue before the door's first answer does not seal the owner's mount").toBeUndefined();
  expect(p.refusals, "the owner's turn was not refused").toEqual([]);
  expect(p.frames.filter(frame => frame.method === "notifications/progress").map(frame => frame.progress), "every frame, in order").toEqual(Array.from({ length: 200 }, (_, n) => n));
  expect(p.frames.at(-1)?.method).toBe("notifications/message");
}, 240_000);


/** MAIN 2026-11-22T20:25:47Z item 3. One bound turn and the real door; the test posts what the release child posts (an upstream
 * reservation with the instance's own bearer), once small and once with 17 MiB of JSON whitespace around the same three fields, so the
 * body is over the door's 16 MiB + 1024 limit and nothing but the door's own read can tell the two requests apart. */
async function doorPost(owner: boolean) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = consumingFixture(undefined, { botId: randomUUID(), ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => fixture.close());
  const capabilities = new InternalCapabilities(); capabilities.begin(fixture.binding.identity.botId, fixture.turn.threadId, fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
  const server = createServer((req, res) => { void door(req, res, { capabilities, authority, json: plainJson }); });
  const port = await listen(server);
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  const post = async (padBytes: number) => {
    const body = `{"operation":"upstream","instanceId":${JSON.stringify(instance.instanceId)},${" ".repeat(padBytes)}"bytes":1}`;
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { authorization: `Bearer ${instance.token}`, "content-type": "application/json" }, body });
      return { status: response.status, answer: await response.json().catch(() => undefined) as unknown };
    } catch { return { status: 0, answer: undefined }; }
  };
  return { post, sealed: () => instance.ingress.sealed };
}

it("D1 owner turn: a 17 MiB request to the release door (over the 16 MiB + 1024 limit of other turns) is read whole and answered; the mount is not sealed", async () => {
  const d = await doorPost(true);
  expect(await d.post(0), "control: the small request is answered").toEqual({ status: 200, answer: { reserved: true } });
  expect(await d.post(17 * MIB), "the owner's 17 MiB request never meets the limit").toEqual({ status: 200, answer: { reserved: true } });
  expect(d.sealed(), "the owner's mount is not sealed").toBe(false);
}, 120_000);

it("D2 a turn that is not the owner's: the same 17 MiB request is refused by the door's 16 MiB + 1024 limit (kept); its small request is answered", async () => {
  const d = await doorPost(false);
  expect(await d.post(0), "control: the small request is answered").toEqual({ status: 200, answer: { reserved: true } });
  expect((await d.post(17 * MIB)).status, "the limit of a turn that is not the owner's is kept").not.toBe(200);
}, 120_000);
