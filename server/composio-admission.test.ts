import { setBackoffRandomForTests } from "./upstream-backoff.ts";
// Owners: composio-429-e owns the request producers, private port and these consumers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as composio from "./composio.ts";
import { clearInventory } from "./connected-inventory.ts";
import { createComposioLifecycle, type ComposioLifecycle } from "../electron/composio-lifecycle.mjs";
import { createComposioAdmissionHost } from "../electron/composio-admission-port.mjs";
import { connectComposioAuthority, disconnectComposioAuthority, receiveComposioAdmission, composioAdmissionStatus, composioFetch as admittedFetch, resetComposioLifecycleForTests } from "./composio-lifecycle.ts";
import type { AppConfig } from "./config.ts";
import { createSupervisorPort } from "./cloud-home/supervisor-port.ts";
import { fluxKeyFingerprint } from "../electron/flux-composio-token.mjs";
import { readFileSync } from "node:fs";
import { check, readLists, select } from "../scripts/ci-test-tiers.mjs";

const composioFetch = (url: string | URL, init?: RequestInit, beforeDispatch?: () => void) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${String(url).startsWith("https://legacy.example.test") ? "b".repeat(64) : "a".repeat(64)}`);
  return admittedFetch(url, { ...init, headers }, beforeDispatch);
};
function memoryAdmissionStore() {
  let rows: Parameters<NonNullable<Parameters<typeof createComposioLifecycle>[0]["store"]>["save"]>[0] = [];
  return { load: () => structuredClone(rows), save: (next: typeof rows) => { rows = structuredClone(next); } };
}
const base = "https://broker.example.test";
const config = {} as AppConfig;
let refuse = "/v1/me", hits: Array<{ path: string; method: string; at: number }>;
const owned: Array<{ dispose(): void }> = [];
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T00:00:00Z")); vi.spyOn(Math, "random").mockReturnValue(1);
  hits = [];
  setBackoffRandomForTests(() => 1);
  composio.resetManagedBrokerState();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    hits.push({ path, method: init?.method ?? "GET", at: Date.now() });
    return Response.json(path === "/health" ? { ready: true } : {}, {
      status: path === refuse ? 429 : 200, headers: path === refuse ? { "retry-after": "7200" } : {},
    });
  }));
  composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: base, fluxAccess: { url: base, token: "a".repeat(64) }, legacyUntil: "" });
  await composio.primeBrokerReadiness(); hits = [];
});
afterEach(() => {
  for (const item of owned.splice(0)) item.dispose();
  disconnectComposioAuthority(); resetComposioLifecycleForTests(); setBackoffRandomForTests();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("real server request producers", () => {
  it.each([
    ["S03 catalog", "/v1/catalog/toolkits", "GET"],
    ["S03 search", "/v1/catalog/toolkits/search?q=fixture", "GET"],
    ["S03 page", "/v1/catalog/toolkits?cursor=fixture", "GET"],
    ["S04 allowance", "/v1/me", "GET"],
    ["S05 status", "/v1/connectors/status?services=fixture", "GET"],
    ["S06 inventory", "/v1/connectors/connected", "GET"],
    ["S10 authorization", "/v1/connectors/fixture/authorize", "POST"],
    ["S10 disconnect", "/v1/connectors/fixture/accounts/fixture", "DELETE"],
    ["S11 cleanup", "/v1/connectors/fixture/accounts/previous", "DELETE"],
  ])("%s cannot dispatch during the shared origin floor", async (_name, path, method) => {
    refuse = "/v1/me";
    const first = await composio.brokerRequest(config, "/v1/me");
    expect(first.status).toBe(429); expect(hits).toHaveLength(1);
    for (const offset of [15_000, 60_000, 3600_000, 7199_999]) {
      vi.setSystemTime(new Date(Date.parse("2026-11-01T00:00:00Z") + offset));
      const held = await composio.brokerRequest(config, path!, { method });
      expect(held.status).toBe(429);
      expect(hits).toHaveLength(1);
      expect(composio.connectorPanelFields(config, true).admission.retryAt).toBe(Date.parse("2026-11-01T02:00:00Z"));
    }
  });
  it("S07/S08 lists, search, schema, session and actions honor raw refusal", async () => {
    refuse = "/v1/mcp";
    const first = await composio.relayMcpUpstream(config, { jsonrpc: "2.0", id: 1, method: "tools/list" } as never);
    expect(first.upstreamStatus).toBe(429);
    expect(hits.filter(x => x.path === "/v1/mcp")).toHaveLength(1);
    for (const name of ["tools/list", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "FIXTURE_ACTION"]) {
      const payload = name === "tools/list" ? { jsonrpc: "2.0", id: 2, method: name } : { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } };
      const held = await composio.relayMcpUpstream(config, payload as never);
      expect(held.delivery).toBe("not-sent");
      expect(hits.filter(x => x.path === "/v1/mcp")).toHaveLength(1);
    }
  });
  it("sends the background Flux memory headers on a Flux broker request and none to another host", async () => {
    for (const [url, onFlux] of [["https://api.fluxrouter.ai/composio", true], [base, false]] as const) {
      composio.resetManagedBrokerState();
      composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: url, fluxAccess: { url, token: "a".repeat(64) }, legacyUntil: "" });
      const seen: Headers[] = [];
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        if (new URL(String(input)).pathname === "/health" || String(input).endsWith("/composio/health")) return Response.json({ ready: true });
        seen.push(new Headers(init?.headers)); return Response.json({});
      });
      await composio.primeBrokerReadiness();
      const response = await composio.brokerRequest(config, "/v1/me", { headers: { "x-flux-memory-capture": "on", "x-flux-feature": "chat" } });
      expect(response.status, url).toBe(200);
      expect(seen, url).toHaveLength(1);
      expect(seen[0]!.get("x-flux-memory-app"), url).toBe(onFlux ? "murage" : null);
      expect(seen[0]!.get("x-flux-memory-capture"), url).toBe(onFlux ? "off" : "on");
      expect(seen[0]!.get("x-flux-memory-inject"), url).toBe(onFlux ? "off" : null);
      expect(seen[0]!.get("x-flux-feature"), url).toBe(onFlux ? "other" : "chat");
      expect(seen[0]!.get("authorization"), url).toBe(`Bearer ${"a".repeat(64)}`);
    }
  });
});

function parentFixture(legacyBrokerUrl?: string, fluxBrokerUrl: string = base) {
  let credentials: Record<string, unknown> = { fluxApiKey: "sk-flux-fixture-owner", fluxComposioBrokerToken: "a".repeat(64), composioBrokerToken: "b".repeat(64) };
  let authority!: ComposioLifecycle;
  let records: Parameters<NonNullable<Parameters<typeof createComposioLifecycle>[0]["store"]>["save"]>[0] = [];
  const host = createComposioAdmissionHost({ authority: () => authority, send: message => { receiveComposioAdmission(message); } });
  authority = createComposioLifecycle({
    getConfiguration: () => ({ fluxBrokerUrl, legacyBrokerUrl, prepareLegacy: false }),
    getCredentials: () => credentials, saveCredentials: async next => { credentials = next; return true; },
    lifecycleTransport: (url, init) => globalThis.fetch(url, init), transport: host.transport,
    now: Date.now, monotonic: Date.now, random: () => 1, store: { load: () => structuredClone(records), save: rows => { records = structuredClone(rows); } },
  });
  owned.push(host, authority);
  connectComposioAuthority({ postMessage: message => { host.receive(message); } });
  return { host, authority };
}
describe("private-port authority", () => {
  it.each(["desktop", "cloud"])("A7 %s parent-required readiness keeps all three eligible attempts", async mode => {
    vi.stubEnv("MURAGE_DESKTOP_PARENT", mode === "desktop" ? "1" : "");
    vi.stubEnv("MURAGE_CLOUD_ROLE", mode === "cloud" ? "home" : "");
    let attempts = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      hits.push({ path, method: "GET", at: Date.now() });
      if (path === "/health" && ++attempts <= 2) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT", syscall: "connect" } });
      return Response.json({ ready: true });
    });
    composio.resetManagedBrokerState();
    parentFixture();
    composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: base, fluxAccess: { url: base, token: "a".repeat(64) }, legacyUntil: "" });
    const done = composio.primeBrokerReadiness();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(attempts).toBe(1); // MAIN RULING 1115-COMPOSIO-A7
    expect(composioAdmissionStatus(`${base}/health`)).toMatchObject({ outcome: "held", attempted: false, retryAt: Date.now() + 1 }); // MAIN RULING 1115-COMPOSIO-A7
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2); // MAIN RULING 1115-COMPOSIO-A7
    await vi.advanceTimersByTimeAsync(59_999);
    expect(attempts).toBe(2); // MAIN RULING 1115-COMPOSIO-A7
    await vi.advanceTimersByTimeAsync(1); await done;
    expect(attempts).toBe(3); // MAIN RULING 1115-COMPOSIO-A7
    expect(composio.connectorAccess({ cfg: config, botComposio: true, installedFromPackage: false, engineMountsConnectors: false, mounted: false })).toBe("engine"); // MAIN RULING 1115-COMPOSIO-A7: the third answer made the broker ready.
  });
  it("A7 parent-required not-sent tool retries keep all three eligible attempts", async () => {
    parentFixture();
    let attempts = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async input => {
      if (String(input).endsWith("/health")) return Response.json({ ready: true });
      attempts++;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT", syscall: "connect" } });
    });
    const done = composio.relayMcp(config, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "FIXTURE_ACTION", arguments: {} } });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(attempts).toBe(1); // MAIN RULING 1115-COMPOSIO-A7
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2); // MAIN RULING 1115-COMPOSIO-A7
    await vi.advanceTimersByTimeAsync(59_999);
    expect(attempts).toBe(2); // MAIN RULING 1115-COMPOSIO-A7
    await vi.advanceTimersByTimeAsync(1);
    const reply = await done;
    expect(attempts).toBe(3); // MAIN RULING 1115-COMPOSIO-A7
    expect(reply.delivery).toBe("not-sent"); // MAIN RULING 1115-COMPOSIO-A7
  });

  // USAGE-TAGS: the request the server child itself sends after its permit (composio-lifecycle.ts dispatchTransport) carries the broker
  // call site's usage tag on a Flux host, and is left untagged on any other broker origin.
  it.each([["https://api.fluxrouter.ai/composio", "other"], [base, null]])("a permitted server broker request to %s is sent with usage feature %s", async (origin, feature) => {
    parentFixture(undefined, origin);
    const seen: Array<string | null> = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      hits.push({ path: new URL(String(url)).pathname, method: init?.method ?? "GET", at: Date.now() });
      seen.push(new Headers(init?.headers).get("x-flux-feature"));
      return Response.json({});
    });
    const response = await composioFetch(`${origin}/v1/connectors/connected`);
    expect(response.status).toBe(200);
    expect(hits.map(hit => hit.path)).toEqual([`${new URL(origin).pathname.replace(/\/$/, "")}/v1/connectors/connected`]);
    expect(seen).toEqual([feature]);
  });
  it("child_and_parent_share_hold", async () => {
    refuse = "/v1/tokens";
    const parent = parentFixture();
    expect((await parent.authority.request({ operation: "reconnect" })).outcome).toBe("held");
    expect(hits).toHaveLength(1);
    const child = await composioFetch(`${base}/v1/connectors/connected`);
    expect(child.status).toBe(429); expect(child.headers.get("x-connected-apps-admission")).toBe("held");
    expect(hits).toHaveLength(1);
  });
  it("child_refusal_holds_parent_mint_before_next_admission", async () => {
    refuse = "/v1/me";
    const parent = parentFixture();
    expect((await composioFetch(`${base}/v1/me`)).status).toBe(429);
    expect(await parent.authority.request({ operation: "reconnect" })).toMatchObject({ outcome: "held", attempted: false });
    expect(hits).toHaveLength(1);
  });
  it("invalid child routes settle without a permit or upstream request", async () => {
    parentFixture();
    let response: Response | undefined;
    const done = composioFetch("https://other.example.test/v1/me").then(value => { response = value; });
    for (let n = 0; n < 100; n++) await Promise.resolve();
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(503);
    expect(await response!.json()).toMatchObject({ outcome: "deferred", reason: "admission_port_unavailable", attempted: false });
    expect(hits).toHaveLength(0);
    await done;
  });
  it("stale_or_missing_port_cannot_dispatch", async () => {
    parentFixture(); disconnectComposioAuthority();
    receiveComposioAdmission({ type: "murage:connected-apps-admission-permit", generation: "obsolete", requestId: "11111111-1111-4111-8111-111111111111" });
    const response = await composioFetch(`${base}/v1/me`);
    expect(response.status).toBe(503); expect(hits).toHaveLength(0);
  });
});

it("cloud_configure_429_blocks_next_configure_and_manual_recovery", async () => {
  let credentials: Record<string, string> = { fluxApiKey: "sk-flux-home-fixture-key-for-home", fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint("sk-flux-home-fixture-key-for-home") };
  const send = vi.fn(), transport = vi.fn(async () => Response.json({}, { status: 429, headers: { "retry-after": "7200" } }));
  const port = createSupervisorPort({ store: { getAll: () => credentials, readBack: () => ({ ...credentials }), patchDurable: patch => { credentials = { ...credentials, ...patch }; return { durable: true }; }, patch: patch => (credentials = { ...credentials, ...patch }) }, send,
    admissionStore: memoryAdmissionStore(), composioTransport: transport });
  owned.push(port);
  await port.configure(); expect(transport).toHaveBeenCalledTimes(1);
  await port.configure(); await port.remintConnectedApps();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(send.mock.calls.some(([message]) => message.type === "murage:managed-composio" && message.admission?.outcome === "held")).toBe(true);
});

it("no_raw_network_export_or_import_and_all_OS_classification", async () => {
  expect(Object.keys(await import("../electron/composio-lifecycle.mjs"))).toEqual(["createComposioLifecycle"]);
  for (const file of ["flux-composio-token.mjs", "composio-legacy-claim.mjs", "managed-composio.mjs"]) {
    const source = readFileSync(new URL(`../electron/${file}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/export (?:async )?function (?:ensureFlux|revokeFlux|prepareLegacy|claimLegacy|ensureManaged|deriveManaged)/);
    expect(source).not.toMatch(/\bfetchImpl\s*\(/);
  }
  const server = readFileSync(new URL("./composio.ts", import.meta.url), "utf8");
  expect(server).not.toMatch(/\b(?:accountedFetch|fetch)\s*\(/);
  expect(server).toContain("composioFetch(");
  const lists = readLists();
  for (const os of ["linux", "mac", "windows"]) {
    const selected = select({ tier: "gate", os });
    // The repository classifier remains the authority; no exception is added.
    expect(JSON.stringify(selected)).toContain("composio-lifecycle.test.mjs");
    expect(JSON.stringify(selected)).toContain("composio-admission.test.ts");
  }
  for (const file of ["electron/composio-lifecycle.test.mjs", "server/composio-admission.test.ts"]) {
    expect(lists.gate.has(file)).toBe(true);
    expect(check().problems.filter(problem => problem.includes(file))).toEqual([]);
  }
});

it("stale_generation_permit_cannot_authorize_a_pending_request", async () => {
  let authority!: ComposioLifecycle;
  let records: Parameters<NonNullable<Parameters<typeof createComposioLifecycle>[0]["store"]>["save"]>[0] = [];
  const host = createComposioAdmissionHost({ authority: () => authority, send: message => {
    const value = message as Record<string, unknown>;
    receiveComposioAdmission(value.type === "murage:connected-apps-admission-permit" ? { ...value, generation: "obsolete-generation" } : value);
  } });
  authority = createComposioLifecycle({ getConfiguration: () => ({ fluxBrokerUrl: base, prepareLegacy: false }), getCredentials: () => ({ fluxComposioBrokerToken: "a".repeat(64) }),
    saveCredentials: async () => true, transport: host.transport, now: Date.now, monotonic: Date.now,
    store: { load: () => structuredClone(records), save: rows => { records = structuredClone(rows); } } });
  owned.push(host, authority);
  connectComposioAuthority({ postMessage: message => { host.receive(message); } });
  const request = composioFetch(`${base}/v1/me`);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(hits).toHaveLength(0);
  disconnectComposioAuthority();
  expect((await request).status).toBe(503);
});

it("memory_refusal_after_a_permit_is_not_reported_as_an_upstream_failure", async () => {
  const parent = parentFixture();
  await expect(composioFetch(`${base}/v1/me`, undefined, () => { throw new Error("fixture memory owner revoked"); }))
    .rejects.toThrow("fixture memory owner revoked");
  expect(hits).toHaveLength(0);
  expect(parent.authority.inspect().outcome).toBe("completed");
});

it("cloud_automatic_recovery_publishes_the_saved_token_and_owner", async () => {
  const key = "sk-flux-home-fixture-key-for-home";
  let credentials: Record<string, string> = { fluxApiKey: key }, calls = 0;
  const send = vi.fn();
  const port = createSupervisorPort({
    store: { getAll: () => credentials, readBack: () => ({ ...credentials }), patchDurable: patch => { credentials = { ...credentials, ...patch }; return { durable: true }; }, patch: patch => (credentials = { ...credentials, ...patch }) }, send,
    admissionStore: memoryAdmissionStore(), admissionNow: Date.now, admissionMonotonic: Date.now,
    composioTransport: async () => ++calls === 1 ? Response.json({}, { status: 429, headers: { "retry-after": "7200" } })
      : Response.json({ token: "c".repeat(64), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() }),
  });
  owned.push(port);
  await port.configure(); expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(7200_000);
  expect(calls).toBe(2);
  const last = send.mock.calls.map(([message]) => message as Record<string, any>).filter(message => message.type === "murage:managed-composio").at(-1);
  expect(last?.fluxAccess?.token).toBe("c".repeat(64));
  expect(last?.fluxOwner).toBe(fluxKeyFingerprint(key));
});

it("parent_data_503_keeps_child_inventory_and_cached_readiness_usable", async () => {
  const parent = parentFixture();
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname; hits.push({ path, method: init?.method ?? "GET", at: Date.now() });
    return Response.json(path === "/health" ? { ready: true } : { services: {} }, { status: path === "/v1/mcp" ? 503 : 200,
      headers: path === "/v1/mcp" ? { "retry-after": "7200" } : {} });
  });
  expect((await composioFetch(`${base}/v1/mcp`, { method: "POST", body: "{}" })).status).toBe(503);
  expect((await composioFetch(`${base}/v1/connectors/connected`)).status).toBe(200);
  await vi.advanceTimersByTimeAsync(301_000); await composio.primeBrokerReadiness();
  expect(composio.connectionBroker(config)).toBe("flux");
  expect(hits).toHaveLength(2); expect(parent.authority.inspect().outcome).toBe("held");
});

it("child_unclaimed_legacy_operation_is_not_denied_by_another_origin_503", async () => {
  const legacy = "https://legacy.example.test";
  parentFixture(legacy);
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const parsed = new URL(String(url)); hits.push({ path: parsed.pathname, method: init?.method ?? "GET", at: Date.now() });
    return parsed.origin === new URL(base).origin ? Response.json({}, { status: 503, headers: { "retry-after": "7200" } })
      : Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  });
  await composioFetch(`${base}/v1/mcp`, { method: "POST", body: "{}" });
  composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: { url: legacy, token: "b".repeat(64) },
    fluxBrokerUrl: base, fluxAccess: null, legacyUntil: "", legacyClaim: { state: "none" } });
  const beforeDispatch = vi.fn();
  const reply = await composio.relayMcpUpstream(config, { jsonrpc: "2.0", id: 1, method: "tools/list" } as never, undefined, beforeDispatch);
  expect(reply.status).toBe(200); expect(reply.delivery).toBeUndefined();
  expect(beforeDispatch).toHaveBeenCalledTimes(1); expect(hits).toHaveLength(2);
});


it.each([0, 64])("child_protocol_admits_200_simultaneous_actions_under_the_same_authority_bound (%s already pending)", async alreadyPending => {
  const releases: ((response: Response) => void)[] = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => releases.push(resolve))));
  parentFixture();
  const requests = Array.from({ length: alreadyPending }, () => composioFetch(`${base}/v1/mcp`, { method: "POST" }));
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
  requests.push(...Array.from({ length: 225 - alreadyPending }, () => composioFetch(`${base}/v1/mcp`, { method: "POST" })));
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
  expect(releases).toHaveLength(200); // MAIN RULING 1115-COMPOSIO-A9
  const excess = await Promise.all(requests.slice(200));
  expect(excess.every(response => response.headers.get("x-connected-apps-admission") === "held")).toBe(true); // MAIN RULING 1115-COMPOSIO-A9
  releases.forEach(release => release(Response.json({}, { status: 429, headers: { "retry-after": "7200" } })));
  const refused = await Promise.all(requests.slice(0, 200));
  expect(refused).toHaveLength(200); // MAIN RULING 1115-COMPOSIO-A9
  expect(refused.every(response => response.status === 429)).toBe(true); // MAIN RULING 1115-COMPOSIO-A9
});

describe("cloud producer admission matrix", () => {
  it.each(["configure", "credential write", "subkey handoff", "child rejection", "manual recovery"])("C01-C03 %s uses the supervisor authority", async trigger => {
    const key = `sk-flux-home-${"f".repeat(30)}`;
    let credentials: Record<string, string> = { fluxApiKey: key };
    let records: Parameters<NonNullable<Parameters<typeof createComposioLifecycle>[0]["store"]>["save"]>[0] = [];
    let refused = true;
    const attempts: number[] = [];
    const port = createSupervisorPort({
      store: { getAll: () => ({ ...credentials }), readBack: () => ({ ...credentials }), patchDurable: patch => { credentials = { ...credentials, ...patch }; return { durable: true }; }, patch: patch => (credentials = { ...credentials, ...patch }) },
      send: () => {}, connectedAppsBrokerUrl: base, now: Date.now, admissionNow: Date.now, admissionMonotonic: Date.now,
      admissionStore: { load: () => structuredClone(records), save: rows => { records = structuredClone(rows); } },
      composioTransport: async () => {
        attempts.push(Date.now());
        return refused ? Response.json({}, { status: 429, headers: { "retry-after": "7200" } })
          : Response.json({ token: "a".repeat(64), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
      },
    });
    owned.push(port);
    const run = () => trigger === "configure" ? port.configure()
      : trigger === "credential write" ? port.handle({ type: "murage:cloud-credential-write", requestId: "fixture-write", credentials: { fluxApiKey: `sk-flux-home-${"n".repeat(30)}` } })
      : trigger === "subkey handoff" ? port.applyFluxSubkey(`sk-flux-home-${"n".repeat(30)}`)
      : trigger === "child rejection" ? port.handle({ type: "murage:flux-composio-token-rejected" })
      : port.remintConnectedApps();
    await port.configure();
    expect(attempts).toHaveLength(1);
    expect(records.length).toBeGreaterThan(0);
    const start = Date.now(), deadline = start + 7200_000;
    for (const elapsed of [15_001, 60_000, 3600_000, 7199_999]) {
      vi.setSystemTime(start + elapsed);
      await run();
      expect(attempts).toHaveLength(1);
      expect(Math.max(...records.map(row => row.notBefore))).toBe(deadline);
    }
    refused = false;
    vi.setSystemTime(deadline);
    await port.configure();
    expect(attempts).toHaveLength(2);
    expect(credentials.fluxComposioBrokerToken).toBe("a".repeat(64));
  });
});

describe("public server producer admission matrix", () => {
  it.each([
    "S01 readiness", "S02 scheduled health", "S03 catalog", "S03 search", "S03 page", "S04 allowance", "S05 status",
    "S06 inventory", "S07 cold list", "S08 search", "S08 schema", "S08 session", "S08 initialize", "S08 initialized notice", "S08 action",
    "S10 authorization", "S10 reconnect", "S10 disconnect", "S10 account removal", "S11 alias authorization",
  ])("%s enters the shared authority", async name => {
    clearInventory();
    const catalog = await import("./app-catalog.ts");
    catalog.resetAppCatalogState({ disk: true });
    refuse = "/v1/me";
    await composio.brokerRequest(config, "/v1/me");
    expect(hits).toHaveLength(1);
    let polls = 0;
    const run = () => name === "S01 readiness" ? composio.primeBrokerReadiness()
      : name === "S02 scheduled health" ? composio.runConnectorHealthPass(config, () => ["fixture"])
      : name === "S03 catalog" ? composio.listToolkits(config, { force: true })
      : name === "S03 search" ? catalog.searchCatalog(composio.catalogBackend(config), "fixture")
      : name === "S03 page" ? catalog.catalogPage(composio.catalogBackend(config), { cursor: "s:d500" })
      : name === "S04 allowance" ? composio.refreshFluxAccountStatus(config)
      : name === "S05 status" ? composio.connectionStatus(config, ++polls % 2 ? ["fixture"] : ["other"])
      : name === "S06 inventory" ? composio.connectedInventory(config, { force: true, fresh: true })
      : name === "S07 cold list" ? composio.relayMcp(config, { jsonrpc: "2.0", id: 20, method: "tools/list" })
      : name === "S10 authorization" ? composio.authorizeService(config, "fixture")
      : name === "S10 reconnect" ? composio.authorizeService(config, "fixture", "work", { reconnect: "ca_fixture" })
      : name === "S10 disconnect" ? composio.removeService(config, "fixture")
      : name === "S10 account removal" ? composio.removeAccount(config, "fixture", "fixture-account")
      : name === "S11 alias authorization" ? composio.authorizeService(config, "fixture", "work")
      : name === "S08 initialize" ? composio.relayMcpUpstream(config, { jsonrpc: "2.0", id: 22, method: "initialize", params: {} })
      : name === "S08 initialized notice" ? composio.relayMcpUpstream(config, { jsonrpc: "2.0", method: "notifications/initialized" })
      : composio.relayMcpUpstream(config, { jsonrpc: "2.0", id: 21, method: "tools/call", params: {
        name: name === "S08 search" ? "COMPOSIO_SEARCH_TOOLS" : name === "S08 schema" ? "COMPOSIO_GET_TOOL_SCHEMAS"
          : name === "S08 session" ? "COMPOSIO_MANAGE_CONNECTIONS" : "FIXTURE_ACTION", arguments: {},
      } });
    const start = Date.now();
    for (const elapsed of [15_001, 60_000, 3600_000, 7199_999]) {
      vi.setSystemTime(start + elapsed);
      const outcomes = await Promise.allSettled([run(), run()]);
      expect(outcomes).toHaveLength(2);
      for(const outcome of outcomes){
        if(name==='S06 inventory'&&elapsed>15_001){
          expect(outcome, name).toMatchObject({status:'fulfilled',value:{services:null,at:null,revalidating:true}});
        }else if(name.startsWith('S05')||name.startsWith('S06')||name.startsWith('S10')||name.startsWith('S11')){
          expect(outcome, name).toMatchObject({status:'rejected',reason:{name:'Error',status:429}});
          if(outcome.status==='rejected')expect(outcome.reason.message).toBe(name.startsWith('S05')||name.startsWith('S06')
            ? 'Connected apps are getting too many requests right now. Wait a minute, then refresh.' : 'Connected apps are waiting to retry.');
        }else{
          expect(outcome.status, name).toBe('fulfilled');
          if(outcome.status!=='fulfilled')throw outcome.reason;
          if(name.startsWith('S03'))expect(outcome.value).toMatchObject({source:'curated',reason:'rate-limited'});
          else if(name==='S07 cold list'){
            expect(outcome.value).toMatchObject({status:200});
            const body=JSON.parse(new TextDecoder().decode((outcome.value as any).bytes));
            expect(body.result.tools.length).toBeGreaterThan(0);
            expect(body.result.tools.map((tool:any)=>tool.name)).toContain('COMPOSIO_SEARCH_TOOLS');
          }else if(name.startsWith('S08'))expect(outcome.value).toMatchObject({status:200,upstreamStatus:429,delivery:'not-sent',brokerFailure:true,retryAfter:String(Math.ceil((7200_000-elapsed)/1000))});
          else expect(outcome.value).toBeUndefined();
        }
      }
      expect(hits, name).toHaveLength(1);
      expect(composio.connectorPanelFields(config, true).admission).toMatchObject({ outcome: "held", attempted: false, retryAt: start + 7200_000 });
    }
    vi.setSystemTime(start + 7200_000);
    expect(composioAdmissionStatus(base+'/v1/me')).toEqual({outcome:'completed',reason:'ready',attempted:false});
    expect(hits, name).toHaveLength(1);
    // Public producers retain their own ordinary failure backoff as well as the shared hold.
    vi.setSystemTime(start + 10800_000);
    vi.mocked(globalThis.fetch).mockImplementation(async (input,init)=>{
      const url=new URL(String(input)),path=url.pathname;
      hits.push({path,method:init?.method??'GET',at:Date.now()});
      const body=path==='/health'?{ready:true}:path==='/v1/me'?{freeRunsRemainingToday:7}
        :path==='/v1/catalog'?{contract:2,items:[{slug:'fixture',name:'Fixture',description:'Fixture app'}],next_cursor:null,catalog_total:1}
        :path.endsWith('/authorize')?{url:'https://connect.composio.dev/fixture'}
        :init?.method==='DELETE'?{removed:1}
        :path==='/v1/mcp'?{jsonrpc:'2.0',id:JSON.parse(String(init?.body)).id??null,result:{tools:[],content:[{type:'text',text:'dispatched'}]}}
        :{services:{fixture:{connected:false,accounts:[]}}};
      return Response.json(body);
    });
    const dispatched=await run();
    expect(hits.slice(1), 'the same producer must dispatch successfully when the hold ends').not.toHaveLength(0);
    const destination=name==='S01 readiness'?'/health':name==='S02 scheduled health'||name==='S06 inventory'?'/v1/connectors/connected'
      :name.startsWith('S03')?'/v1/catalog':name==='S04 allowance'?'/v1/me':name==='S05 status'?'/v1/connectors'
      :name.startsWith('S07')||name.startsWith('S08')?'/v1/mcp':name==='S10 disconnect'?'/v1/connectors/fixture'
      :name==='S10 account removal'?'/v1/connectors/fixture/accounts/fixture-account':'/v1/connectors/fixture/authorize';
    expect(hits.slice(1).map(hit=>hit.path)).toContain(destination);
    if(name.startsWith('S03'))expect(dispatched).toMatchObject({source:name==='S03 catalog'?'api':'service'});
    else if(name==='S05 status')expect(dispatched).toMatchObject({fixture:{connected:false}});
    else if(name==='S06 inventory')expect(dispatched).toMatchObject({services:{fixture:{connected:false}},revalidating:false});
    else if(name==='S10 disconnect'||name==='S10 account removal')expect(dispatched).toEqual({removed:1});
    else if(name.startsWith('S10')||name.startsWith('S11'))expect(dispatched).toMatchObject({url:'https://connect.composio.dev/fixture'});
    else if(name.startsWith('S07')||name.startsWith('S08')){
      expect(dispatched).toMatchObject({status:200});
      expect((dispatched as any).brokerFailure).toBeUndefined();
      expect(JSON.parse(new TextDecoder().decode((dispatched as any).bytes)).result).toBeDefined();
    }else expect(dispatched).toBeUndefined();
    catalog.resetAppCatalogState({ disk: true });
  });
});

it.each([0, 1])("S01/S09 a concurrent refusal during retry sleep blocks retry leg %s", async retry => {
  const netError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect" }) });
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    hits.push({ path, method: "POST", at: Date.now() });
    if (path === "/v1/mcp") { posts++; throw netError(); }
    return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
  }));
  const result = composio.relayMcpUpstream(config, { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "FIXTURE_ACTION", arguments: {} } });
  await vi.advanceTimersByTimeAsync(retry === 0 ? 100 : 30_100);
  expect(posts).toBe(retry + 1);
  await composio.brokerRequest(config, "/v1/connectors/connected");
  await vi.advanceTimersByTimeAsync(retry === 0 ? 29_900 : 59_900);
  expect(posts).toBe(retry + 1);
  expect((await result).delivery).toBe("not-sent");
});

it.each(["startup", "post-mint drain", "dropped token"])("C04 %s keeps held revocations owned through restart", async trigger => {
  const key = `sk-flux-home-${"f".repeat(30)}`;
  const old = "a".repeat(64), pending = ["b", "c", "d", "e"].map(letter => letter.repeat(64));
  let credentials: Record<string, string> = { fluxApiKey: key };
  let records: Parameters<NonNullable<Parameters<typeof createComposioLifecycle>[0]["store"]>["save"]>[0] = [];
  let refusing = true;
  const attempts: { path: string; token: string | null }[] = [];
  const attach = () => {
    const port = createSupervisorPort({
      store: { getAll: () => ({ ...credentials }), readBack: () => ({ ...credentials }), patchDurable: patch => { credentials = { ...credentials, ...patch }; return { durable: true }; }, patch: patch => (credentials = { ...credentials, ...patch }) }, send: () => {},
      connectedAppsBrokerUrl: base, now: Date.now, admissionNow: Date.now, admissionMonotonic: Date.now,
      admissionStore: { load: () => structuredClone(records), save: rows => { records = structuredClone(rows); } },
      composioTransport: async (url, init) => {
        attempts.push({ path: new URL(String(url)).pathname, token: new Headers(init?.headers).get("authorization") });
        return refusing ? Response.json({}, { status: 429, headers: { "retry-after": "7200" } })
          : Response.json({ token: "f".repeat(64), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
      },
    });
    owned.push(port); return port;
  };
  let port = attach();
  await port.configure();
  expect(attempts).toHaveLength(1);
  const deadline = Date.now() + 7200_000;
  credentials = { ...credentials, fluxComposioBrokerToken: old,
    fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(key), fluxComposioBrokerTokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    fluxComposioPendingRevokeTokens: JSON.stringify(trigger === "dropped token" ? pending : [pending[0]]) };
  if (trigger === "startup") { port.dispose(); port = attach(); await port.configure(); }
  else if (trigger === "post-mint drain") await port.remintConnectedApps();
  else await port.handle({ type: "murage:cloud-credential-write", requestId: "fixture-swap", credentials: { fluxApiKey: `sk-flux-home-${"n".repeat(30)}` } });
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(attempts).toHaveLength(1);
  if (trigger === "dropped token") expect(credentials.composioPendingRevocations).toContain(pending[0]);
  else expect(credentials.fluxComposioPendingRevokeTokens).toContain(pending[0]);
  refusing = false; vi.setSystemTime(deadline);
  await port.configure();
  for (let i = 0; i < 200; i++) await Promise.resolve();
  expect(attempts.filter(row => row.path === "/v1/tokens/current" && row.token === `Bearer ${pending[0]}`)).toHaveLength(1);
  expect(credentials.fluxComposioPendingRevokeTokens).toBe("");
});

it.each(["dead delete", "alias retry"])("S11 %s re-admits after an intervening origin refusal", async leg => {
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let posts = 0, deletes = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    hits.push({ path, method: init?.method ?? "GET", at: Date.now() });
    if (path === "/v1/catalog") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    if (path.endsWith("/authorize")) { posts++; return posts === 1 ? Response.json({}, { status: 409 }) : Response.json({ url: "https://connect.composio.dev/link/fixture" }); }
    if (path === "/v1/connectors/connected") {
      const response = Response.json({ services: { fixture: { connected: false, status: "EXPIRED", accounts: [{ id: "ca_dead", alias: "work", status: "EXPIRED" }] } } });
      if (leg === "dead delete") {
        const json = response.json.bind(response);
        Object.defineProperty(response, "json", { value: async () => { entered(); await resume; return json(); } });
      }
      return response;
    }
    if (init?.method === "DELETE") { deletes++; if (leg === "alias retry") { entered(); await resume; } return Response.json({ removed: 1 }); }
    return Response.json({ ready: true });
  }));
  const result = composio.authorizeService(config, "fixture", "work").catch(error => error);
  await paused;
  await composio.brokerRequest(config, "/v1/catalog");
  release(); await result;
  expect(posts).toBe(1);
  expect(deletes).toBe(leg === "dead delete" ? 0 : 1);
  expect(composio.connectorPanelFields(config, true).admission).toMatchObject({ outcome: "held", retryAt: Date.now() + 7200_000 });
});

it("S11 replacement retirement re-admits after the new inventory reply", async () => {
  let accounts = [{ id: "ca_old", alias: "work", status: "ACTIVE" }];
  let pause = false, entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let deletes = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    hits.push({ path, method: init?.method ?? "GET", at: Date.now() });
    if (path === "/v1/catalog") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    if (path === "/v1/connectors/connected") {
      const response = Response.json({ services: { gmail: { connected: true, status: "ACTIVE", accounts } } });
      if (pause) { const json = response.json.bind(response); Object.defineProperty(response, "json", { value: async () => { entered(); await resume; return json(); } }); }
      return response;
    }
    if (path === "/v1/mcp") {
      const payload = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: JSON.stringify({
        successful: false, data: { results: [{ index: 0, tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: false, error: "401 Unauthorized", status: 401 } }] },
      }) }] } });
    }
    if (path.endsWith("/authorize")) return JSON.parse(String(init?.body)).alias === "work" ? Response.json({}, { status: 409 })
      : Response.json({ url: "https://connect.composio.dev/link/fixture" });
    if (init?.method === "DELETE") { deletes++; return Response.json({ removed: 1 }); }
    return Response.json({ ready: true });
  }));
  await composio.connectedServices(config, { fresh: true });
  await composio.relayMcpUpstream(config, { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", account: "work", arguments: {} }] } } });
  expect(composio.appsNeedingReconnect(config)).toHaveLength(1);
  await composio.authorizeService(config, "gmail", "work", { reconnect: "ca_old" });
  accounts = [...accounts, { id: "ca_new", alias: "work 2", status: "ACTIVE" }]; pause = true;
  const inventory = composio.connectedInventory(config, { force: true, fresh: true }).catch(error => error);
  await paused;
  await composio.brokerRequest(config, "/v1/catalog");
  release(); const read = await inventory;
  for (let i = 0; i < 80; i++) await Promise.resolve();
  expect(deletes).toBe(0);
  expect(read.services.gmail.connected).toBe(true);
  expect(composio.connectorPanelFields(config, true).admission.outcome).toBe("held");
});

it.each([0, 1])("S01 pending inventory refusal blocks readiness retry leg %s", async retry => {
  let entered!: () => void, release!: (response: Response) => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  let health = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/connectors/connected") { entered(); return new Promise<Response>(resolve => { release = resolve; }); }
    health++;
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "connect" }) });
  }));
  const inventory = composio.brokerRequest(config, "/v1/connectors/connected");
  await pending;
  composio.invalidateBrokerReadiness();
  const probe = composio.primeBrokerReadiness();
  await vi.advanceTimersByTimeAsync(retry === 0 ? 100 : 30_100);
  expect(health).toBe(retry + 1);
  release(Response.json({}, { status: 429, headers: { "retry-after": "7200" } }));
  await inventory;
  await vi.advanceTimersByTimeAsync(retry === 0 ? 29_900 : 59_900);
  expect(health).toBe(retry + 1);
  await probe;
});

it("S06 zero-delay refresh re-admits after a cached panel answer", async () => {
  let inventories = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/me") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    if (path === "/health") return Response.json({ ready: true });
    inventories++;
    return Response.json({ services: { fixture: { connected: true, status: "ACTIVE", accounts: [{ id: "ca_fixture", status: "ACTIVE" }] } } });
  }));
  await composio.connectedInventory(config, { force: true, fresh: true });
  expect(inventories).toBe(1);
  vi.setSystemTime(Date.now() + 61_000);
  await composio.connectedInventory(config);
  await composio.brokerRequest(config, "/v1/me");
  await vi.advanceTimersByTimeAsync(1);
  expect(inventories).toBe(1);
  vi.setSystemTime(Date.now() + 7200_000);
  await composio.connectedInventory(config, { force: true, fresh: true });
  expect(inventories).toBe(2);
});

it("S02 scheduled inventory refresh re-admits after the readiness reply", async () => {
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let inventories = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/health") {
      const response = Response.json({ ready: true });
      const json = response.json.bind(response);
      Object.defineProperty(response, "json", { value: async () => { entered(); await resume; return json(); } });
      return response;
    }
    if (path === "/v1/me") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    inventories++; return Response.json({ services: {} });
  }));
  composio.invalidateBrokerReadiness();
  const pass = composio.runConnectorHealthPass(config, () => ["fixture"]).catch(error => error);
  await paused;
  await composioFetch(`${base}/v1/me`);
  release(); await pass;
  expect(inventories).toBe(0);
  expect(composio.connectorPanelFields(config, true).admission.outcome).toBe("held");
});

import { DEV_FLUX_TOKEN_FILE, devFluxTokenApplies } from "./flux-composio-dev-token.ts";
import { DATA_DIR } from "./config.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
it.each(["throw-before", "commit-then-throw"])("T2 dev credential_commit_preserves_current_custody %s and publishes only durable state", async mode => {
  vi.resetModules();
  const dev = await import("./flux-composio-dev-token.ts");
  const devAtomic = await import("./atomic.ts");
  dev.resetDevFluxTokenState(); dev.clearDevFluxTokenDocument();
  const key = "sk-flux-fixture-owner", previous = "a".repeat(64), minted = "c".repeat(64), unrelated = "e".repeat(64);
  expect(devFluxTokenApplies(base, { FLUX_API_KEY: key })).toBe(true);
  expect((await import("./flux-config.ts")).fluxKey({ FLUX_API_KEY: key })).toBe(key);
  const file = join(DATA_DIR, DEV_FLUX_TOKEN_FILE);
  writeFileSync(file, JSON.stringify({ fluxComposioBrokerToken: previous, fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(key),
    fluxComposioBrokerTokenExpiresAt: "2099-01-01T00:00:00.000Z", composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: base, token: unrelated }]) }), { mode: 0o600 });
  dev.resetDevFluxTokenState();
  const realWrite = devAtomic.writeFileAtomic;
  let w2 = false;
  const writer = vi.spyOn(devAtomic, "writeFileAtomic").mockImplementation((path, value, options) => {
    const document = path === file ? JSON.parse(String(value)) : {};
    if (document.fluxComposioBrokerToken === minted) {
      w2 = true;
      if (mode === "commit-then-throw") realWrite(path, value, options);
      throw new Error("fixture ambiguous W2");
    }
    return realWrite(path, value, options);
  });
  try {
    const result = await dev.ensureDevFluxBrokerToken({ fluxBrokerUrl: base, env: { FLUX_API_KEY: key }, force: true,
      fetchImpl: async () => Response.json({ token: minted, expiresAt: "2099-01-01T00:00:00.000Z" }) });
    expect(w2, JSON.stringify({ admission: composioAdmissionStatus(), resultFields: Object.keys(result) })).toBe(true);
    const disk = JSON.parse(readFileSync(file, "utf8"));
    expect(result.fluxComposioBrokerToken).toBe(disk.fluxComposioBrokerToken);
    expect(disk.fluxComposioBrokerToken).toBe(mode === "throw-before" ? previous : minted);
    expect(JSON.parse(disk.composioPendingRevocations).map((entry: { token: string }) => entry.token)).toEqual([unrelated, minted]);
  } finally { writer.mockRestore(); dev.resetDevFluxTokenState(); dev.clearDevFluxTokenDocument(); }
});
