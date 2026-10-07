// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 L17 Part E: can a bot find and connect ANY app, not just the 24?
//
// The question the plan asked first: does the Tool Router session's own
// search already reach apps the owner has not connected, or does Murage need
// a find_app tool? Murage can only prove its own half against a fake broker:
// that nothing on the way (session creation, the harness relay, the engine's
// MCP bridge) narrows the search to connected or curated apps, and that
// connecting a long-tail app ends in a connect card with the right words.
// The vendor's half (its search covering the whole catalog when the session
// has no toolkit allowlist) is its documented behaviour and is checked live
// at Q1 ("connect my Airtable" returns a card). Result: no find_app tool.
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogApp, resetAppCatalogState } from "./app-catalog.ts";
import { fakeCatalogApps, fakeCatalogBroker } from "./app-catalog.fixture.ts";
import { catalogBackend, relayMcp, setManagedBrokerAccess } from "./composio.ts";
import { DATA_DIR } from "./config.ts";
import { CONNECTED_APPS_OWNER_ONLY, connectedAppsAudienceRefusal, connectorCardText } from "./connector-requests.ts";
import { closeDatabase } from "./database.ts";
import { bindHumanThread, humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, threadHumanPrincipal } from "./human-principals.ts";
import { internalRouteRefusal } from "./internal-route-authority.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { Store } from "./store.ts";

const APPS = fakeCatalogApps();
const CONNECTED = new Set(["gmail", "slack", "github"]);

/** The fake broker's MCP endpoint: SEARCH_TOOLS searches EVERY app and says
 * which ones are connected, the way the vendor documents it. */
function brokerMcp(body: { method?: string; id?: unknown; params?: { name?: string; arguments?: { queries?: Array<{ use_case?: string }> } } }) {
  if (body.method !== "tools/call" || body.params?.name !== "COMPOSIO_SEARCH_TOOLS") return { jsonrpc: "2.0", id: body.id, result: { tools: [] } };
  const want = (body.params.arguments?.queries?.[0]?.use_case ?? "").toLowerCase();
  const hits = APPS.filter(app => !/composio/i.test(app.slug) && `${app.slug} ${app.name}`.toLowerCase().includes(want)).slice(0, 5);
  const text = JSON.stringify({
    results: hits.map(app => ({ tool_slug: `${app.slug.toUpperCase()}_LIST`, toolkit: app.slug })),
    toolkit_connection_statuses: hits.map(app => ({ toolkit: app.slug, has_active_connection: CONNECTED.has(app.slug) })),
  });
  return { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } };
}

let received: unknown[] = [];
let server: Server | null = null;
let child: ChildProcessWithoutNullStreams | null = null;

beforeEach(() => {
  resetAppCatalogState({ disk: true });
  received = [];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setManagedBrokerAccess(null);
  resetAppCatalogState({ disk: true });
  child?.kill("SIGKILL");
  child = null;
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

function stubBroker() {
  const catalog = fakeCatalogBroker(APPS);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/v1/mcp")) {
      const body = JSON.parse(String(init?.body));
      received.push(body);
      return Response.json(brokerMcp(body));
    }
    return catalog.fetch(input, init);
  });
  setManagedBrokerAccess({ url: "https://broker.example.test", token: "e".repeat(64) });
  return catalog;
}

describe("the session's own search reaches apps nobody has connected", () => {
  it("relays a search for an unconnected long-tail app untouched, and returns it", async () => {
    stubBroker();
    const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: "tail app 1499" }] } } };
    const answer = await relayMcp({}, call);
    // nothing narrowed the request on the way out
    expect(received).toEqual([call]);
    const text = JSON.parse(new TextDecoder().decode(answer.bytes)).result.content[0].text;
    expect(JSON.parse(text)).toMatchObject({
      results: [{ toolkit: "tail_app_1499" }],
      toolkit_connection_statuses: [{ toolkit: "tail_app_1499", has_active_connection: false }],
    });
  });
});

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
async function listen(handler: Parameters<typeof createServer>[1]) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}
const readBody = async (request: import("node:http").IncomingMessage) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw);
};

describe("an engine searching, then connecting a long-tail app (scripted engine over the real MCP bridge)", () => {
  it("finds the app and ends in a connect card that says it needs the person's own sign-in details", async () => {
    stubBroker();
    const backend = catalogBackend({});
    const cards: Array<{ slug: string; label: string; description: string }> = [];
    // One loopback stand-in for the harness: the connectors MCP relay and the
    // connect-card route, answering from the same catalog code the harness uses.
    const base = await listen(async (request, response) => {
      const body = await readBody(request);
      response.setHeader("content-type", "application/json");
      if (request.url === "/mcp") return response.end(JSON.stringify(brokerMcp(body)));
      for (const item of body.items) cards.push({ slug: item.slug, ...connectorCardText(await catalogApp(backend, item.slug)) });
      response.end(JSON.stringify({ messageIds: cards.map((_card, index) => `m${index}`) }));
    });
    child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
      env: { ...process.env, MURAGE_CONNECTOR_UPSTREAM_URL: `${base}/mcp`, MURAGE_HARNESS_URL: base, MURAGE_CONNECTORS_TOKEN: "fixture", MURAGE_BOT_ID: "bot", MURAGE_THREAD_ID: "thread" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    const next = () => new Promise<Record<string, any>>(resolve => lines.once("line", line => resolve(JSON.parse(line))));
    const tail = APPS.find(app => !app.managed && app.slug.startsWith("tail_"))!;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: tail.name }] } } })}\n`);
    const search = JSON.parse((await next()).result.content[0].text);
    expect(search.toolkit_connection_statuses[0]).toEqual({ toolkit: tail.slug, has_active_connection: false });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: tail.slug }] } } })}\n`);
    const connect = await next();
    expect(connect.result.content[0].text).toContain(`secure connection card for ${tail.slug}`);
    expect(cards).toEqual([{
      slug: tail.slug,
      label: tail.name,
      description: `${tail.blurb}. Needs your own sign-in details. Connecting opens a page where you enter them.`,
    }]);
  });

  it("words a managed app's card as before", () => {
    expect(connectorCardText({ label: "Calendly", blurb: "Scheduling", signIn: "managed" })).toEqual({ label: "Calendly", description: "Scheduling" });
    expect(connectorCardText({ label: "Calendly", blurb: "", signIn: "managed" }, "Work")).toEqual({ label: "Calendly (Work)", description: "Connect Calendly so the bot can continue" });
  });
});

describe("a bot in a contact's thread cannot list the owner's accounts", () => {
  beforeEach(() => {
    closeDatabase();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  function threads() {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot();
    const helper = store.createBot();
    const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture-connection", authorityId: "TEAM", userId: "U-CONTACT" });
    linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
    const contactTask = store.createTask(bot.id, "Channel conversation", false)!;
    bindHumanThread(contactTask.threadId, resolveHumanBinding(bindingId));
    // a teammate asked for help from the contact's thread
    const delegated = humanTask(store, helper.id, threadHumanPrincipal(contactTask.threadId))!;
    return { owner: bot.threadId, contact: contactTask.threadId, delegated: delegated.threadId };
  }

  it("refuses the connected-apps surface for a contact and for a turn a contact started", () => {
    const { owner, contact, delegated } = threads();
    expect(connectedAppsAudienceRefusal(owner)).toBeNull();
    expect(connectedAppsAudienceRefusal(contact)).toBe(CONNECTED_APPS_OWNER_ONLY);
    expect(connectedAppsAudienceRefusal(delegated)).toBe(CONNECTED_APPS_OWNER_ONLY);
    // and the route gate in front of it says no as well
    for (const path of ["/api/internal/connectors/mcp", "/api/internal/connectors/request"]) {
      expect(internalRouteRefusal({ path, kind: "connectors", principal: threadHumanPrincipal(contact) })).not.toBeNull();
    }
  });

  it("refuses a turn whose words came from an unproven caller", () => {
    const { owner } = threads();
    expect(connectedAppsAudienceRefusal(owner, { origin: "unproven" })).toBe(CONNECTED_APPS_OWNER_ONLY);
  });

  it("fails closed when the audience cannot be read", () => {
    expect(connectedAppsAudienceRefusal("thread", {}, () => { throw new Error("database closed"); })).toBe(CONNECTED_APPS_OWNER_ONLY);
  });

  it("never names the connection service in the refusal", () => {
    expect(CONNECTED_APPS_OWNER_ONLY).not.toMatch(/composio|—/i);
  });
});

describe("audit round 1 (Kimi)", () => {
  it("the audience check stands in front of both connected-app routes, before any body is read", async () => {
    const { readFileSync } = await import("node:fs");
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    for (const route of ["/api/internal/connectors/mcp", "/api/internal/connectors/request"]) {
      const at = index.indexOf(`path === "${route}") {`);
      expect(at).toBeGreaterThan(0);
      expect(index.slice(at, at + 260)).toMatch(/connectedAppsAudienceRefusal\(internalClaim\.threadId\);\n\s+if \(audienceRefusal\) return json\(res, 403/);
    }
  });
});
