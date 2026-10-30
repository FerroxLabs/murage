// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-CARDS-1010 section 2 and A8/A9: "connected apps: unreachable (tool
// call): ETIMEDOUT" from 10-28 to 10-30 while the broker answered 200 from the
// same computer. The readiness probe now tries 3 times (4 s each, 0.5 s and
// 1.5 s apart) before it records "not ready"; a mount keeps the last ready
// answer while a probe retries, and joins a first probe for its remaining
// deadline; a tool call that was never sent is tried twice more, and one that
// may have been sent is never repeated. fetch is a stub; no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyManagedBrokerMessage, connectorAccess, primeBrokerReadiness, relayMcp, resetManagedBrokerState, setFluxProbeBackoffMsForTests, FLUX_PROBE_DEADLINE_MS, FLUX_PROBE_TIMEOUT_MS } from "./composio.ts";
import type { AppConfig } from "./config.ts";

const URL_ = "http://127.0.0.1:9/composio";
const cfg = (): AppConfig => ({}) as AppConfig;
const access = () => connectorAccess({ cfg: cfg(), botComposio: undefined, installedFromPackage: false, engineMountsConnectors: false, mounted: false });
const ready = () => access() !== "unreachable" && access() !== "unconfigured";

function shellFlux(): void {
  applyManagedBrokerMessage({
    type: "murage:managed-composio", access: null, fluxBrokerUrl: URL_, fluxAccess: { url: URL_, token: "b".repeat(64) },
    legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null,
  });
}
const netError = (code: string, syscall = "connect") => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code, syscall }) });
const healthy = () => new Response(JSON.stringify({ ready: true }), { status: 200, headers: { "content-type": "application/json" } });
const rpc = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), { status: 200, headers: { "content-type": "application/json" } });
/** A failure that arrives only after the attempt's whole 4 s timeout. */
const slowTimeout = () => new Promise<Response>((_, reject) => { setTimeout(() => reject(netError("ETIMEDOUT")), 4_000); });

let fetchMock: ReturnType<typeof vi.fn>;
const calls = (path: string) => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(path)).length;

beforeEach(() => {
  resetManagedBrokerState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  resetManagedBrokerState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setFluxProbeBackoffMsForTests();
});

describe("the readiness probe on a jittery link", () => {
  it("ETIMEDOUT twice, then ready: records ready on the third answer", async () => {
    vi.useFakeTimers();
    let n = 0;
    fetchMock.mockImplementation(async () => { n++; if (n <= 2) throw netError("ETIMEDOUT"); return healthy(); });
    shellFlux();
    const done = primeBrokerReadiness();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(calls("/health")).toBe(3);
    expect(ready()).toBe(true);
  });

  it("the attempt's real AbortSignal timeout is retried; a failure that is not a network one is final (fix round)", async () => {
    // fetch honours the signal it is given, as undici does: each attempt ends only when production's own
    // AbortSignal.timeout(FLUX_PROBE_TIMEOUT_MS) fires (real timers: AbortSignal.timeout is not a faked timer)
    setFluxProbeBackoffMsForTests([5, 5]);
    const reasons: string[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => { reasons.push((init.signal!.reason as Error).name); reject(init.signal!.reason); });
    }));
    shellFlux();
    const started = Date.now();
    await primeBrokerReadiness();
    expect(calls("/health")).toBe(3);
    expect(reasons).toEqual(["TimeoutError", "TimeoutError", "TimeoutError"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * FLUX_PROBE_TIMEOUT_MS - 100);
    expect(ready()).toBe(false);
  }, 30_000);

  it("a probe failure with no network code (a redirect refused, a bad answer) is not retried", async () => {
    fetchMock.mockImplementation(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") }); });
    shellFlux();
    await primeBrokerReadiness();
    expect(calls("/health")).toBe(1);
    expect(ready()).toBe(false);
  });

  it("an HTTP 503 is an answer: not retried", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }));
    shellFlux();
    await primeBrokerReadiness();
    expect(calls("/health")).toBe(1);
    expect(ready()).toBe(false);
  });

  it("three timeout-length failures end in not ready within the 14 s deadline", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(slowTimeout);
    shellFlux();
    let settled = false;
    const done = primeBrokerReadiness().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(FLUX_PROBE_DEADLINE_MS - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(calls("/health")).toBe(3);
    expect(FLUX_PROBE_DEADLINE_MS).toBe(14_000);
    expect(ready()).toBe(false);
  });

  it("a mount keeps the last ready answer while a probe retries", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => healthy());
    shellFlux();
    await primeBrokerReadiness();
    expect(ready()).toBe(true);
    // the ready answer goes stale; the next probe meets a jittery link
    vi.setSystemTime(Date.now() + 6 * 60_000);
    fetchMock.mockImplementation(slowTimeout);
    await primeBrokerReadiness({ turn: true, mount: true });
    expect(ready()).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ready()).toBe(true);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(ready()).toBe(false);
  });

  it("a mount with no ready answer joins the first probe past the old 5 s cap", async () => {
    vi.useFakeTimers();
    let n = 0;
    fetchMock.mockImplementation(() => { n++; return n <= 2 ? slowTimeout() : Promise.resolve(healthy()); });
    shellFlux();
    const first = primeBrokerReadiness();
    let mounted = false;
    const mount = primeBrokerReadiness({ turn: true, mount: true }).then(() => { mounted = true; });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mounted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_500);
    await mount;
    await first;
    expect(ready()).toBe(true);
  });
});

describe("a connector tool call on a jittery link", () => {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "X", arguments: {} } } as const;
  async function readyBroker(): Promise<void> {
    fetchMock.mockImplementationOnce(async () => healthy());
    shellFlux();
    await primeBrokerReadiness();
  }

  it("a call that was never sent is tried again, twice at most", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await readyBroker();
    let n = 0;
    fetchMock.mockImplementation(async () => { n++; if (n <= 2) throw netError("ECONNREFUSED"); return rpc(); });
    const reply = relayMcp(cfg(), call);
    await vi.advanceTimersByTimeAsync(2_500);
    const done = await reply;
    expect(calls("/v1/mcp")).toBe(3);
    expect(done.status).toBe(200);
    expect(Buffer.from(done.bytes).toString("utf8")).toContain('"result"');
  });

  it("gives up after three tries, as not sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await readyBroker();
    fetchMock.mockImplementation(async () => { throw netError("ETIMEDOUT"); });
    const reply = relayMcp(cfg(), call);
    await vi.advanceTimersByTimeAsync(2_500);
    const done = await reply;
    expect(calls("/v1/mcp")).toBe(3);
    expect(done.delivery).toBe("not-sent");
  });

  it("a redirect is never followed: possibly delivered, and never sent again (fix round, Astra High 6)", async () => {
    await readyBroker();
    // following the redirect would reach an unreachable destination (ECONNREFUSED), which once read as "never sent"
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.redirect !== "manual") throw netError("ECONNREFUSED");
      return new Response(null, { status: 307, headers: { location: "http://127.0.0.1:1/elsewhere" } });
    });
    const done = await relayMcp(cfg(), call);
    expect(calls("/v1/mcp")).toBe(1);
    expect(fetchMock.mock.calls.at(-1)![1].redirect).toBe("manual");
    expect(done.delivery).toBe("unknown");
  });

  it("a bare ETIMEDOUT (not on connect) is not a never-sent error: never repeated", async () => {
    await readyBroker();
    fetchMock.mockImplementation(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) }); });
    const done = await relayMcp(cfg(), call);
    expect(calls("/v1/mcp")).toBe(1);
    expect(done.delivery).toBe("unknown");
  });

  it("a call that may have reached the app is never sent again", async () => {
    await readyBroker();
    fetchMock.mockImplementation(async () => { throw netError("ECONNRESET", "read"); });
    const done = await relayMcp(cfg(), call);
    expect(calls("/v1/mcp")).toBe(1);
    expect(done.delivery).toBe("unknown");
  });
});
