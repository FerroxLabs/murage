// Connected apps answered 429 on every call (Windows 1.0.17, since 29 Oct): every install shares one
// upstream rate limit through Flux Router, and this app kept asking it: the background health pass
// every five minutes, the allowance line every minute, a not-ready probe every 20 s, a tool-list
// refresh on every turn once stale. These tests count what one install sends upstream, with a fake
// clock, and pin the backoff rules: exponential with jitter, Retry-After honoured, capped, one
// request in flight per key, no idle traffic, and a cached tool list that outlives a 429.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as composio from "./composio.ts";
import { startConnectorHealthMonitor } from "./connector-health-monitor.ts";
import { backoffDelayMs, BackoffGate, BACKOFF_BASE_MS, BACKOFF_CAP_MS, parseRetryAfterMs, setBackoffRandomForTests, SingleFlight } from "./upstream-backoff.ts";
import type { AppConfig } from "./config.ts";

const URL_BASE = "https://flux.example.test/composio";
const TOKEN = "a".repeat(64);
const cfg = (): AppConfig => ({}) as AppConfig;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

interface Hit { path: string; at: number }
let hits: Hit[] = [];
let healthAnswer: () => { status: number; headers?: Record<string, string>; body?: unknown };
let inventoryAnswer: () => { status: number; headers?: Record<string, string>; body?: unknown };
let meAnswer: () => { status: number; headers?: Record<string, string>; body?: unknown };
let mcpAnswer: () => { status: number; headers?: Record<string, string>; body?: unknown };
const LIST = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description: "d", inputSchema: { type: "object" } }] } };
const gmail = { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }] } };

function stubBroker() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace("/composio", "") + url.search;
    hits.push({ path, at: Date.now() });
    const pick = path === "/health" ? healthAnswer() : path === "/v1/connectors/connected" ? inventoryAnswer() : path === "/v1/me" ? meAnswer() : path === "/v1/mcp" ? mcpAnswer() : { status: 404 };
    return new Response(JSON.stringify(pick.body ?? {}), { status: pick.status, headers: { "content-type": "application/json", ...(pick.headers ?? {}) } });
  }));
}
const count = (path?: string) => hits.filter((hit) => path === undefined || hit.path === path).length;
const gaps = (path: string) => { const at = hits.filter((hit) => hit.path === path).map((hit) => hit.at); return at.slice(1).map((time, i) => Math.round((time - at[i]!) / SECOND)); };
const tools = (reply: { bytes: Uint8Array }) => (JSON.parse(new TextDecoder().decode(reply.bytes)).result?.tools ?? []) as unknown[];
const listCall = (id = 1) => ({ jsonrpc: "2.0", id, method: "tools/list" }) as never;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  hits = [];
  healthAnswer = () => ({ status: 200, body: { ready: true } });
  inventoryAnswer = () => ({ status: 200, body: { services: gmail } });
  meAnswer = () => ({ status: 200, body: { freeRunsRemainingToday: 3 } });
  mcpAnswer = () => ({ status: 200, body: LIST });
  setBackoffRandomForTests(() => 1);
  composio.resetManagedBrokerState();
  stubBroker();
  composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: URL_BASE, fluxAccess: { url: URL_BASE, token: TOKEN }, legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
  await composio.primeBrokerReadiness();
  hits = []; // the setup's own readiness probe is not the install's traffic
});
afterEach(() => {
  setBackoffRandomForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  composio.resetManagedBrokerState();
});

/** The app's background health pass, as the monitor drives it. Before the fix this was the body of checkConnectorHealth. */
async function healthPass() {
  const pass = (composio as { runConnectorHealthPass?: (c: AppConfig, s: (n: number) => string[]) => Promise<void> }).runConnectorHealthPass;
  if (pass) return pass(cfg(), () => []);
  await composio.primeBrokerReadiness();
  await composio.connectedServices(cfg(), { fresh: true });
}

describe("upstream-backoff rules", () => {
  it("doubles from the base, caps, and jitters inside [0.5, 1] of the nominal delay", () => {
    setBackoffRandomForTests(() => 1);
    expect([1, 2, 3, 4, 5, 6, 7, 30].map((n) => backoffDelayMs(n))).toEqual([30, 60, 120, 240, 480, 900, 900, 900].map((s) => s * SECOND));
    setBackoffRandomForTests(() => 0);
    expect(backoffDelayMs(3)).toBe(60 * SECOND);
    expect(BACKOFF_BASE_MS).toBe(30 * SECOND);
    expect(BACKOFF_CAP_MS).toBe(15 * MINUTE);
  });
  it("reads Retry-After as seconds or an HTTP date and never truncates its floor", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs("Sun, 01 Nov 2026 00:05:00 GMT", now)).toBe(5 * MINUTE);
    // MAIN RULING 1115-COMPOSIO-429-REVIEW: the server Retry-After is an uncapped floor.
    expect(parseRetryAfterMs("999999", now)).toBe(999999 * SECOND);
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(backoffDelayMs(1, 5 * MINUTE)).toBe(5 * MINUTE);
  });
  it("a gate opens on failure, closes on its time and on success", () => {
    const gate = new BackoffGate();
    expect(gate.blocked("k")).toBe(false);
    expect(gate.failure("k", 429, "90")).toBe(90 * SECOND);
    expect(gate.blocked("k")).toBe(true);
    vi.advanceTimersByTime(91 * SECOND);
    expect(gate.blocked("k")).toBe(false);
    gate.failure("k", 503);
    gate.success("k");
    expect(gate.failures("k")).toBe(0);
  });
  it("single flight shares one run per key", async () => {
    const flight = new SingleFlight();
    let runs = 0;
    const work = async () => { runs++; await new Promise((resolve) => setTimeout(resolve, 10)); return runs; };
    const all = Promise.all(Array.from({ length: 10 }, () => flight.run("k", work)));
    await vi.advanceTimersByTimeAsync(20);
    expect((await all).every((value) => value === 1)).toBe(true);
    expect(runs).toBe(1);
  });
});

describe("idle install traffic (one hour, fake clock)", () => {
  it("an install nobody is using sends nothing upstream for an hour", async () => {
    const stop = startConnectorHealthMonitor(healthPass);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    stop();
    console.log(`idle hour, no connector use: ${count()} upstream calls`);
    expect(count()).toBe(0);
  });

  it("after the last use the health pass quiets down once the idle window passes", async () => {
    composio.noteConnectorUse();
    await composio.connectedServices(cfg()); // one use, then idle
    hits = [];
    const stop = startConnectorHealthMonitor(healthPass);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    stop();
    console.log(`idle hour after one use: ${count()} upstream calls (${count("/health")} health, ${count("/v1/connectors/connected")} inventory)`);
    // 30 idle-window minutes at a 5-minute pass: at most the 6 passes inside the window, none after it
    // MAIN RULING 1115-COMPOSIO-429-REVIEW: establish real connector use and require five active passes.
    expect(count()).toBe(10);
    expect(hits.every((hit) => hit.at <= Date.parse("2026-11-01T00:00:00Z") + 31 * MINUTE)).toBe(true);
  });

  it("the allowance line is not re-asked every minute while a panel stays open", async () => {
    for (let second = 0; second < 3600; second += 65) {
      await composio.refreshFluxAccountStatus(cfg());
      await vi.advanceTimersByTimeAsync(65 * SECOND);
    }
    console.log(`account status polled every 65 s for an hour: ${count("/v1/me")} /v1/me calls`);
    expect(count("/v1/me")).toBeLessThanOrEqual(6);
  });

  it("ten concurrent account-status reads make one request", async () => {
    await Promise.all(Array.from({ length: 10 }, () => composio.refreshFluxAccountStatus(cfg())));
    expect(count("/v1/me")).toBe(1);
  });

  it("a warm turn (readiness, mount, tool list) sends at most one request", async () => {
    await composio.relayMcp(cfg(), listCall()); // warm
    hits = [];
    for (let turn = 0; turn < 5; turn++) {
      await composio.primeBrokerReadiness({ turn: true, mount: true });
      await composio.relayMcp(cfg(), listCall(turn + 2));
      await vi.advanceTimersByTimeAsync(20 * SECOND);
    }
    console.log(`5 warm turns inside 5 minutes: ${count()} upstream calls`);
    expect(count()).toBeLessThanOrEqual(1);
  });
});

describe("a 429 storm", () => {
  it("inventory: the gaps between asks double from 30 s to the 15 minute cap, never faster", async () => {
    inventoryAnswer = () => ({ status: 429, headers: { "content-type": "application/json" } });
    for (let second = 0; second < 3 * 3600; second++) {
      await composio.connectedServices(cfg(), { fresh: true }).catch(() => {});
      await vi.advanceTimersByTimeAsync(SECOND);
    }
    const seen = gaps("/v1/connectors/connected");
    console.log(`429 storm, 3 h of asks every second: ${count("/v1/connectors/connected")} inventory calls, gaps ${seen.slice(0, 8).join(",")}s`);
    expect(seen.slice(0, 6)).toEqual([30, 60, 120, 240, 480, 900]);
    expect(Math.max(...seen)).toBeLessThanOrEqual(901);
    expect(count("/v1/connectors/connected")).toBeLessThanOrEqual(1 + 6 + 3 * 4);
  });

  it("inventory: Retry-After is a floor, not a hint", async () => {
    inventoryAnswer = () => ({ status: 429, headers: { "retry-after": "600" } });
    await composio.connectedServices(cfg(), { fresh: true }).catch(() => {});
    await vi.advanceTimersByTimeAsync(599 * SECOND);
    await composio.connectedServices(cfg(), { fresh: true }).catch(() => {});
    expect(count("/v1/connectors/connected")).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    inventoryAnswer = () => ({ status: 200, body: { services: gmail } });
    await composio.connectedServices(cfg(), { fresh: true });
    expect(count("/v1/connectors/connected")).toBe(2);
  });

  it("inventory: a remembered list is still served during the backoff", async () => {
    await composio.connectedServices(cfg());
    inventoryAnswer = () => ({ status: 429 });
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await composio.connectedServices(cfg(), { fresh: true }).catch(() => {});
    const served = await composio.connectedServices(cfg(), { fresh: true });
    expect(served.gmail?.connected).toBe(true);
    expect(count("/v1/connectors/connected")).toBe(2);
  });

  it("readiness: a 429 from /health keeps the last good answer and backs the probe off", async () => {
    healthAnswer = () => ({ status: 429, headers: { "retry-after": "180" } });
    await vi.advanceTimersByTimeAsync(6 * MINUTE); // past the ready lifetime
    hits = [];
    for (let second = 0; second < 10 * 60; second += 5) {
      void composio.primeBrokerReadiness({ turn: true }).catch(() => {});
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    console.log(`/health answering 429 for 10 min, a reader every 5 s: ${count("/health")} probes`);
    expect(count("/health")).toBeLessThanOrEqual(4);
    expect(composio.configured(cfg())).toBe(true); // still ready: apps and tools stay
  });

  it("readiness: a 5xx health answer backs off from its first refusal", async () => {
    healthAnswer = () => ({ status: 500 });
    composio.invalidateBrokerReadiness();
    for (let second = 0; second < 30 * 60; second += 5) {
      void composio.primeBrokerReadiness({ turn: true }).catch(() => {});
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    const seen = gaps("/health");
    console.log(`/health 500 for 30 min: ${count("/health")} probes, gaps ${seen.slice(0, 7).join(",")}s`);
    // MAIN RULING 1115-COMPOSIO-429-REVIEW: the first 5xx now opens the same exponential deadline.
    expect(seen[0]).toBe(30);
    for (let i = 2; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(count("/health")).toBeLessThanOrEqual(12);
  });

  it("account status: Retry-After is honoured and nothing is asked inside it", async () => {
    meAnswer = () => ({ status: 429, headers: { "retry-after": "900" } });
    await composio.refreshFluxAccountStatus(cfg());
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await composio.refreshFluxAccountStatus(cfg());
    expect(count("/v1/me")).toBe(1);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await composio.refreshFluxAccountStatus(cfg());
    expect(count("/v1/me")).toBe(2);
  });

  it("the health pass makes no ask while Flux is refusing the app", async () => {
    composio.noteConnectorUse();
    await composio.connectedServices(cfg()); // used
    inventoryAnswer = () => ({ status: 429, headers: { "retry-after": "1200" } });
    await vi.advanceTimersByTimeAsync(2 * MINUTE); // make the held inventory stale so the pass really asks
    await healthPass().catch(() => {});
    expect(count("/v1/connectors/connected")).toBe(2); // the pass really received the 429
    hits = [];
    const stop = startConnectorHealthMonitor(healthPass);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    stop();
    expect(count("/v1/connectors/connected")).toBe(0);
  });
});

describe("cached tools survive a 429", () => {
  it("a remembered tool list is served while its refresh is refused, and is asked for again only after the backoff", async () => {
    expect(tools(await composio.relayMcp(cfg(), listCall())).length).toBe(1);
    mcpAnswer = () => ({ status: 429, headers: { "retry-after": "300" } });
    await vi.advanceTimersByTimeAsync(11 * MINUTE); // past the ten-minute freshness
    hits = [];
    for (let i = 0; i < 20; i++) {
      expect(tools(await composio.relayMcp(cfg(), listCall(i + 10))).length).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    console.log(`stale tool list, upstream 429: ${count("/v1/mcp")} refresh asks over 20 turns`);
    expect(count("/v1/mcp")).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    mcpAnswer = () => ({ status: 200, body: LIST });
    await composio.relayMcp(cfg(), listCall(99));
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(count("/v1/mcp")).toBe(2);
  });

  it("a 429 on /health does not turn tool calls into 'no tools'", async () => {
    await composio.relayMcp(cfg(), listCall());
    healthAnswer = () => ({ status: 429 });
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    hits = [];
    const call = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: "x" }] } } } as never;
    const reply = await composio.relayMcp(cfg(), call);
    expect(count("/v1/mcp")).toBe(1);
    expect(new TextDecoder().decode(reply.bytes)).not.toMatch(/can't be reached|need Flux Router/);
    expect(tools(await composio.relayMcp(cfg(), listCall(6))).length).toBe(1);
  });

  it("with nothing cached and Flux refusing, the standard tools answer and no new ask is made inside the backoff", async () => {
    composio.resetManagedBrokerState();
    composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: URL_BASE, fluxAccess: { url: URL_BASE, token: TOKEN }, legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
    await composio.primeBrokerReadiness();
    mcpAnswer = () => ({ status: 429, headers: { "retry-after": "120" } });
    hits = [];
    for (let i = 0; i < 10; i++) {
      const answered = tools(await composio.relayMcp(cfg(), listCall(i + 1))).length;
      if (i > 0) expect(answered).toBeGreaterThan(0); // the first ask is the one the service refused
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    expect(count("/v1/mcp")).toBe(1);
  });
});


describe("review regressions: admission and refusal metadata", () => {
  it("B1 status polling: concurrent and five-second repeats share one refused ask", async () => {
    inventoryAnswer = () => ({ status: 429, headers: { "retry-after": "600" } });
    // The status route and catalog use the same broker stub as inventory.
    const fetcher = vi.mocked(fetch);
    fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      hits.push({ path, at: Date.now() });
      return Response.json({}, { status: 429, headers: { "retry-after": "600" } });
    });
    await Promise.allSettled(Array.from({ length: 10 }, () => composio.connectionStatus(cfg(), ["gmail"])));
    expect(hits).toHaveLength(1);
    for (let i = 0; i < 119; i++) {
      await vi.advanceTimersByTimeAsync(5 * SECOND);
      await composio.connectionStatus(cfg(), [i % 2 ? "gmail" : "slack"]).catch(() => {});
    }
    expect(hits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    await composio.connectionStatus(cfg(), ["gmail"]).catch(() => {});
    expect(hits.filter(hit => hit.path.endsWith("/v1/connectors"))).toHaveLength(2);
    expect(hits.filter(hit => hit.path.endsWith("/health"))).toHaveLength(1);
  });

  it.each(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"])("B1 %s: concurrent cache misses share one ask and preserve each id", async (name) => {
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { query: "fixture" } } }) as never;
    const replies = await Promise.all(Array.from({ length: 10 }, (_, id) => composio.relayMcp(cfg(), call(id))));
    expect(count("/v1/mcp")).toBe(1);
    expect(replies.map(reply => JSON.parse(new TextDecoder().decode(reply.bytes)).id)).toEqual(Array.from({ length: 10 }, (_, id) => id));
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    mcpAnswer = () => ({ status: 429, headers: { "retry-after": "600" }, body: { error: "composio_rate_limited" } });
    const first = await composio.relayMcp(cfg(), call(11));
    expect(first.status).toBe(429);
    for (let i = 0; i < 20; i++) {
      const refused = await composio.relayMcp(cfg(), call(20 + i));
      expect(refused.delivery).toBe("not-sent");
      expect(JSON.parse(new TextDecoder().decode(refused.bytes)).result.isError).toBe(true);
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    expect(count("/v1/mcp")).toBe(2);
  });

  it("B1 catalog: repeated and concurrent reads cannot bypass a 429", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      hits.push({ path: new URL(String(input)).pathname, at: Date.now() });
      return Response.json({}, { status: 429, headers: { "retry-after": "600" } });
    });
    const backend = composio.catalogBackend(cfg())!;
    await Promise.all(Array.from({ length: 10 }, () => backend.request(new URLSearchParams(), new AbortController().signal)));
    expect(hits).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      const response = await backend.request(new URLSearchParams({ cursor: String(i) }), new AbortController().signal);
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    expect(hits).toHaveLength(1);
  });

  it("B2 a normalized tools/list 503 retains its upstream status and Retry-After", async () => {
    mcpAnswer = () => ({ status: 503, headers: { "retry-after": "600" } });
    const refused = await composio.relayMcp(cfg(), listCall());
    expect(refused).toMatchObject({ upstreamStatus: 503, retryAfter: "600", brokerFailure: true });
    expect(JSON.parse(new TextDecoder().decode(refused.bytes)).error).toBeDefined();
  });

  it("B2 healthy health with stale tools/list 503 refreshes once, with cached tools intact", async () => {
    await composio.relayMcp(cfg(), listCall());
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    mcpAnswer = () => ({ status: 503, headers: { "retry-after": "600" } });
    hits = [];
    for (let i = 0; i < 120; i++) {
      expect(tools(await composio.relayMcp(cfg(), listCall(i))).length).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    expect(count("/v1/mcp")).toBe(1);
    expect(count("/health")).toBeLessThanOrEqual(1);
    await composio.relayMcp(cfg(), listCall(999));
    await vi.advanceTimersByTimeAsync(1);
    expect(count("/v1/mcp")).toBe(2);
  });

  it("B3 first health 503 honors Retry-After even if readiness is invalidated", async () => {
    healthAnswer = () => ({ status: 503, headers: { "retry-after": "600" } });
    composio.invalidateBrokerReadiness();
    await composio.primeBrokerReadiness();
    expect(count("/health")).toBe(1);
    for (let i = 0; i < 119; i++) {
      await vi.advanceTimersByTimeAsync(5 * SECOND);
      composio.invalidateBrokerReadiness();
      await composio.primeBrokerReadiness();
    }
    expect(count("/health")).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    await composio.primeBrokerReadiness();
    expect(count("/health")).toBe(2);
  });

  it("M1 Retry-After above one hour and a later shorter refusal never shorten the floor", () => {
    const gate = new BackoffGate();
    expect(gate.failure("k", 429, "7200")).toBe(7200 * SECOND);
    vi.advanceTimersByTime(SECOND);
    gate.failure("k", 503, "10");
    expect(gate.remainingMs("k")).toBe(7199 * SECOND);
    expect(parseRetryAfterMs(new Date(Date.now() + 3 * 3600 * SECOND).toUTCString())).toBe(3 * 3600 * SECOND);
  });
});

describe("final review: a refusal survives fallback and concurrent success", () => {
  it("B1 a claimed legacy fallback cannot bypass a Flux data 503 hold", async () => {
    composio.applyManagedBrokerMessage({ type: "murage:managed-composio",
      access: { url: "https://legacy.example.test", token: "b".repeat(64) },
      fluxBrokerUrl: URL_BASE, fluxAccess: { url: URL_BASE, token: TOKEN },
      legacyUntil: "", legacyClaim: { state: "claimed" }, accountKind: null, tokenError: null });
    await composio.primeBrokerReadiness();
    mcpAnswer = () => ({ status: 503, headers: { "retry-after": "600" } });
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { query: String(id) } } }) as never;
    await composio.relayMcp(cfg(), call(1));
    composio.invalidateBrokerReadiness(); // a concurrent health failure may select the fallback too
    const before = count();
    for (let i = 0; i < 10; i++) {
      const held = await composio.relayMcp(cfg(), call(i + 2));
      expect(held.delivery).toBe("not-sent");
      expect(held).toMatchObject({ upstreamStatus: 503 });
      await composio.connectionStatus(cfg(), ["gmail"]).catch(() => {});
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    expect(count()).toBe(before);
  });

  it("B1 a slower healthy read cannot erase another route's longer refusal", async () => {
    let finish!: () => void;
    const slow = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(fetch).mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      hits.push({ path, at: Date.now() });
      if (path.endsWith("/v1/catalog")) {
        await slow;
        return Response.json({ items: [] });
      }
      return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    });
    const backend = composio.catalogBackend(cfg())!;
    const healthy = backend.request(new URLSearchParams(), new AbortController().signal);
    await composio.connectionStatus(cfg(), ["gmail"]).catch(() => {});
    finish();
    expect((await healthy).status).toBe(200);
    expect(count()).toBe(2);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    const refused = await backend.request(new URLSearchParams({ cursor: "next" }), new AbortController().signal);
    expect(refused.status).toBe(429);
    expect(count()).toBe(2);
  });
});

it.each([429, 503])("B1 legacy catalog/status reads also hold HTTP %s without a storm", async status => {
  composio.resetManagedBrokerState();
  composio.setManagedBrokerAccess({ url: "https://legacy.example.test", token: "b".repeat(64) });
  hits = [];
  vi.mocked(fetch).mockImplementation(async input => {
    hits.push({ path: new URL(String(input)).pathname, at: Date.now() });
    return Response.json({}, { status, headers: { "retry-after": "600" } });
  });
  const backend = composio.catalogBackend(cfg())!;
  const answers = await Promise.all(Array.from({ length: 10 }, () => backend.request(new URLSearchParams(), new AbortController().signal)));
  expect(answers.every(answer => answer.status === status)).toBe(true);
  expect(count()).toBe(1);
  for (let i = 0; i < 20; i++) {
    await composio.connectionStatus(cfg(), ["gmail"]).catch(() => {});
    await vi.advanceTimersByTimeAsync(5 * SECOND);
  }
  expect(count()).toBe(1);
});

it("B1 shared failure response bodies can each be cancelled without waiting for another reader", async () => {
  vi.mocked(fetch).mockImplementation(async input => {
    hits.push({ path: new URL(String(input)).pathname, at: Date.now() });
    return Response.json({}, { status: 429, headers: { "retry-after": "600" } });
  });
  const backend = composio.catalogBackend(cfg())!;
  const responses = await Promise.all(Array.from({ length: 10 }, () => backend.request(new URLSearchParams(), new AbortController().signal)));
  let finished = 0;
  const cancelled = responses.map(response => response.body!.cancel().then(() => { finished++; }));
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(10);
  await Promise.all(cancelled);
  expect(count()).toBe(1);
});

it("B2 a tool 503 still permits mandatory EXPIRED inventory verification", async () => {
  await composio.connectedServices(cfg());
  mcpAnswer = () => {
    inventoryAnswer = () => ({ status: 200, body: { services: { gmail: { connected: false, status: "EXPIRED", accounts: [{ id: "ca_1", status: "EXPIRED" }] } } } });
    return { status: 503, headers: { "retry-after": "600" } };
  };
  await composio.checkIdleConnectorHealth(cfg(), ["gmail"]);
  expect(count("/v1/mcp")).toBe(1);
  expect(count("/v1/connectors/connected")).toBe(2);
  expect(composio.appsNeedingReconnect(cfg())[0]?.accounts).toEqual([{ id: "ca_1" }]);
});

// Concurrent discovery SSE must remain an answer to each waiting request.
it.each(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"])("R4 shared %s SSE retains each response id, notifications and foreign frames", async name => {
  let calls = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("/health")) return Response.json({ ready: true });
    calls++;
    const request = JSON.parse(String(init?.body));
    return new Response(': keepalive\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"id":"progress"}}\r\n\r\ndata: {"jsonrpc":"2.0","id":"foreign","result":{}}\r\n\r\ndata: '+JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "fixture" }] } })+'\r\n\r\ndata: [DONE]\r\n\r\n', { headers: { "content-type": "text/event-stream" } });
  });
  const ids = [1, "second", 3];
  const replies = await Promise.all(ids.map(id => composio.relayMcp(cfg(), { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { query: "fixture-sse" } } } as never)));
  expect(calls).toBe(1);
  replies.forEach((reply, i) => {
    const text = new TextDecoder().decode(reply.bytes);
    const frames = text.split(/\r?\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(5)));
    expect(reply.contentType).toContain("text/event-stream");
    expect(frames.at(-1)).toMatchObject({ id: ids[i], result: { content: [{ text: "fixture" }] } });
    expect(frames[0]).not.toHaveProperty("id");
    expect(frames[1].id).toBe("foreign");
    expect(text).toContain(": keepalive"); expect(text).toContain("data: [DONE]");
  });
});

it("R4 shared SSE identifies the leader response even when a foreign response comes last", async () => {
  let calls = 0;
  vi.mocked(fetch).mockImplementation(async (_input, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    return new Response('data: '+JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "leader" }] } })+'\n\ndata: {"jsonrpc":"2.0","id":"foreign-last","result":{"content":[]}}\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const ids = [0, "second"];
  const replies = await Promise.all(ids.map(id => composio.relayMcp(cfg(), { jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "foreign-last-fixture" } } } as never)));
  expect(calls).toBe(1);
  replies.forEach((reply, index) => {
    const frames = new TextDecoder().decode(reply.bytes).split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(frames[0]).toMatchObject({ id: ids[index], result: { content: [{ text: "leader" }] } });
    expect(frames[1]).toMatchObject({ id: "foreign-last", result: { content: [] } });
  });
});
