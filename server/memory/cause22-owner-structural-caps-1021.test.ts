// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.21 cause22 r2 (TRIAGE-STOPS-1122 2c; Sean, MAIN-RULING local-memory-budget: an owner turn is never stopped).
// Owners: upstream-reader.ts UpstreamAccounting owns the two structural caps; release-budget.ts owns the counters, who is the owner's
// turn (ownerKept) and the 64 MiB ceiling; consuming-turn-response.ts denyConsumingHttp owns the engine-facing 409 body;
// proxy-turn-release.ts owns the proxy's terminal JSON-RPC error.
// On rc/1021-r2 c3f339db41 one upstream SSE event over 1 MiB (a computer-use screenshot) or one collected body over 8 MiB refused the
// owner's turn as checking:retained-budget. Real fence, real SQLite ledger, real release budget bound by the real turn binder, the real
// upstream reader under the real owner scope and the real release boundary for the reply; only the upstream bytes are made here.
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { consumingFixture, consumingResponseRecorder } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, frameDigest } from "../consuming-turn-ingress.ts";
import { denyConsumingHttp, emitConsumingTurnResponse, refuseConsumingTurn, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { BUDGET_REFUSAL_LINE, LEDGER_REFUSAL_LINE, REFUSAL_KIND_HEADER } from "../ledger-refusal.ts";
import { createProxyTurnRelease, terminalProxyRefusal } from "../proxy-turn-release.ts";
import { checkedOpenTurns } from "./lineage-write.ts";
import type { LineageVerdict } from "./lineage-types.ts";
import { BUDGET_VERDICT, RELEASE_LIMITS } from "./release-budget.ts";
import { accountedChunks, accountedResponse, currentUpstreamAccounting, withUpstreamOwner } from "./upstream-reader.ts";

const MIB = 1024 * 1024, PIECE = 64 * 1024;
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** One bound turn and its upstream owner scope, as index.ts builds it for a tool route (withUpstreamOwner over the turn's budgets). */
function turn(owner: boolean) {
  const warned: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(String(args[0])); });
  const verdicts: LineageVerdict[] = [];
  const f = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); }, ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => f.close());
  const scope = <T>(work: () => T): T => withUpstreamOwner({ budgets: checkedOpenTurns(f.binding.turn).map(member => member.budget!),
    refuse: verdict => refuseConsumingTurn(f.binding, verdict) }, work);
  const reply = registerConsumingDescriptor("proxy:custom:frame", "body");
  /** The turn's reply through the real release boundary; returns what the destination was given. */
  const deliver = (text: string) => {
    const written: string[] = [];
    emitConsumingTurnResponse(f.binding, reply, { bytes: Buffer.byteLength(text), refs: [], write: () => { written.push(text); } });
    return written;
  };
  return { f, verdicts, warned, scope, deliver, open: () => checkedOpenTurns(f.turn)[0]! };
}
function pieces(total: number, fill: number, tail?: Buffer): ReadableStream<Uint8Array> {
  let sent = 0, done = false;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (sent < total) { const size = Math.min(PIECE, total - sent); sent += size; controller.enqueue(Buffer.alloc(size, fill)); return; }
    if (tail && !done) { done = true; controller.enqueue(tail); return; }
    controller.close();
  } });
}
/** One SSE response whose first event carries `eventBytes` of payload (a base64 screenshot), followed by one small event. */
const sse = (eventBytes: number) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(Buffer.from("event: message\ndata: "));
  for (let sent = 0; sent < eventBytes; sent += PIECE) controller.enqueue(Buffer.alloc(Math.min(PIECE, eventBytes - sent), 0x41));
  controller.enqueue(Buffer.from("\n\ndata: {\"done\":true}\n\n"));
  controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
async function drain(response: Response): Promise<number> {
  let bytes = 0;
  const reader = response.body!.getReader();
  for (;;) { const next = await reader.read(); if (next.done) return bytes; bytes += next.value.byteLength; }
}
async function collect(stream: AsyncIterable<Uint8Array>): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.byteLength;
  return bytes;
}

it("W22r2-1 owner turn: a 1.5 MiB screenshot SSE event and a 12 MiB collected tool body stream past their caps; the turn completes with its reply delivered", async () => {
  const r = turn(true);
  const event = Math.floor(1.5 * MIB), body = 12 * MIB;
  const eventBytes = await r.scope(() => drain(accountedResponse(sse(event)))).catch(() => -1);
  expect(r.verdicts, "the 1.5 MiB event did not refuse the owner's turn").toEqual([]);
  expect(eventBytes, "every byte of the oversize event was passed on").toBeGreaterThan(event);
  const bodyBytes = await collect(r.scope(() => accountedChunks(pieces(body, 0x42) as unknown as AsyncIterable<Uint8Array>, "collection"))).catch(() => -1);
  expect(r.verdicts, "the 12 MiB collected body did not refuse the owner's turn").toEqual([]);
  expect(bodyBytes, "the whole collected body was passed on").toBe(body);
  // the computer-use broker's shape: one collection accounting fed raw chunks (host-computer-broker.ts startHostEngine)
  const accounting = r.scope(() => currentUpstreamAccounting("collection"))!;
  expect(() => { for (let sent = 0; sent < body; sent += PIECE) accounting.accept(Buffer.alloc(PIECE, 0x43)); accounting.end(); }).not.toThrow();
  expect(r.f.refusals, "refusal count 0").toBe(0);
  expect(r.f.budget.refused).toBe(false);
  expect(r.deliver("the reply"), "the turn's reply is delivered after the oversize reads").toEqual(["the reply"]);
  expect(r.f.budget.acceptedReleases).toBeGreaterThan(0);
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the crossings were
  // recorded as oversize marks ({ event: 1, body: 2 }, upstreamOversize ["event","body"], one "[memory] upstream" line per kind); now there
  // is no cap to cross, so nothing is marked, and the bytes are counted on the budget. Never a revoke mark.
  expect(r.f.budget.oversized).toEqual({ event: 0, body: 0, cut: 0 });
  expect(r.open().upstreamOversize).toBeUndefined();
  expect(r.open().noReplay).toBeUndefined();
  expect(r.warned.filter(line => line.startsWith("[memory] upstream "))).toEqual([]);
  expect(r.f.budget.counts.bytes, "every upstream byte is counted").toBeGreaterThanOrEqual(event + 2 * body);
});

it("W22r2-2 every other turn: the same event and the same body now pass whole too; the turn is not refused", async () => {
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: a non-owner turn
  // was refused as checking:retained-budget at the 1 MiB event cap and at the 8 MiB body cap.
  const event = turn(false), eventSize = Math.floor(1.5 * MIB);
  expect(await event.scope(() => drain(accountedResponse(sse(eventSize)))), "the 1.5 MiB event is read whole").toBeGreaterThan(eventSize);
  expect(event.verdicts, "a non-owner turn is not refused for the event's size").toEqual([]);
  expect(event.f.budget.refused).toBe(false);
  expect(event.f.budget.oversized).toEqual({ event: 0, body: 0, cut: 0 });
  const body = turn(false);
  expect(await collect(body.scope(() => accountedChunks(pieces(12 * MIB, 0x42) as unknown as AsyncIterable<Uint8Array>, "collection")))).toBe(12 * MIB);
  expect(body.verdicts, "a non-owner turn is not refused for the body's size").toEqual([]);
  expect(body.f.budget.refused).toBe(false);
  expect(body.f.budget.oversized).toEqual({ event: 0, body: 0, cut: 0 });
});

it("W22r2-3 no 64 MiB ceiling: one event or body past 64 MiB is read whole; the owner turn is not refused and its next read and reply go through", async () => {
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the 64 MiB ceiling cut
  // one event or body with UPSTREAM_OVERSIZE_CUT (oversized.cut 2, upstreamOversize "cut", one ceiling log line); now nothing is cut.
  const r = turn(true);
  const accounting = r.scope(() => currentUpstreamAccounting("sse"))!;
  const mib = Buffer.alloc(MIB, 0x41);
  let failed: unknown, taken = 0;
  try { for (let n = 0; n < 70; n++) { accounting.accept(mib); taken += MIB; } accounting.end(); } catch (error) { failed = error; }
  expect(failed, "one 70 MiB event is not cut").toBeUndefined();
  expect(taken, "every byte streamed").toBe(70 * MIB);
  expect(r.verdicts, "not a refusal").toEqual([]);
  expect(r.f.refusals).toBe(0);
  // a body past 64 MiB on the stream path: the consumer gets all of it
  expect(await collect(r.scope(() => accountedChunks(pieces(65 * MIB, 0x42) as unknown as AsyncIterable<Uint8Array>, "collection"))), "one 65 MiB body is passed whole").toBe(65 * MIB);
  expect(r.verdicts).toEqual([]);
  expect(r.f.budget.refused, "the turn's budget did not refuse").toBe(false);
  // the turn keeps going: the next ordinary read and the reply
  expect(await r.scope(() => drain(accountedResponse(sse(1024)))), "the next read on the same turn works").toBeGreaterThan(1024);
  expect(r.deliver("after the big reads")).toEqual(["after the big reads"]);
  expect(r.f.budget.oversized).toEqual({ event: 0, body: 0, cut: 0 });
  expect(r.open().upstreamOversize).toBeUndefined();
  expect(r.warned.filter(line => line.startsWith("[memory] upstream "))).toEqual([]);
}, 120_000);

it("W22r2-4 the engine-facing 409 body tells a budget stop with the budget line (and its header word); any other denial keeps the context line", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const budget = consumingResponseRecorder();
  denyConsumingHttp(budget.raw, undefined, Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: BUDGET_VERDICT }));
  expect(budget.output.at(-1), "a budget stop is never told as lost context").toEqual({ status: 409, body: BUDGET_REFUSAL_LINE });
  expect(budget.headers.get(REFUSAL_KIND_HEADER)).toBe("retained-budget");
  for (const cause of [undefined, new Error("MEMORY_CONTEXT_REVOKED"), Object.assign(new Error("x"), { fence: { state: "revoked", reason: "target" } })]) {
    const other = consumingResponseRecorder();
    denyConsumingHttp(other.raw, undefined, cause);
    expect(other.output.at(-1), "every other denial keeps the context line").toEqual({ status: 409, body: LEDGER_REFUSAL_LINE });
    expect(other.headers.has(REFUSAL_KIND_HEADER)).toBe(false);
  }
  // a bound non-owner turn whose own budget refused: the door knows without being handed the error
  const r = turn(false);
  expect(() => r.f.budget.charge({ work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(r.verdicts).toEqual([BUDGET_VERDICT]);
  const bound = consumingResponseRecorder();
  denyConsumingHttp(bound.raw, r.f.binding);
  expect(bound.output.at(-1), "the bound turn's budget stop is told with the budget line").toEqual({ status: 409, body: BUDGET_REFUSAL_LINE });
});

// cause22 caps: this case sets the proxy's budget flag by hand (release.budgetStop()). The header a real proxy child reads from the
// door's 409 is driven at runtime in cause22-owner-caps-proxy-1021.test.ts (P7: a spawned child, the real door, a real budget stop).
it("W22r2-5 the proxy's terminal JSON-RPC error carries the budget line once the release door said so; the verdict door carries the budget verdict", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(terminalProxyRefusal(7).error.message).toBe(LEDGER_REFUSAL_LINE);
  expect(terminalProxyRefusal(7, true).error).toEqual({ code: -32099, message: BUDGET_REFUSAL_LINE, data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } });
  const terminal = (budgetStop: boolean) => {
    const frames: Array<ReturnType<typeof terminalProxyRefusal>> = [];
    const release = createProxyTurnRelease("instance", { verdict: async () => { throw new Error("unused"); }, envelope: async () => {}, seal() {},
      terminal(frame) { frames.push(frame); }, close() {} });
    if (budgetStop) release.budgetStop();
    expect(() => release.transportLost("upstream-reserve")).toThrow("MEMORY_CONTEXT_REVOKED");
    return frames;
  };
  expect(terminal(true).map(frame => frame.error.message), "the engine is told the budget line").toEqual([BUDGET_REFUSAL_LINE]);
  expect(terminal(false).map(frame => frame.error.message), "any other terminal refusal keeps the context line").toEqual([LEDGER_REFUSAL_LINE]);
  // the server side of that door: a frame offered for release on a non-owner turn whose budget has nothing left
  const r = turn(false);
  const caps = new InternalCapabilities(); caps.begin(r.f.binding.identity.botId, r.f.turn.threadId, r.f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  const instance = authority.register(r.f.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
  const claim = caps.resolve(`Bearer ${instance.token}`)!;
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the attempt count was
  // filled here, so the verdict's attempt crossed it. Now the window's work is filled exactly (no release accepted yet), so the verdict's
  // own bookkeeping work (proposeTurnParents) crosses it: still a budget stop inside the verdict door.
  r.f.budget.charge({ work: RELEASE_LIMITS.work - r.f.budget.counts.work });
  expect(r.verdicts, "filling the window is not itself a refusal").toEqual([]);
  const frame = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
  let thrown: unknown;
  try { authority.verdict(claim, { instanceId: instance.instanceId, sequence: 1, descriptor: "proxy:custom:frame", requestId: null, bytes: Buffer.byteLength(frame), digest: frameDigest(frame), frame }); }
  catch (error) { thrown = error; }
  expect(r.verdicts[0]).toEqual(BUDGET_VERDICT);
  expect((thrown as { fence?: LineageVerdict } | undefined)?.fence, "the budget verdict travels with the verdict door's rejection").toEqual(BUDGET_VERDICT);
  const door = consumingResponseRecorder();
  denyConsumingHttp(door.raw, undefined, thrown);
  expect(door.output.at(-1)).toEqual({ status: 409, body: BUDGET_REFUSAL_LINE });
});
