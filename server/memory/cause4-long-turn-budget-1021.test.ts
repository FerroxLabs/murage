// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.21 cause4: a long turn whose every release is ordinary and passes the retained fence was refused as checking:retained-budget once
// the sum of its releases crossed a lifetime counter of its release budget (release-budget.ts), and the refusal replaced its whole reply
// with "I stopped this turn because some of its context is no longer available." although nothing had been revoked.
// Every witness below drives the real boundary (route-delegation.ts sendDelegated -> consumingHttpWriter -> emitPreparedConsumingResponse
// -> the retained fence) over a real SQLite ledger; nothing of the budget or the fence is mocked.
import { createServer, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createConsumingIngress } from "../consuming-turn-ingress.ts";
import { stageConsumingResponse } from "../consuming-turn-response.ts";
import { sendDelegated } from "../route-delegation.ts";
import { consumingFixture, fixtureHttp } from "../testing/consuming-fixture.ts";
import type { LineageVerdict } from "./lineage-types.ts";
import { MEMBER } from "./testing/writetime-fixture.ts";
import { RELEASE_LIMITS, ReleaseBudget, reserveRelease, withReleaseBudgets } from "./release-budget.ts";

const ROUTE = "POST /api/internal/resolve-image-reference";
const fixtures: ReturnType<typeof consumingFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.close()); });
function longTurn() {
  const verdicts: LineageVerdict[] = [];
  const f = consumingFixture(MEMBER, { onRefused: verdict => { verdicts.push(verdict); } });
  fixtures.push(f);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // never spread: that would snapshot the fixture's live `refusals` getter
  return Object.assign(f, { verdicts });
}
/** One finished internal reply of the running turn, through the real writer. Returns the delivered output rows. */
function reply(f: ReturnType<typeof longTurn>, body: unknown = { ok: true }) {
  const http = fixtureHttp(f.binding, ROUTE);
  sendDelegated(http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => body });
  return http.output;
}
const delivered = (output: ReturnType<typeof reply>, body: unknown) =>
  output.some(row => row.status === 200) && output.some(row => row.body === JSON.stringify(body));

it("C4-1 a long turn's replies are all delivered after the sum of its releases passes every lifetime limit", () => {
  const f = longTurn();
  // One reply's own cost, read from the real counters between two replies: how many such replies one window holds at most.
  expect(delivered(reply(f, { n: -1 }), { n: -1 })).toBe(true);
  const before = f.budget.counts;
  expect(delivered(reply(f, { n: 0 }), { n: 0 })).toBe(true);
  const after = f.budget.counts;
  const keys = (Object.keys(RELEASE_LIMITS) as Array<keyof typeof RELEASE_LIMITS>).filter(key => after[key] > before[key]);
  // "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, attempts was asserted to be one of the
  // lifetime limits a reply spends; attempts and bytes are no longer limits, so the window is bounded by statements (and work) only.
  expect(keys).not.toContain("attempts"); expect(keys).toContain("statements");
  const window = Math.min(...keys.map(key => Math.floor(RELEASE_LIMITS[key] / (after[key] - before[key]))));
  console.info(`C4-1 one reply costs ${keys.map(key => `${key}=${after[key] - before[key]}`).join(" ")}; one window holds ${window} replies`);
  // Well past one window of ordinary replies (the base refuses reply number `window + 1`).
  const total = window + 64;
  for (let n = 1; n <= total; n++) {
    const body = { n };
    const output = reply(f, body);
    if (!delivered(output, body)) throw new Error(`reply ${n} of ${total} was not delivered (one window holds ${window})`);
  }
  expect(f.refusals).toBe(0);
  expect(f.verdicts).toEqual([]);
  expect(f.budget.windows).toBeGreaterThan(1);
}, 240_000);

it("C4-2 a revoke after the budget opened a new window still refuses the next reply, as a revoke and not as a budget", () => {
  const f = longTurn();
  expect(delivered(reply(f), { ok: true })).toBe(true);
  // the rest of this window, then one more reply: the crossing opens window 2 and that reply is delivered
  f.budget.charge({ statements: RELEASE_LIMITS.statements - f.budget.counts.statements });
  expect(delivered(reply(f, { after: "window" }), { after: "window" })).toBe(true);
  expect(f.budget.windows).toBe(2); expect(f.refusals).toBe(0);
  f.flip();
  const prepare = vi.fn(() => ({ secret: "never" }));
  const http = fixtureHttp(f.binding, ROUTE);
  expect(() => sendDelegated(http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: prepare })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(http.output.some(row => row.status === 200)).toBe(false);
  expect(JSON.stringify(http.output)).not.toContain("never");
  expect(f.refusals).toBe(1);
  expect(f.verdicts[0]).not.toEqual({ state: "checking", reason: "retained-budget" });
  expect(f.verdicts[0]!.state).toBe("withheld");
});

it("C4-3 work that releases nothing stays bounded by one window: no accepted release, no new window", () => {
  const f = longTurn(), ingress = createConsumingIngress(f.binding, "fixture-instance");
  const piece = 64 * 1024;
  // "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, the releasing-nothing work was upstream
  // bytes staged through ingress.upstream (work = bytes + 1); an upstream charge is transport now and its work is not counted (asserted
  // here), so the same work is reserved as bookkeeping that releases nothing, with the same cost per piece.
  const staged = f.budget.counts;
  ingress.upstream(piece);
  expect(f.budget.counts.bytes).toBe(staged.bytes + piece); expect(f.budget.counts.work).toBe(staged.work);
  let refusedAt = -1;
  for (let n = 0; n < 2 * Math.ceil(RELEASE_LIMITS.work / piece); n++) {
    try { reserveRelease([f.budget], { work: piece + 1 }); } catch (error) { expect((error as Error).message).toBe("MEMORY_CONTEXT_REVOKED"); refusedAt = n; break; }
  }
  expect(refusedAt).toBe(Math.floor(RELEASE_LIMITS.work / (piece + 1)));
  expect(f.budget.windows).toBe(1);
  expect(f.refusals).toBe(1);
  expect(f.verdicts[0]).toEqual({ state: "checking", reason: "retained-budget" });
  // sealed for good: a later reply is refused, nothing opens a window any more
  (f.budget as { accepted?: () => void }).accepted?.();
  const http = fixtureHttp(f.binding, ROUTE);
  expect(() => sendDelegated(http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => ({ ok: true }) })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(http.output.some(row => row.status === 200)).toBe(false);
  expect(f.budget.windows).toBe(1);
});

// "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, this also asserted that the upstream
// volume opened a new window (windows > 1); upstream bytes no longer count against any window, so it asserts they are counted instead.
it("C4-4 upstream volume of a turn that keeps releasing is not a refusal", () => {
  const f = longTurn(), ingress = createConsumingIngress(f.binding, "fixture-instance");
  const piece = 64 * 1024, pieces = Math.ceil(64 * 1024 * 1024 / piece) + 8;
  // more upstream bytes than both the work and the byte limit of one window, with a delivered reply every 32 pieces (2 MiB)
  for (let n = 0; n < pieces; n++) {
    ingress.upstream(piece);
    if (n % 32 === 31) expect(delivered(reply(f, { n }), { n })).toBe(true);
  }
  expect(f.refusals).toBe(0); expect(f.verdicts).toEqual([]);
  expect(f.budget.counts.bytes).toBeGreaterThanOrEqual(pieces * piece);
});

// "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": the first row was a byte cost above the 64 MiB
// byte limit; that limit is gone, so the row is a work cost above the whole work limit (still a structural cap).
it.each([
  ["a cost above a whole limit", (budget: ReleaseBudget) => reserveRelease([budget], { work: RELEASE_LIMITS.work + 1 })],
  ["a negative cost", (budget: ReleaseBudget) => reserveRelease([budget], { work: -1 })],
  ["a fractional cost", (budget: ReleaseBudget) => reserveRelease([budget], { statements: 0.5 })],
])("C4-5 the structural caps still refuse a turn that has accepted releases: %s", (_name, cross) => {
  const f = longTurn();
  expect(delivered(reply(f), { ok: true })).toBe(true);
  expect(() => cross(f.budget)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.budget.windows).toBe(1);
  expect(f.refusals).toBe(1);
  expect(f.verdicts[0]).toEqual({ state: "checking", reason: "retained-budget" });
  expect(() => f.budget.charge({ work: 0 })).toThrow("MEMORY_CONTEXT_REVOKED");
});

it("C4-6 one release cannot open two windows: a second crossing with no accepted release in between refuses", () => {
  const f = longTurn();
  expect(delivered(reply(f), { ok: true })).toBe(true);
  expect(() => withReleaseBudgets([f.budget], () => {
    reserveRelease([f.budget], { work: RELEASE_LIMITS.work - f.budget.counts.work });
    reserveRelease([f.budget], { work: 1 });
    expect(f.budget.windows).toBe(2);
    expect(f.budget.counts.work).toBe(1);
    reserveRelease([f.budget], { work: RELEASE_LIMITS.work - 1 });
    reserveRelease([f.budget], { work: 1 });
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.budget.windows).toBe(2);
  expect(f.refusals).toBe(1);
  expect(f.verdicts[0]).toEqual({ state: "checking", reason: "retained-budget" });
});

it("C4-7 a reply whose destination throws is not an accepted release", () => {
  const f = longTurn();
  const http = fixtureHttp(f.binding, ROUTE);
  vi.spyOn(http.raw, "end").mockImplementation(() => { throw new Error("fixture destination failure"); });
  expect(() => sendDelegated(http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => ({ ok: true }) })).toThrow();
  expect(f.budget.acceptedReleases).toBe(0);
  // whatever that failure did to the turn, it opened no window: a crossing straight after it refuses
  expect(() => { f.budget.charge({ work: RELEASE_LIMITS.work - f.budget.counts.work }); f.budget.charge({ work: 1 }); }).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.budget.windows).toBe(1);
  expect(f.refusals).toBeGreaterThanOrEqual(1);
});

// 1.0.21 cause4 round 2: Node reports a failed socket write later, never by a throw. A reply written to a response whose socket is
// already gone returns normally (write() false, end() the response itself), sends nothing, and the failure arrives through the write
// callback (ERR_STREAM_DESTROYED) or as a 'finish' that never comes. Counting the returned write() as the accepted release let a turn
// whose replies reach nobody renew its budget window. These witnesses use a real node:http ServerResponse over a loopback socket.
const servers: Server[] = [], clients: Socket[] = [];
afterEach(async () => {
  clients.splice(0).forEach(client => client.destroy());
  await Promise.all(servers.splice(0).map(server => new Promise(done => { server.closeAllConnections(); server.close(done); })));
});
/** One real request of the running turn: the server side's ServerResponse and everything the client received. */
async function realResponse() {
  const server = createServer();
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const response = new Promise<ServerResponse>(done => server.once("request", (_request, res) => done(res)));
  const client = connect((server.address() as { port: number }).port, "127.0.0.1");
  clients.push(client);
  let received = "";
  client.on("error", () => {}); client.on("data", data => { received += data.toString(); });
  client.write("POST /fixture HTTP/1.1\r\nHost: fixture\r\nContent-Length: 0\r\n\r\n");
  const raw = await response;
  raw.on("error", () => {});
  return { raw, client, received: () => received };
}
const settle = () => new Promise(done => setTimeout(done, 100));
/** A crossing straight after: refused when the window holds no accepted release, a new window when it holds one. */
const cross = (f: ReturnType<typeof longTurn>) => { f.budget.charge({ work: RELEASE_LIMITS.work - f.budget.counts.work }); f.budget.charge({ work: 1 }); };

it("C4-8 a reply the real socket took is an accepted release once the socket confirms it, and not before", async () => {
  const f = longTurn(), real = await realResponse();
  const http = fixtureHttp(f.binding, ROUTE, real.raw);
  sendDelegated(http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => ({ ok: "live" }) });
  // write() returned, the socket has not reported yet: nothing is known to be accepted
  expect(f.budget.acceptedReleases).toBe(0);
  await new Promise(done => real.raw.once("finish", done));
  await vi.waitFor(() => expect(real.received()).toContain(JSON.stringify({ ok: "live" })));
  expect(f.budget.acceptedReleases).toBe(1);
  cross(f);
  expect(f.budget.windows).toBe(2); expect(f.refusals).toBe(0);
});

it("C4-9 a reply written to a socket that is already gone is not an accepted release (end() returns, nothing is sent, no finish)", async () => {
  const f = longTurn(), real = await realResponse();
  // gone in this same tick: the response does not know yet (destroyed === false), so the writer's own checks all pass
  real.raw.socket!.destroy();
  expect(real.raw.destroyed).toBe(false);
  const http = fixtureHttp(f.binding, ROUTE, real.raw);
  sendDelegated(http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => ({ ok: "lost" }) });
  await settle();
  expect(real.received()).toBe("");
  expect(f.budget.acceptedReleases).toBe(0);
  expect(() => cross(f)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.budget.windows).toBe(1);
  expect(f.verdicts[0]).toEqual({ state: "checking", reason: "retained-budget" });
});

it("C4-10 a streamed chunk whose write fails later (write() false, ERR_STREAM_DESTROYED by callback) is not an accepted release", async () => {
  const f = longTurn(), real = await realResponse();
  real.client.destroy();
  await vi.waitFor(() => expect(real.raw.destroyed).toBe(true));
  const http = fixtureHttp(f.binding, ROUTE, real.raw);
  http.writer.writeHead(200, { "content-type": "text/event-stream" });
  stageConsumingResponse(http.writer, []); // the stream declares no remembered context
  // the caller's own callback still runs (as before); the failure is Node's, reported later and never thrown
  let called = 0;
  expect(http.writer.write("data: lost\n\n", "utf8", () => { called++; })).toBe(false);
  await settle();
  expect(real.received()).toBe("");
  expect(called).toBe(1);
  expect(f.budget.acceptedReleases).toBe(0);
  expect(() => cross(f)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.budget.windows).toBe(1);
});

it("C4-11 a streamed chunk the real socket took is an accepted release once its write callback reports no error", async () => {
  const f = longTurn(), real = await realResponse();
  const http = fixtureHttp(f.binding, ROUTE, real.raw);
  http.writer.writeHead(200, { "content-type": "text/event-stream" });
  stageConsumingResponse(http.writer, []);
  let called = 0;
  expect(http.writer.write("data: live\n\n", "utf8", () => { called++; })).toBe(true);
  expect(f.budget.acceptedReleases).toBe(0);
  await vi.waitFor(() => expect(real.received()).toContain("data: live"));
  await vi.waitFor(() => expect(called).toBe(1));
  expect(f.budget.acceptedReleases).toBe(1);
  cross(f);
  expect(f.budget.windows).toBe(2); expect(f.refusals).toBe(0);
});

it("C4-12 a socket report that arrives after the window changed does not count for the new window", async () => {
  const f = longTurn(), real = await realResponse();
  const http = fixtureHttp(f.binding, ROUTE, real.raw);
  sendDelegated(http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => ({ ok: "late" }) });
  expect(f.budget.acceptedReleases).toBe(0);
  // another reply of the same window is taken at once (the recorder reports in the same tick) and the window is crossed
  expect(delivered(reply(f), { ok: true })).toBe(true);
  expect(f.budget.acceptedReleases).toBe(1);
  cross(f);
  expect(f.budget.windows).toBe(2); expect(f.budget.acceptedReleases).toBe(0);
  // the first reply's report lands now, in window 2: that window has released nothing itself
  await new Promise(done => real.raw.once("finish", done));
  await vi.waitFor(() => expect(real.received()).toContain(JSON.stringify({ ok: "late" })));
  await settle();
  expect(f.budget.acceptedReleases).toBe(0);
  expect(() => cross(f)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.budget.windows).toBe(2);
});
