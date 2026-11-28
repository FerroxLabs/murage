// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1023-winfirst (1): a spawned mount proxy whose release-door call meets a keep-alive socket the server already closed. Owners: lane
// q1023-winfirst owns the proxy child's door transport (proxy-turn-release.ts doorFetch); cause22 caps owns the door and its authority
// (turn-release-door.ts, consuming-turn-ingress.ts), used here unchanged.
// Release finding (fresh Windows box, first Fuigo turn): both bundled mounts ("agents", "browser") died at once with
// stderr=proxy.reserveupstream/typeerror, the MCP gate waited 17 s and the turn ended "Murage couldn't start this reply". The children
// had answered `initialize`, then sat idle while the browser engine took 5197 ms to start: past Node's 5 s keep-alive timeout on the
// server, so their next door call went out on a socket the server had closed and fetch rejected with "fetch failed" (a TypeError,
// nothing answered, nothing reserved). One such call sealed the whole mount.
// Nothing under test is replaced: a REAL spawned child running the real proxy-turn-release.ts (testing/cause22-proxy-child.fixture.ts)
// with the release environment a mount admission gives it, the REAL door handler (handleTurnReleaseDoor) and the real authority,
// ingress and ledger of a bound turn. The only stand-in is the server closing an idle keep-alive socket: the first door call of the
// chosen kind that arrives on a reused socket finds it closed (destroyed before any byte of it is read, as a server-side keep-alive
// close crossing the request), which is the race the cold box ran into. A new connection is served as usual.
import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, decodeReleaseEnvelope } from "./consuming-turn-ingress.ts";
import { registerConsumingDescriptor } from "./consuming-turn-response.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { handleTurnReleaseDoor } from "./turn-release-door.ts";

const CHILD = fileURLToPath(new URL("./testing/cause22-proxy-child.fixture.ts", import.meta.url));
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const plainJson = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
// A reserve body is {"operation":"upstream","instanceId":<uuid>,"bytes":N} (under 160 bytes); a verdict body carries the frame and its digest.
const RESERVE_MAX_BODY = 160;
type Kind = "reserve" | "verdict";

/** One bound owner turn, its real release door behind a server that closes the first reused socket a `kind` call arrives on, and one
 * spawned proxy child admitted to it that answers `initialize` and then one tool call. `closes` 2: the call sent again on its new
 * connection is closed as well (the negative row: one more try, never a loop). */
async function coldMount(kind: Kind, owner: boolean, closes: 1 | 2 = 1) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const refusals: unknown[] = [];
  const fixture = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { refusals.push(verdict); }, ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => fixture.close());
  const capabilities = new InternalCapabilities(); capabilities.begin(fixture.binding.identity.botId, fixture.turn.threadId, fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
  for (const id of [0, 1]) instance.ingress.request(JSON.stringify({ jsonrpc: "2.0", id, method: id === 0 ? "initialize" : "tools/call", params: {} }), () => {});
  const served = new WeakSet<Socket>();
  let closedOnReuse = 0;
  const server = createServer((req, res) => {
    const bytes = Number(req.headers["content-length"] ?? 0);
    const isKind = kind === "reserve" ? bytes < RESERVE_MAX_BODY : bytes >= RESERVE_MAX_BODY;
    if (isKind && (closedOnReuse === 0 && served.has(req.socket) || closedOnReuse === 1 && closes === 2)) { closedOnReuse++; req.socket.destroy(); return; }
    served.add(req.socket);
    void handleTurnReleaseDoor(req, res, { capabilities, authority, json: plainJson });
  });
  const port = await listen(server);
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  const child: ChildProcess = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token, MURAGE_RELEASE_URL: `http://127.0.0.1:${port}`,
      FIXTURE_PLAN: JSON.stringify([{ op: "frame", id: 1, bytes: 64 }]) } });
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
        // the mount relay's part (mcp-mounts.ts accept): decode at the trusted ingress, deliver, acknowledge over IPC
        const envelope = decodeReleaseEnvelope(line, (instance.ingress as { ownerTurn?: boolean }).ownerTurn === true);
        instance.ingress.deliver(envelope, frame => { const rpc = JSON.parse(frame); frames.push({ id: rpc.id, ...(rpc.result?.content ? { resultBytes: String(rpc.result.content[0]?.text ?? "").length } : {}) }); });
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
  await done;
  return { frames, reports, refusals, closedOnReuse: () => closedOnReuse, terminal: () => terminal, relayRefused: () => relayRefused,
    step: (index: number) => reports.find(entry => entry.step === index) };
}

// SITES.md rows: proxy-turn-release.ts reserveProxyUpstream (the release finding's site) and processProxyRelease verdict, the only two
// door fetches a proxy child makes; on the owner's first turn and on a turn that is not the owner's.
const ROWS: Array<{ kind: Kind; owner: boolean }> = [
  { kind: "reserve", owner: true }, { kind: "verdict", owner: true }, { kind: "reserve", owner: false }, { kind: "verdict", owner: false },
];
for (const row of ROWS) {
  it(`W1-${row.kind}-${row.owner ? "owner" : "other"}: a door ${row.kind} call that meets a closed keep-alive socket goes again on a new connection; the mount answers its tool call and is not sealed`, async () => {
    const p = await coldMount(row.kind, row.owner);
    expect(p.closedOnReuse(), "the server closed one reused socket under a door call of this kind (the stand-in ran)").toBe(1);
    expect(p.terminal()?.reason, "the mount is not sealed by a socket the server closed before reading the call").toBeUndefined();
    expect(p.step(0), "the tool call is answered").toEqual(expect.objectContaining({ released: 1 }));
    expect(p.frames.find(frame => frame.id === 1)?.resultBytes, "the answer reached the relay side whole").toBe(64);
    expect(p.relayRefused(), "the ingress took every envelope").toBeUndefined();
    expect(p.refusals, "the turn was not refused").toEqual([]);
  }, 60_000);
}

// Opus self-review M1: the call goes again once. When its new connection is closed too, the mount is sealed as before (a bounded retry,
// never a loop that hides a server that is gone).
for (const kind of ["reserve", "verdict"] as const) {
  it(`W1-${kind}-twice: a door ${kind} call whose second connection is closed as well still seals the mount`, async () => {
    const p = await coldMount(kind, true, 2);
    expect(p.closedOnReuse(), "the server closed the reused socket and the new one (the stand-in ran twice)").toBe(2);
    expect(p.terminal()?.reason, "a second closed connection seals the mount").toBe(kind === "reserve" ? "upstream-reserve" : "verdict-failed");
    expect(p.frames.find(frame => frame.id === 1), "no answer reached the relay side").toBeUndefined();
  }, 60_000);
}
