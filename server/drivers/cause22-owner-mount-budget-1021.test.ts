// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.21 cause22 (TRIAGE-STOPS-1122 rows 2, 4, 6; Sean's computer-use run). Owners: this lane owns the owner keep of the release budget
// (release-budget.ts keepOwner, bound in lineage-write.ts bindRetainedTurn), the budget refusal line (ledger-refusal-line.ts) and the
// denial door's cause word (consuming-turn-response.ts denyConsumingHttp); cause4 owns the windows, revkill2 owns the held reply.
// Sean, No limits: an OWNER turn is never stopped for memory bookkeeping. On rc/1021-r2 c3f339db41 about 16 MiB of mount output with no
// delivered reply in the window (replies held behind a pending memory check and then dropped) refused the owner's turn as
// checking:retained-budget and replaced its reply with "I stopped this turn because some of its context is no longer available."
// Real fence, real deny reader, real SQLite ledger, real release budget, real ingress and mount relay line path; only the mount child and
// the CLI process are stand-ins (as mount-pending-defer-1020.test.ts).
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { consumingFixture, consumingResponseRecorder } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, frameDigest } from "../consuming-turn-ingress.ts";
import { denyConsumingHttp, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { BUDGET_REFUSAL_LINE, LEDGER_REFUSAL_LINE, createLedgerRefusal } from "../ledger-refusal.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { refsLookup } from "../memory/deny-read.ts";
import { checkedOpenTurns, turnWithheldFromBots } from "../memory/lineage-write.ts";
import type { LineageVerdict } from "../memory/lineage-types.ts";
import { BUDGET_VERDICT, RELEASE_LIMITS, UPSTREAM_COLLECTION_MAX, reserveRelease } from "../memory/release-budget.ts";
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
const CALLS = 200, SCREENSHOTS = 12, SCREENSHOT_BYTES = MIB, RESULT_BYTES = 45 * 1024;
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "computer" } });
const result = (id: number, bytes: number) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "s".repeat(bytes) }] } }) + "\n");
const held = { kind: "line", threadId: "T", messageId: "X" } as const;
const dbBytes = (db: { prepare(sql: string): { get(): unknown } }) =>
  Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count) * Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);

/** One mounted turn attached to its CLI: the fake engine is the relay socket, the fake computer-use server is the mount child. */
async function mounted(owner: boolean) {
  const bound = RelayedMount.pendingWaitMs;
  RelayedMount.pendingWaitMs = 5; cleanups.push(() => { RelayedMount.pendingWaitMs = bound; });
  const warned: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(String(args[0])); });
  const verdicts: LineageVerdict[] = [];
  // The owner's keep hook (index.ts continueOwnerPending, a running owner turn: it keeps). A mount reply is proposed together with what the
  // turn already holds (consuming-turn-ingress.ts issue), so under checking:pending it is deferred whatever the hook says: held, then dropped.
  const f = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); },
    ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "use the computer", warmIdentity: { botId: f.binding.identity.botId, audience: owner ? "owner" : "non-owner" },
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
  // the engine side: complete lines only, and every byte it was given
  const engine: Array<{ id?: number; error?: { code?: number; message?: string }; result?: unknown }> = [];
  let engineBytes = 0, tail = "";
  socket.on("data", chunk => {
    engineBytes += chunk.length; tail += String(chunk);
    const lines = tail.split("\n"); tail = lines.pop()!;
    for (const line of lines) if (line) engine.push(JSON.parse(line));
  });
  const forwarded: number[] = [];
  let childTail = "";
  children[0]!.stdin!.on("data", chunk => {
    childTail += String(chunk);
    const lines = childTail.split("\n"); childTail = lines.pop()!;
    for (const line of lines) if (line) forwarded.push(JSON.parse(line).id);
  });
  const child = children[0]!;
  return { f, relay, failed, socket, engine, forwarded, child, verdicts, warned,
    get engineBytes() { return engineBytes; },
    ingress: () => relay.mounts.get("computer")!.mount.ingress,
    open: () => checkedOpenTurns(f.turn)[0]!,
    /** memory is checking:pending: a revoke walk is open over the thread whose line the turn holds */
    openPending: () => { f.f.job(1, 50).pending("T", 1); expect(refsLookup(f.f.db, [held], MEMBER)).toMatchObject({ state: "checking", reason: "pending" }); },
    clearPending: () => { f.f.db.exec("DELETE FROM memory_deny_pending"); f.f.db.prepare("UPDATE memory_revoke_jobs SET state='done'").run(); },
    /** the mount child writes one tool result, in 64 KiB pieces as a pipe delivers it */
    emit: (frame: Buffer) => { for (let at = 0; at < frame.length; at += PIECE) child.stdout!.emit("data", frame.subarray(at, at + PIECE)); },
  };
}

/** The computer-use turn: CALLS tool calls already made, then their results (12 screenshots of 1 MiB, the rest 45 KiB: over 20 MiB)
 * arrive one after another while memory stays checking:pending, so each reply is held and then dropped. Stops at the first refusal. */
async function computerUseTurn(r: Awaited<ReturnType<typeof mounted>>) {
  for (let id = 1; id <= CALLS; id++) r.socket.write(request(id) + "\n");
  await vi.waitFor(() => expect(r.forwarded).toHaveLength(CALLS), { timeout: 20_000 });
  // Every forwarded call was an accepted release of window 1. A long turn is always somewhere inside a window; the results arrive at the
  // start of a fresh one (the rest of window 1 is spent, as cause4 C4-2 does), which holds no accepted release of its own (TRIAGE 2a).
  r.f.budget.charge({ statements: RELEASE_LIMITS.statements - r.f.budget.counts.statements });
  r.f.budget.charge({ statements: 1 });
  expect(r.f.budget.windows).toBe(2); expect(r.f.budget.acceptedReleases).toBe(0);
  r.openPending();
  let upstream = 0, dropped = 0;
  for (let id = 1; id <= CALLS; id++) {
    const frame = result(id, id % Math.floor(CALLS / SCREENSHOTS) === 0 ? SCREENSHOT_BYTES : RESULT_BYTES);
    upstream += frame.length;
    r.emit(frame);
    // answered (the held reply was dropped: the content-free error), or the turn was refused
    await vi.waitFor(() => expect(r.engine.some(line => line.id === id) || r.f.refusals > 0 || r.failed.mock.calls.length > 0).toBe(true), { timeout: 10_000, interval: 2 });
    if (r.f.refusals > 0 || r.failed.mock.calls.length > 0) break;
    if (r.engine.find(line => line.id === id)?.error?.code === -32000) dropped++;
  }
  return { upstream, dropped };
}

it("W22-1 owner turn: 200 tool calls and 20 MiB of results held then dropped under checking:pending never stop the turn; their volume does not degrade the budget", async () => {
  const r = await mounted(true);
  const before = dbBytes(r.f.f.db);
  const { upstream, dropped } = await computerUseTurn(r);
  // row 2: no refusal for the owner's turn, the relay and its ingress stay open
  expect(r.verdicts, "refusal count 0 for the owner turn").toEqual([]);
  expect(upstream, "the turn moved more than 20 MiB of tool results").toBeGreaterThan(20 * MIB);
  expect(r.f.refusals).toBe(0);
  expect(r.failed, "the relay is not sealed").not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  // 1.0.22 userbug-sealed (changed expectation, CHANGED-EXPECTATIONS.md): the owner's replies are delivered whole, none is held to its bound and dropped
  expect(dropped, "no reply of the owner's turn was dropped").toBe(0);
  expect(r.warned.filter(line => line.startsWith("[mount-relay] a tool reply still waiting for its memory check was dropped"))).toHaveLength(0);
  const told = JSON.stringify(r.engine);
  expect(told).not.toContain(LEDGER_REFUSAL_LINE);
  expect(told).not.toContain(BUDGET_REFUSAL_LINE);
  expect(r.engineBytes, "every result reached the engine").toBeGreaterThan(20 * MIB);
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the per-byte work of
  // the 20 MiB crossed the work limit, so the budget degraded (crossed "work", budgetDegraded on the turn, one degraded log line). Now
  // upstream bytes are counted, not charged as work: nothing crosses, nothing degrades.
  expect(r.f.budget.degraded, "transport volume is not a crossing").toBeUndefined();
  expect(r.open().budgetDegraded).toBeUndefined();
  expect(r.f.budget.counts.bytes, "every upstream byte is counted").toBeGreaterThanOrEqual(upstream);
  // not a revoke: the reply is never marked "bots no longer see this reply: it used something you deleted or changed"
  expect(turnWithheldFromBots(r.f.turn), "a kept budget crossing is not a privacy revoke").toBe(false);
  expect(r.open().redactions, "nothing of the reply is redacted").toBeUndefined();
  expect(r.warned.filter(line => line.startsWith("[memory] release budget degraded"))).toEqual([]);
  expect(r.warned.some(line => line.includes("ledger refusal"))).toBe(false);
  // retained bytes bounded: each window's counters stay inside the limits and the ledger did not grow with the 20 MiB
  for (const key of Object.keys(RELEASE_LIMITS) as Array<keyof typeof RELEASE_LIMITS>) expect(r.f.budget.counts[key]).toBeLessThanOrEqual(RELEASE_LIMITS[key]);
  expect(dbBytes(r.f.f.db) - before, "nothing of the tool results is retained in the ledger").toBeLessThan(MIB);
  // the turn completes: once the check settles, the next call's reply is delivered whole
  r.clearPending();
  r.socket.write(request(CALLS + 1) + "\n");
  await vi.waitFor(() => expect(r.forwarded).toContain(CALLS + 1), { timeout: 5000 });
  r.emit(result(CALLS + 1, SCREENSHOT_BYTES));
  await vi.waitFor(() => expect(r.engine.find(line => line.id === CALLS + 1)?.result, "the reply is delivered").toBeDefined(), { timeout: 5000 });
  expect(r.engineBytes).toBeGreaterThan(SCREENSHOT_BYTES);
  expect(r.f.refusals).toBe(0);
  await expect(r.relay.finish(), "the turn completes").resolves.toBe(true);
}, 240_000);

it("W22-2 the same turn of a non-owner is no longer refused for its volume; a budget refusal of it is still told the budget line (never the context line)", async () => {
  const r = await mounted(false);
  // the real refusal lifecycle (ledger-refusal.ts) settles and presents; only its ports are recorders
  const presented: string[] = [], settled: LineageVerdict[] = [];
  const lifecycle = createLedgerRefusal({ ...r.f.binding.identity }, { seal() {}, interrupt: async () => true, quarantine() {},
    settle(_reason, verdict) { settled.push(verdict); }, present(line) { presented.push(line); } });
  const { upstream } = await computerUseTurn(r);
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: this non-owner turn
  // was refused as checking:retained-budget at the work limit of one window (about 16 MiB of held then dropped output) and sealed.
  expect(r.verdicts, "a non-owner turn is not refused for the volume of its mount output").toEqual([]);
  expect(upstream, "all of the 20 MiB moved").toBeGreaterThan(20 * MIB);
  expect(r.failed).not.toHaveBeenCalled();
  expect(r.ingress().sealed).toBe(false);
  expect(r.f.budget.refused).toBe(false);
  expect(r.f.budget.degraded, "no owner keep on a non-owner turn").toBeUndefined();
  expect(turnWithheldFromBots(r.f.turn)).toBe(false);
  // the budget line is still what a budget refusal is told: a crossing of the work limit (not transport) seals a non-owner budget
  expect(() => r.f.budget.charge({ work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(r.verdicts, "a non-owner turn keeps the budget refusal").toEqual([BUDGET_VERDICT]);
  lifecycle.onLedgerRefused(r.verdicts[0]!);
  await vi.waitFor(() => expect(presented).toHaveLength(1));
  expect(settled).toEqual([BUDGET_VERDICT]);
  expect(presented[0], "row 4: a bookkeeping refusal is told as what it is").toBe(BUDGET_REFUSAL_LINE);
  expect(presented[0]).not.toBe(LEDGER_REFUSAL_LINE);
  expect(BUDGET_REFUSAL_LINE).not.toMatch(/context is no longer available/);
  expect(r.f.budget.refused).toBe(true);
}, 240_000);

it("W22-3 row 4 guard: every refusal that is not the budget keeps the context line", async () => {
  for (const verdict of [{ state: "withheld", reason: "deny-line" }, { state: "checking", reason: "pending" }, { state: "checking", reason: "retained-over" }] as LineageVerdict[]) {
    const presented: string[] = [];
    const lifecycle = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["G"], adapterLeaseId: "G" },
      { seal() {}, interrupt: async () => true, quarantine() {}, settle() {}, present(line) { presented.push(line); } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    lifecycle.onLedgerRefused(verdict);
    await vi.waitFor(() => expect(presented).toHaveLength(1));
    expect(presented[0]).toBe(LEDGER_REFUSAL_LINE);
  }
});

/** The proxy-child door (index.ts /api/internal/turn-release -> reserveUpstream): 8 MiB reservations with no reply delivered. */
function proxyDoor(owner: boolean | "room") {
  const warned: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(String(args[0])); });
  const verdicts: LineageVerdict[] = [];
  const f = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); },
    ...(owner === "room" ? { ownerTurn: true } : owner ? { continuePending: () => false } : {}) });
  cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  const instance = authority.register(f.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
  const claim = caps.resolve(`Bearer ${instance.token}`)!;
  const reserve = () => authority.reserveUpstream(claim, { operation: "upstream", instanceId: instance.instanceId, bytes: UPSTREAM_COLLECTION_MAX });
  /** The same door's verdict for the instance's first frame. */
  const verdict = (frame: string) => authority.verdict(claim, { instanceId: instance.instanceId, sequence: 1, descriptor: "proxy:custom:frame", requestId: null,
    bytes: Buffer.byteLength(frame), digest: frameDigest(frame), frame });
  return { f, verdicts, warned, reserve, verdict, instance };
}

it("W22-4 row 6: a budget stop at the proxy-child door is logged with its real cause, not as consuming-http-denied", () => {
  const door = proxyDoor(false);
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the second 8 MiB
  // upstream reserve crossed the window's work limit (bytes + 1 each) and was the budget stop. Now the stop is made at the same door's
  // verdict: the window's work is full with no accepted release, so the verdict's own bookkeeping work crosses it.
  door.reserve(); door.reserve();
  expect(door.verdicts, "two 8 MiB reserves are not a refusal").toEqual([]);
  door.f.budget.charge({ work: RELEASE_LIMITS.work - door.f.budget.counts.work });
  let thrown: unknown;
  try { door.verdict(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })); } catch (error) { thrown = error; }
  expect((thrown as Error | undefined)?.message).toBe("MEMORY_CONTEXT_REVOKED");
  expect(door.verdicts).toEqual([BUDGET_VERDICT]);
  expect((thrown as { fence?: LineageVerdict }).fence, "the refusing check's fixed verdict travels with the denial").toEqual(BUDGET_VERDICT);
  const sink = consumingResponseRecorder();
  denyConsumingHttp(sink.raw, undefined, thrown);
  expect(sink.output[0]?.status).toBe(409);
  const lines = door.warned.filter(line => line.startsWith("[memory] ledger refusal cause="));
  expect(lines, "the door names the real cause").toContain("[memory] ledger refusal cause=checking:retained-budget door=consuming-http-denied");
  expect(lines).not.toContain("[memory] ledger refusal cause=consuming-http-denied");
  // cause22 caps: the route is no longer pinned by its source text here. The real route (turn-release-door.ts handleTurnReleaseDoor,
  // the code index.ts runs) is driven in cause22-owner-caps-proxy-1021.test.ts: a real proxy child's frame meets a real budget stop
  // of a non-owner turn and is told the budget line through the door's own 409 (P7).
});

it("W22-5 row 6 guard: a denial with no verdict, or with words outside the fixed vocabulary, keeps the door's own label", () => {
  const warned: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(String(args[0])); });
  denyConsumingHttp(consumingResponseRecorder().raw);
  denyConsumingHttp(consumingResponseRecorder().raw, undefined, new Error("MEMORY_CONTEXT_REVOKED"));
  denyConsumingHttp(consumingResponseRecorder().raw, undefined, Object.assign(new Error("x"), { fence: { state: "checking", reason: "owner typed words" } }));
  expect(warned).toEqual(Array(3).fill("[memory] ledger refusal cause=consuming-http-denied"));
});

it("W22-6 owner turn at the proxy-child door: 40 MiB reserved with no delivered reply is not a refusal", () => {
  const door = proxyDoor(true);
  expect(() => { for (let n = 0; n < 5; n++) door.reserve(); }, "the owner's turn is not stopped at this door either").not.toThrow();
  expect(door.verdicts).toEqual([]);
  expect(door.f.refusals).toBe(0);
  expect(door.instance.ingress.sealed).toBe(false);
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the per-byte work
  // degraded the owner's budget (degraded.windows >= 2); now the 40 MiB is counted, never a crossing.
  expect(door.f.budget.degraded).toBeUndefined();
  expect(door.f.budget.counts.bytes, "counted").toBeGreaterThanOrEqual(5 * UPSTREAM_COLLECTION_MAX);
  expect(door.warned.filter(line => line.includes("ledger refusal"))).toEqual([]);
});

// cause22 caps (Sean STANDING: no size stops an owner turn; FABLE c76dbfa42f asked for this flip): one cost above a whole limit no
// longer refuses the owner's turn (a 64 MiB frame is delivered as one write). The assertion that pinned that refusal is replaced on
// purpose. What still refuses an owner turn is a cost that is not a size at all (negative: a bug), and a budget already sealed.
it("W22-7 an owner turn is not refused by one cost above a whole limit; an invalid cost still refuses it, and a sealed budget stays sealed", () => {
  const over = proxyDoor(true);
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the over-limit charge
  // was one byte over the 64 MiB byte budget (gone): a transport charge of any size is now no crossing at all, and the
  // owner rule is pinned with the work limit, which is still one.
  expect(() => reserveRelease([over.f.budget], { bytes: 64 * MIB + 1 }), "a 64 MiB transport charge is no crossing").not.toThrow();
  expect(over.f.budget.degraded).toBeUndefined();
  expect(() => reserveRelease([over.f.budget], { work: RELEASE_LIMITS.work + 1 }), "one over-limit charge is kept by the owner rule").not.toThrow();
  expect(over.verdicts).toEqual([]);
  expect(over.f.budget.degraded?.windows).toBeGreaterThanOrEqual(1);
  const invalid = proxyDoor(true);
  expect(() => reserveRelease([invalid.f.budget], { work: -1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(invalid.verdicts, "an invalid cost is not kept by the owner rule").toEqual([BUDGET_VERDICT]);
  expect(invalid.f.budget.degraded).toBeUndefined();
  expect(() => invalid.f.budget.charge({ work: 0 }), "sealed for good").toThrow("MEMORY_CONTEXT_REVOKED");
  // every other turn: a transport charge of any size is not refused either (before: refused); an over-limit work charge refuses as before
  const other = proxyDoor(false);
  expect(() => reserveRelease([other.f.budget], { bytes: 64 * MIB + 1 })).not.toThrow();
  expect(other.verdicts).toEqual([]);
  expect(() => reserveRelease([other.f.budget], { work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(other.verdicts).toEqual([BUDGET_VERDICT]);
});

it("W22-8 a room turn answering only the owner (no keep hook, the owner flag alone) is not stopped by its budget either", () => {
  const door = proxyDoor("room");
  expect(() => { for (let n = 0; n < 5; n++) door.reserve(); }, "the room owner turn is kept").not.toThrow();
  expect(door.verdicts).toEqual([]);
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the 40 MiB of
  // reserves crossed "work" and the owner flag kept it (degraded); they are no crossing now, so the keep is pinned with a work crossing.
  expect(door.f.budget.degraded).toBeUndefined();
  expect(() => reserveRelease([door.f.budget], { work: RELEASE_LIMITS.work + 1 }), "the owner flag alone keeps a work crossing").not.toThrow();
  expect(door.verdicts).toEqual([]);
  expect(door.f.budget.degraded?.crossed).toContain("work");
  // cause22 caps: who says "owner turn" at the two real binders is no longer pinned by source text. Both run for real in
  // cause22-owner-caps-1021.e2e.test.ts: a direct owner turn (E1-E3) and a room turn answering only the owner (E4) pass a result
  // that no turn without the owner keep may pass (cause22-owner-caps-relay-1021.test.ts R9).
});
