// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HL-S2-WRITES (e) NATIVE WINS, tests T10-T15 and T18 (design HL-S2-WRITES-1103.md section (f)). A bot the owner gave
// Murage's own HighLevel connection never sees or runs HighLevel through the generic connected-apps relay, whatever its
// generic access mode and whatever the state of that connection. Bots with no native grant are unchanged.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppCatalogState } from "../app-catalog.ts";
import { assertConnectedAppCall, assertStoredConnectedAppAccess, connectedAppsListScope, restrictedConnectorTools } from "../bot-access.ts";
import { accessRoleBinding } from "../bot-access-role.ts";
import { relayConnectedAppCall, resetConnectedAppOperations, setManagedBrokerAccess } from "../composio.ts";
import type { BotRecord } from "../store.ts";
import { FAKE_CONNECTION_ID, highLevelHarness } from "../testing/fake-highlevel.ts";
import { createHighLevelRuntime } from "./runtime.ts";

// Base proof (HL-S2-WRITES): a module this lane adds is loaded by feature detection, so on the base the file still loads and
// each test fails on its own assertion. A missing module reads as a stub on which every name is the stub itself.
const missingModule = (): unknown => {
  const stub: unknown = new Proxy(function stubbed() { return stub; }, {
    get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : stub),
    apply: () => stub, construct: () => stub as object,
  });
  return stub;
};
const optionalModule = async <T,>(spec: string): Promise<T> => {
  try { return await import(/* @vite-ignore */ spec) as T; } catch { return missingModule() as T; }
};
const {
  hasProxyExecute, HIGHLEVEL_NATIVE_WINS_REFUSAL, HIGHLEVEL_RECONNECT_LINE, highlevelConnectionActiveFor, nativeHighLevelGranted,
  nativeWinsConnectorRequestRefused, nativeWinsFiltersReply, nativeWinsProxyGuard, nativeWinsProxyRefused, nativeWinsRefusalText, stripComposioHighLevelBytes,
} = await optionalModule<typeof import("./native-wins.ts")>("./native-wins.ts");

const REFUSAL = "This bot uses Murage's own HighLevel connection.";
const RECONNECT = "HighLevel needs reconnecting. Ask the owner to reconnect HighLevel in Settings.";
// A Composio HighLevel slug that is not one of Murage's native names (those are refused for every bot already).
const COMPOSIO_HL = "HIGHLEVEL_LIST_FORMS";

const asBot = (bot: unknown) => bot as BotRecord;
const messageOf = (run: () => void): string => { try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); } return "(no refusal)"; };
const multi = (tools: unknown[], extra: Record<string, unknown> = {}, id: number | string = 1) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools, sync_response_to_workbench: false, ...extra } } });
const tool = (name: string, args: unknown = {}, id: number | string = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const gmail = { tool_slug: "GMAIL_FETCH_EMAILS", account: "ca_gmail", arguments: { user_id: "me" } };
const composioHl = (account = "ca_hl", args: Record<string, unknown> = {}) => ({ tool_slug: COMPOSIO_HL, account, arguments: args });
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The owner granted this bot Murage's own HighLevel (stored grant); `none` removes it. */
function nativeBot(state: "connected" | "needs_reconnect" | "pending_browser_confirmation" | "none" = "connected") {
  const h = highLevelHarness();
  h.leases.views.get(FAKE_CONNECTION_ID)!.state = state === "none" ? "connected" : state;
  if (state === "none") delete h.bot.highlevelAccess;
  return h;
}

describe("T10 ruling 2: native wins whatever the connection state", () => {
  it("connection active: native tools mount and no Composio HighLevel is listed or callable", async () => {
    const h = nativeBot("connected");
    const rt = createHighLevelRuntime({
      threadMarkState: () => "marked",
      dataDir: mkdtempSync(join(tmpdir(), "hlw-native-")), capabilities: h.capabilities, signals: h.signals,
      bot: (id) => (id === h.bot.id ? h.bot : undefined),
      leases: h.leases, fetch: h.api.fetch,
    });
    expect(await rt.mountsFor(h.bot.id)).toBe(true);
    expect(nativeHighLevelGranted(h.bot)).toBe(true);
    expect(highlevelConnectionActiveFor(h.bot, h.leases.views.get(FAKE_CONNECTION_ID))).toBe(true);
    expect(messageOf(() => assertConnectedAppCall(asBot(h.bot), multi([composioHl()]), { connectionActive: true }))).toBe(REFUSAL);
    const listing = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }, { name: COMPOSIO_HL }, { name: "highlevel_location_get" }] } };
    expect(nativeWinsFiltersReply({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(true);
    expect(decode(stripComposioHighLevelBytes("application/json", encode(listing))).result.tools).toEqual([{ name: "COMPOSIO_SEARCH_TOOLS" }]);
  });

  for (const state of ["needs_reconnect", "pending_browser_confirmation"] as const) {
    it(`connection ${state}: no native tools, Composio HighLevel still hidden, the reconnect line on the turn and the refusal`, async () => {
      const h = nativeBot(state);
      const rt = createHighLevelRuntime({
      threadMarkState: () => "marked",
        dataDir: mkdtempSync(join(tmpdir(), "hlw-native-")), capabilities: h.capabilities, signals: h.signals,
        bot: (id) => (id === h.bot.id ? h.bot : undefined),
        leases: h.leases, fetch: h.api.fetch,
      });
      expect(await rt.mountsFor(h.bot.id)).toBe(false);
      const active = highlevelConnectionActiveFor(h.bot, h.leases.views.get(FAKE_CONNECTION_ID));
      expect(active).toBe(false);
      // Never a silent fallback to Composio: still refused, now with the reconnect line.
      expect(messageOf(() => assertConnectedAppCall(asBot(h.bot), multi([composioHl()]), { connectionActive: active }))).toBe(`${REFUSAL} ${RECONNECT}`);
      expect(nativeWinsRefusalText(false)).toBe(`${REFUSAL} ${RECONNECT}`);
      const search = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ tool_slug: COMPOSIO_HL, toolkit: "highlevel" }, { tool_slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" }] }) }] } };
      const stripped = decode(stripComposioHighLevelBytes("application/json", encode(search), active));
      expect(JSON.parse(stripped.result.content[0].text).results).toEqual([{ tool_slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" }]);
      // The owner turn carries the line; another audience never does.
    });
  }

  it("the copy is exact", () => {
    expect(HIGHLEVEL_NATIVE_WINS_REFUSAL).toBe(REFUSAL);
    expect(HIGHLEVEL_RECONNECT_LINE).toBe(RECONNECT);
  });
});

describe("T11 ruling 3: no location-id match and no exception", () => {
  it("a Composio HighLevel account for a second location is hidden and refused for a native-granted bot", () => {
    const h = nativeBot();
    for (const call of [
      multi([composioHl("ca_hl_location_2", { locationId: "loc_second" })]),
      multi([{ tool_slug: "highlevel_location_get_location", account: "ca_hl_location_2", arguments: { locationId: "loc_second" } }]),
      tool("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["highlevel_location"] }),
    ]) expect(() => assertConnectedAppCall(asBot(h.bot), call)).toThrow(REFUSAL);
    const search = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ toolkits: [{ toolkit: { slug: "highlevel_location", name: "HighLevel" }, account: "ca_hl_location_2" }, { toolkit: { slug: "gmail" } }] }) }] } };
    expect(new TextDecoder().decode(stripComposioHighLevelBytes("application/json", encode(search)))).not.toMatch(/highlevel_location|ca_hl_location_2/);
    // A restricted bot's Composio HighLevel grant is dropped from its offered tools and scopes.
    const policy = { revision: 1, roleBinding: accessRoleBinding(h.bot), mode: "restricted", allowWrites: false, requests: [],
      grants: [{ toolkit: "gmail", accountId: "ca_gmail", tools: ["GMAIL_FETCH_EMAILS"] }, { toolkit: "highlevel_location", accountId: "ca_hl_location_2", tools: [COMPOSIO_HL] }] };
    (h.bot as { connectedAppAccess?: unknown }).connectedAppAccess = policy;
    expect(JSON.stringify(restrictedConnectorTools(asBot(h.bot), 1))).not.toContain("ca_hl_location_2");
    delete h.bot.highlevelAccess;
    expect(JSON.stringify(restrictedConnectorTools(asBot(h.bot), 1))).toContain("ca_hl_location_2");
  });
});

describe("T12 ruling 4: every route to Composio HighLevel is refused, unrestricted policy included", () => {
  it("workbench, remote bash, sync to workbench, nested slugs, batches, schemas and connection management", () => {
    const h = nativeBot();
    expect((h.bot as { connectedAppAccess?: unknown }).connectedAppAccess).toBeUndefined(); // unrestricted
    const refused = [
      tool("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print(1)" }),
      tool("COMPOSIO_REMOTE_BASH_TOOL", { command: "ls" }),
      multi([gmail], { sync_response_to_workbench: true }),
      multi([{ ...gmail, arguments: { user_id: "me", nested: { deeper: ["x", { slug: COMPOSIO_HL }] } } }]),
      [multi([gmail], {}, 1), multi([composioHl()], {}, 2)],
      tool("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: [COMPOSIO_HL] }),
      tool("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["HighLevel"] }),
      tool(COMPOSIO_HL, {}),
    ];
    for (const call of refused) expect(() => assertConnectedAppCall(asBot(h.bot), call), JSON.stringify(call)).toThrow(REFUSAL);
    // The same calls from a bot with no native grant are not refused by native wins.
    delete h.bot.highlevelAccess;
    for (const call of refused) expect(() => assertConnectedAppCall(asBot(h.bot), call)).not.toThrow();
  });

  it("COMPOSIO_PROXY_EXECUTE: a HighLevel account, a LeadConnector host or an account that cannot be resolved", async () => {
    const accounts: Record<string, string> = { ca_hl: "highlevel", ca_gmail: "gmail" };
    const lookup = async (id: string) => accounts[id];
    const proxy = (args: Record<string, unknown>) => tool("COMPOSIO_PROXY_EXECUTE", args);
    expect(hasProxyExecute(proxy({}))).toBe(true);
    expect(await nativeWinsProxyRefused(proxy({ connected_account_id: "ca_hl", endpoint: "/contacts/", method: "GET" }), lookup)).toBe(true);
    expect(await nativeWinsProxyRefused(proxy({ connected_account_id: "ca_gmail", endpoint: "https://services.leadconnectorhq.com/contacts/", method: "GET" }), lookup)).toBe(true);
    expect(await nativeWinsProxyRefused(proxy({ connected_account_id: "ca_gmail", endpoint: "https://rest.gohighlevel.com/v1/contacts", method: "GET" }), lookup)).toBe(true);
    expect(await nativeWinsProxyRefused(proxy({ connected_account_id: "ca_unknown", endpoint: "/x", method: "GET" }), lookup)).toBe(true);
    expect(await nativeWinsProxyRefused(proxy({ endpoint: "/x", method: "GET" }), lookup)).toBe(true);
    expect(await nativeWinsProxyRefused(proxy({ connected_account_id: "ca_gmail", endpoint: "/x" }), async () => { throw new Error("inventory down"); })).toBe(true);
    expect(await nativeWinsProxyRefused([tool("COMPOSIO_SEARCH_TOOLS", {}), proxy({ connected_account_id: "ca_hl", endpoint: "/x" })], lookup)).toBe(true);
    // A non-HighLevel account on a non-HighLevel host is not a HighLevel call.
    expect(await nativeWinsProxyRefused(proxy({ connected_account_id: "ca_gmail", endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile", method: "GET" }), lookup)).toBe(false);
  });
});

describe("T13 ruling 4: /api/internal/connectors/request", () => {
  it("a HighLevel toolkit alone or mixed with another is refused whole", () => {
    expect(nativeWinsConnectorRequestRefused(["highlevel"])).toBe(true);
    expect(nativeWinsConnectorRequestRefused(["gmail", "highlevel_location"])).toBe(true);
    expect(nativeWinsConnectorRequestRefused(["gmail", "slack"])).toBe(false);
  });
});

// ---- stored results: a fixture broker for the relay ---------------------------------------------------------------------
let server: Server, base: string;
let delayMs = 0;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    const answer = () => res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: "fixture answer" }] } }));
    if (message.method === "tools/call" && delayMs) setTimeout(answer, delayMs); else answer();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  base = `http://127.0.0.1:${address.port}`;
  const localFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === base) return localFetch(input, init);
    throw new Error(`Unexpected external request in the native-wins fixture: ${url.origin}`);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  setManagedBrokerAccess(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  setManagedBrokerAccess({ url: base, token: "9".repeat(64) });
  resetAppCatalogState({ disk: true });
  resetConnectedAppOperations();
  delayMs = 0;
});
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const relay = (payload: unknown, bot: unknown, waitMs: number) => relayConnectedAppCall({}, payload as never, undefined, undefined, {
  botId: "bot_1", waitMs, statusWaitMs: 2_000, authorizeStored: (used) => assertStoredConnectedAppAccess(asBot(bot), used),
});
const replyText = (reply: { bytes: Uint8Array }) => decode(reply.bytes).result.content.map((item: { text: string }) => item.text).join("\n");

describe("T14 ruling 4: a stored Composio HighLevel result is refused once a native grant exists", () => {
  it("provenance naming Composio HighLevel, or incomplete, is refused before the unrestricted shortcut", () => {
    const h = nativeBot();
    expect(() => assertStoredConnectedAppAccess(asBot(h.bot), { requirements: [{ tool: COMPOSIO_HL, account: "ca_hl" }], complete: true })).toThrow(REFUSAL);
    expect(() => assertStoredConnectedAppAccess(asBot(h.bot), { requirements: [], complete: false })).toThrow(REFUSAL);
    expect(() => assertStoredConnectedAppAccess(asBot(h.bot), { requirements: [{ tool: "GMAIL_SEND_EMAIL", account: "ca_gmail" }], complete: true })).not.toThrow();
  });

  it("action started, grant added, then CHECK_CONNECTED_APP_ACTION (after its wait): refused", async () => {
    const h = nativeBot("none");
    delayMs = 150;
    const first = await relay(multi([composioHl()]), h.bot, 10);
    const handle = /handle (?:is )?(op-[a-z0-9-]+)/.exec(replyText(first))![1]!;
    const check = relay(tool("CHECK_CONNECTED_APP_ACTION", { handle }, 2), h.bot, 1_000);
    await settle(30);
    h.saveAccess(); // the owner gives the bot Murage's own HighLevel while CHECK waits
    await expect(check).rejects.toThrow(REFUSAL);
    await expect(relay(tool("CHECK_CONNECTED_APP_ACTION", { handle }, 3), h.bot, 10)).rejects.toThrow(REFUSAL);
  });
});

describe("T18: the original action's first wait re-checks the native grant", () => {
  it("a Composio HighLevel action whose first wait outlasts a native grant added mid-wait is refused with the refusal text", async () => {
    const h = nativeBot("none");
    delayMs = 120;
    const pending = relay(multi([composioHl()]), h.bot, 1_000);
    await settle(30);
    h.saveAccess();
    await expect(pending).rejects.toThrow(REFUSAL);
  });
});

describe("T15: a bot with no native grant is unchanged", () => {
  it("Composio HighLevel listed and callable; a warm process re-lists when a grant changes", async () => {
    const h = nativeBot("none");
    expect(nativeHighLevelGranted(h.bot)).toBe(false);
    expect(() => assertConnectedAppCall(asBot(h.bot), multi([composioHl()]))).not.toThrow();
    expect(() => assertStoredConnectedAppAccess(asBot(h.bot), { requirements: [{ tool: COMPOSIO_HL, account: "ca_hl" }], complete: true })).not.toThrow();
    // native names on the relay are still refused for every bot
    expect(() => assertConnectedAppCall(asBot(h.bot), multi([{ tool_slug: "HIGHLEVEL_GET_CONTACT", account: "ca_hl", arguments: {} }]))).toThrow(/Murage's own HighLevel connection, never through/);
    const reply = await relay(multi([composioHl()]), h.bot, 1_000);
    expect(replyText(reply)).toBe("fixture answer");
    const before = connectedAppsListScope(asBot(h.bot)).revision;
    expect(connectedAppsListScope(asBot(h.bot)).revision).toBe(before);
    h.saveAccess();
    const granted = connectedAppsListScope(asBot(h.bot)).revision;
    expect(granted).not.toBe(before);
    delete h.bot.highlevelAccess;
    expect(connectedAppsListScope(asBot(h.bot)).revision).toBe(before);
  });
});

// HL-S2-WRITES round 2, Astra H4: the proxy check races a grant added while the call waits. Checked at call time AND at
// dispatch, after the reply and before a receipt: a grant added mid-call wins.
describe("H4: a native grant added during a COMPOSIO_PROXY_EXECUTE call wins", () => {
  const proxy = () => tool("COMPOSIO_PROXY_EXECUTE", { connected_account_id: "ca_hl", endpoint: "/contacts", method: "POST", body: { name: "x" } });
  const guardFor = (bot: { current: { id: string; highlevelAccess?: unknown } }, lookups: { n: number }) => nativeWinsProxyGuard({
    body: proxy(),
    bot: () => bot.current,
    accountToolkit: async () => { lookups.n += 1; return async () => "highlevel"; },
    refusal: () => new Error(REFUSAL),
  });

  it("nativeWins.proxyGrantRaceRefused: no grant at call time, a grant before dispatch: nothing dispatches", async () => {
    expect(typeof nativeWinsProxyGuard).toBe("function");
    const h = nativeBot("connected");
    const grant = h.bot.highlevelAccess;
    delete h.bot.highlevelAccess;
    const bot = { current: h.bot as { id: string; highlevelAccess?: unknown } };
    const lookups = { n: 0 };
    const guard = guardFor(bot, lookups);
    await guard.check();
    expect(lookups.n).toBe(0);
    expect(messageOf(() => guard.assert())).toBe("(no refusal)");
    bot.current = { ...h.bot, highlevelAccess: grant };
    expect(messageOf(() => guard.assert())).toBe(REFUSAL);
    expect(guard.refused()).toBe(true);
  });

  it("the route runs the guard before dispatch, after the reply, in authorizeStored and before the receipt", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const route = index.slice(index.indexOf('path === "/api/internal/connectors/mcp"'), index.indexOf("const listed = (Array.isArray(body) ? body : [body])"));
    expect(route).toMatch(/const authorize = \(\) => \{[\s\S]{0,600}?proxyGuard\.assert\(\);\s*\};/);
    expect(route).toContain("await proxyGuard.check();");
    expect(route).toMatch(/assertStoredConnectedAppAccess\(current, used, \{ connectionActive: highlevelConnectionActive\(current\) \}\);\s*proxyGuard\.assert\(\);/);
    expect(route).toContain("onAnswered: (call, answer) => proxyGuard.refused() ? undefined : connectedAppReceipts.record(");
    expect(route).toMatch(/\);\s*authorize\(\);\s*const headers/);
  });
});

describe("nativeWins nested meta-tools cannot bypass the same refusal", () => {
  it("a workbench nested in MULTI_EXECUTE is refused", () => {
    const h = nativeBot();
    expect(() => assertConnectedAppCall(asBot(h.bot), multi([{ tool_slug: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: "print(1)" } }]))).toThrow(REFUSAL);
  });
  it("a proxy nested in MULTI_EXECUTE still checks its account", async () => {
    const payload = multi([{ tool_slug: "COMPOSIO_PROXY_EXECUTE", arguments: { connected_account_id: "ca_hl", endpoint: "/contacts/" } }]);
    expect(hasProxyExecute(payload)).toBe(true);
    expect(await nativeWinsProxyRefused(payload, async () => "highlevel")).toBe(true);
  });
  it("unreadable discovery responses cannot expose a raw listing", () => {
    const bytes = new TextEncoder().encode('{"result":{"tools":["unreadable');
    expect(new TextDecoder().decode(stripComposioHighLevelBytes("application/json", bytes))).toContain(REFUSAL);
  });
});

it("nativeWins SSE batch discovery removes every HighLevel result", () => {
  const listing = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: COMPOSIO_HL }, { name: "GMAIL_FETCH_EMAILS" }] } };
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify([listing])}\n\n`);
  const result = new TextDecoder().decode(stripComposioHighLevelBytes("text/event-stream", bytes));
  expect(result).not.toContain(COMPOSIO_HL);
  expect(result).toContain("GMAIL_FETCH_EMAILS");
});

describe("nativeWins canonical proxy authority", () => {
  it("normalizes an encoded endpoint hostname before deciding it is not HighLevel", async () => {
    const endpoint = "https://%73ervices.%6ceadconnectorhq.com/contacts/";
    expect(new URL(endpoint).hostname).toBe("services.leadconnectorhq.com");
    expect(await nativeWinsProxyRefused(tool("COMPOSIO_PROXY_EXECUTE", { connected_account_id: "ca_gmail", endpoint }), async () => "gmail")).toBe(true);
  });
  it("a live inventory failure returns the fixed native-wins refusal", async () => {
    const h = nativeBot();
    const guard = nativeWinsProxyGuard({
      body: tool("COMPOSIO_PROXY_EXECUTE", { connected_account_id: "ca_hl", endpoint: "/contacts/" }),
      bot: () => h.bot, accountToolkit: async () => { throw new Error("PROVIDER_PRIVATE_INVENTORY_ERROR"); }, refusal: () => new Error(REFUSAL),
    });
    await expect(guard.check()).rejects.toThrow(REFUSAL);
    expect(guard.refused()).toBe(true);
  });
});
