// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OPTIONAL HIGHLEVEL (Sean, 1.0.20, customer-seen on 1.0.19): bots asked people to "connect HighLevel" who never set it up
// and never asked for it. HighLevel stays available in Settings → Connected apps, but an engine never sees it, is never
// handed a connect card for it and is never pointed at it unless the owner connected it (natively, or a Composio
// HighLevel account). Owners who connected it keep today's behaviour exactly.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppCatalogState } from "../app-catalog.ts";
import { relayConnectedAppCall, resetConnectedAppOperations, setManagedBrokerAccess } from "../composio.ts";
import { buildMcpServers } from "../drivers/mcp-mounts.ts";
import { searchHelp } from "../../shared/help-search.ts";
import { FAKE_CONNECTION_ID, highLevelHarness } from "../testing/fake-highlevel.ts";
import { createHighLevelRuntime } from "./runtime.ts";
import { HIGHLEVEL_NATIVE_WINS_REFUSAL, stripComposioHighLevelBytes } from "./native-wins.ts";

// Base proof: the names this lane adds are read by feature detection, so on the base the file loads and each test fails on
// its own assertion rather than on an import error.
const optional = async <T,>(spec: string): Promise<Partial<T>> => { try { return await import(/* @vite-ignore */ spec) as T; } catch { return {}; } };
const wins = await optional<typeof import("./native-wins.ts")>("./native-wins.ts");
const help = await optional<typeof import("../../shared/help-search.ts")>("../../shared/help-search.ts");
const missing = () => { throw new Error("not on this build"); };
const connectorReplyBytes = wins.connectorReplyBytes ?? missing;
const connectorRequestHighLevelRefusal = wins.connectorRequestHighLevelRefusal ?? missing;
const searchHelpForBot = help.searchHelpForBot ?? missing;

const NAMES_HL = /high\s*level|leadconnector/i;
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const searchCall = (id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: "find my leads and contacts" }] } } });
// What the broker answers a contacts search with: a connected Gmail toolkit and an unconnected Composio HighLevel toolkit
// whose card tells the engine to start a connection, the shape that turned into "connect HighLevel" in chat.
const SEARCH_RESULTS = {
  results: [
    { tool_slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail", connected: true },
    { tool_slug: "HIGHLEVEL_SEARCH_CONTACTS", toolkit: "highlevel", connected: false, next_step: "Call COMPOSIO_MANAGE_CONNECTIONS for highlevel" },
  ],
  toolkit_connection_statuses: [{ toolkit: "gmail", has_active_connection: true }, { toolkit: "highlevel", has_active_connection: false }],
};

let server: Server, base: string;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(SEARCH_RESULTS) }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  base = `http://127.0.0.1:${address.port}`;
  const localFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === base) return localFetch(input, init);
    throw new Error(`Unexpected external request in the optional-HighLevel fixture: ${url.origin}`);
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
});

/** The broker's real answer to a contacts search, through the relay the route calls. */
async function relayedSearch(): Promise<{ contentType: string; bytes: Uint8Array }> {
  const reply = await relayConnectedAppCall({}, searchCall() as never, undefined, undefined, { botId: "bot_1", waitMs: 1_000, statusWaitMs: 2_000 });
  expect(new TextDecoder().decode(reply.bytes)).toMatch(/highlevel/);
  return { contentType: reply.contentType, bytes: reply.bytes };
}
const plainBot = () => ({ id: "bot_plain" });
const grantedBot = () => highLevelHarness().bot;
const replyFor = (bot: { id: string; highlevelAccess?: unknown }, upstream: { contentType: string; bytes: Uint8Array }, connected: ReadonlySet<string> | null, noLimits = false) =>
  connectorReplyBytes({ bot, noLimits, body: searchCall(), contentType: upstream.contentType, bytes: upstream.bytes, connectedSlugs: () => connected, connectionActive: () => true });

describe("OPT-1 unconnected: the relay never shows Composio HighLevel", () => {
  for (const [label, connected] of [["inventory without HighLevel", new Set(["gmail"])], ["inventory unknown (fail closed)", null]] as const) {
    for (const noLimits of [false, true]) {
      it(`${label}, ${noLimits ? "No limits" : "Ask"}: the search keeps Gmail and names no HighLevel`, async () => {
        const upstream = await relayedSearch();
        const text = new TextDecoder().decode(replyFor(plainBot(), upstream, connected, noLimits));
        expect(text).not.toMatch(NAMES_HL);
        const inner = JSON.parse(JSON.parse(text).result.content[0].text);
        expect(inner.results).toEqual([SEARCH_RESULTS.results[0]]);
        expect(inner.toolkit_connection_statuses).toEqual([SEARCH_RESULTS.toolkit_connection_statuses[0]]);
      });
    }
  }

  it("a tool list or a free-text answer that names HighLevel becomes the neutral line, never the native refusal", () => {
    const listing = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }, { name: "HIGHLEVEL_LIST_FORMS" }] } };
    const list = decode(connectorReplyBytes({ bot: plainBot(), noLimits: false, body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, contentType: "application/json",
      bytes: encode(listing), connectedSlugs: () => new Set(), connectionActive: () => true }));
    expect(list.result.tools).toEqual([{ name: "COMPOSIO_SEARCH_TOOLS" }]);
    const prose = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Connect HighLevel to read your contacts." }] } };
    const text = new TextDecoder().decode(connectorReplyBytes({ bot: plainBot(), noLimits: false, body: searchCall(), contentType: "application/json",
      bytes: encode(prose), connectedSlugs: () => new Set(), connectionActive: () => true }));
    expect(text).not.toMatch(NAMES_HL);
    expect(text).not.toContain(HIGHLEVEL_NATIVE_WINS_REFUSAL);
    expect(JSON.parse(text).result).toEqual({ content: [{ type: "text", text: wins.HIGHLEVEL_OPTIONAL_HIDDEN_RESULT }], isError: true });
  });

  // MAIN (final review): a search across apps must keep every other app's results; only HighLevel goes.
  const hidden = (answer: unknown, contentType = "application/json", raw?: string) => new TextDecoder().decode(connectorReplyBytes({ bot: plainBot(), noLimits: false, body: searchCall(),
    contentType, bytes: raw === undefined ? encode(answer) : new TextEncoder().encode(raw), connectedSlugs: () => new Set(), connectionActive: () => true }));
  const mixed = () => ({ successful: true, data: {
    results: [
      { index: 0, use_case: "send an email", toolkits: ["gmail"], tools: [{ tool_slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" }] },
      { index: 1, use_case: "find my leads", toolkits: ["highlevel"], tools: [{ tool_slug: "HIGHLEVEL_SEARCH_CONTACTS", toolkit: "highlevel" }] },
      { index: 2, use_case: "post a message", toolkits: ["slack", "highlevel_location"], tools: [{ tool_slug: "SLACK_SEND_MESSAGE", toolkit: "slack" }, { tool_slug: "HIGHLEVEL_LIST_FORMS", toolkit: "highlevel" }] },
    ],
    // an entry that is not in a list: the older removal left it, and then threw the whole answer away
    related: { suggested: { toolkit: "highlevel", reason: "crm" }, other: { toolkit: "slack" } },
    toolkit_connection_statuses: { gmail: { connected: true }, highlevel: { connected: false }, slack: { connected: true } },
  } });

  it("MIXED a search that names HighLevel among other apps loses only HighLevel: Gmail and Slack results stay", () => {
    const text = hidden({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(mixed()) }] } });
    expect(text).not.toMatch(NAMES_HL);
    expect(text).not.toContain(wins.HIGHLEVEL_OPTIONAL_HIDDEN_RESULT);
    const result = JSON.parse(text).result;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ successful: true, data: {
      results: [
        { index: 0, use_case: "send an email", toolkits: ["gmail"], tools: [{ tool_slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" }] },
        { index: 2, use_case: "post a message", toolkits: ["slack"], tools: [{ tool_slug: "SLACK_SEND_MESSAGE", toolkit: "slack" }] },
      ],
      related: { other: { toolkit: "slack" } },
      toolkit_connection_statuses: { gmail: { connected: true }, slack: { connected: true } },
    } });
  });

  it("MIXED the same over an event stream, and plain text loses only the lines that name HighLevel", () => {
    const frame = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(mixed()) }] } };
    const stream = hidden(undefined, "text/event-stream", `event: message\ndata: ${JSON.stringify(frame)}\n\n`);
    expect(stream).not.toMatch(NAMES_HL);
    expect(stream).toContain("GMAIL_SEND_EMAIL");
    expect(stream).toContain("SLACK_SEND_MESSAGE");
    expect(stream).not.toContain(wins.HIGHLEVEL_OPTIONAL_HIDDEN_RESULT);
    const prose = hidden({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Gmail: send and read mail.\nHighLevel: connect it to read your contacts.\nSlack: post a message." }] } });
    expect(JSON.parse(prose).result).toEqual({ content: [{ type: "text", text: "Gmail: send and read mail.\nSlack: post a message." }] });
  });

  it("MIXED the English phrase is not the app: another tool that says \"high level overview\" survives, in text and in JSON", () => {
    const prose = hidden({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: [
      "Notion: gives a high level overview of your pages.",
      "HighLevel: connect it to read your contacts.",
      "GoHighLevel CRM: contacts and pipelines.",
      "HIGHLEVEL_LIST_FORMS lists forms.",
      "toolkit highlevel_location is not connected.",
      "LeadConnector: phone and SMS.",
      "Linear: a High Level summary of the roadmap.",
    ].join("\n") }] } });
    expect(JSON.parse(prose).result).toEqual({ content: [{ type: "text", text: "Notion: gives a high level overview of your pages.\nLinear: a High Level summary of the roadmap." }] });
    const answer = { successful: true, data: { results: [
      { index: 0, toolkits: ["notion"], tools: [{ tool_slug: "NOTION_SEARCH", toolkit: "notion", description: "Returns a high level overview of matching pages." }] },
      { index: 1, toolkits: ["highlevel"], tools: [{ tool_slug: "HIGHLEVEL_SEARCH_CONTACTS", toolkit: "highlevel", description: "Search contacts." }] },
    ] } };
    const json = JSON.parse(hidden({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } })).result;
    expect(JSON.parse(json.content[0].text)).toEqual({ successful: true, data: { results: [answer.data.results[0]] } });
  });

  it("MIXED nothing left once HighLevel is removed, or an answer that cannot be read: the neutral line, naming no app", () => {
    const only = hidden({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "HighLevel: connect it to read your contacts." }] } });
    expect(JSON.parse(only).result).toEqual({ content: [{ type: "text", text: wins.HIGHLEVEL_OPTIONAL_HIDDEN_RESULT }], isError: true });
    const unreadable = hidden(undefined, "application/json", "{not json highlevel");
    expect(unreadable).not.toMatch(NAMES_HL);
    expect(JSON.parse(unreadable).result).toEqual({ content: [{ type: "text", text: wins.HIGHLEVEL_OPTIONAL_HIDDEN_RESULT }], isError: true });
  });

  it("a call that is not a search or a list passes through unchanged", () => {
    const answer = encode({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "highlevel fixture answer" }] } });
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [] } } };
    expect(connectorReplyBytes({ bot: plainBot(), noLimits: false, body: call, contentType: "application/json", bytes: answer, connectedSlugs: () => null, connectionActive: () => true })).toBe(answer);
  });
});

describe("OPT-2 connected: owners who set HighLevel up keep today's relay exactly", () => {
  it("a Composio HighLevel account in the inventory: the reply bytes are the broker's own, at every level", async () => {
    const upstream = await relayedSearch();
    for (const noLimits of [false, true]) expect(replyFor(plainBot(), upstream, new Set(["gmail", "highlevel"]), noLimits)).toBe(upstream.bytes);
  });

  it("a native grant: NATIVE WINS stripping below No limits, untouched at No limits (as on the base)", async () => {
    const upstream = await relayedSearch();
    const bot = grantedBot();
    expect(new TextDecoder().decode(replyFor(bot, upstream, new Set(["gmail"]), false))).toBe(new TextDecoder().decode(stripComposioHighLevelBytes(upstream.contentType, upstream.bytes, true)));
    expect(replyFor(bot, upstream, new Set(["gmail"]), true)).toBe(upstream.bytes);
  });
});

describe("OPT-3 the connect card: never offered for HighLevel nobody set up", () => {
  const refusal = (bot: { id: string; highlevelAccess?: unknown }, slugs: string[], connected: ReadonlySet<string> | null, noLimits = false) =>
    connectorRequestHighLevelRefusal({ bot, noLimits, slugs, connectedSlugs: () => connected, connectionActive: () => true });

  it("unconnected: HighLevel alone or mixed is refused with the do-not-offer line at every level; other apps go on", () => {
    for (const noLimits of [false, true]) {
      for (const connected of [new Set(["gmail"]), null]) {
        expect(refusal(plainBot(), ["highlevel"], connected, noLimits)).toBe(wins.HIGHLEVEL_OPTIONAL_REQUEST_REFUSAL);
        expect(refusal(plainBot(), ["gmail", "highlevel_location"], connected, noLimits)).toBe(wins.HIGHLEVEL_OPTIONAL_REQUEST_REFUSAL);
        expect(refusal(plainBot(), ["gmail", "slack"], connected, noLimits)).toBeNull();
      }
    }
    expect(wins.HIGHLEVEL_OPTIONAL_REQUEST_REFUSAL).toMatch(/Don't offer it or ask the owner to connect it/);
  });

  it("connected: a Composio HighLevel account goes on; a native grant keeps the NATIVE WINS refusal below No limits only", () => {
    expect(refusal(plainBot(), ["highlevel"], new Set(["highlevel"]))).toBeNull();
    expect(refusal(grantedBot(), ["highlevel"], new Set(["gmail"]), false)).toBe(HIGHLEVEL_NATIVE_WINS_REFUSAL);
    expect(refusal(grantedBot(), ["highlevel"], new Set(["gmail"]), true)).toBeNull();
  });
});

describe("OPT-4 the routes call these decisions", () => {
  const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  it("the relay route answers through connectorReplyBytes with the remembered inventory, and warms an unknown one", () => {
    const route = index.slice(index.indexOf('method === "POST" && path === "/api/internal/connectors/mcp"'), index.indexOf("// ── the owner's link servers"));
    expect(route.length).toBeGreaterThan(0);
    expect(route).toContain("return res.end(Buffer.from(connectorReplyBytes({ bot: nativeBot, noLimits: serviceNoLimits(internalClaim.generation, internalClaim.threadId, internalClaim.botId), body,");
    expect(route).toContain("connectedSlugs: () => composio.rememberedConnectedSlugs(cfg)");
    expect(route).toContain("composio.rememberedConnectedSlugs(cfg) === null) await composio.connectedServices(cfg).catch(() => undefined);");
    expect(route).not.toMatch(/res\.end\(Buffer\.from\(relayed\)|res\.end\(relayed\)/);
  });
  it("the connect-request route refuses through connectorRequestHighLevelRefusal before the No limits branch", () => {
    const route = index.slice(index.indexOf('method === "POST" && path === "/api/internal/connectors/request"'));
    expect(route.length).toBeLessThan(index.length);
    const decision = route.indexOf("const highlevelRequestRefusal = connectorRequestHighLevelRefusal(");
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeLessThan(route.indexOf("if (serviceNoLimits(internalClaim.generation, internalClaim.threadId, internalClaim.botId)) {"));
    expect(route).toContain("if (highlevelRequestRefusal) return localJson(res, 403, { error: highlevelRequestRefusal });");
  });
});

describe("OPT-5 murage_help never points a bot at HighLevel it was not asked about", () => {
  it("a contacts/CRM question: the plain index has a HighLevel section, the bot's search has none", () => {
    const question = "how can my bot read my CRM contacts and opportunities";
    expect(searchHelp(question, { limit: 5 }).some((result) => NAMES_HL.test(`${result.id} ${result.text}`))).toBe(true);
    const forBot = searchHelpForBot(question, { limit: 5 });
    expect(forBot.length).toBeGreaterThan(0);
    expect(forBot.some((result) => NAMES_HL.test(`${result.id} ${result.title} ${result.heading ?? ""} ${result.where} ${result.text}`))).toBe(false);
  });
  it("a question that names HighLevel still finds its section", () => {
    expect(searchHelpForBot("how do I connect HighLevel", { limit: 3 }).some((result) => result.id.includes("highlevel"))).toBe(true);
  });
  it("the agents proxy answers murage_help through searchHelpForBot", () => {
    const proxy = readFileSync(new URL("../drivers/agents-proxy.ts", import.meta.url), "utf8");
    expect(proxy).toContain("const results = searchHelpForBot(question,");
    expect(proxy).not.toMatch(/\bsearchHelp\(/);
  });
});

describe("OPT-6 the native mount: no HighLevel tool on an unconnected turn, unchanged for a connected one", () => {
  const runtime = (h: ReturnType<typeof highLevelHarness>) => createHighLevelRuntime({
    threadMarkState: () => "marked", dataDir: mkdtempSync(join(tmpdir(), "hlopt-")), capabilities: h.capabilities, signals: h.signals,
    bot: (id) => (id === h.bot.id ? h.bot : undefined), leases: h.leases, fetch: h.api.fetch,
  });
  it("no grant: mountsFor is false at every level, and a turn without the integration mounts no highlevel server", async () => {
    const h = highLevelHarness();
    delete h.bot.highlevelAccess;
    for (const level of ["ask", "auto", "full", "unlimited"] as const) expect(await runtime(h).mountsFor(h.bot.id, level)).toBe(false);
    const servers = buildMcpServers({ integrations: {} } as never) ?? {};
    expect(Object.keys(servers)).not.toContain("highlevel");
  });
  it("granted on a connected location: mountsFor is true, as on the base", async () => {
    const h = highLevelHarness();
    expect(h.leases.views.get(FAKE_CONNECTION_ID)?.state).toBe("connected");
    expect(await runtime(h).mountsFor(h.bot.id, "ask")).toBe(true);
  });
});
