// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 cause22 caps r2 (ASTRA c0174cc11d High; Sean STANDING, MAIN-RULING local-memory-budget: an owner turn is never stopped,
// refused or sealed by a size cap). Owners: lane cause22-caps owns the owner-turn behaviour of the permission hop: the permission
// proxy's broker reader and ask writer (permission-proxy.ts, CAPS-INVENTORY B15) and the broker's ask line cap (drivers/claude.ts
// createPermissionBroker, CAPS-INVENTORY A31). The permission mount is never dropped (cli-mount-relay.ts dropMount), so a seal of
// this proxy ends the turn: here no size may seal it. One answer or ask over a cap denies that one request with a fixed note.
// Nothing under test is replaced: the REAL spawned permission-proxy.ts with the release environment a mount admission gives one, the
// REAL release door on a loopback socket, the real authority, ingress, fence, ledger and budget of a bound turn. Answer-size cases
// read from a plain socket that writes one answer of the stated size (the proxy's reader is what is under test); ask-size cases run
// against the REAL createPermissionBroker bound to the same turn. This file stands in only for the mount relay's two lines of work
// (hand each printed envelope to the real ingress, acknowledge it over IPC) and writes the engine's calls to the proxy's stdin.
import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectSocket, createServer as createSocketServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, decodeReleaseEnvelope } from "./consuming-turn-ingress.ts";
import { denyConsumingHttp, registerConsumingDescriptor } from "./consuming-turn-response.ts";
import { createPermissionBroker } from "./drivers/claude.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { BROKER_UNAVAILABLE_NOTE } from "./permission-pipe.ts";
import * as refusalLine from "./ledger-refusal-line.ts";
import { readBody } from "./read-body.ts";

const MIB = 1024 * 1024;
// The fixed notes of owner-turn-caps.ts, pinned by their words.
const ANSWER_TOO_LARGE = "Murage: the answer to this request was too large to pass on (over 64 MiB), so skip this action";
const ASK_TOO_LARGE = "Murage: this request was too large to ask about (over 64 MiB), so skip this action";
const PROXY = fileURLToPath(new URL("./permission-proxy.ts", import.meta.url));
const cleanups: Array<() => void | Promise<unknown>> = [];
// The release door (index.ts /api/internal/turn-release/v1/verdict): turn-release-door.ts when the build has it, else the same door as
// index.ts held it inline on c187b11166 (as server/cause22-owner-hops-witness-1021.test.ts does), so every row here also runs on that sha.
type DoorAuthority = ReturnType<typeof createProxyReleaseAuthority> & { bodyCap?(claim: unknown): number; answer?(claim: unknown, body: unknown): { payload: unknown; ownerTurn: boolean } };
type Door = (req: IncomingMessage, res: ServerResponse, ports: { capabilities: InternalCapabilities; authority: DoorAuthority; json: (res: ServerResponse, status: number, body: unknown) => void }) => Promise<void>;
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
const handleTurnReleaseDoor: Door = await import(/* @vite-ignore */ doorModule).then(module => module.handleTurnReleaseDoor as Door, () => inlineDoor);
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const plainJson = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

type Call = { id: number; inputBytes: number };
type Delivered = { id: number; decision?: { behavior?: string; message?: string; updatedInput?: { content?: string } }; error?: unknown };
/** One bound turn (`owner`: bound with the owner keep, as index.ts binds an owner turn), its real release door, and the real permission
 * proxy admitted to it. `answerBytes`: a plain socket answers ask N with an allow whose narrowed input is that many bytes. Absent: the
 * real permission broker of the same turn answers every ask it is given with the owner's allow. `fill`: the text that narrowed input
 * repeats, as it stands on the answer line (default one plain letter). The calls are written to the proxy
 * one at a time, each after the one before it was answered. */
async function permission(owner: boolean, calls: Call[], answerBytes?: number[], fill = "r") {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const refusals: unknown[] = [];
  const fixture = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { refusals.push(verdict); }, ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => fixture.close());
  const capabilities = new InternalCapabilities(); capabilities.begin(fixture.binding.identity.botId, fixture.turn.threadId, fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor("proxy:permission:frame", "body"), () => []);
  const door = createServer((req: IncomingMessage, res) => { void handleTurnReleaseDoor(req, res, { capabilities, authority, json: plainJson } as never); });
  const port = await listen(door);
  cleanups.push(() => new Promise(resolve => { door.closeAllConnections(); door.close(() => resolve(undefined)); }));

  const dir = mkdtempSync(join(tmpdir(), "murage-c22-perm-"));
  cleanups.push(() => removeTempDirSync(dir));
  // what the broker side was asked: the size of each ask's input text, in order; and how often its socket closed
  const asked: number[] = []; let brokerCloses = 0;
  let socketPath = join(dir, "p.sock");
  if (answerBytes) {
    const sockets = new Set<Socket>();
    const server = createSocketServer(conn => {
      sockets.add(conn); conn.on("error", () => {}); conn.on("close", () => { brokerCloses++; });
      let pending = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        pending += chunk;
        for (let nl; (nl = pending.indexOf("\n")) !== -1;) {
          const ask = JSON.parse(pending.slice(0, nl)); pending = pending.slice(nl + 1);
          const bytes = answerBytes[asked.length] ?? 16; asked.push(String(ask.input?.content ?? "").length);
          // one answer line of `bytes` narrowed input, written in 1 MiB pieces as the socket takes them
          const head = `{"t":"answer","id":${JSON.stringify(ask.id)},"behavior":"allow","updatedInput":{"file_path":"/fixture/out.txt","content":"`;
          const piece = fill.repeat(MIB / fill.length); let left = bytes;
          const pump = () => {
            while (left > 0) { const size = Math.min(left, MIB); left -= size; if (!conn.write(size === MIB ? piece : piece.slice(0, size))) { conn.once("drain", pump); return; } }
            conn.write('"}}\n');
          };
          conn.write(head); pump();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve(undefined)); }));
  } else {
    const broker = await createPermissionBroker({
      releaseBinding: fixture.binding, threadId: fixture.turn.threadId, socketPaths: [socketPath],
      onAsk: ask => { asked.push(String((ask.input as { content?: string } | undefined)?.content ?? "").length); broker.answer(ask.id, "allow", "Owner decision"); },
      onResolve: () => {},
    });
    socketPath = broker.socketPath;
    cleanups.push(() => broker.close());
  }

  const child: ChildProcess = spawn(process.execPath, [PROXY, socketPath], { stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token, MURAGE_RELEASE_URL: `http://127.0.0.1:${port}` } });
  cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const delivered: Delivered[] = [];
  let terminal: { reason?: string; frame?: { error?: { message?: string; data?: { code?: string } } } } | undefined, relayRefused: string | undefined, tail: Buffer[] = [];
  let wake = () => {};
  child.stderr!.resume();
  child.stdin!.on("error", () => {});
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
          delivered.push({ id: rpc.id, error: rpc.error, ...(rpc.result?.content ? { decision: JSON.parse(rpc.result.content[0].text) } : {}) });
        });
        if (child.connected) child.send({ type: "turn-release-ack", instanceId: envelope.instanceId, sequence: envelope.sequence });
      } catch (error) { relayRefused = String((error as Error).message); child.kill("SIGKILL"); }
      wake();
    }
  });
  child.on("message", (message: any) => { if (message?.type === "turn-release-terminal") { terminal = message; wake(); } });
  child.once("exit", () => wake());
  const settled = (id: number) => delivered.some(frame => frame.id === id) || terminal !== undefined || child.exitCode !== null || child.signalCode !== null;
  for (const call of calls) {
    if (terminal || child.exitCode !== null) break;
    const line = JSON.stringify({ jsonrpc: "2.0", id: call.id, method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "/fixture/in.txt", content: "w".repeat(call.inputBytes) } } } });
    // the engine's call as the relay forwards it (ingress.request), then its bytes on the proxy's stdin
    instance.ingress.request(JSON.stringify({ jsonrpc: "2.0", id: call.id, method: "tools/call", params: {} }), () => {});
    child.stdin!.write(line + "\n");
    // a call nobody answers within 90 s is left unanswered (its assertion then says so) instead of holding the case for ever
    const deadline = Date.now() + 90_000;
    while (!settled(call.id) && Date.now() < deadline) await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 1000); });
  }
  return { delivered, asked, refusals, get brokerCloses() { return brokerCloses; }, get terminal() { return terminal; }, get relayRefused() { return relayRefused; },
    answer: (id: number) => delivered.find(frame => frame.id === id) };
}

it("B1 owner turn: one broker answer over the 64 MiB ceiling denies that one request with the fixed note; the permission mount is not sealed and the next request is asked and allowed", async () => {
  const p = await permission(true, [{ id: 1, inputBytes: 64 }, { id: 2, inputBytes: 64 }], [70 * MIB, 16]);
  expect(p.terminal, "an oversized permission answer does not seal the owner's permission mount").toBeUndefined();
  expect(p.relayRefused).toBeUndefined();
  expect(p.refusals, "the owner's turn was not refused").toEqual([]);
  expect(p.answer(1)?.decision, "the one request is denied with the fixed note").toEqual({ behavior: "deny", message: ANSWER_TOO_LARGE });
  expect(ANSWER_TOO_LARGE.includes(BROKER_UNAVAILABLE_NOTE), "never the note the driver ends the turn on").toBe(false);
  expect(p.brokerCloses, "the broker socket stays open").toBe(0);
  expect(p.asked.length, "the next request of the same turn reached the broker").toBe(2);
  expect(p.answer(2)?.decision?.behavior, "and is answered with the owner's allow").toBe("allow");
}, 300_000);

it("B2 control, not a witness (r1 built this pass, so it is GREEN on c0174cc11d too): an owner turn's 20 MiB broker answer still passes the proxy's 8 MiB read cap whole through the new reader", async () => {
  const p = await permission(true, [{ id: 1, inputBytes: 64 }], [20 * MIB]);
  expect(p.terminal, "a 20 MiB permission answer does not seal the owner's permission mount").toBeUndefined();
  expect(p.answer(1)?.decision?.behavior, "the 20 MiB answer is delivered as the owner's allow").toBe("allow");
  expect(p.answer(1)?.decision?.updatedInput?.content?.length, "the narrowed input arrived whole").toBe(20 * MIB);
}, 300_000);

it("B3 owner turn: a 40 MiB ask passes the real broker's 32 MiB line cap; the broker answers it and the turn continues", async () => {
  const p = await permission(true, [{ id: 1, inputBytes: 40 * MIB }, { id: 2, inputBytes: 64 }]);
  expect(p.terminal, "a 40 MiB ask does not close the broker socket on the owner's turn").toBeUndefined();
  expect(p.refusals).toEqual([]);
  expect(p.asked, "the broker was asked both times, the first with every byte").toEqual([40 * MIB, 64]);
  expect(p.answer(1)?.decision?.behavior).toBe("allow");
  expect(p.answer(2)?.decision?.behavior).toBe("allow");
}, 300_000);

it("B4 owner turn: an ask over the 64 MiB ceiling is denied by the proxy with the fixed note and never sent; the next request is asked and allowed", async () => {
  const p = await permission(true, [{ id: 1, inputBytes: 70 * MIB }, { id: 2, inputBytes: 64 }]);
  expect(p.terminal, "an oversized ask does not seal the owner's permission mount").toBeUndefined();
  expect(p.refusals).toEqual([]);
  expect(p.answer(1)?.decision, "the oversized ask is denied with the fixed note").toEqual({ behavior: "deny", message: ASK_TOO_LARGE });
  expect(p.asked, "only the next request reached the broker").toEqual([64]);
  expect(p.answer(2)?.decision?.behavior).toBe("allow");
}, 300_000);

// MAIN-RULING cause22-no-transport-caps (1.0.21): the broker ask line has no size cap (drivers/claude.ts, drivers/bounded-lines.ts), so the
// 70 MiB ask is read whole and asked like any other. Before the ruling this row asserted the 64 MiB skip and its fixed denial.
it("B6 owner turn: a 70 MiB ask that reaches the real broker is read whole, asked and answered with the owner's decision; the socket stays and the next ask is answered", async () => {
  // r3 (sweep row A31b): the proxy denies such an ask itself only when it knows the turn is the owner's; when it does not (its door
  // answer failed or is stale) the ask is written, the broker skips the line, and on 2271914b37 nothing ever answered that tool call.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = consumingFixture(undefined, { botId: randomUUID(), continuePending: () => true });
  cleanups.push(() => fixture.close());
  const dir = mkdtempSync(join(tmpdir(), "murage-c22-perm-"));
  cleanups.push(() => removeTempDirSync(dir));
  const asked: string[] = [];
  const broker = await createPermissionBroker({
    releaseBinding: fixture.binding, threadId: fixture.turn.threadId, socketPaths: [join(dir, "p.sock")],
    onAsk: ask => { asked.push(ask.id); broker.answer(ask.id, "allow", "Owner decision"); },
    onResolve: () => {},
  });
  cleanups.push(() => broker.close());
  const conn = connectSocket(broker.socketPath);
  cleanups.push(() => { conn.destroy(); });
  const answers = new Map<string, { behavior?: string; message?: string }>(); let closed = false, pendingText = "", wake = () => {};
  conn.setEncoding("utf8");
  conn.on("error", () => {}); conn.on("close", () => { closed = true; wake(); });
  conn.on("data", (chunk: string) => {
    pendingText += chunk;
    for (let nl; (nl = pendingText.indexOf("\n")) !== -1;) { const line = JSON.parse(pendingText.slice(0, nl)); pendingText = pendingText.slice(nl + 1); answers.set(line.id, { behavior: line.behavior, message: line.message }); }
    wake();
  });
  await new Promise<void>(resolve => conn.once("connect", () => resolve()));
  // the proxy's own ask line (permission-proxy.ts: t, id, tool, input), 70 MiB of input written in 1 MiB pieces, then a small one
  conn.write('{"t":"ask","id":"big-1","tool":"Write","input":{"file_path":"/fixture/in.txt","content":"');
  const piece = "w".repeat(MIB);
  for (let sent = 0; sent < 70; sent++) if (!conn.write(piece)) await new Promise(resolve => conn.once("drain", resolve));
  conn.write('"}}\n');
  conn.write(JSON.stringify({ t: "ask", id: "small-2", tool: "Write", input: { file_path: "/fixture/in.txt", content: "w" } }) + "\n");
  const deadline = Date.now() + 120_000;
  while (!answers.has("small-2") && !closed && Date.now() < deadline) await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 250); });
  expect(closed, "a 70 MiB ask does not close the broker socket on the owner's turn").toBe(false);
  expect(answers.get("small-2")?.behavior, "the next ask is asked and allowed").toBe("allow");
  expect(answers.get("big-1"), "the 70 MiB ask gets the owner's decision, not a size denial").toEqual({ behavior: "allow", message: "Owner decision" });
  expect(asked, "both asks reached the owner, in order").toEqual(["big-1", "small-2"]);
}, 300_000);

it("B7 owner turn: a 40 MiB answer of quotes, over 64 MiB once the reply escapes it again, denies that one request with the fixed note; the next request is allowed", async () => {
  // r3 (sweep row B15c): the answer line is under the 64 MiB ceiling, but the decision travels as JSON inside the reply's JSON, where
  // every quote doubles again. On 2271914b37 that reply was swapped downstream for a tool error, not a permission answer.
  const p = await permission(true, [{ id: 1, inputBytes: 64 }, { id: 2, inputBytes: 64 }], [40 * MIB, 16], '\\"');
  expect(p.terminal, "an answer over the ceiling once escaped does not seal the owner's permission mount").toBeUndefined();
  expect(p.refusals).toEqual([]);
  expect(p.answer(1)?.decision, "the request whose escaped reply is over the ceiling is denied with the fixed note").toEqual({ behavior: "deny", message: ANSWER_TOO_LARGE });
  expect(p.answer(1)?.error, "it is a permission answer, not a tool error").toBeUndefined();
  expect(p.answer(2)?.decision?.behavior).toBe("allow");
}, 300_000);

// MAIN-RULING cause22-no-transport-caps (1.0.21): the broker's 32 MiB ask line cap is deleted (drivers/claude.ts, GROUP B), so the second
// half now asserts the 40 MiB ask is read by the broker. The proxy's own 8 MiB answer cap (first half) is GROUP A's (permission-proxy.ts).
it("B5 every other turn: a 9 MiB broker answer seals the proxy at its 8 MiB read cap; a 40 MiB ask is read whole by the broker (no ask line cap)", async () => {
  const answer = await permission(false, [{ id: 1, inputBytes: 64 }, { id: 2, inputBytes: 64 }], [9 * MIB, 16]);
  expect(answer.terminal?.frame?.error?.data?.code, "a non-owner permission mount is sealed at the 8 MiB answer cap").toBe("MEMORY_CONTEXT_REVOKED");
  expect(answer.delivered, "nothing is released after the seal").toEqual([]);
  const ask = await permission(false, [{ id: 1, inputBytes: 40 * MIB }, { id: 2, inputBytes: 64 }]);
  expect(ask.asked[0], "the broker read the 40 MiB ask whole").toBe(40 * MIB);
  expect(ask.terminal, "the broker does not close on a 40 MiB ask, so nothing seals the mount").toBeUndefined();
}, 300_000);
