import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { bumpGeneration } from "./connector-cache.ts";
import { Store } from "./store.ts";
import { assertConnectedAppCall, reviewBotAccess } from "./bot-access.ts";
import { LEGACY_DAILY_LIMIT } from "../shared/connected-app-calls.ts";
import { exposedToolName, LEGACY_NAMES_ENV } from "../shared/connected-app-names.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
let child: ChildProcessWithoutNullStreams | null = null;
let server: Server | null = null;

async function listen(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function start(env: Record<string, string>) {
  // Each bridge gets its own remembered-list folder unless a test names one.
  const toolsCache = env.MURAGE_CONNECTOR_TOOLS_CACHE_DIR ?? mkdtempSync(join(tmpdir(), "murage-proxy-cache-"));
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    // Windows trusts a cache folder only when the harness verified its ACL; the test folders are private temp ones.
    env: { ...process.env, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: toolsCache, ...(process.platform === "win32" ? { MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE: "1" } : {}), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return readline.createInterface({ input: child.stdout });
}

function nextJson(lines: readline.Interface) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    lines.once("line", (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
}

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("connector MCP bridge", () => {
  it("forwards the RMCP envelope through restricted authorization without admitting writes or other accounts", async () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot({ name: "RMCP metadata fixture" });
    reviewBotAccess(store, bot.id, {
      action: "configure", revision: 0, mode: "restricted", allowWrites: false,
      grants: [{ toolkit: "gmail", accountId: "ca_fixture_owned", tools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"] }],
    }, [{ toolkit: "gmail", accountId: "ca_fixture_owned" }]);
    const forwarded: unknown[] = [];
    const upstream = await listen((request, response) => {
      let raw = "";
      request.on("data", chunk => { raw += chunk; });
      request.on("end", () => {
        if (request.headers.authorization !== "Bearer fixture-metadata") {
          response.writeHead(403); response.end(); return;
        }
        const message = JSON.parse(raw);
        try {
          assertConnectedAppCall(bot, message);
          forwarded.push(message);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "fixture-read-ok" }] } }));
        } catch (error) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : "refused" }));
        }
      });
    });
    const lines = start({
      MURAGE_CONNECTOR_UPSTREAM_URL: upstream,
      MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer fixture-metadata" }),
    });
    const fixture = JSON.parse(readFileSync(new URL("./testing/fixtures/rmcp-3.2.0-tools-call.json", import.meta.url), "utf8"));
    const send = async (message: unknown) => {
      const reply = nextJson(lines);
      child!.stdin.write(`${JSON.stringify(message)}\n`);
      return reply;
    };
    const allowed = await send(fixture);
    expect(allowed.result.content[0].text).toBe("fixture-read-ok");
    expect(forwarded).toEqual([fixture]);
    const write = structuredClone(fixture); write.id = 2;
    write.params.arguments.tools[0].tool_slug = "GMAIL_SEND_EMAIL";
    expect((await send(write)).result).toMatchObject({ isError: true });
    const foreign = structuredClone(fixture); foreign.id = 3;
    foreign.params.arguments.tools[0].account = "ca_other";
    expect((await send(foreign)).result).toMatchObject({ isError: true });
    const metadata = structuredClone(fixture); metadata.id = 4;
    metadata.params._meta.account = "ca_other";
    expect((await send(metadata)).result).toMatchObject({ isError: true });
    expect(forwarded).toEqual([fixture]);
  });

  it("preserves distinct account aliases and canonical duplicates in authenticated requests", async () => {
    let received: any;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({ MURAGE_HARNESS_URL: harness, MURAGE_CONNECTORS_TOKEN: "fixture-secret" });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: {
      name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [
        { toolkit: " GMAIL ", alias: " Personal " }, { name: "gmail", account: "Work", action: "connect" },
        { toolkit: "gmail", alias: "work" }, { toolkit: "gmail", alias: "Ignored", action: "remove" }, "GMAIL",
      ] },
    } })}\n`);
    const reply = await nextJson(lines);
    expect(received.items).toEqual([{ slug: "gmail", alias: "Personal" }, { slug: "gmail", alias: "Work" }, { slug: "gmail" }]);
    expect(received.slugs).toEqual(["gmail"]);
    expect(reply.result.content[0].text).toContain("gmail (Work)");
  });

  it("turns agent connection requests into authenticated chat-card requests", async () => {
    let received: any = null;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({
      MURAGE_HARNESS_URL: harness,
      MURAGE_COMMS_TOKEN: "different-agents-capability",
      MURAGE_CONNECTORS_TOKEN: "bridge-secret",
      MURAGE_BOT_ID: "bot-1",
      MURAGE_THREAD_ID: "thread-1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: ["GMAIL"] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(7);
    expect(reply.result.content[0].text).toMatch(/secure connection card/i);
    expect(received.authorization).toBe("Bearer bridge-secret");
    expect(received.body).toMatchObject({ botId: "bot-1", threadId: "thread-1", slugs: ["gmail"] });
    expect(received.body.resumeKey).toMatch(/^[\w-]{8,100}$/);
  });

  it("answers initialize locally so a missing or failing upstream cannot fail the MCP handshake", async () => {
    const lines = start({});
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "murage-connectors", version: "1" },
      },
    });
    expect(reply.result).not.toHaveProperty("isError");
    expect(reply.result).not.toHaveProperty("content");
  });

  it("answers initialize at once while the upstream stalls", async () => {
    let sawInitialize!: () => void;
    const received = new Promise<void>((resolve) => { sawInitialize = resolve; });
    const upstream = await listen((request) => {
      request.resume();
      request.on("end", sawInitialize);
      // Deliberately never respond. The engine still gets its local
      // capability result at once: the upstream session opens behind it.
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream });
    const replied = nextJson(lines);
    const asked = Date.now();
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })}\n`);

    const reply = await replied;
    expect(Date.now() - asked).toBeLessThan(900);
    await received;
    expect(reply).toMatchObject({
      id: 11,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
      },
    });
  });

  it("still opens the upstream MCP session on initialize without echoing secrets", async () => {
    let upstreamAuthorization = "";
    let upstreamBody: any = null;
    const methods: string[] = [];
    const sessionHeaders: string[] = [];
    let sawInitialized!: () => void;
    const initialized = new Promise<void>((resolve) => { sawInitialized = resolve; });
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        upstreamAuthorization = String(request.headers.authorization ?? "");
        upstreamBody = JSON.parse(body);
        methods.push(String(upstreamBody.method ?? ""));
        sessionHeaders.push(String(request.headers["mcp-session-id"] ?? ""));
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
        response.end(upstreamBody.id === undefined
          ? ""
          : JSON.stringify({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } }));
        if (upstreamBody.method === "notifications/initialized") sawInitialized();
      });
    });
    const lines = start({
      MURAGE_CONNECTOR_UPSTREAM_URL: upstream,
      MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    let sawUpstreamInitialize!: () => void;
    const upstreamInitialize = new Promise<void>((resolve) => { sawUpstreamInitialize = resolve; });
    const watch = setInterval(() => { if (methods.includes("initialize")) sawUpstreamInitialize(); }, 10);
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    const reply = await nextJson(lines);
    await upstreamInitialize;
    clearInterval(watch);
    expect(reply.result.protocolVersion).toBe("2024-11-05");
    expect(reply.result.serverInfo).toEqual({ name: "murage-connectors", version: "1" });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(upstreamBody).toMatchObject({ method: "initialize" });
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");

    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    await initialized;
    expect(methods).toEqual(["initialize", "notifications/initialized"]);
    expect(sessionHeaders).toEqual(["", "transport-1"]);
  });

  it("relays tools/list without exposing upstream headers on stdout", async () => {
    let upstreamAuthorization = "";
    const upstream = await listen((request, response) => {
      upstreamAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS", inputSchema: { type: "object" } }] },
      }));
    });
    const lines = start({
      MURAGE_CONNECTOR_UPSTREAM_URL: upstream,
      MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(4);
    // The service's tools, then the bridge's own outcome check.
    expect(reply.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["APPS_SEARCH_TOOLS", "CHECK_CONNECTED_APP_ACTION"]);
    expect(reply.result.tools[0]).toEqual({ name: "APPS_SEARCH_TOOLS", inputSchema: { type: "object" } });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");
  });

  it("returns a JSON-RPC error, not a tools result, when a non-call relay fails", async () => {
    const lines = start({});
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "connected apps are unavailable" },
    });
  });

  // The three ways this bridge used to fail in silence. Each was found by
  // driving the real proxy against a stub upstream, not by reading it.

  it("carries the upstream's own words, not just its status number", async () => {
    // Every distinct failure collapsed to "connector service returned HTTP
    // 429". The broker writes a real sentence with a code and a reset time,
    // and all of it was discarded — which is why a dead connector could not
    // be diagnosed from inside the app.
    const harness = await listen((_request, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: "This install has hit today's connected-app request limit. It resets at 00:00 UTC.",
        code: "daily_call_ceiling",
        used: 251,
      }));
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: harness });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    const reply = await nextJson(lines);
    expect(JSON.stringify(reply)).toContain("daily_call_ceiling");
    expect(JSON.stringify(reply)).toContain("resets at 00:00 UTC");
  });

  it("answers an unreadable upstream instead of hanging forever", async () => {
    // A 200 with an empty body parsed to null, and null was never written to
    // stdout at all. An MCP client waits on an unanswered id indefinitely,
    // and inside an agent turn a hung tool call looks exactly like the model
    // thinking.
    const harness = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("");
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: harness });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(11);
    // Never hangs, and never an empty mount: the first list answers with the fallback tools.
    expect(reply.result.tools.map((t: { name: string }) => t.name)).toContain("APPS_REMOTE_WORKBENCH");
  });

  it("refuses to answer one request with another request's frame", async () => {
    // `?? frames.at(-1)` forwarded a stranger: a frame carrying a different
    // jsonrpc id was handed back as the answer, so the client never resolved
    // the id it asked about.
    const harness = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { tools: [] } })}\n\n`);
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: harness });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list" })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id, "answered id 12 with id 999's frame").toBe(12);
    expect(reply.result.tools.map((t: { name: string }) => t.name)).toContain("APPS_REMOTE_WORKBENCH"); // the stranger's empty list is not the answer
  });

  it("opens a new upstream session and retries once when the old one is gone", async () => {
    // After a network drop the upstream forgets the session and answers 404 to
    // the id the bridge kept. The bridge used to keep forwarding it for the
    // rest of its life; now it drops it, initializes again, and retries.
    const seen: Array<{ method: unknown; session: string | undefined; id: unknown }> = [];
    let sessions = 0;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        const session = request.headers["mcp-session-id"] as string | undefined;
        seen.push({ method: message.method, session, id: message.id });
        if (message.method === "initialize") {
          sessions += 1;
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": `s${sessions}` });
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        }
        if (message.method === "tools/call" && session === "s1") {
          response.writeHead(404, { "content-type": "application/json" });
          return response.end(JSON.stringify({ error: "session_gone" }));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "done" }] } }));
      });
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: harness });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    await nextJson(lines);
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(2);
    expect(reply.result.content[0].text).toBe("done");
    const calls = seen.filter((entry) => entry.method === "tools/call");
    expect(calls.map((entry) => entry.session)).toEqual(["s1", "s2"]);
    expect(seen.filter((entry) => entry.method === "initialize").map((entry) => entry.session)).toEqual([undefined, undefined]);
  });

  it("retries a gone session only once, so a broken upstream cannot loop", async () => {
    let calls = 0;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sx" });
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        }
        if (message.method === "tools/call") calls += 1;
        response.writeHead(message.method === "tools/call" ? 404 : 200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: harness });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await nextJson(lines);
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "X", arguments: {} } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(2);
    expect(calls).toBe(2);
  });

  // 1.0.2 tool latency: engines wait up to 6000 s (Grok) on an MCP call. The
  // bridge bounds each connected-app call itself and answers the bot plainly.
  it("answers an action that outlasts the wait as still running, never as an error to repeat", async () => {
    const hung: Array<() => void> = [];
    const waits: string[] = [];
    const upstream = await listen((request, response) => { waits.push(String(request.headers["x-murage-wait-ms"])); request.resume(); hung.push(() => response.destroy()); });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream, MURAGE_CONNECTOR_ACTION_TIMEOUT_MS: "400", MURAGE_CONNECTOR_LOOKUP_TIMEOUT_MS: "200", MURAGE_CONNECTOR_GRACE_MS: "100" });
    const started = Date.now();
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {
      name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 5 } }] },
    } })}\n`);
    const reply = await nextJson(lines);
    const waited = Date.now() - started;
    for (const end of hung) end();
    expect(reply.id).toBe(9);
    expect(reply.result.isError).toBeUndefined();
    const text: string = reply.result.content[0].text;
    expect(text).toContain("Gmail: fetch emails");
    expect(text).toMatch(/still running/);
    expect(text).toMatch(/Do not run it again/);
    expect(text).not.toMatch(/composio|safe|\u2014/i);
    // The server is told how long it may hold the bot: the bound, less the grace.
    expect(Number(waits[0])).toBeGreaterThan(200);
    expect(Number(waits[0])).toBeLessThanOrEqual(400);
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(5_000);
  });

  it("gives a lookup the shorter bound, and a retry hint instead of the action warning", async () => {
    const hung: Array<() => void> = [];
    const upstream = await listen((request, response) => { request.resume(); hung.push(() => response.destroy()); });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream, MURAGE_CONNECTOR_ACTION_TIMEOUT_MS: "5000", MURAGE_CONNECTOR_LOOKUP_TIMEOUT_MS: "200" });
    const started = Date.now();
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: ["GMAIL_FETCH_EMAILS"] } } })}\n`);
    const reply = await nextJson(lines);
    for (const end of hung) end();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/^The connected app lookup did not answer within/);
    expect(reply.result.content[0].text).toMatch(/Try it once more/);
  });

  it("still relays an action that answers inside its bound", async () => {
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "3 emails" }] } }));
      }, 100));
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream, MURAGE_CONNECTOR_ACTION_TIMEOUT_MS: "2000" });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [] } } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.result.content[0].text).toBe("3 emails");
    expect(reply.result.isError).toBeUndefined();
  });

  // Names (shared/connected-app-names.ts): what the engine is shown, and what reaches it untouched.
  /** An upstream that lists the search tool, answers a call with `answer`, and records each call's name. */
  async function namedUpstream(answer: (id: unknown) => Record<string, unknown>, calls: string[]) {
    return listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        if (message.method === "tools/list") {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description: "Search Composio's tools.", inputSchema: { type: "object" } }] } }));
        } else if (message.method === "tools/call") {
          calls.push(message.params.name);
          response.end(JSON.stringify(answer(message.id)));
        } else response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
    });
  }

  it("a session an earlier release started is listed its older tool names too, and a call by one runs unchanged", async () => {
    const calls: string[] = [];
    const upstream = await namedUpstream((id) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "found 2" }] } }), calls);
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream, [LEGACY_NAMES_ENV]: "1" });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const list = await nextJson(lines);
    const names = list.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["APPS_SEARCH_TOOLS", "COMPOSIO_SEARCH_TOOLS"]));
    // the alias is described plainly like the rest
    expect(list.result.tools.find((tool: { name: string }) => tool.name === "COMPOSIO_SEARCH_TOOLS").description).not.toMatch(/composio/i);
    // the exact call a 1.0.1 transcript holds
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [] } } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(2);
    expect(reply.result.content[0].text).toBe("found 2");
    expect(calls).toEqual(["COMPOSIO_SEARCH_TOOLS"]);
  });

  it("a session started now is never listed an older tool name", async () => {
    const upstream = await namedUpstream((id) => ({ jsonrpc: "2.0", id, result: {} }), []);
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const list = await nextJson(lines);
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain("APPS_SEARCH_TOOLS");
    expect(JSON.stringify(list)).not.toMatch(/composio/i);
  });

  it("hands an action's result to the engine exactly as the app sent it", async () => {
    const data = "Saved COMPOSIO_API_KEY to /tmp/COMPOSIO_RESULT.json for the Composio team";
    const upstream = await namedUpstream((id) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: data }] } }), []);
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "APPS_MULTI_EXECUTE_TOOL", arguments: { tools: [] } } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.result.content[0].text).toBe(data);
  });

  it("says the service's own error without its name", async () => {
    const upstream = await namedUpstream((id) => ({ jsonrpc: "2.0", id, error: { code: -32001, message: "Composio authentication failed", data: { detail: "Composio key rejected" } } }), []);
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "APPS_SEARCH_TOOLS", arguments: {} } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(5);
    expect(JSON.stringify(reply)).toMatch(/authentication failed/);
    expect(JSON.stringify(reply)).not.toMatch(/composio/i);
  });

  it("keeps session recovery and the retry inside the call's one deadline", async () => {
    let initializes = 0;
    const hung: Array<() => void> = [];
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          initializes += 1;
          // The first session opens; reopening it after the 404 never answers.
          if (initializes > 1) { hung.push(() => response.destroy()); return; }
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        }
        setTimeout(() => {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "session_gone" }));
        }, 150);
      });
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: harness, MURAGE_CONNECTOR_LOOKUP_TIMEOUT_MS: "600" });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await nextJson(lines);
    const started = Date.now();
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } })}\n`);
    const reply = await nextJson(lines);
    const waited = Date.now() - started;
    for (const end of hung) end();
    expect(reply.id).toBe(2);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/^The connected app lookup did not answer within 1 seconds/);
    // One 600 ms deadline for the call, the reopen and the retry together
    // (it used to be up to 15 s for the reopen, then a fresh full bound).
    expect(waited).toBeLessThan(2_000);
  });

  it("lists the outcome check beside the service's tools", async () => {
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS", inputSchema: { type: "object" } }] } }));
      });
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: harness });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    const reply = await nextJson(lines);
    const names = reply.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(["APPS_SEARCH_TOOLS", "CHECK_CONNECTED_APP_ACTION"]);
    const description: string = reply.result.tools[1].description;
    expect(description).toMatch(/instead of running the action again/);
    expect(description).not.toMatch(/composio|\u2014/i);
  });

  describe("tools/list never waits on a slow upstream", () => {
    const dirs: string[] = [];
    const cacheDir = () => { const dir = mkdtempSync(join(tmpdir(), "murage-tools-cache-")); dirs.push(dir); return dir; };
    afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

    const listReq = (id: number) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`;
    const realTools = (label: string) => [{ name: `REAL_${label}`, description: "d", inputSchema: { type: "object", properties: {} } }];
    /** An upstream that answers tools/list with `tools` after `delayMs` (never, when null). */
    const upstream = (tools: unknown, delayMs: number | null) => listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        if (message.method !== "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
        if (delayMs === null) return; // stalls until the test ends
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }));
        }, delayMs);
      });
    });

    it("an upstream that stalls (90 s) still yields a mounted server with the bundled tools in under 10 s, with a one-line notice, and a call says plainly that apps are still loading", async () => {
      const url = await upstream(realTools("A"), null);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: cacheDir(), MURAGE_BOT_ID: "bot-a" });
      const began = Date.now();
      child!.stdin.write(listReq(1));
      const reply = await nextJson(lines);
      expect(Date.now() - began).toBeLessThan(10_000);
      expect(Date.now() - began).toBeGreaterThan(7_000); // held for the real list first
      expect(reply.result.tools[0].description).toContain("Some connected-app tools are still loading and are checked again next turn.");
      expect(reply.result.tools[0].description).not.toMatch(/—|composio/i);
      expect(reply.id).toBe(1);
      expect(reply.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["APPS_SEARCH_TOOLS", "APPS_MULTI_EXECUTE_TOOL"]));
      // The bundled stand-in served after the deadline carries the outcome check exactly once.
      expect(reply.result.tools.filter((t: { name: string }) => t.name === "CHECK_CONNECTED_APP_ACTION")).toHaveLength(1);
      expect(JSON.stringify(reply)).not.toMatch(/composio(?!_)/i);
      // A call before the real list has come says so in plain words instead of hanging.
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } })}\n`);
      const call = await nextJson(lines);
      expect(call).toMatchObject({ id: 2, result: { isError: true } });
      expect(call.result.content[0].text).toBe("Connected apps are still loading. Try again in a moment.");
    }, 20_000);

    const ID_A = "a".repeat(32);
    const ID_B = "b".repeat(32);
    const scopeEnv = (identity: string, revision = "rev-1") => ({ MURAGE_CONNECTOR_IDENTITY: identity, MURAGE_CONNECTOR_REVISION: revision });
    /** The service tools; the bridge lists its own outcome-check tool beside them (1.0.2 tool latency). */
    const names = (reply: Record<string, any>) => {
      const all: string[] = reply.result.tools.map((t: { name: string }) => t.name);
      expect(all.filter((name) => name === "CHECK_CONNECTED_APP_ACTION")).toHaveLength(1);
      return all.filter((name) => name !== "CHECK_CONNECTED_APP_ACTION");
    };
    /** Restart a stalled upstream on the same port. */
    const restartAs = async (url: string, handler: RequestListener) => {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      const again = createServer(handler);
      again.listen(Number(new URL(url).port), "127.0.0.1");
      await once(again, "listening");
      server = again;
    };

    it("serves the remembered list at once next session, then tells the engine when the fresh list differs", async () => {
      const dir = cacheDir();
      const fast = await upstream(realTools("OLD"), 0);
      let lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: fast, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      expect((await nextJson(lines)).result.tools[0].name).toBe("REAL_OLD");
      child!.kill("SIGKILL");
      await restartAs(fast, (request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          response.writeHead(200, { "content-type": "application/json" });
          setTimeout(() => response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools("NEW") } })), 800);
        });
      });
      lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: fast, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scopeEnv(ID_A) });
      const began = Date.now();
      child!.stdin.write(listReq(2));
      const first = await nextJson(lines);
      expect(Date.now() - began).toBeLessThan(700);
      expect(first.result.tools[0].name).toBe("REAL_OLD");
      // The remembered (cached) list carries the outcome check exactly once.
      expect(first.result.tools.filter((t: { name: string }) => t.name === "CHECK_CONNECTED_APP_ACTION")).toHaveLength(1);
      const changed = await nextJson(lines);
      expect(changed).toMatchObject({ method: "notifications/tools/list_changed" });
    }, 30_000);

    it("files the list under the harness identity, not the rotating turn token", async () => {
      const dir = cacheDir();
      const a = await upstream(realTools("ACCOUNT_A"), 0);
      let lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: a, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTORS_TOKEN: "turn-token-1", MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer turn-token-1" }), ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      expect(names(await nextJson(lines))).toEqual(["REAL_ACCOUNT_A"]);
      child!.kill("SIGKILL");
      // A new turn: a new token, the same account and bot. The upstream stalls; the remembered list answers.
      await restartAs(a, () => {});
      lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: a, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTORS_TOKEN: "turn-token-2", MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer turn-token-2" }), ...scopeEnv(ID_A) });
      const began = Date.now();
      child!.stdin.write(listReq(2));
      expect(names(await nextJson(lines))).toEqual(["REAL_ACCOUNT_A"]);
      expect(Date.now() - began).toBeLessThan(500);
    }, 30_000);

    it("never serves one account's, one bot's or an older access revision's list to another", async () => {
      const dir = cacheDir();
      const a = await upstream(realTools("ACCOUNT_A"), 0);
      const first = start({ MURAGE_CONNECTOR_UPSTREAM_URL: a, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scopeEnv(ID_A, "rev-1") });
      child!.stdin.write(listReq(1));
      await nextJson(first);
      child!.kill("SIGKILL");
      await restartAs(a, () => {});
      for (const scope of [scopeEnv(ID_B, "rev-1"), scopeEnv(ID_A, "rev-2")]) {
        const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: a, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scope });
        child!.stdin.write(listReq(2));
        const other = await nextJson(lines);
        expect(names(other)).toContain("APPS_SEARCH_TOOLS");
        expect(names(other)).not.toContain("REAL_ACCOUNT_A");
        child!.kill("SIGKILL");
      }
    }, 30_000);

    /** An upstream that holds every tools/list reply until the test releases it, so a fetch is
     * provably still in flight while the test changes something, however slow the machine is. */
    const gatedUpstream = async (tools: unknown) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const closed: Promise<unknown>[] = [];
      const waiters: { count: number; resolve: () => void }[] = [];
      let lists = 0;
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          if (message.method !== "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
          closed.push(once(response, "close"));
          lists += 1;
          for (const waiter of waiters.splice(0)) { if (lists >= waiter.count) waiter.resolve(); else waiters.push(waiter); }
          void gate.then(() => {
            if (response.destroyed) return; // the bridge gave up on this one (its deadline passed)
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }));
          });
        });
      });
      return {
        url,
        /** Resolves once the upstream holds `count` tools/list requests. */
        holding: (count: number) => new Promise<void>((resolve) => { if (lists >= count) resolve(); else waiters.push({ count, resolve }); }),
        /** Lets every held reply go and resolves once each has been delivered (or dropped by the bridge). */
        releaseAll: async () => { release(); await Promise.all(closed); },
      };
    };

    it("does not publish a list fetched under an access revision that changed while it was in flight", async () => {
      const dir = cacheDir();
      const credDir = cacheDir();
      const credFile = join(credDir, "creds.json");
      const writeCreds = (revision: string) => writeFileSync(credFile, JSON.stringify({ composio: { MURAGE_CONNECTOR_IDENTITY: ID_A, MURAGE_CONNECTOR_REVISION: revision } }));
      writeCreds("rev-1");
      const held = await gatedUpstream(realTools("STALE"));
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: held.url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_CRED_FILE: credFile, MURAGE_CRED_SERVER: "composio" });
      child!.stdin.write(listReq(1));
      expect(names(await nextJson(lines))).toContain("APPS_SEARCH_TOOLS"); // the initial list
      // The bridge reads the scope for its background refresh just AFTER it sends the initial list, so the
      // reply alone does not prove the refresh began under rev-1 (on a slow box the change could land first,
      // making it a legitimate rev-2 fetch: CI 40193051242). Once the upstream holds the refresh request
      // (beside the held first-list fetch), its scope is fixed at rev-1.
      await held.holding(2);
      writeCreds("rev-2"); // the owner changed this bot's access while they were in flight
      let notified = false;
      lines.on("line", (line) => { if (JSON.parse(line).method === "notifications/tools/list_changed") notified = true; });
      await held.releaseAll(); // the rev-1 lists now reach the bridge
      await new Promise((resolve) => setTimeout(resolve, 1_000)); // time for a (wrong) publish to land
      expect(readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith("incomplete-"))).toEqual([]);
      expect(notified).toBe(false);
    }, 30_000);

    it("keeps the remembered list in the supplied private folder only: nothing in shared temp, and a symlinked folder is refused", async () => {
      const temp = cacheDir();
      const fast = await upstream(realTools("ACCOUNT_A"), 0);
      // No folder supplied: nothing is written anywhere, shared temp included.
      let lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: fast, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: "", TMPDIR: temp, TMP: temp, TEMP: temp, ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      expect(names(await nextJson(lines))).toEqual(["REAL_ACCOUNT_A"]);
      child!.kill("SIGKILL");
      expect(readdirSync(temp)).toEqual([]);
      if (process.platform !== "win32") {
        // A planted symlink as the folder: not followed, nothing written through it.
        const target = cacheDir();
        const link = join(cacheDir(), "link");
        symlinkSync(target, link);
        lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: fast, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: link, ...scopeEnv(ID_A) });
        child!.stdin.write(listReq(2));
        expect(names(await nextJson(lines))).toEqual(["REAL_ACCOUNT_A"]);
        child!.kill("SIGKILL");
        expect(readdirSync(target)).toEqual([]);
        // A planted symlink as the entry itself: never read.
        const dir = cacheDir();
        const secret = join(cacheDir(), "planted.json");
        writeFileSync(secret, JSON.stringify({ revision: "rev-1", tools: [{ name: "PLANTED", description: "d", inputSchema: { type: "object" } }] }));
        symlinkSync(secret, join(dir, `${ID_A}.json`));
        await restartAs(fast, () => {});
        lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: fast, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scopeEnv(ID_A) });
        child!.stdin.write(listReq(3));
        expect(names(await nextJson(lines))).not.toContain("PLANTED");
        child!.kill("SIGKILL");
        // A group- or world-accessible folder is tightened to owner-only before use.
        const loose = cacheDir();
        chmodSync(loose, 0o777);
        lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: fast, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: loose, ...scopeEnv(ID_B) });
        child!.stdin.write(listReq(4));
        await nextJson(lines);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(statSync(loose).mode & 0o077).toBe(0);
      }
    }, 30_000);

    it("prunes obsolete entries: leftovers and files beyond the cap are removed", async () => {
      const dir = cacheDir();
      const old = new Date(Date.now() - 40 * 24 * 3600_000);
      const stale = join(dir, `${"c".repeat(32)}.json`);
      writeFileSync(stale, "{}");
      utimesSync(stale, old, old);
      const fast = await upstream(realTools("ACCOUNT_A"), 0);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: fast, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      await nextJson(lines);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(readdirSync(dir)).toEqual([`${ID_A}.json`]);
    }, 30_000);

    it("a stale-session 404 during a list still ends the whole operation inside the bound, recovery included", async () => {
      let initializes = 0;
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          if (message.method === "initialize") {
            initializes += 1;
            const reply = () => { response.writeHead(200, { "content-type": "application/json", "mcp-session-id": `s${initializes}` }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })); };
            if (initializes === 1) return reply();
            return void setTimeout(reply, 1_200); // recovery is slow
          }
          if (message.method === "notifications/initialized") return void setTimeout(() => { response.writeHead(202); response.end(); }, 1_200);
          if (request.headers["mcp-session-id"] === "s1") { response.writeHead(404); return response.end("gone"); }
          // the retried list never answers
        });
      });
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1500" });
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
      await nextJson(lines);
      await new Promise((resolve) => setTimeout(resolve, 300)); // the background session is open
      const began = Date.now();
      child!.stdin.write(listReq(2));
      const reply = await nextJson(lines);
      expect(Date.now() - began).toBeLessThan(2_000);
      expect(names(reply)).toContain("APPS_SEARCH_TOOLS");
    }, 30_000);

    it("a restricted bot is first shown only the list the harness supplied, never the unrestricted tools", async () => {
      const approved = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "approved only", inputSchema: { type: "object", properties: { account: { enum: ["ca_fixture_owned"] } } } }];
      const url = await upstream(realTools("UNAPPROVED"), null);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_INITIAL_GENERATION: "initial", MURAGE_CONNECTOR_INITIAL_TOOLS: JSON.stringify(approved), MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000" });
      const began = Date.now();
      child!.stdin.write(listReq(1));
      const reply = await nextJson(lines);
      expect(Date.now() - began).toBeLessThan(3_500);
      expect(names(reply)).toEqual(["APPS_MULTI_EXECUTE_TOOL"]);
      expect(JSON.stringify(reply)).not.toContain("APPS_SEARCH_TOOLS");
      expect(reply.result._meta).toMatchObject({ "murage/provisional": true });
      // A bot with nothing approved is shown nothing (never the unrestricted tools).
      child!.kill("SIGKILL");
      const empty = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_INITIAL_GENERATION: "initial", MURAGE_CONNECTOR_INITIAL_TOOLS: "[]", MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000" });
      child!.stdin.write(listReq(2));
      expect(names(await nextJson(empty))).toEqual([]);
    }, 30_000);

    it("a restricted bot's approved list longer than the environment allows arrives whole through a private file (never an empty mount)", async () => {
      const dir = cacheDir();
      const revision = "rev-big";
      const approved = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "approved only ".repeat(3_000), inputSchema: { type: "object", properties: { account: { enum: ["ca_fixture_owned"] } } } }];
      expect(JSON.stringify(approved).length).toBeGreaterThan(24_000);
      writeFileSync(join(dir, `initial-${ID_A}-${revision}.json`), JSON.stringify({ revision, tools: approved }), { mode: 0o600 });
      const url = await upstream(realTools("UNAPPROVED"), null);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_INITIAL_GENERATION: "initial", MURAGE_CONNECTOR_INITIAL_TOOLS: "@file", ...scopeEnv(ID_A, revision) });
      child!.stdin.write(listReq(1));
      const reply = await nextJson(lines);
      expect(names(reply)).toEqual(["APPS_MULTI_EXECUTE_TOOL"]);
      expect(reply.result.tools[0].description).toBe(approved[0]!.description);
      expect(JSON.stringify(reply)).not.toContain("APPS_SEARCH_TOOLS");
      child!.kill("SIGKILL");
      // A file written for another access revision is never read, and an empty list is never handed over:
      // the mount fails recoverably (a fresh process next turn), with no unrestricted tools.
      const other = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_INITIAL_TOOLS: "@file", MURAGE_CONNECTOR_TOOLS_LIST_MS: "800", ...scopeEnv(ID_A, "rev-other") });
      child!.stdin.write(listReq(2));
      const stale = await nextJson(other);
      expect(stale.result).toBeUndefined();
      expect(stale.error.message).toContain("next turn");
      expect(JSON.stringify(stale)).not.toContain("APPS_SEARCH_TOOLS");
    }, 30_000);

    it("discards a foreground reply fetched under a scope that changed while it was in flight and shows the current scope's list", async () => {
      const dir = cacheDir();
      const credFile = join(cacheDir(), "creds.json");
      const writeCreds = (revision: string) => writeFileSync(credFile, JSON.stringify({ composio: { MURAGE_CONNECTOR_IDENTITY: ID_A, MURAGE_CONNECTOR_REVISION: revision } }));
      writeCreds("rev-1");
      const slow = await upstream(realTools("PREVIOUS_SCOPE"), 900);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: slow, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "4000", MURAGE_CRED_FILE: credFile, MURAGE_CRED_SERVER: "composio" });
      child!.stdin.write(listReq(1));
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeCreds("rev-2"); // the owner changed the bot's access during the request
      const reply = await nextJson(lines);
      expect(JSON.stringify(reply)).not.toContain("REAL_PREVIOUS_SCOPE");
      expect(names(reply)).toContain("APPS_SEARCH_TOOLS");
      expect(reply.result._meta).toMatchObject({ "murage/provisional": true });
      expect(readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith("initial-") && !name.startsWith("incomplete-"))).toEqual([]);
    }, 30_000);

    it("never reads an expired entry, deletes it, and sweeps expired entries at start without any list request", async () => {
      const dir = cacheDir();
      const old = new Date(Date.now() - 8 * 24 * 3600_000);
      const entry = join(dir, `${ID_A}.json`);
      writeFileSync(entry, JSON.stringify({ revision: "rev-1", tools: realTools("EXPIRED") }));
      utimesSync(entry, old, old);
      const other = join(dir, `${ID_B}.json`);
      writeFileSync(other, JSON.stringify({ revision: "rev-1", tools: realTools("ALSO_EXPIRED") }));
      utimesSync(other, old, old);
      const url = await upstream(realTools("A"), null);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scopeEnv(ID_A) });
      await new Promise((resolve) => setTimeout(resolve, 600)); // the start-up sweep, before any request
      expect(readdirSync(dir).filter((name) => !name.startsWith("incomplete-"))).toEqual([]);
      // A file that turns up expired between sweeps (same running bridge) is rejected on read, not served.
      writeFileSync(entry, JSON.stringify({ revision: "rev-1", tools: realTools("EXPIRED") }));
      utimesSync(entry, old, old);
      child!.stdin.write(listReq(1));
      expect(names(await nextJson(lines))).not.toContain("REAL_EXPIRED");
      expect(readdirSync(dir).filter((name) => !name.startsWith("incomplete-"))).toEqual([]);
    }, 30_000);
    it("holds the first list for the real one: a 3 s upstream yields the real tools, with no notice", async () => {
      const url = await upstream(realTools("SLOWISH"), 3_000);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_BOT_ID: "bot-a" });
      child!.stdin.write(listReq(1));
      const reply = await nextJson(lines);
      expect(names(reply)).toEqual(["REAL_SLOWISH"]);
      expect(reply.result._meta).toBeUndefined();
      expect(JSON.stringify(reply)).not.toContain("checked again next turn");
    }, 20_000);

    it("a harness that answers its own bundled stand-in first (provisional) is asked again within the hold, and the real list is what the engine gets", async () => {
      let asked = 0;
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          response.writeHead(200, { "content-type": "application/json" });
          if (message.method !== "tools/list") { response.end("{}"); return; }
          asked += 1;
          const bundled = asked === 1;
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: bundled ? [{ name: "BUNDLED", inputSchema: { type: "object" } }] : realTools("REAL").concat([]), ...(bundled ? { _meta: { "murage/provisional": true, "murage/provisional-bundled": true } } : {}) } }));
        });
      });
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_BOT_ID: "bot-a" });
      child!.stdin.write(listReq(1));
      const reply = await nextJson(lines);
      expect(names(reply)).toEqual(["REAL_REAL"]);
      expect(asked).toBeGreaterThanOrEqual(2);
    }, 20_000);

    it("after a degraded mount the model is told once in the turn's own result, and the engine gets list_changed when the real list lands", async () => {
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          const reply = () => { response.writeHead(200, { "content-type": "application/json" }); response.end(message.method === "tools/list" ? JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools("LATE") } }) : JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } })); };
          if (message.method === "tools/list" && String(message.id).startsWith("murage-tools-bg") === false && message.id === 1) setTimeout(reply, 2_500); else reply();
        });
      });
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_LIST_MS: "600", MURAGE_BOT_ID: "bot-a" });
      const seen: Record<string, any>[] = [];
      lines.on("line", (line) => { try { seen.push(JSON.parse(line)); } catch { /* ignore */ } });
      child!.stdin.write(listReq(1));
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(seen[0]!.result.tools[0].description).toContain("Some connected-app tools are still loading and are checked again next turn.");
      expect(seen.some((m) => m.method === "notifications/tools/list_changed")).toBe(true);
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "REAL_LATE", arguments: {} } })}\n`);
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "REAL_LATE", arguments: {} } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const first = seen.find((m) => m.id === 2)!;
      const second = seen.find((m) => m.id === 3)!;
      expect(first.result.content.map((c: { text: string }) => c.text)).toEqual(["ok", "Some connected-app tools are still loading and are checked again next turn."]);
      expect(second.result.content.map((c: { text: string }) => c.text)).toEqual(["ok"]);
    }, 30_000);

    it("a handoff that failed ('@harness') gets the authoritative list from the harness, or fails the mount recoverably; never an empty list", async () => {
      const live = await upstream(realTools("AUTH"), 200);
      const ok = start({ MURAGE_CONNECTOR_UPSTREAM_URL: live, MURAGE_CONNECTOR_INITIAL_TOOLS: "@harness" });
      child!.stdin.write(listReq(1));
      expect(names(await nextJson(ok))).toEqual(["REAL_AUTH"]);
      child!.kill("SIGKILL");
      const dead = await upstream(realTools("AUTH"), null);
      const bad = start({ MURAGE_CONNECTOR_UPSTREAM_URL: dead, MURAGE_CONNECTOR_INITIAL_TOOLS: "@harness", MURAGE_CONNECTOR_TOOLS_LIST_MS: "700" });
      child!.stdin.write(listReq(2));
      const failed = await nextJson(bad);
      expect(failed.result).toBeUndefined();
      expect(failed.error.message).toContain("next turn");
    }, 30_000);

    it("the whole list operation spends ONE absolute deadline: a failed handoff ('@harness') on a stalled upstream fails the mount at the deadline, not at twice it", async () => {
      const dead = await upstream(realTools("AUTH"), null);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: dead, MURAGE_CONNECTOR_INITIAL_TOOLS: "@harness", MURAGE_CONNECTOR_TOOLS_LIST_MS: "700" });
      await new Promise((resolve) => setTimeout(resolve, 500)); // the bridge is up
      const asked = Date.now();
      child!.stdin.write(listReq(1));
      const failed = await nextJson(lines);
      expect(failed.error.message).toContain("next turn");
      expect(Date.now() - asked).toBeLessThan(1_100);
    }, 20_000);

    it("a retried or concurrent list awaits the discovery already in flight: one upstream request answers both, each under its own id", async () => {
      let asked = 0;
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          if (message.method !== "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
          asked += 1;
          setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools("ONCE") } })); }, 1_500);
        });
      });
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_BOT_ID: "bot-a" });
      const seen: Record<string, any>[] = [];
      lines.on("line", (line) => { try { seen.push(JSON.parse(line)); } catch { /* ignore */ } });
      child!.stdin.write(listReq(1));
      await new Promise((resolve) => setTimeout(resolve, 300));
      child!.stdin.write(listReq(2));
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(asked).toBe(1);
      for (const id of [1, 2]) expect(names(seen.find((m) => m.id === id)!)).toEqual(["REAL_ONCE"]);
    }, 20_000);

    it("a provisional list is filed for the driver (a fresh mount next turn) and the filing goes when the engine is given the real one", async () => {
      const dir = cacheDir();
      const slow = await upstream(realTools("LATER"), 1_500);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: slow, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "400", MURAGE_THREAD_ID: "thr-1", ...scopeEnv(ID_A) });
      const seen: Record<string, any>[] = [];
      lines.on("line", (line) => { try { seen.push(JSON.parse(line)); } catch { /* ignore */ } });
      child!.stdin.write(listReq(1));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(seen[0]!.result._meta).toEqual({ "murage/provisional": true });
      const filed = () => readdirSync(dir).filter((name) => name.startsWith(`incomplete-${ID_A}-`));
      expect(filed()).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 2_500)); // the real list lands; the engine is told to list again
      expect(seen.some((m) => m.method === "notifications/tools/list_changed")).toBe(true);
      child!.stdin.write(listReq(2));
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(names(seen.find((m) => m.id === 2)!)).toEqual(["REAL_LATER"]);
      expect(filed()).toHaveLength(0);
    }, 30_000);

    it("a disconnect while a list is in flight: the late reply is discarded, nothing is recreated after the purge, and an older entry is never served", async () => {
      const dir = cacheDir();
      bumpGeneration(dir);
      const slow = await upstream(realTools("BEFORE_DISCONNECT"), 1_200);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: slow, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      await new Promise((resolve) => setTimeout(resolve, 300));
      bumpGeneration(dir); // the harness announces the disconnect, then purges
      for (const name of readdirSync(dir)) if (name.endsWith(".json")) rmSync(join(dir, name));
      const reply = await nextJson(lines);
      expect(JSON.stringify(reply)).not.toContain("REAL_BEFORE_DISCONNECT");
      await new Promise((resolve) => setTimeout(resolve, 2_500)); // the background refresh runs under the NEW generation
      expect(readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith("initial-") && !name.startsWith("incomplete-")).length).toBeLessThanOrEqual(1);
      // An entry stored under the old generation is not served after the bump.
      child!.kill("SIGKILL");
      const entry = join(dir, `${ID_B}.json`);
      writeFileSync(entry, JSON.stringify({ revision: "rev-1", generation: "old-generation", tools: realTools("OLD_GEN") }));
      const stalled = await upstream(realTools("X"), null);
      const again = start({ MURAGE_CONNECTOR_UPSTREAM_URL: stalled, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "500", ...scopeEnv(ID_B) });
      child!.stdin.write(listReq(2));
      expect(JSON.stringify(await nextJson(again))).not.toContain("REAL_OLD_GEN");
    }, 40_000);

    it("a restricted bot's inline approved list is bound to its connection generation: a disconnect during discovery means the stale accounts are never sent", async () => {
      const dir = cacheDir();
      bumpGeneration(dir);
      const stale = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "STALE_APPROVED_ACCOUNT", inputSchema: { type: "object", properties: {} } }];
      const stalled = await upstream(realTools("AUTH"), null);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: stalled, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_INITIAL_TOOLS: JSON.stringify(stale), MURAGE_CONNECTOR_INITIAL_GENERATION: "initial", MURAGE_CONNECTOR_TOOLS_LIST_MS: "1200", ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      await new Promise((resolve) => setTimeout(resolve, 300));
      bumpGeneration(dir); // the disconnect is announced while the list is being discovered
      const reply = await nextJson(lines);
      expect(JSON.stringify(reply)).not.toContain("STALE_APPROVED_ACCOUNT");
      expect(reply.result).toBeUndefined();
      expect(reply.error.message).toContain("next turn"); // recoverable: a fresh bridge, a fresh handoff
    }, 30_000);

    it("a handoff built under an older generation than the current one (harness-named) is not reused either, and the authoritative list is fetched instead", async () => {
      const dir = cacheDir();
      const built = bumpGeneration(dir);
      bumpGeneration(dir); // disconnected after the harness built the handoff
      const stale = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "STALE_APPROVED_ACCOUNT", inputSchema: { type: "object", properties: {} } }];
      // The first discovery stalls past the hold; the stand-in must not be the handoff.
      let asked = 0;
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          response.writeHead(200, { "content-type": "application/json" });
          if (message.method !== "tools/list") { response.end("{}"); return; }
          asked += 1;
          if (asked === 1) return; // never answers
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools("FRESH_AUTH") } }));
        });
      });
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_INITIAL_TOOLS: JSON.stringify(stale), MURAGE_CONNECTOR_INITIAL_GENERATION: built, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1500", ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      const reply = await nextJson(lines);
      expect(JSON.stringify(reply)).not.toContain("STALE_APPROVED_ACCOUNT");
    }, 30_000);

    it("an inline handoff that names no generation is not usable, and one built before any generation existed is dead after a later disconnect", async () => {
      const stale = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "STALE_APPROVED_ACCOUNT", inputSchema: { type: "object", properties: {} } }];
      // 1. No generation named: never used (the harness is asked instead).
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(message.method === "tools/list" ? JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools("FRESH_AUTH") } }) : "{}");
        });
      });
      const missing = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_INITIAL_TOOLS: JSON.stringify(stale), MURAGE_CONNECTOR_TOOLS_LIST_MS: "1500", ...scopeEnv(ID_A) });
      child!.stdin.write(listReq(1));
      expect(JSON.stringify(await nextJson(missing))).not.toContain("STALE_APPROVED_ACCOUNT");
      child!.kill("SIGKILL");
      // 2. Built under the explicit initial generation (no generation file yet); the first disconnect lands
      //    after the handoff was made but before discovery: discovery stalls, the stale accounts are not sent.
      const dir = cacheDir();
      const stalled = await upstream(realTools("AUTH"), null);
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: stalled, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_INITIAL_TOOLS: JSON.stringify(stale), MURAGE_CONNECTOR_INITIAL_GENERATION: "initial", MURAGE_CONNECTOR_TOOLS_LIST_MS: "1200", ...scopeEnv(ID_A) });
      bumpGeneration(dir); // the first disconnect ever, before discovery starts
      child!.stdin.write(listReq(2));
      expect(JSON.stringify(await nextJson(lines))).not.toContain("STALE_APPROVED_ACCOUNT");
    }, 30_000);

    describe("the stand-in probe stops when it should", () => {
      const probeUpstream = async (hits: { n: number }, hang = false) => listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          if (message.method !== "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
          hits.n += 1;
          if (hang && hits.n > 1) return; // later probes never answer: they stay in flight
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools("OLD"), _meta: { "murage/provisional": true } } }));
        });
      });
      const creds = (token: string) => { const f = join(cacheDir(), "creds.json"); writeFileSync(f, JSON.stringify({ composio: { MURAGE_CONNECTORS_TOKEN: token, MURAGE_CONNECTOR_IDENTITY: ID_A, MURAGE_CONNECTOR_REVISION: "rev-1" } })); return f; };

      it("makes no further probe request once the turn ends (credentials cleared)", async () => {
        const hits = { n: 0 };
        const url = await probeUpstream(hits);
        const credFile = creds("turn-token");
        const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_CRED_FILE: credFile, MURAGE_CRED_SERVER: "composio" });
        void lines;
        child!.stdin.write(listReq(1));
        await new Promise((resolve) => setTimeout(resolve, 3_500)); // probing while the turn is active
        expect(hits.n).toBeGreaterThan(1);
        writeFileSync(credFile, JSON.stringify({})); // turn end: the driver empties the file
        await new Promise((resolve) => setTimeout(resolve, 1_200)); // the watcher notices
        const settled = hits.n;
        await new Promise((resolve) => setTimeout(resolve, 7_000)); // longer than the backoff
        expect(hits.n).toBe(settled);
      }, 40_000);

      it("cancels the probe, in flight included, when the connection generation changes", async () => {
        const hits = { n: 0 };
        const url = await probeUpstream(hits, true);
        const dir = cacheDir();
        const credFile = creds("turn-token");
        const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_CRED_FILE: credFile, MURAGE_CRED_SERVER: "composio" });
        void lines;
        child!.stdin.write(listReq(1));
        await new Promise((resolve) => setTimeout(resolve, 3_500)); // a probe request is in flight and unanswered
        expect(hits.n).toBeGreaterThan(1);
        bumpGeneration(dir); // disconnect
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        const settled = hits.n;
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        expect(hits.n).toBe(settled);
      }, 40_000);

      it("restarts bounded recovery when a new active turn begins with the stand-in still held", async () => {
        const hits = { n: 0 };
        const url = await probeUpstream(hits);
        const credFile = creds("turn-token");
        const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_CRED_FILE: credFile, MURAGE_CRED_SERVER: "composio" });
        void lines;
        child!.stdin.write(listReq(1));
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        writeFileSync(credFile, JSON.stringify({}));
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        const idle = hits.n;
        writeFileSync(credFile, JSON.stringify({ composio: { MURAGE_CONNECTORS_TOKEN: "turn-token-2", MURAGE_CONNECTOR_IDENTITY: ID_A, MURAGE_CONNECTOR_REVISION: "rev-1" } }));
        child!.stdin.write(listReq(2)); // the next turn's first request
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(hits.n).toBeGreaterThan(idle);
      }, 40_000);
    });

    describe("recovery follows the harness's turn start and cancellation", () => {
      const credsFor = (token: string) => JSON.stringify(token ? { composio: { MURAGE_CONNECTORS_TOKEN: token, MURAGE_CONNECTOR_IDENTITY: ID_A, MURAGE_CONNECTOR_REVISION: "rev-1" } } : {});
      it("restarts at turn start with no MCP request at all (a warm engine does not list again): probe runs, marker ready", async () => {
        const dir = cacheDir();
        let healthy = false;
        const hits = { n: 0 };
        const url = await listen((request, response) => {
          let body = "";
          request.on("data", (chunk) => { body += chunk; });
          request.on("end", () => {
            const message = JSON.parse(body);
            response.writeHead(200, { "content-type": "application/json" });
            if (message.method !== "tools/list") { response.end("{}"); return; }
            hits.n += 1;
            response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools(healthy ? "RECOVERED" : "OLD"), ...(healthy ? {} : { _meta: { "murage/provisional": true } }) } }));
          });
        });
        const credDir = mkdtempSync(join(tmpdir(), "murage-cred-dir-"));
        dirs.push(credDir);
        const file = join(credDir, "creds.json");
        writeFileSync(file, credsFor("turn-1"));
        const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_THREAD_ID: "thr-1", MURAGE_CRED_FILE: file, MURAGE_CRED_SERVER: "composio" });
        void lines;
        child!.stdin.write(listReq(1));
        await new Promise((resolve) => setTimeout(resolve, 2_500)); // probing, service still failing
        writeFileSync(file, credsFor("")); // turn end
        await new Promise((resolve) => setTimeout(resolve, 1_500)); // probe stops
        const idle = hits.n;
        healthy = true; // the service recovers between turns
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        expect(hits.n).toBe(idle); // still no polling
        const marker = () => { const f = readdirSync(dir).find((name) => name.startsWith(`incomplete-${ID_A}-`)); return f ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null; };
        expect(marker()).toMatchObject({ ready: false });
        writeFileSync(file, credsFor("turn-2")); // the next turn starts: the driver rewrites the file; the engine sends nothing
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(hits.n).toBeGreaterThan(idle);
        expect(marker()).toMatchObject({ ready: true });
      }, 40_000);

      for (const mode of ["throw", "error"] as const) {
        it(`falls back to a stat poll when the credential watcher ${mode === "throw" ? "cannot be created" : "emits an error"}: a rewrite still restarts recovery with no MCP traffic`, async () => {
          const dir = cacheDir();
          let healthy = false;
          const hits = { n: 0 };
          const url = await listen((request, response) => {
            let body = "";
            request.on("data", (chunk) => { body += chunk; });
            request.on("end", () => {
              const message = JSON.parse(body);
              response.writeHead(200, { "content-type": "application/json" });
              if (message.method !== "tools/list") { response.end("{}"); return; }
              hits.n += 1;
              response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools(healthy ? "RECOVERED" : "OLD"), ...(healthy ? {} : { _meta: { "murage/provisional": true } }) } }));
            });
          });
          const credDir = mkdtempSync(join(tmpdir(), "murage-cred-dir-"));
          dirs.push(credDir);
          const file = join(credDir, "creds.json");
          writeFileSync(file, credsFor("turn-1"));
          // Preload that makes fs.watch fail the way a resource limit or an unsupported filesystem does.
          const preload = join(credDir, "break-watch.mjs");
          writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = fs.watch;
fs.watch = (...args) => {
  if (process.env.MURAGE_TEST_WATCH_FAIL === "throw") throw new Error("EMFILE");
  const w = real(...args);
  setTimeout(() => w.emit("error", new Error("EMFILE")), 200);
  return w;
};
syncBuiltinESMExports();
`);
          const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_THREAD_ID: "thr-1", MURAGE_CRED_FILE: file, MURAGE_CRED_SERVER: "composio", MURAGE_TEST_WATCH_FAIL: mode, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
          void lines;
          let stderr = "";
          child!.stderr.on("data", (chunk) => { stderr += String(chunk); });
          child!.stdin.write(listReq(1));
          await new Promise((resolve) => setTimeout(resolve, 2_500)); // probing, service still failing
          writeFileSync(file, credsFor("")); // turn end
          await new Promise((resolve) => setTimeout(resolve, 1_500)); // probe stops
          const idle = hits.n;
          healthy = true;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          expect(hits.n, stderr).toBe(idle); // still no polling between turns
          const marker = () => { const f = readdirSync(dir).find((name) => name.startsWith(`incomplete-${ID_A}-`)); return f ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null; };
          expect(marker(), stderr).toMatchObject({ ready: false });
          writeFileSync(file, credsFor("turn-2")); // next turn: the driver rewrites the file; the engine sends nothing
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          expect(hits.n).toBeGreaterThan(idle);
          expect(marker()).toMatchObject({ ready: true });
        }, 40_000);
      }

      it("credentials clearing while session recovery is initializing cancels the handshake request promptly", async () => {
        const dir = cacheDir();
        const credDir = mkdtempSync(join(tmpdir(), "murage-cred-dir-"));
        dirs.push(credDir);
        const file = join(credDir, "creds.json");
        writeFileSync(file, credsFor("turn-1"));
        let initializes = 0;
        let hungClosedAt = 0;
        const url = await listen((request, response) => {
          let body = "";
          request.on("data", (chunk) => { body += chunk; });
          request.on("end", () => {
            const message = JSON.parse(body);
            if (message.method === "initialize") {
              initializes += 1;
              if (initializes > 1) { response.on("close", () => { hungClosedAt = Date.now(); }); return; } // the reopen never answers
              response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
              response.end("{}");
              return;
            }
            if (message.method !== "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
            if (String(message.id).startsWith("murage-tools-refresh")) { response.writeHead(404); response.end("gone"); return; }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools("OLD"), _meta: { "murage/provisional": true } } }));
          });
        });
        const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_THREAD_ID: "thr-1", MURAGE_CRED_FILE: file, MURAGE_CRED_SERVER: "composio" });
        void lines;
        child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
        child!.stdin.write(listReq(1));
        for (let waited = 0; initializes < 2 && waited < 8_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
        expect(initializes).toBeGreaterThan(1); // the probe got a 404 and is reopening
        const clearedAt = Date.now();
        writeFileSync(file, credsFor("")); // credentials clear during initialization
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(hungClosedAt).toBeGreaterThan(0);
        expect(hungClosedAt - clearedAt).toBeLessThan(2_000); // not the 10 s reopen deadline
      }, 40_000);
    });

    it("a stand-in marker stays unready while discovery keeps failing (so the driver never recycles), and becomes ready once the probe gets a real list", async () => {
      const dir = cacheDir();
      let healthy = false;
      const url = await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const message = JSON.parse(body);
          if (message.method !== "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
          response.writeHead(200, { "content-type": "application/json" });
          // The harness keeps answering provisionally while its own source fails; then it recovers.
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: realTools(healthy ? "RECOVERED" : "OLD"), ...(healthy ? {} : { _meta: { "murage/provisional": true } }) } }));
        });
      });
      const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTORS_TOKEN: "turn-token", MURAGE_CONNECTOR_TOOLS_LIST_MS: "1000", MURAGE_THREAD_ID: "thr-1", ...scopeEnv(ID_A) });
      void lines;
      child!.stdin.write(listReq(1));
      const marker = () => {
        const file = readdirSync(dir).find((name) => name.startsWith(`incomplete-${ID_A}-`));
        return file ? JSON.parse(readFileSync(join(dir, file), "utf8")) : null;
      };
      await new Promise((resolve) => setTimeout(resolve, 3_000)); // the probe has failed at least once
      expect(marker()).toMatchObject({ revision: "rev-1", ready: false });
      healthy = true;
      await new Promise((resolve) => setTimeout(resolve, 8_000)); // the next probe (backoff) gets the real list
      expect(marker()).toMatchObject({ revision: "rev-1", ready: true });
    }, 40_000);
  });
});

describe("the first tools/list is never an error or an empty list", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
  const ID = "c".repeat(32);
  const listReq = (id: number) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`;
  const SEVEN = ["SEARCH_TOOLS", "GET_TOOL_SCHEMAS", "MULTI_EXECUTE_TOOL", "MANAGE_CONNECTIONS", "REMOTE_WORKBENCH", "REMOTE_BASH_TOOL", "WAIT_FOR_CONNECTIONS"].map((name) => ({ name: `COMPOSIO_${name}`, description: "d", inputSchema: { type: "object", properties: {} } }));
  type Mode = "http500" | "rpc-error" | "unreadable" | "result-empty" | "tools-not-a-list" | "result-null" | "tool-without-schema" | "tool-without-name";
  /** First answers that are not a catalogue: each must be treated like an error reply. */
  const MALFORMED: Partial<Record<Mode, unknown>> = {
    "result-empty": {},
    "tools-not-a-list": { tools: "invalid" },
    "result-null": null,
    "tool-without-schema": { tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] },
    "tool-without-name": { tools: [{ description: "d", inputSchema: { type: "object" } }] },
  };
  /** The first tools/list fails in `mode`; later ones (after `realAfterMs`) return the real seven tools. */
  const upstream = (mode: Mode, realAfterMs = 0) => {
    let listed = 0;
    return listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        if (message.method !== "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ran" }] } })); return; }
        listed += 1;
        if (listed === 1) {
          if (mode === "http500") { response.writeHead(500, { "content-type": "text/plain" }); response.end("boom"); return; }
          response.writeHead(200, { "content-type": "application/json" });
          if (mode in MALFORMED) { response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: MALFORMED[mode] })); return; }
          response.end(mode === "rpc-error" ? JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "broker unavailable" } }) : "");
          return;
        }
        setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: SEVEN } })); }, realAfterMs);
      });
    });
  };
  const markerOf = (dir: string) => { const f = readdirSync(dir).find((name) => name.startsWith(`incomplete-${ID}-`)); return f ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null; };
  const toolNames = (reply: Record<string, any>): string[] => reply.result.tools.map((t: { name: string }) => t.name);

  it.each<Mode>(["http500", "rpc-error", "unreadable", "result-empty", "tools-not-a-list", "result-null", "tool-without-schema", "tool-without-name"])("%s: the engine gets the fallback list, the mount is incomplete, then list_changed and the real list", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "murage-first-list-")); dirs.push(dir);
    const url = await upstream(mode, 700);
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_BOT_ID: "bot-a", MURAGE_CONNECTOR_IDENTITY: ID, MURAGE_CONNECTOR_REVISION: "rev-1" });
    let stderr = "";
    child!.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const seen: Record<string, any>[] = [];
    lines.on("line", (line) => { try { seen.push(JSON.parse(line)); } catch { /* ignore */ } });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    child!.stdin.write(listReq(1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const first = seen.find((m) => m.id === 1)!;
    expect(seen.find((m) => m.id === 0)!.result.capabilities.tools.listChanged).toBe(true);
    expect(first.error).toBeUndefined();
    expect(toolNames(first)).toEqual(expect.arrayContaining(["APPS_REMOTE_WORKBENCH", "APPS_REMOTE_BASH_TOOL", "APPS_WAIT_FOR_CONNECTIONS", "APPS_MULTI_EXECUTE_TOOL"]));
    expect(first.result._meta["murage/provisional"]).toBe(true);
    expect(markerOf(dir)).toMatchObject({ revision: "rev-1" }); // the mount is marked incomplete
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(seen.some((m) => m.method === "notifications/tools/list_changed")).toBe(true);
    child!.stdin.write(listReq(2));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const second = seen.find((m) => m.id === 2)!;
    expect(toolNames(second)).toEqual(expect.arrayContaining(SEVEN.map((t) => exposedToolName(t.name))));
    expect(second.result._meta?.["murage/provisional"]).toBeUndefined();
    expect(markerOf(dir)).toBeNull(); // the engine now holds the real list
    // One log line per list: outcome, count and status; nothing else.
    expect(stderr).toMatch(/tools\/list outcome=standin tools=\d+/);
    if (mode === "http500") expect(stderr).toContain("http=500");
    expect(stderr).toMatch(/tools\/list outcome=remembered tools=\d+/);
    expect(stderr).not.toMatch(/token|authorization|bearer/i);
  }, 30_000);

  it("one odd entry in a real list is dropped and logged; the rest is the real catalogue, not the stand-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-first-list-")); dirs.push(dir);
    // A real catalogue with two entries that are not tools: one without a schema, one without a name.
    const odd = [{ name: "NO_SCHEMA_TOOL", description: "d" }, { description: "no name", inputSchema: { type: "object" } }];
    const url = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        if (message.method !== "tools/list") { response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ran" }] } })); return; }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [...SEVEN, ...odd] } }));
      });
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_BOT_ID: "bot-a", MURAGE_CONNECTOR_IDENTITY: ID, MURAGE_CONNECTOR_REVISION: "rev-1" });
    let stderr = "";
    child!.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const seen: Record<string, any>[] = [];
    lines.on("line", (line) => { try { seen.push(JSON.parse(line)); } catch { /* ignore */ } });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    child!.stdin.write(listReq(1));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const first = seen.find((m) => m.id === 1)!;
    expect(first.error).toBeUndefined();
    // The seven real tools (beside the bridge's own status tool), in the engine's first answer; neither odd entry, and no stand-in.
    expect(toolNames(first).filter((name) => name !== "CHECK_CONNECTED_APP_ACTION").sort()).toEqual(SEVEN.map((t) => exposedToolName(t.name)).sort());
    expect(first.result._meta?.["murage/provisional"]).toBeUndefined();
    expect(markerOf(dir)).toBeNull(); // a real list: the mount is not incomplete
    expect(stderr).toMatch(/tools\/list outcome=real tools=8/); // seven, plus the bridge's status tool
    expect(stderr).toMatch(/tools\/list dropped=2 without a name or object inputSchema: NO_SCHEMA_TOOL, \(unnamed\)/);
    expect(stderr).not.toMatch(/outcome=standin/);
  }, 30_000);

  it("an exact WORKBENCH call after a failed first list is never 'Tool not found': it waits for the real list, then runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-first-list-")); dirs.push(dir);
    const url = await upstream("http500", 1_200);
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_BOT_ID: "bot-a", MURAGE_CONNECTOR_IDENTITY: ID, MURAGE_CONNECTOR_REVISION: "rev-1" });
    const seen: Record<string, any>[] = [];
    lines.on("line", (line) => { try { seen.push(JSON.parse(line)); } catch { /* ignore */ } });
    child!.stdin.write(listReq(1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(toolNames(seen.find((m) => m.id === 1)!)).toContain("APPS_REMOTE_WORKBENCH");
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: "print(1)" } } })}\n`);
    for (let waited = 0; waited < 12_000 && !seen.some((m) => m.id === 9); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    const call = seen.find((m) => m.id === 9)!;
    expect(call, "the call was answered").toBeDefined();
    expect(JSON.stringify(call)).not.toMatch(/tool not found/i);
    expect(call.error).toBeUndefined();
    expect(call.result.content[0].text).toBe("ran");
  }, 30_000);

  it("a restricted bot's fallback is its own approved list, never the standard tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-first-list-")); dirs.push(dir);
    const built = bumpGeneration(dir);
    const approved = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "APPROVED_ONLY", inputSchema: { type: "object", properties: {} } }];
    const url = await upstream("http500", 60_000);
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_CONNECTOR_INITIAL_TOOLS: JSON.stringify(approved), MURAGE_CONNECTOR_INITIAL_GENERATION: built, MURAGE_BOT_ID: "bot-r", MURAGE_CONNECTOR_IDENTITY: ID, MURAGE_CONNECTOR_REVISION: "rev-r" });
    child!.stdin.write(listReq(1));
    const reply = await nextJson(lines);
    const names = toolNames(reply);
    expect(names).toContain("APPS_MULTI_EXECUTE_TOOL");
    for (const widened of ["APPS_REMOTE_WORKBENCH", "APPS_REMOTE_BASH_TOOL", "APPS_WAIT_FOR_CONNECTIONS", "APPS_SEARCH_TOOLS", "APPS_GET_TOOL_SCHEMAS"]) expect(names).not.toContain(widened);
  }, 30_000);

  // The harness turns the original service's daily-limit 429 into HTTP 200 with
  // a JSON-RPC error. That is the same refusal as the direct 429: the engine is
  // told the limit and its reset time, no fallback tools are mounted, and a
  // later call answers with the limit, never "still loading".
  it.each([
    ["the harness's plain answer", { code: -32000, message: LEGACY_DAILY_LIMIT }],
    ["an error carrying the upstream status", { code: -32000, message: "Today's request limit was reached. It resets at 00:00 UTC.", data: { status: 429 } }],
  ])("a daily limit normalised to a JSON-RPC error (%s) is answered with its own words, like the direct 429", async (_label, rpcError) => {
    const dir = mkdtempSync(join(tmpdir(), "murage-first-list-")); dirs.push(dir);
    let calls = 0;
    const url = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        if (message.method === "tools/call") { calls += 1; response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: rpcError.message }], isError: true } })); return; }
        if (message.method === "tools/list") { response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: rpcError })); return; }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_BOT_ID: "bot-a", MURAGE_CONNECTOR_IDENTITY: ID, MURAGE_CONNECTOR_REVISION: "rev-1" });
    let stderr = "";
    child!.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child!.stdin.write(listReq(1));
    const reply = await nextJson(lines);
    expect(reply.id).toBe(1);
    expect(reply.result).toBeUndefined(); // no fallback tools for a refusal
    expect(reply.error.message).toBe(rpcError.message);
    expect(reply.error.message).toContain("resets at 00:00 UTC");
    expect(markerOf(dir)).toMatchObject({ revision: "rev-1" }); // recovered at the next turn, as for the direct 429
    expect(stderr).toMatch(/tools\/list outcome=error tools=0 http=429/);
    expect(stderr).not.toMatch(/outcome=standin/);
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } })}\n`);
    const call = await nextJson(lines);
    expect(call.id).toBe(2);
    expect(call.result.content[0].text).toBe(rpcError.message);
    expect(JSON.stringify(call)).not.toContain("still loading");
    expect(calls).toBe(1);
  }, 30_000);

  it("an access refusal (HTTP 403) is still an error, and also marks the mount incomplete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-first-list-")); dirs.push(dir);
    const url = await listen((request, response) => {
      request.resume();
      request.on("end", () => { response.writeHead(403, { "content-type": "text/plain" }); response.end("no"); });
    });
    const lines = start({ MURAGE_CONNECTOR_UPSTREAM_URL: url, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: dir, MURAGE_BOT_ID: "bot-a", MURAGE_CONNECTOR_IDENTITY: ID, MURAGE_CONNECTOR_REVISION: "rev-1" });
    child!.stdin.write(listReq(1));
    const reply = await nextJson(lines);
    expect(reply.error.message).toContain("HTTP 403");
    expect(markerOf(dir)).toMatchObject({ revision: "rev-1" });
  }, 30_000);
});
