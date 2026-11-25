// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 cause22 caps (Sean STANDING, MAIN-RULING local-memory-budget: an owner turn is never stopped, refused or sealed by a size or
// memory cap). Owners: lane cause22-caps owns the owner-turn behaviour of the mount relay's caps (cli-mount-relay.ts), the ingress's
// frame caps (consuming-turn-ingress.ts) and the single over-limit charge (release-budget.ts); cause4 owns the windows, revkill2 the
// held reply. On c187b11166 each cap below sealed the relay or refused the owner's turn (CAPS-INVENTORY rows A1, A5, A6, A10,
// A12-A17). Real fence, real deny reader, real SQLite ledger, real release budget, real ingress, real mount relay and its real unix
// socket; only the mount child (a custom stdio MCP server) and the CLI process are stand-ins, as in cause22-owner-mount-budget.
// MAIN-RULING cause22-no-transport-caps (Sean 11-22): the mount relay has NO size or count cap. Rows R1 (20 MiB reply), R3 (12,000
// frames) and R4 (20 MiB call) prove a large real item passes and the turn completes; RED on c187b11166 (2 MiB line, 10,000 frames).
// The rows that asserted a 64 MiB ceiling, a cut line or the 4096 in-flight count were deleted with those caps. Owners: lane
// cause22-main-fable owns these rows and cli-mount-relay.ts; group C (lane cause22-cli) owns the ingress and the chat MCP client.
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { refsLookup } from "../memory/deny-read.ts";
import type { LineageVerdict } from "../memory/lineage-types.ts";
import { BUDGET_VERDICT, RELEASE_LIMITS, reserveRelease } from "../memory/release-budget.ts";
import { MEMBER } from "../memory/testing/writetime-fixture.ts";
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
const { CliMountRelay, RelayedMount } = await import("./cli-mount-relay.ts");

const MIB = 1024 * 1024, PIECE = 64 * 1024;
// The fixed lines of owner-turn-caps.ts, pinned by their words (this file also runs on the base, where that module does not exist).
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (id: number, text = "") => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "computer", arguments: { text } } });
const TOO_MANY_CALLS = "Too many tool calls are waiting at once. Try this one again in a moment.";
const requestIdLast = (id: number, text = "") => JSON.stringify({ method: "tools/call", params: { name: "computer", arguments: { text } }, jsonrpc: "2.0", id });
const result = (id: number, bytes: number) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "s".repeat(bytes) }] } }) + "\n");
// the member order the MCP TypeScript SDK writes: the id AFTER the params or the result
const held = { kind: "line", threadId: "T", messageId: "X" } as const;
const dbBytes = (db: { prepare(sql: string): { get(): unknown } }) =>
  Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count) * Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);

/** One mounted turn attached to its CLI: the engine is the relay's real socket, the tool server is the mount child. */
async function mounted(owner: boolean, childStdinHighWaterMark = 256 * MIB) {
  const bound = RelayedMount.pendingWaitMs;
  RelayedMount.pendingWaitMs = 40; cleanups.push(() => { RelayedMount.pendingWaitMs = bound; });
  const warned: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(String(args[0])); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const verdicts: LineageVerdict[] = [];
  const f = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); }, ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "use the computer", warmIdentity: { botId: f.binding.identity.botId, audience: owner ? "owner" : "non-owner" },
    releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough({ highWaterMark: childStdinHighWaterMark }), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { computer: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawn);
  cleanups.push(() => relay.finish());
  const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, pid: undefined }) as unknown as ChildProcess;
  const failed = vi.fn();
  relay.attach(cli, failed);
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  let closed = false;
  socket.on("error", () => {}); socket.on("close", () => { closed = true; }); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: relay.ticket, server: "computer" }) + "\n");
  // the engine side: for each complete line its id, its error and the size of its result text; never the megabytes themselves
  const engine: Array<{ id?: number; error?: { code?: number; message?: string }; resultBytes?: number; method?: string }> = [];
  let engineBytes = 0, tail: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {
    engineBytes += chunk.length;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end < 0) { if (start < chunk.length) tail.push(chunk.subarray(start)); break; }
      const line = JSON.parse(Buffer.concat([...tail, chunk.subarray(start, end)]).toString("utf8")); tail = []; start = end + 1;
      engine.push({ id: line.id, error: line.error, method: line.method, ...(line.result ? { resultBytes: String(line.result.content?.[0]?.text ?? "").length } : {}) });
    }
  });
  // what the child was forwarded: each call's id and the size of its argument text
  const forwarded: Array<{ id: number; bytes: number }> = [];
  let childTail: Buffer[] = [];
  children[0]!.stdin!.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end < 0) { if (start < chunk.length) childTail.push(chunk.subarray(start)); break; }
      const line = JSON.parse(Buffer.concat([...childTail, chunk.subarray(start, end)]).toString("utf8")); childTail = []; start = end + 1;
      forwarded.push({ id: line.id, bytes: String(line.params?.arguments?.text ?? "").length });
    }
  });
  const child = children[0]!;
  const r = { f, relay, failed, socket, engine, forwarded, child, verdicts, warned,
    get engineBytes() { return engineBytes; },
    get socketClosed() { return closed; },
    ingress: () => relay.mounts.get("computer")!.mount.ingress,
    /** memory is checking:pending: a revoke walk is open over the thread whose line the turn holds */
    openPending: () => { f.f.job(1, 50).pending("T", 1); expect(refsLookup(f.f.db, [held], MEMBER)).toMatchObject({ state: "checking", reason: "pending" }); },
    clearPending: () => { f.f.db.exec("DELETE FROM memory_deny_pending"); f.f.db.prepare("UPDATE memory_revoke_jobs SET state='done'").run(); },
    /** the mount child writes bytes, in 64 KiB pieces as a pipe delivers them */
    emit: (frame: Buffer) => { for (let at = 0; at < frame.length; at += PIECE) child.stdout!.emit("data", frame.subarray(at, at + PIECE)); },
    /** the engine makes one call and the relay forwards it to the child */
    call: async (id: number) => { socket.write(request(id) + "\n"); await vi.waitFor(() => expect(forwarded.some(entry => entry.id === id)).toBe(true), { timeout: 10_000, interval: 5 }); },
    /** true once the turn was refused or the relay sealed (never on an owner turn) */
    stopped: () => f.refusals > 0 || failed.mock.calls.length > 0,
  };
  return r;
}
type Mounted = Awaited<ReturnType<typeof mounted>>;
/** Wait until the engine holds a line for `id`, or the turn was stopped; returns that line (undefined when stopped first). */
async function answered(r: Mounted, id: number, timeout = 60_000) {
  await vi.waitFor(() => expect(r.engine.some(line => line.id === id) || r.stopped()).toBe(true), { timeout, interval: 5 });
  return r.engine.find(line => line.id === id);
}
/** The turn is alive and completes: nothing refused, relay and ingress open, the next call's reply delivered, a clean finish. */
async function completes(r: Mounted, nextId: number) {
  expect(r.verdicts, "the owner turn was not refused").toEqual([]);
  expect(r.failed, "the relay is not sealed").not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  await r.call(nextId);
  r.emit(result(nextId, 1024));
  expect((await answered(r, nextId))?.resultBytes, "the next reply of the same turn is delivered").toBe(1024);
  await expect(r.relay.finish(), "the turn completes").resolves.toBe(true);
}

it("R1 owner turn: one 20 MiB tool result from a stdio server reaches the engine whole; the turn completes with its reply delivered", async () => {
  const r = await mounted(true);
  const before = dbBytes(r.f.f.db);
  await r.call(1);
  r.emit(result(1, 20 * MIB));
  const line = await answered(r, 1);
  expect(r.verdicts, "a 20 MiB result does not refuse the owner's turn").toEqual([]);
  expect(line?.resultBytes, "every byte of the result reached the engine").toBe(20 * MIB);
  expect(line?.error).toBeUndefined();
  expect(r.engineBytes).toBeGreaterThan(20 * MIB);
  expect(dbBytes(r.f.f.db) - before, "nothing of the result is stored in the ledger").toBeLessThan(MIB);
  expect(r.warned.filter(text => text.includes("ledger refusal"))).toEqual([]);
  await completes(r, 2);
}, 240_000);

it("R3 owner turn: 12,000 frames from one mount are all delivered (no frame count); the turn completes", async () => {
  const r = await mounted(true);
  // the engine is connected and has a call open (the relay then knows the connection of this mount)
  await r.call(1);
  r.emit(result(1, 16));
  expect((await answered(r, 1))?.resultBytes).toBe(16);
  const note = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) + "\n");
  for (let n = 0; n < 12_000 && !r.stopped(); n++) r.emit(note);
  expect(r.verdicts, "a frame count does not refuse the owner's turn").toEqual([]);
  expect(r.failed, "the relay is not sealed at 10,000 frames").not.toHaveBeenCalled();
  await vi.waitFor(() => expect(r.engine.filter(line => line.method === "notifications/progress")).toHaveLength(12_000), { timeout: 60_000, interval: 20 });
  await completes(r, 2);
}, 240_000);

it("R4 owner turn: a 20 MiB tool call from the engine reaches the tool server whole; the connection stays open and the turn completes", async () => {
  const r = await mounted(true);
  r.socket.write(request(1, "a".repeat(20 * MIB)) + "\n");
  await vi.waitFor(() => expect(r.forwarded.some(entry => entry.id === 1) || r.stopped() || r.socketClosed).toBe(true), { timeout: 60_000, interval: 5 });
  expect(r.failed, "a 20 MiB call does not seal the relay").not.toHaveBeenCalled();
  expect(r.forwarded.find(entry => entry.id === 1)?.bytes, "the whole call reached the tool server").toBe(20 * MIB);
  r.emit(result(1, 16));
  expect((await answered(r, 1))?.resultBytes).toBe(16);
  expect(r.socketClosed, "the engine connection stays open").toBe(false);
  await completes(r, 3);
}, 240_000);

it("R5 owner turn: replies written while the engine connection is busy (it needs drain) are taken and delivered in order; the relay is not sealed", async () => {
  const r = await mounted(true);
  for (const id of [1, 2, 3]) await r.call(id);
  r.socket.pause();
  // three 1.5 MiB replies back to back (each under every line cap): the first leaves the connection needing drain, which sealed the relay at the second
  for (const id of [1, 2, 3]) r.emit(result(id, MIB + MIB / 2));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(r.failed, "a busy engine connection does not seal the owner's relay").not.toHaveBeenCalled();
  expect(r.verdicts).toEqual([]);
  r.socket.resume();
  for (const id of [1, 2, 3]) expect((await answered(r, id))?.resultBytes, `reply ${id} is delivered whole`).toBe(MIB + MIB / 2);
  expect(r.engine.filter(line => line.id !== undefined).map(line => line.id), "in order").toEqual([1, 2, 3]);
  await completes(r, 4);
}, 240_000);

for (const owner of [false, true]) it(`R10 ${owner ? "owner turn" : "every other turn"}: a call that arrives while the mount child's stdin is busy is written behind the first and served, never a seal`, async () => {
  // SITES #24b, the engine-to-child direction. The child's stdin holds 16 bytes and the child is not reading, so the first call leaves
  // it needing drain; the second call is in the same write from the engine, so the relay meets it while the pipe is still busy.
  // On c187b11166 that second call sealed the relay (writableNeedDrain -> MEMORY_CONTEXT_REVOKED).
  const r = await mounted(owner, 16);
  (r.child.stdin as unknown as PassThrough).pause();
  r.socket.write(request(1) + "\n" + request(2) + "\n");
  await vi.waitFor(() => expect(r.child.stdin!.writableNeedDrain, "the rig's child stdin is busy").toBe(true), { timeout: 10_000, interval: 5 });
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(r.stopped(), "a busy child stdin does not seal the relay or refuse the turn").toBe(false);
  expect(r.socketClosed).toBe(false);
  (r.child.stdin as unknown as PassThrough).resume();
  await vi.waitFor(() => expect(r.forwarded.map(entry => entry.id), "both calls reach the child once it reads again, in order").toEqual([1, 2]), { timeout: 10_000, interval: 5 });
  for (const id of [1, 2]) { r.emit(result(id, 1024)); expect((await answered(r, id))?.resultBytes, `call ${id} is answered`).toBe(1024); }
  expect(r.stopped()).toBe(false);
}, 120_000);

it("R6 owner turn: a reply that meets a pending memory check and 300 more chunks (past the old 256-chunk cap) behind it are delivered in order, nothing sealed", async () => {
  const r = await mounted(true);
  await r.call(1); await r.call(2);
  r.openPending();
  // the first reply meets checking:pending on what the turn already holds; 300 more chunks (one 19 MiB reply) arrive behind it
  r.emit(result(1, 1024));
  r.emit(result(2, 19 * MIB));
  expect(r.failed, "chunks past 256 do not seal the owner's relay").not.toHaveBeenCalled();
  expect(r.verdicts).toEqual([]);
  // 1.0.22 userbug-sealed (changed expectation, was: each held reply dropped with the -32000 error at the bound): memory readiness never
  // refuses or drops the owner's own running turn (send-fence.ts ownerHeldPendingProposal), so both replies reach the engine whole, in
  // order, with no hold; the hold-then-drop at the bound stays for every other turn (mount-pending-defer-1020.test.ts REVKILL2 bound).
  expect((await answered(r, 1))?.resultBytes).toBe(1024);
  expect((await answered(r, 2))?.resultBytes).toBe(19 * MIB);
  expect(r.verdicts).toEqual([]);
  r.clearPending();
  await completes(r, 3);
}, 240_000);

// MAIN-RULING cause22-no-transport-caps (2026-11-22T14:29:39Z): "DELETE ... the CHAT_MCP_MAX_FRAMES / 4096 count seals". The count of calls in
// flight is deleted in consuming-turn-ingress.ts (group C, cause22-cli-caps-witness-1021 V3), so the 4097th call is forwarded like every
// other and answered by the tool server; it used to be answered with the fixed "too many calls" line.
it("R7 owner turn: the 4097th call in flight is forwarded like every other and answered by the tool server (no count of calls in flight)", async () => {
  const r = await mounted(true);
  for (let id = 1; id <= 4096; id++) r.socket.write(request(id) + "\n");
  // one more than the old count, with its id after its params (as the MCP TypeScript SDK writes a call)
  r.socket.write(requestIdLast(4097) + "\n");
  await vi.waitFor(() => expect(r.forwarded.some(entry => entry.id === 4097)).toBe(true), { timeout: 30_000, interval: 10 });
  expect(r.verdicts, "many calls in flight do not refuse the owner's turn").toEqual([]);
  expect(r.forwarded.filter(entry => entry.id <= 4096)).toHaveLength(4096);
  r.emit(result(4097, 64));
  const line = await answered(r, 4097);
  expect(line?.resultBytes, "the 4097th call gets the tool server's own reply").toBe(64);
  expect(JSON.stringify(line?.error ?? null), "never the old fixed line").not.toContain(TOO_MANY_CALLS);
  // the calls in flight are still answered
  r.emit(result(1, 64));
  expect((await answered(r, 1))?.resultBytes).toBe(64);
  expect(r.failed).not.toHaveBeenCalled();
}, 240_000);

it("R8 the owner's budget takes one charge above a whole limit (a 64 MiB frame delivered as one write); an invalid cost still refuses", () => {
  const owner = consumingFixture(undefined, { botId: randomUUID(), continuePending: () => true });
  cleanups.push(() => owner.close());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn (the byte budget is gone; this was one byte over it)
  expect(() => reserveRelease([owner.budget], { bytes: 64 * MIB + 1 }), "no size stops the owner's turn").not.toThrow();
  expect(() => reserveRelease([owner.budget], { work: RELEASE_LIMITS.work + 1 })).not.toThrow();
  expect(owner.refusals).toBe(0);
  expect(owner.budget.refused).toBe(false);
  expect(owner.budget.degraded?.windows, "the crossing is recorded").toBeGreaterThanOrEqual(1);
  expect(() => reserveRelease([owner.budget], { work: -1 }), "an invalid cost is a bug, not a size").toThrow("MEMORY_CONTEXT_REVOKED");
  expect(owner.refusals).toBe(1);
});

it("R9 every other turn: replies written while the engine connection is busy are delivered, never a seal; one over-limit budget charge still stops it (the budget is not a transport cap)", async () => {
  // busy engine connection
  const busy = await mounted(false);
  for (const id of [1, 2]) await busy.call(id);
  busy.socket.pause();
  for (const id of [1, 2]) busy.emit(result(id, MIB + MIB / 2));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(busy.failed, "a busy engine connection does not seal a non-owner relay either").not.toHaveBeenCalled();
  busy.socket.resume();
  for (const id of [1, 2]) expect((await answered(busy, id))?.resultBytes, "both replies are delivered once the engine reads again").toBe(MIB + MIB / 2);
  // one charge above a whole limit. MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a
  // turn; bytes have no limit any more, so the over-limit charge is on work (it was RELEASE_LIMITS.bytes + 1)
  const other = consumingFixture(undefined, { botId: randomUUID(), onRefused: () => {} });
  cleanups.push(() => other.close());
  let thrown: unknown;
  try { reserveRelease([other.budget], { work: RELEASE_LIMITS.work + 1 }); } catch (error) { thrown = error; }
  expect((thrown as { fence?: LineageVerdict } | undefined)?.fence, "a non-owner budget refuses one over-limit charge").toEqual(BUDGET_VERDICT);
}, 240_000);
