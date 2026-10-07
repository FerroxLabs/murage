// Connected apps recover from a network drop with no restart (0.1.62, Bug 2).
//
// "Not ready" used to be trusted indefinitely by every reader that did not
// probe, one 404 or 503 poisoned the rest of a turn, and a dead MCP session id
// was forwarded for the life of the proxy. Each test below fails on that
// behavior and passes once the broker is re-checked after the negative TTL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyManagedBrokerMessage,
  connectedPanelInventory,
  connectorAccess,
  connectorSystemPrompt,
  configured,
  primeBrokerReadiness,
  relayMcp,
  resetManagedBrokerState,
  BROKER_UNREACHABLE,
} from "./composio.ts";
import type { AppConfig } from "./config.ts";

const TOKEN = "d".repeat(64);
const BASE = "https://flux.example.test/composio";
const cfg = (): AppConfig => ({}) as AppConfig;

let online = true;
let healthStatus = 200;
let mcp: (payload: any, headers: Headers, n: number) => Response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
let mcpN = 0;
let paths: string[] = [];
let inventoryBody: unknown = { services: { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }] } } };

const rpc = (payload: { id?: unknown }, text = "ok") => new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text }] } }), { status: 200, headers: { "content-type": "application/json" } });

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (!online) throw new TypeError("fetch failed");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace("/composio", "");
    paths.push(path);
    if (path === "/health") return new Response(JSON.stringify({ ready: healthStatus === 200 }), { status: healthStatus, headers: { "content-type": "application/json" } });
    if (path === "/v1/connectors/connected") return new Response(JSON.stringify(inventoryBody), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/v1/mcp") {
      mcpN += 1;
      return mcp(JSON.parse(String(init?.body ?? "{}")), new Headers(init?.headers), mcpN);
    }
    return new Response("{}", { status: 404 });
  }));
}

function connect() {
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: null,
    fluxBrokerUrl: BASE,
    fluxAccess: { url: BASE, token: TOKEN },
    legacyUntil: "",
    legacyClaim: { state: "claimed" },
    accountKind: null,
    tokenError: null,
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const call = async (id: number, session?: string) => {
  const out = await relayMcp(cfg(), { jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: {} } }, session);
  return { ...out, json: JSON.parse(new TextDecoder().decode(out.bytes)) as any };
};

beforeEach(() => {
  online = true;
  healthStatus = 200;
  mcpN = 0;
  paths = [];
  mcp = (payload) => rpc(payload);
  resetManagedBrokerState();
  stub();
  connect();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetManagedBrokerState();
});

describe("readiness heals itself", () => {
  it("re-checks a not-ready answer after the negative TTL even when nothing primes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    online = false;
    await primeBrokerReadiness();
    expect(configured(cfg())).toBe(false);
    online = true;
    vi.setSystemTime(Date.now() + 21_000);
    configured(cfg()); // a reader that never primes
    await flush();
    expect(configured(cfg())).toBe(true);
  });

  it("does not re-probe inside the negative TTL", async () => {
    online = false;
    await primeBrokerReadiness();
    paths = [];
    for (let i = 0; i < 20; i += 1) configured(cfg());
    await flush();
    expect(paths.filter((path) => path === "/health")).toHaveLength(0);
  });
});

describe("one failed call does not poison the rest of a turn", () => {
  it("answers the next tool call after one 503", async () => {
    await primeBrokerReadiness();
    mcp = (payload, _headers, n) => n === 1 ? new Response("<html>503</html>", { status: 503 }) : rpc(payload, "second");
    const first = await call(1);
    expect(JSON.stringify(first.json)).not.toMatch(/Connect Flux Router/);
    const second = await call(2);
    expect(second.json.result.content[0].text).toBe("second");
  });

  it("answers the next tool call after one 404 that carried no session", async () => {
    await primeBrokerReadiness();
    mcp = (payload, _headers, n) => n === 1 ? new Response("not found", { status: 404 }) : rpc(payload, "second");
    await call(1);
    const second = await call(2);
    expect(second.json.result.content[0].text).toBe("second");
  });

  it("says the apps are briefly unreachable, in plain words, after a 503", async () => {
    await primeBrokerReadiness();
    mcp = () => new Response("<html>nginx</html>", { status: 503 });
    const first = await call(1);
    expect(first.json.result.content[0].text).toBe(BROKER_UNREACHABLE);
    expect(BROKER_UNREACHABLE).not.toMatch(/—|safe|safety|composio|\$/i);
  });
});

describe("a dead MCP session is forgotten, not blamed on the broker", () => {
  it("keeps the broker ready and stops forwarding the id when the session is gone", async () => {
    await primeBrokerReadiness();
    const seen: Array<string | null> = [];
    mcp = (payload, headers, n) => {
      seen.push(headers.get("mcp-session-id"));
      if (n === 1) return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
      if (n === 2) return new Response("session not found", { status: 404 });
      return rpc(payload);
    };
    const open = await call(1);
    expect(open.transportSessionId).toBe("s1");
    const gone = await call(2, "s1");
    expect(gone.status).toBe(404);
    expect(configured(cfg())).toBe(true); // readiness untouched
    await call(3, "s1");
    expect(seen).toEqual([null, "s1", null]); // the dead id is not forwarded again
  });
});

describe("the prompt and the error tell an outage from 'not set up'", () => {
  it("says unreachable, never 'not set up', when a token exists and the broker is down", async () => {
    online = false;
    await primeBrokerReadiness();
    const access = connectorAccess({ cfg: cfg(), botComposio: undefined, installedFromPackage: false, engineMountsConnectors: true, mounted: false });
    expect(access).toBe("unreachable");
    const prompt = connectorSystemPrompt(access);
    expect(prompt).not.toMatch(/not set up|neither FluxRouter/i);
    expect(prompt).toMatch(/can't be reached right now/);
  });

  it("still says 'unconfigured' when there is no token at all", () => {
    resetManagedBrokerState();
    expect(connectorAccess({ cfg: cfg(), botComposio: undefined, installedFromPackage: false, engineMountsConnectors: true, mounted: false })).toBe("unconfigured");
  });
});

describe("the whole drop and recovery, with no restart and no user action", () => {
  it("recovers connected apps by itself after the network drops and comes back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await primeBrokerReadiness();
    expect(configured(cfg())).toBe(true);
    expect((await call(1)).json.result.content[0].text).toBe("ok");

    // The connection drops. Tool calls say so in plain words; nothing throws.
    online = false;
    vi.setSystemTime(Date.now() + 6 * 60_000); // past the ready TTL too
    const dropped = await call(2);
    expect(dropped.json.result.content[0].text).toContain(BROKER_UNREACHABLE);
    await flush();
    vi.setSystemTime(Date.now() + 1_000);
    configured(cfg());
    await flush();
    expect(configured(cfg())).toBe(false);

    // The connection returns. Nobody restarts the app or presses anything:
    // a reader that never primes, one negative TTL later, is all it takes.
    online = true;
    vi.setSystemTime(Date.now() + 21_000);
    configured(cfg());
    await flush();
    expect(configured(cfg())).toBe(true);
    expect((await call(3)).json.result.content[0].text).toBe("ok");
    const panel = await connectedPanelInventory(cfg(), { force: true });
    expect(panel.kind === "ok" && panel.read.services?.gmail.connected).toBe(true);
  });
});
