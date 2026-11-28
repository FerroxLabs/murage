import { readFileSync } from "node:fs";
import { connectedAppTurnUnattended } from "./connected-app-unattended.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as composio from "./composio.ts";
import { connectorHealthStore } from "./connected-app-health.ts";
import type { AppConfig } from "./config.ts";
import { assertRelayBot, assertRelayStored } from "./connector-relay.ts";

// Shopify actions that run unattended (routines, scheduled or background turns,
// delegated work) use the GraphQL actions only; attended chat is unchanged. A
// Shopify call that fails on an expired or invalid token shows one plain
// reconnect prompt and is not retried.
const cfg = {} as AppConfig;
let calls: any[], reply: any, isError: boolean;
let mcpStatus: number;
let clock = 20_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(async () => {
  composio.resetManagedBrokerState(); connectorHealthStore().clearAll();
  clock += 4_000_000; vi.spyOn(Date, "now").mockImplementation(() => clock);
  calls = []; reply = { successful: true }; isError = false;
  mcpStatus = 200;
  const services = { shopify: [{ id: "S1", alias: "shop", status: "ACTIVE" }], gmail: [{ id: "G1", alias: "mail", status: "ACTIVE" }] };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return json({ ready: true });
    if (url.endsWith("/connected")) return json({ services: Object.fromEntries(Object.entries(services).map(([slug, accounts]) => [slug, { connected: true, status: "ACTIVE", accounts }])) });
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (mcpStatus !== 200) return new Response("{}", { status: mcpStatus, headers: { "retry-after": "600" } });
    return json({ jsonrpc: "2.0", id: body.id, result: { isError, content: [{ type: "text", text: typeof reply === "string" ? reply : JSON.stringify(reply) }] } });
  }));
  composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: "http://127.0.0.1:49321/composio", fluxAccess: { url: "http://127.0.0.1:49321/composio", token: "c".repeat(64) }, legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
  await composio.primeBrokerReadiness(); await composio.connectedInventory(cfg, { force: true, fresh: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); composio.resetManagedBrokerState(); });
let id = 0;
const payload = (name: string, args: any) => ({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
// each call is distinct, so the one-send guard on repeated identical writes never joins two of them
const dispatch = (name: string, args: any = {}, options: any = {}) => composio.relayConnectedAppCall(cfg, payload(name, { ...args, nonce: `n${id + 1}` }), undefined, undefined, { botId: "shopify-fixture", ...options });
const textOf = (answer: { bytes: Uint8Array }) => {
  const body = JSON.parse(new TextDecoder().decode(answer.bytes));
  return (body.result?.content ?? []).map((part: any) => part.text ?? "").join("\n") + (body.error?.message ?? "");
};
const multi = (...slugs: string[]) => ["COMPOSIO_MULTI_EXECUTE_TOOL", { tools: slugs.map(tool_slug => ({ tool_slug, arguments: {} })) }] as const;

it("an unattended turn is refused a Shopify REST action, with a plain reason, and nothing is sent", async () => {
  const answer = await dispatch("SHOPIFY_GET_ORDERS", { account: "S1" }, { unattended: true });
  expect(calls).toHaveLength(0);
  expect(answer.delivery).toBe("not-sent");
  const text = textOf(answer);
  expect(text).toMatch(/Shopify/);
  expect(text).toMatch(/GraphQL/);
  expect(text).toMatch(/unattended|routine|scheduled|background/i);
});

it("an unattended turn may use the Shopify GraphQL actions", async () => {
  await dispatch("SHOPIFY_GRAPH_QL_QUERY", { account: "S1", query: "{ shop { name } }" }, { unattended: true });
  await dispatch("SHOPIFY_GRAPH_QL_MUTATION", { account: "S1" }, { unattended: true });
  expect(calls).toHaveLength(2);
});

it("an unattended batch with any Shopify REST row is refused whole; an all-GraphQL batch goes through", async () => {
  const refused = await dispatch(...multi("SHOPIFY_GRAPH_QL_QUERY", "SHOPIFY_GET_ORDERS"), { unattended: true });
  expect(calls).toHaveLength(0);
  expect(refused.delivery).toBe("not-sent");
  await dispatch(...multi("SHOPIFY_GRAPH_QL_QUERY"), { unattended: true });
  expect(calls).toHaveLength(1);
});

it("an unattended REST refusal is not a sign-in problem: no reconnect incident, no reconnect callback", async () => {
  const onReconnect = vi.fn();
  await dispatch("SHOPIFY_GET_ORDERS", { account: "S1" }, { unattended: true, onReconnect });
  expect(onReconnect).not.toHaveBeenCalled();
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
});

it("an attended turn still uses Shopify REST actions", async () => {
  await dispatch("SHOPIFY_GET_ORDERS", { account: "S1" });
  await dispatch("SHOPIFY_GET_ORDERS", { account: "S1", n: 2 }, { unattended: false });
  expect(calls).toHaveLength(2);
});

it("an unattended turn is not restricted on other toolkits", async () => {
  await dispatch("GMAIL_FETCH_EMAILS", { account: "G1" }, { unattended: true });
  expect(calls).toHaveLength(1);
});

it.each([
  ["structured 401", { successful: false, status_code: 401, error: "denied" }],
  ["invalid token text", { successful: false, error: "[API] Invalid API key or access token (unrecognized login or wrong password)" }],
  ["expired token text", { successful: false, error: "Access token has expired" }],
])("a Shopify call that fails on %s shows one reconnect prompt and is not retried", async (_name, answer) => {
  reply = answer; isError = true;
  const onReconnect = vi.fn();
  const first = await dispatch("SHOPIFY_GRAPH_QL_QUERY", { account: "S1", query: "{ shop { name } }" }, { onReconnect });
  expect(textOf(first)).toMatch(/Reconnect Shopify/i);
  expect(onReconnect).toHaveBeenCalledTimes(1);
  expect(composio.appsNeedingReconnect(cfg).map(app => app.slug)).toEqual(["shopify"]);
  const again = await dispatch("SHOPIFY_GRAPH_QL_QUERY", { account: "S1", query: "{ shop { id } }" }, { onReconnect });
  expect(onReconnect).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(1);
  expect(again.delivery).toBe("not-sent");
  expect(textOf(again)).toMatch(/Reconnect Shopify/i);
});

it("the same expired-token failure on an unattended GraphQL call also becomes the reconnect prompt", async () => {
  reply = { successful: false, error: "Invalid API key or access token" }; isError = true;
  const answer = await dispatch("SHOPIFY_GRAPH_QL_QUERY", { account: "S1" }, { unattended: true });
  expect(textOf(answer)).toMatch(/Reconnect Shopify/i);
  expect(composio.appsNeedingReconnect(cfg).map(app => app.slug)).toEqual(["shopify"]);
});

it("a Shopify error that is not about the token stays a plain failure", async () => {
  reply = { successful: false, error: "Throttled: try again later" }; isError = true;
  const answer = await dispatch("SHOPIFY_GRAPH_QL_QUERY", { account: "S1" });
  expect(textOf(answer)).not.toMatch(/Reconnect Shopify/i);
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
});

it("other toolkits do not get the token-wording reading", async () => {
  reply = { successful: false, error: "Invalid API key or access token" }; isError = true;
  await dispatch("GMAIL_FETCH_EMAILS", { account: "G1" });
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
});

it.each([
  ["a nested message that only mentions the token", { error: "Validation failed", data: { message: "Access token expired" } }],
  ["a parsed body whose text mentions the token", { successful: false, data: { note: "Invalid API key or access token" } }],
])("a Shopify failure with %s is not read as a sign-in failure", async (_name, answer) => {
  reply = answer; isError = true;
  const result = await dispatch("SHOPIFY_GRAPH_QL_QUERY", { account: "S1" });
  expect(textOf(result)).not.toMatch(/Reconnect Shopify/i);
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
});

it("text that is not JSON still counts as a token failure", async () => {
  reply = "Access token has expired"; isError = true;
  const result = await dispatch("SHOPIFY_GRAPH_QL_QUERY", { account: "S1" });
  expect(textOf(result)).toMatch(/Reconnect Shopify/i);
});

// The connectors route, as production runs it (the slice of index.ts that builds the relay options), with the real relay.
// threadState says what the server knows about the turn's thread.
async function route(threadState: { unattended?: boolean; liveRoutine?: boolean; routinePeer?: boolean; wake?: boolean }, body: unknown) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("        // Actions get an operation identity");
  const end = source.indexOf("        authorize();", start);
  const { stripTypeScriptTypes } = await import("node:module");
  // The callbacks the slice builds only run on the paths this test does not take, except the grant re-check, which has no grants to fail.
  const js = "const requireActiveInternal = () => {}, store = { bot: () => ({}), appendMessage() {} }, routinesStub = { failThread() {} }, proxyGuard = { assert() {}, refused: () => false }, connectedAppReceipts = { record() {} }, receiptForAnswer = () => ({}), murageLine = (line) => line, assertStoredConnectedAppAccess = () => {}, highlevelConnectionActive = () => false;\n"
    + stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
  const deps = { isUnattended: () => threadState.unattended === true, routines: () => ({ isActiveThread: () => threadState.liveRoutine === true }), routineAuthority: () => threadState.routinePeer === true || threadState.wake === true };
  let reply: { bytes: Uint8Array; delivery?: string } | undefined;
  const manager = { routineRunForThread: () => null };
  await new Function("composio", "cfg", "routines", "req", "internalClaim", "authorize", "CONNECTED_APP_WAIT_HEADER", "body", "internalCapabilities", "serviceNoLimits", "connectedAppUnattended", "assertRelayBot", "assertRelayStored", "relayInventory",
    `return (async () => { ${js} })();`)(
    { relayConnectedAppCall: async (...args: any[]) => (reply = await (composio.relayConnectedAppCall as any)(...args)) }, cfg, manager,
    { headers: {} }, { threadId: "peer-thread", botId: "shopify-fixture", generation: "g" }, () => {}, "x-fixture-wait", body, { providerTurnOf: () => "t" }, () => false,
    (threadId: string) => connectedAppTurnUnattended(deps, threadId), assertRelayBot, assertRelayStored, null);
  return reply!;
}
const shapes = {
  direct: (tool: string) => payload(tool, { account: "S1", nonce: `d${++id}` }),
  useTool: (tool: string) => payload("USE_TOOL", { tool_name: "COMPOSIO_MULTI_EXECUTE_TOOL", tool_input: { tools: [{ tool_slug: tool, account: "S1", arguments: { nonce: `u${++id}` } }] } }),
  batchRow: (tool: string) => payload("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "SHOPIFY_GRAPH_QL_QUERY", arguments: { nonce: `b${++id}` } }, { tool_slug: tool, arguments: { nonce: `c${id}` } }] }),
};

// Producer: composio-429-j; consumer: shopify-graphql-d. Run with the pinned Composio co-landing dependency.
describe.each([429, 503])("Shopify GraphQL under a broker HTTP %s hold", status => {
  it.each(Object.entries(shapes))("honors Retry-After for %s without reconnecting Shopify or replaying the action", async (_shape, make) => {
    const onReconnect = vi.fn();
    const send = () => composio.relayConnectedAppCall(cfg, make("SHOPIFY_GRAPH_QL_QUERY"), undefined, undefined,
      { botId: "shopify-fixture", unattended: true, onReconnect });
    mcpStatus = status;
    await send();
    expect(calls).toHaveLength(1);
    expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
    expect(onReconnect).not.toHaveBeenCalled();

    mcpStatus = 200;
    const held = await send();
    expect(held.delivery).toBe("not-sent");
    expect(calls).toHaveLength(1);
    clock += 599_999;
    expect((await send()).delivery).toBe("not-sent");
    expect(calls).toHaveLength(1);
    expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
    expect(onReconnect).not.toHaveBeenCalled();

    clock += 2;
    const recovered = await send();
    expect(JSON.parse(new TextDecoder().decode(recovered.bytes)).result.isError).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1].id).not.toBe(calls[0].id);
    expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
const unattendedStates = {
  "an unattended mark": { unattended: true },
  "a live routine run": { liveRoutine: true },
  "a routine peer carrying routine authority, unattended false, thread outside a live routine": { routinePeer: true, unattended: false, liveRoutine: false },
  "a wake of the owner's routine": { wake: true },
};
describe.each(Object.entries(unattendedStates))("route dispatch with %s", (_label, state) => {
  it.each(Object.entries(shapes))("refuses a Shopify REST action sent as %s and sends nothing", async (_shape, make) => {
    const answer = await route(state, make("SHOPIFY_GET_ORDERS"));
    expect(calls).toHaveLength(0);
    expect(answer.delivery).toBe("not-sent");
    expect(textOf(answer)).toMatch(/GraphQL/);
  });
  it("still sends a Shopify GraphQL action", async () => {
    // The production connectors slice must run to a reply with only the names this fixture supplies.
    const answer = await route(state, shapes.direct("SHOPIFY_GRAPH_QL_QUERY")).catch((error: unknown) => ({ lost: String(error) }));
    expect(calls).toHaveLength(1);
    expect(answer, "the action was sent and its answer is handed back by the connectors route").toHaveProperty("bytes");
  });
});
describe("route dispatch on an attended thread", () => {
  it.each(Object.entries(shapes))("still sends a Shopify REST action sent as %s", async (_shape, make) => {
    const answer = await route({}, make("SHOPIFY_GET_ORDERS")).catch((error: unknown) => ({ lost: String(error) }));
    expect(calls).toHaveLength(1);
    expect(answer, "the action was sent and its answer is handed back by the connectors route on an attended thread").toHaveProperty("bytes");
  });
});
