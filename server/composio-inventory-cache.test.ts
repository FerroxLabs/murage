// The connected-accounts inventory cache (0.1.62, Bug 3).
//
// Opening Connected apps took 20-40 s because every surface (panel, tray,
// setup card, bot access) made its own full broker round trip. The cache is
// single-flight, stale-while-revalidate, persisted, and owned per credential:
// one owner's list is never served to another, and anything that could make a
// remembered "connected" untrue (disconnect, connect, a token or key change)
// invalidates it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyManagedBrokerMessage,
  authorizeService,
  connectedInventory,
  connectedPanelInventory,
  connectedServices,
  connectionStatus,
  forgetInventoryMemory,
  primeBrokerReadiness,
  relayMcp,
  refreshFluxAccountStatusBriefly,
  removeAccount,
  resetManagedBrokerState,
} from "./composio.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const URL_BASE = "https://flux.example.test/composio";
const cfg = (): AppConfig => ({}) as AppConfig;

interface Hit { path: string; method: string; auth: string | null; body?: unknown }
let hits: Hit[] = [];
let inventory: Record<string, unknown> = {};
let inventoryDelayMs = 0;
let inventoryHangs = false;
let meHangs = false;
let upstreamMcp: (payload: { method?: string; id?: unknown; params?: { name?: string } }, n: number) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
let mcpCalls = 0;

function stubBroker() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const auth = new Headers(init?.headers).get("authorization");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/composio", "").replace("/legacy", "") + url.search;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    hits.push({ path, method, auth, body: raw ? JSON.parse(raw) : undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/health") return json(200, { ready: true });
    if (path === "/v1/me") {
      if (meHangs) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      return json(200, { freeRunsRemainingToday: 3 });
    }
    if (path === "/v1/connectors/connected") {
      if (inventoryHangs) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      if (inventoryDelayMs) await new Promise((r) => setTimeout(r, inventoryDelayMs));
      return json(200, { services: inventory });
    }
    if (path.startsWith("/v1/connectors?")) return json(200, { services: { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }] } } });
    if (path.endsWith("/authorize")) return json(200, { url: "https://connect.composio.dev/link/1" });
    if (method === "DELETE") return json(200, { removed: 1 });
    if (path === "/v1/mcp") {
      mcpCalls += 1;
      const payload = JSON.parse(raw ?? "{}");
      const answer = upstreamMcp(payload, mcpCalls);
      return json(answer.status, answer.body);
    }
    return json(404, {});
  }));
}

const LEGACY_TOKEN = "f".repeat(64);
const LEGACY_URL = "https://flux.example.test/legacy";
/** An install that still holds the Worker identity AND has a Flux token. */
function useBothBrokers() {
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: { url: LEGACY_URL, token: LEGACY_TOKEN },
    fluxBrokerUrl: URL_BASE,
    fluxAccess: { url: URL_BASE, token: TOKEN_A },
    legacyUntil: "2999-01-01T00:00:00Z",
    legacyClaim: { state: "claimed" },
    accountKind: null,
    tokenError: null,
  });
}

function useToken(token: string) {
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: null,
    fluxBrokerUrl: URL_BASE,
    fluxAccess: { url: URL_BASE, token },
    legacyUntil: "",
    legacyClaim: { state: "none" },
    accountKind: null,
    tokenError: null,
  });
}

const gmail = (id = "ca_1") => ({ gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id, status: "ACTIVE" }] } });
const inventoryHits = () => hits.filter((hit) => hit.path === "/v1/connectors/connected").length;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  hits = [];
  inventory = gmail();
  inventoryDelayMs = 0;
  inventoryHangs = false;
  meHangs = false;
  mcpCalls = 0;
  upstreamMcp = () => ({ status: 200, body: {} });
  resetManagedBrokerState();
  stubBroker();
  useToken(TOKEN_A);
  await primeBrokerReadiness();
  hits = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetManagedBrokerState();
});

describe("single-flight and freshness", () => {
  it("answers a second call inside the freshness window from memory", async () => {
    await connectedServices(cfg());
    await connectedServices(cfg());
    expect(inventoryHits()).toBe(1);
  });

  it("joins five concurrent identical requests into one broker call", async () => {
    inventoryDelayMs = 20;
    const all = await Promise.all(Array.from({ length: 5 }, () => connectedServices(cfg())));
    expect(inventoryHits()).toBe(1);
    for (const services of all) expect(services.gmail.connected).toBe(true);
  });

  it("serves a stale list at once and refreshes it in the background", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await connectedServices(cfg());
    vi.setSystemTime(Date.now() + 61_000);
    inventory = { ...gmail(), slack: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_2", status: "ACTIVE" }] } };
    const stale = await connectedInventory(cfg());
    expect(Object.keys(stale.services ?? {})).toEqual(["gmail"]);
    expect(stale.revalidating).toBe(true);
    await flush();
    const fresh = await connectedInventory(cfg());
    expect(Object.keys(fresh.services ?? {}).sort()).toEqual(["gmail", "slack"]);
    expect(fresh.revalidating).toBe(false);
  });

  it("keeps the remembered list when a background refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await connectedServices(cfg());
    vi.setSystemTime(Date.now() + 61_000);
    inventoryHangs = false;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const stale = await connectedInventory(cfg());
    await flush();
    const after = await connectedInventory(cfg());
    expect(after.services).toEqual(stale.services);
    expect(after.services?.gmail.connected).toBe(true);
  });

  it("answers a cold, slow broker within the wait budget with no list and revalidating", async () => {
    inventoryHangs = true;
    const started = Date.now();
    const answer = await connectedInventory(cfg(), { waitMs: 60 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(answer.services).toBeNull();
    expect(answer.revalidating).toBe(true);
  });
});

describe("a remembered inventory is usable before any broker call", () => {
  it("makes zero broker calls before first paint after a restart", async () => {
    await connectedServices(cfg());
    expect(inventoryHits()).toBe(1);
    forgetInventoryMemory(); // the process restarts; the file stays
    hits = [];
    const first = await connectedInventory(cfg());
    expect(hits).toHaveLength(0);
    expect(first.services?.gmail.connected).toBe(true);
    expect(first.revalidating).toBe(true);
    await flush();
    expect(inventoryHits()).toBe(1);
  });

  it("persists only slugs, ids, aliases and statuses, never a token or key", async () => {
    await connectedServices(cfg());
    const path = join(DATA_DIR, "connected-apps-inventory.json");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toMatch(/token|apiKey|authorization/i);
    expect(text).toContain("ca_1");
  });
});

describe("a remembered list is never shown after it stopped being true", () => {
  it("drops the list when an account is disconnected here", async () => {
    await connectedServices(cfg());
    await removeAccount(cfg(), "gmail", "ca_1");
    inventory = {};
    const after = await connectedServices(cfg());
    expect(after.gmail).toBeUndefined();
  });

  it("never stores a refresh that began before a disconnect", async () => {
    inventoryDelayMs = 30;
    const early = connectedServices(cfg()); // reads the broker while ca_1 still exists
    await new Promise((r) => setTimeout(r, 5));
    await removeAccount(cfg(), "gmail", "ca_1");
    await early;
    inventory = {};
    inventoryDelayMs = 0;
    const after = await connectedInventory(cfg(), { waitMs: 1000 });
    expect(after.services?.gmail).toBeUndefined();
  });

  it("refetches after a connect starts", async () => {
    await connectedServices(cfg());
    await authorizeService(cfg(), "slack", "work");
    inventory = { ...gmail(), slack: { connected: false, pending: true, status: "INITIATED", accounts: [{ id: "ca_9", alias: "work", status: "INITIATED" }] } };
    const next = await connectedServices(cfg(), { fresh: true });
    expect(next.slack?.pending).toBe(true);
  });

  it("refetches once a status poll sees the sign-in finish", async () => {
    inventory = { slack: { connected: false, pending: true, status: "INITIATED", accounts: [{ id: "ca_9", status: "INITIATED" }] } };
    await connectedServices(cfg());
    inventory = gmail();
    await connectionStatus(cfg(), ["gmail"]); // the broker says ACTIVE
    const next = await connectedServices(cfg(), { fresh: true });
    expect(next.gmail?.connected).toBe(true);
    expect(next.slack).toBeUndefined();
  });

  it("refetches when the panel asks with force", async () => {
    await connectedServices(cfg());
    inventory = {};
    const forced = await connectedInventory(cfg(), { force: true, waitMs: 1000 });
    expect(forced.services).toEqual({});
  });
});

describe("one owner's list is never served to another", () => {
  it("does not show owner A's list to owner B, and drops it when the token changes", async () => {
    await connectedServices(cfg()); // A: gmail
    hits = [];
    useToken(TOKEN_B);
    await primeBrokerReadiness();
    inventory = { notion: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_b", status: "ACTIVE" }] } };
    const b = await connectedServices(cfg());
    expect(Object.keys(b)).toEqual(["notion"]);
    // The broker was asked with B's token, not answered from A's memory.
    expect(hits.filter((hit) => hit.path === "/v1/connectors/connected").map((hit) => hit.auth)).toEqual([`Bearer ${TOKEN_B}`]);
    // Back to A: A's old list is gone, so it is fetched again, not recalled.
    useToken(TOKEN_A);
    await primeBrokerReadiness();
    inventory = {};
    const a = await connectedServices(cfg());
    expect(a).toEqual({});
  });

  it("does not load another owner's persisted list after a restart", async () => {
    await connectedServices(cfg()); // A persisted
    forgetInventoryMemory();
    useToken(TOKEN_B);
    await primeBrokerReadiness();
    hits = [];
    inventoryHangs = true; // B's own answer has not arrived: nothing of A's may stand in for it
    const first = await connectedInventory(cfg(), { waitMs: 20 });
    expect(first.services).toBeNull();
  });

  it("forgets the list when the token is replaced mid-session", async () => {
    await connectedServices(cfg());
    useToken(TOKEN_B);
    inventoryHangs = true;
    const peek = await connectedInventory(cfg(), { waitMs: 20 });
    expect(peek.services).toBeNull();
  });
});

describe("tool search and schema cache", () => {
  const search = (id: number, query = "send mail") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: query }] } } });
  const execute = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [] } } });
  const ok = (id: unknown) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "found" }] } });
  const run = async (payload: object) => {
    const out = await relayMcp(cfg(), payload as never);
    return JSON.parse(new TextDecoder().decode(out.bytes));
  };

  beforeEach(() => {
    upstreamMcp = (payload) => ({ status: 200, body: ok(payload.id) });
  });

  it("makes one upstream call for two identical searches and answers with the request's own id", async () => {
    const first = await run(search(1));
    const second = await run(search(2));
    expect(mcpCalls).toBe(1);
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(second.result).toEqual(first.result);
  });

  it("does not share a search between different arguments", async () => {
    await run(search(1, "send mail"));
    await run(search(2, "read calendar"));
    expect(mcpCalls).toBe(2);
  });

  it("never caches executing a tool", async () => {
    await run(execute(1));
    await run(execute(2));
    expect(mcpCalls).toBe(2);
  });

  it("never caches an error answer", async () => {
    upstreamMcp = (payload) => ({ status: 200, body: { jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "nope" } } });
    await run(search(1));
    await run(search(2));
    expect(mcpCalls).toBe(2);
  });

  it("caches tools/list", async () => {
    const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
    await run(list(1));
    await run(list(2));
    expect(mcpCalls).toBe(1);
  });

  it("drops cached searches when the inventory changes", async () => {
    await run(search(1));
    await connectedServices(cfg());
    await authorizeService(cfg(), "slack", "work");
    await run(search(2));
    expect(mcpCalls).toBe(2);
  });

  it("expires a cached search after its short lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await run(search(1));
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await run(search(2));
    expect(mcpCalls).toBe(2);
  });

  it("does not serve one owner's search to another", async () => {
    await run(search(1));
    useToken(TOKEN_B);
    await primeBrokerReadiness();
    await run(search(2));
    expect(mcpCalls).toBe(2);
  });
});

describe("the panel route's inventory", () => {
  it("answers a remembered list at once while the broker hangs, with no broker call before it", async () => {
    await connectedServices(cfg());
    forgetInventoryMemory();
    hits = [];
    inventoryHangs = true;
    const started = Date.now();
    const panel = await connectedPanelInventory(cfg());
    expect(Date.now() - started).toBeLessThan(200);
    expect(hits).toHaveLength(0);
    expect(panel.kind).toBe("ok");
    if (panel.kind === "ok") {
      expect(panel.read.services?.gmail.connected).toBe(true);
      expect(panel.read.revalidating).toBe(true);
    }
  });

  it("still answers with the remembered list while the broker is unreachable", async () => {
    await connectedServices(cfg());
    forgetInventoryMemory();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const panel = await connectedPanelInventory(cfg());
    expect(panel.kind === "ok" && panel.read.services?.gmail.connected).toBe(true);
  });

  it("waits for a Retry (force) but never longer than its budget", async () => {
    await connectedServices(cfg());
    inventoryHangs = true;
    const started = Date.now();
    const panel = await connectedPanelInventory(cfg(), { force: true });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(panel.kind === "ok" && panel.read.services?.gmail.connected).toBe(true);
  }, 10_000);

  it("does not hold the catalog route for the allowance line", async () => {
    meHangs = true;
    const started = Date.now();
    await refreshFluxAccountStatusBriefly(cfg(), 100);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("review round 1: the cache's edges", () => {
  it("F7: stores nothing when the owner changed while the fetch was in flight", async () => {
    const live = {} as AppConfig;
    inventoryDelayMs = 40;
    const reading = connectedServices(live).catch((error: Error) => error);
    await new Promise((r) => setTimeout(r, 10));
    useToken(TOKEN_B); // the token changed under the fetch
    const outcome = await reading;
    expect(outcome).toBeInstanceOf(Error);
    useToken(TOKEN_A);
    inventoryHangs = true;
    const after = await connectedInventory(live, { waitMs: 20 });
    expect(after.services).toBeNull(); // nothing of the old owner's was kept
  });

  it("F8: a Flux outage does not flip the owner to the Worker identity and lose the list", async () => {
    useBothBrokers();
    await primeBrokerReadiness();
    await connectedServices(cfg()); // remembered while Flux is ready
    // Flux goes dark: the health probe fails, so calls fall back to the Worker.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      if (path.endsWith("/health")) return new Response("{}", { status: 503 });
      throw new TypeError("fetch failed");
    }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000); // past the ready TTL, so the probe runs
    await primeBrokerReadiness();
    const during = await connectedInventory(cfg(), { waitMs: 20 });
    expect(during.services?.gmail.connected).toBe(true);
  });

  it("F13: a caller that joined a fetch begun before a disconnect is told it is revalidating", async () => {
    inventoryDelayMs = 30;
    const early = connectedInventory(cfg(), { waitMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    await removeAccount(cfg(), "gmail", "ca_1");
    const answer = await early;
    expect(answer.revalidating).toBe(true);
  });

  it("F13: a fresh read that raced a disconnect fetches again instead of listing the removed account", async () => {
    inventoryDelayMs = 30;
    const early = connectedServices(cfg(), { fresh: true });
    await new Promise((r) => setTimeout(r, 5));
    inventory = {}; // the broker's answer once the account is gone
    await removeAccount(cfg(), "gmail", "ca_1");
    inventoryDelayMs = 0;
    expect((await early).gmail).toBeUndefined();
  });
});

describe("review round 2 (N3): a 401 does not wipe what is remembered", () => {
  const rejected = () => {
    const original = globalThis.fetch;
    return original;
  };

  it("keeps the last known list, marked stale, and its file, when the token is rejected", async () => {
    await connectedServices(cfg());
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      if (path.endsWith("/health")) return new Response(JSON.stringify({ ready: true }), { status: 200 });
      return new Response(JSON.stringify({ code: "broker_token_revoked" }), { status: 401, headers: { "content-type": "application/json" } });
    }));
    await connectedInventory(cfg(), { force: true, waitMs: 1000 }).catch(() => undefined); // the 401
    expect(existsSync(join(DATA_DIR, "connected-apps-inventory.json"))).toBe(true);
    const panel = await connectedInventory(cfg(), { waitMs: 20 });
    expect(panel.services?.gmail.connected).toBe(true);
    expect(panel.revalidating).toBe(true);
    void rejected;
  });

  it("carries the list across the re-mint that follows a 401 (same install), still refetching", async () => {
    await connectedServices(cfg());
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      if (path.endsWith("/health")) return new Response(JSON.stringify({ ready: true }), { status: 200 });
      return new Response(JSON.stringify({ code: "broker_token_revoked" }), { status: 401, headers: { "content-type": "application/json" } });
    }));
    await connectedInventory(cfg(), { force: true, waitMs: 1000 }).catch(() => undefined);
    stubBroker();
    useToken(TOKEN_B); // the desktop's new token
    inventoryHangs = true;
    const panel = await connectedInventory(cfg(), { waitMs: 20 });
    expect(panel.services?.gmail.connected).toBe(true);
    expect(panel.revalidating).toBe(true);
  });

  it("still drops the list on a token change that did not follow a rejection", async () => {
    await connectedServices(cfg());
    useToken(TOKEN_B);
    inventoryHangs = true;
    expect((await connectedInventory(cfg(), { waitMs: 20 })).services).toBeNull();
  });
});
