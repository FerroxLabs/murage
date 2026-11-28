// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23) dispatch side, through the REAL bridge process (server/connector-proxy.ts) and a fake upstream that
// records the bytes it receives. Witnesses W4 W5 (bridge half) W7 W8 (bridge half) W10 of
// designs/F11-V3-APP-ALIASES-1023.md.
import { boundProxyState, spawnBoundProxy } from "./testing/bound-proxy-fixture.ts";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { CONNECTED_APP_TOOLS } from "../shared/bot-access.ts";
import { aliasAsk, CONNECTOR_ALIASES_ENV, CONNECTOR_ALIASES_HEADER } from "../shared/connected-app-aliases.ts";
import { operationKey } from "./connected-app-operations.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
let child: ChildProcessWithoutNullStreams | null = null;
let server: Server | null = null;
const frameReaders = new WeakMap<readline.Interface, AsyncIterator<string>>();
const tempDirs: string[] = [];

async function listen(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}
async function start(env: Record<string, string>, cache?: string) {
  const toolsCache = cache ?? mkdtempSync(join(tmpdir(), "murage-alias-cache-"));
  if (!cache) tempDirs.push(toolsCache);
  child = await spawnBoundProxy("connectors", process.execPath, ["--experimental-strip-types", ENTRY], {
    windowsHide: true,
    env: { ...process.env, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: toolsCache, ...(process.platform === "win32" ? { MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE: "1" } : {}), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  frameReaders.set(lines, lines[Symbol.asyncIterator]());
  return lines;
}
async function nextJson(lines: readline.Interface): Promise<Record<string, any>> {
  const next = await frameReaders.get(lines)!.next();
  if (next.done) throw new Error("bridge closed before an application frame");
  return JSON.parse(next.value);
}
const send = async (lines: readline.Interface, message: unknown) => { const reply = nextJson(lines); child!.stdin.write(`${JSON.stringify(message)}\n`); return reply; };

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
});

type Seen = { headers: Record<string, unknown>; message: any };
/** A fake upstream that records every request and answers an action with a fixed text. */
async function fakeUpstream(seen: Seen[], reply?: (message: any) => unknown) {
  return listen((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const message = JSON.parse(raw);
      seen.push({ headers: request.headers, message });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message.id === undefined ? "" : JSON.stringify(reply?.(message) ?? { jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "ran" }] } }));
    });
  });
}
const flagged = (upstream: string, extra: Record<string, string> = {}) => ({ MURAGE_CONNECTOR_UPSTREAM_URL: upstream, MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer fixture" }), [CONNECTOR_ALIASES_ENV]: "1", ...extra });
const actions = (seen: Seen[]) => seen.filter((entry) => entry.message.method === "tools/call");
const call = (id: number, name: string, args: unknown, meta?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });

const EXAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  GMAIL_FETCH_EMAILS: { max_results: 3 },
  GMAIL_GET_PROFILE: {},
  GMAIL_SEND_EMAIL: { recipient_email: "a@x.com", subject: "s", body: "b" },
  SLACK_SEND_MESSAGE: { channel: "#general", text: "hi" },
  GOOGLECALENDAR_LIST_EVENTS: { calendar_id: "primary" },
};

describe("W4 one function, two callers: the bytes the bridge relays equal the body the card side judged", () => {
  for (const row of CONNECTED_APP_TOOLS) {
    it(`${row.tool}: bridge body deep-equals the intake body, params._meta kept, id kept`, async () => {
      const seen: Seen[] = [];
      const lines = await start(flagged(await fakeUpstream(seen)));
      const input = { account: "acct_a", arguments: EXAMPLE_ARGS[row.tool]! };
      const alias = row.tool.toLowerCase();
      const meta = { progressToken: "tok-1" };
      const answered = await send(lines, call(41, alias, input, meta));
      expect(answered.id).toBe(41);
      expect(answered.result?.content?.[0]?.text).toBe("ran");
      const relayed = actions(seen);
      expect(relayed).toHaveLength(1);
      const intake = aliasAsk({ type: "request.opened", requestType: "permission", toolEngine: "claude", tool: `mcp__murage_connectors__${alias}`, summary: alias, toolCall: { name: `mcp__murage_connectors__${alias}`, input }, mcpMounts: [{ engineName: "murage_connectors", mountId: "own:connector", provenance: "own" }] } as never) as any;
      expect(relayed[0]!.message.params.name).toBe("COMPOSIO_MULTI_EXECUTE_TOOL");
      expect(relayed[0]!.message.params.arguments).toEqual(intake.toolCall.input);
      expect(relayed[0]!.message.params._meta).toEqual(meta);
      expect(relayed[0]!.message.id).toBe(41);
    });
  }
});

describe("W5 / W7 the bridge refuses what the card side holds as unread, at every level, and runs nothing", () => {
  const refusals: Array<[string, unknown]> = [
    ["no account", { arguments: { recipient_email: "a@x.com" } }],
    ["an account override inside arguments", { account: "acct_a", arguments: { connected_account_id: "acct_b" } }],
    ["a nested account override", { account: "acct_a", arguments: { cc: [{ account: "acct_b" }] } }],
    ["a foreign gmail user_id", { account: "acct_a", arguments: { user_id: "someone-else" } }],
    ["an extra key beside account and arguments", { account: "acct_a", arguments: {}, connected_account_id: "acct_b" }],
  ];
  for (const [label, input] of refusals) {
    it(`${label}: isError with a reason, nothing reaches upstream`, async () => {
      const seen: Seen[] = [];
      const lines = await start(flagged(await fakeUpstream(seen)));
      const reply = await send(lines, call(5, "gmail_send_email", input));
      expect(reply.result).toMatchObject({ isError: true });
      expect(String(reply.result.content[0].text)).toMatch(/Murage (cannot|does not)? ?read|shape Murage reads/);
      expect(actions(seen)).toEqual([]);
    });
  }
});

describe("W8 (bridge half) the flag decides everything the bridge does with a plain name", () => {
  it("initializes and lists before loading the alias resolver", async () => {
    const cache = mkdtempSync(join(tmpdir(), "murage-alias-startup-"));
    tempDirs.push(cache);
    const trace = join(cache, "module-load");
    writeFileSync(trace, "");
    const preload = `
      import { appendFileSync } from "node:fs";
      import { registerHooks } from "node:module";
      registerHooks({ load(url, context, next) {
        if (url.endsWith("/shared/connected-app-aliases.ts")) appendFileSync(${JSON.stringify(trace)}, "loaded");
        return next(url, context);
      } });
    `;
    const seen: Seen[] = [];
    const lines = await start(flagged(await fakeUpstream(seen), {
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    }), cache);
    const initialized = await send(lines, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const listed = await send(lines, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const startup = readFileSync(trace, "utf8");
    const reply = await send(lines, call(3, "gmail_send_email", { account: "a", arguments: {} }));
    expect({
      ready: Boolean(initialized.result?.capabilities && listed.result?.tools?.length),
      startup,
      loaded: readFileSync(trace, "utf8"),
      action: actions(seen)[0]?.message.params.name,
      reply: reply.result?.content[0]?.text,
    }).toEqual({ ready: true, startup: "", loaded: "loaded", action: "COMPOSIO_MULTI_EXECUTE_TOOL", reply: "ran" });
  });

  it("an unflagged bridge relays an alias name untouched (the relay refuses it) and asks for no alias rows", async () => {
    const seen: Seen[] = [];
    const lines = await start({ MURAGE_CONNECTOR_UPSTREAM_URL: await fakeUpstream(seen), MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer fixture" }) });
    await send(lines, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    await send(lines, call(2, "gmail_send_email", { account: "a", arguments: {} }));
    const list = seen.find((entry) => entry.message.method === "tools/list")!;
    expect(list.headers[CONNECTOR_ALIASES_HEADER]).toBeUndefined();
    expect(actions(seen)[0]!.message.params.name).toBe("gmail_send_email");
  });
  it("a flagged bridge sends the listing header on every tools/list fetch", async () => {
    const seen: Seen[] = [];
    const lines = await start(flagged(await fakeUpstream(seen)));
    await send(lines, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    await send(lines, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const lists = seen.filter((entry) => entry.message.method === "tools/list");
    expect(lists.length).toBeGreaterThan(0);
    for (const entry of lists) expect(entry.headers[CONNECTOR_ALIASES_HEADER]).toBe("1");
    expect(seen.filter((entry) => entry.message.method !== "tools/list").every((entry) => entry.headers[CONNECTOR_ALIASES_HEADER] === undefined)).toBe(true);
  });
  it("the flag is part of the bridge's remembered-list identity: a list a flagged bridge stored (disk) is not served to an unflagged one", async () => {
    const cache = mkdtempSync(join(tmpdir(), "murage-alias-cache-"));
    tempDirs.push(cache);
    const identity = { MURAGE_CONNECTOR_IDENTITY: "a".repeat(32), MURAGE_CONNECTOR_REVISION: "rev-1" };
    const rows = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" } }, { name: "gmail_send_email", inputSchema: { type: "object" } }];
    const seenA: Seen[] = [];
    let lines = await start(flagged(await fakeUpstream(seenA, (m) => ({ jsonrpc: "2.0", id: m.id, result: { tools: rows } })), identity), cache);
    expect((await send(lines, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).result.tools.map((t: { name: string }) => t.name)).toContain("gmail_send_email");
    child!.kill("SIGKILL"); await once(child!, "close");
    await new Promise<void>((resolve) => server!.close(() => resolve())); server = null;
    // the same account, bot and revision, UNFLAGGED, against an upstream whose list has no plain-name rows: a remembered list
    // served from the flagged bridge's disk entry would still show the alias row
    const plain = [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" } }];
    lines = await start({ MURAGE_CONNECTOR_UPSTREAM_URL: await fakeUpstream([], (m) => ({ jsonrpc: "2.0", id: m.id, result: { tools: plain } })), MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer fixture" }), ...identity }, cache);
    const served = await send(lines, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(JSON.stringify(served)).not.toContain("gmail_send_email");
    expect(served.result.tools.map((t: { name: string }) => t.name)).toContain("APPS_MULTI_EXECUTE_TOOL");
  });
});

describe("the alias flag touches the remembered-list identity only, never the harness's revision (Opus review M1)", () => {
  it("the stand-in marker a flagged bridge writes carries the raw MURAGE_CONNECTOR_REVISION the driver reads", async () => {
    const cache = mkdtempSync(join(tmpdir(), "murage-alias-cache-"));
    tempDirs.push(cache);
    const provisional = (id: unknown) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "PENDING_FIXTURE", inputSchema: { type: "object" } }], _meta: { "murage/provisional": true, "murage/provisional-bundled": true } } });
    const lines = await start(flagged(await fakeUpstream([], (m) => provisional(m.id)), { MURAGE_CONNECTOR_IDENTITY: "b".repeat(32), MURAGE_CONNECTOR_REVISION: "rev-raw", MURAGE_THREAD_ID: "thread-1" }), cache);
    await send(lines, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
    const markers = files(cache).map((path) => { try { return JSON.parse(readFileSync(path, "utf8")) as { revision?: string; ready?: boolean }; } catch { return {}; } }).filter((entry) => entry.ready === false);
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) expect(marker.revision).toBe("rev-raw");
  });
});

describe("W10 a bridge restart between two identical alias calls: the same bytes, so one operation identity", () => {
  it("the body is byte-identical across a restart and its operation key is equal", async () => {
    const seen: Seen[] = [];
    const upstream = await fakeUpstream(seen);
    const input = { account: "acct_a", arguments: EXAMPLE_ARGS.GMAIL_SEND_EMAIL };
    let lines = await start(flagged(upstream));
    await send(lines, call(1, "gmail_send_email", input));
    child!.kill("SIGKILL"); await once(child!, "close");
    lines = await start(flagged(upstream));
    await send(lines, call(1, "gmail_send_email", input));
    const [first, second] = actions(seen);
    // the calls the upstream received are the canonical execute call (the rewrite happened), identical across the restart
    expect(first!.message.params.name).toBe("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(JSON.stringify(second!.message)).toBe(JSON.stringify(first!.message));
    expect(operationKey(second!.message.params.name, second!.message.params.arguments)).toBe(operationKey(first!.message.params.name, first!.message.params.arguments));
    expect(boundProxyState(child!)).toBeDefined();
  });
});
