// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1023-connparity-fix (MAIN-RULING CONNPARITY-1022 2026-11-25T17:42:59Z part 1: "the Settings Test must run the SAME
// code path chats use (same wrapper process for command servers) - one path, so a passing test proves chats work";
// OPUS 14d1f27d48 H1, ASTRA 14d1f27d48 High 1): what Settings → Test says about a COMMAND server is what a chat turn
// gets from it.
//
// Both sides are the real ones. The harness runs as the desktop app runs it (testing/desktop-shell.ts). The Settings
// side is POST /api/mcp/servers/<name>/test. The chat side is a real owner turn of the fake Claude engine in its
// "call the first custom tool" mode (testing/fake-custom-tool.ts): the engine starts the mount it was handed, the
// mount relay starts the admitted server process, and the engine's own initialize and tools/list go through the
// turn's release door. Nothing here talks to the server on the chat's behalf.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { startDesktopShell, type DesktopShell } from "./testing/desktop-shell.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

const TOOLS = [{ name: "alpha", inputSchema: { type: "object" } }, { name: "beta", inputSchema: { type: "object" } }];
const OPENED = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "link-check", version: "1" } };
const bodyOf = async (req: IncomingMessage): Promise<Record<string, any>> => {
  let text = "";
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text) as Record<string, any>; } catch { return {}; }
};
const sendJson = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
};
const closeServer = (server: Server | undefined) => new Promise<void>((resolve) => { if (!server) return resolve(); server.closeAllConnections(); server.close(() => resolve()); });

/** W7: a streamable HTTP link server that, asked for its tools, first sends a `ping` of its own on the answer stream
 * and lists the tools only once that ping is answered. Unanswered for 4 s, it ends the stream with no tools. */
function pingFirstServer(sameId = false) {
  const seen = { pings: 0, pongs: 0, sessions: 0 };
  const waiting = new Map<string, () => void>(); // by session and id: every connection has its own id space
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") return sendJson(res, req.method === "DELETE" ? 200 : 405);
    const frame = await bodyOf(req), key = (id: unknown) => `${String(req.headers["mcp-session-id"])}:${String(id)}`;
    if (frame.method === "initialize") return sendJson(res, 200, { jsonrpc: "2.0", id: frame.id, result: OPENED }, { "mcp-session-id": `ping-first-${++seen.sessions}` });
    if (frame.method === undefined && frame.result && waiting.has(key(frame.id))) { seen.pongs++; waiting.get(key(frame.id))!(); waiting.delete(key(frame.id)); return sendJson(res, 202); }
    if (frame.method === "tools/list") {
      const pingId: string | number = (++seen.pings, sameId ? frame.id : `srv-ping-${seen.pings}`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: pingId, method: "ping" })}\n\n`);
      const gaveUp = setTimeout(() => { waiting.delete(key(pingId)); res.end(); }, 4_000);
      waiting.set(key(pingId), () => { clearTimeout(gaveUp); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { tools: TOOLS } })}\n\n`); });
      return;
    }
    if (frame.method === "tools/call") return sendJson(res, 200, { jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: "alpha ran" }] } });
    return frame.id === undefined ? sendJson(res, 202) : sendJson(res, 200, { jsonrpc: "2.0", id: frame.id, result: {} });
  });
  return { server, seen };
}

/** W8: a legacy HTTP+SSE link server (GET the link for the stream, POST to the endpoint it names, answers on the
 * stream) whose stream breaks under the first tool call of a chat: that call is accepted and never answered. */
function legacyBreakingServer() {
  const seen = { streams: 0, initializes: 0, calls: 0, breaks: 0 };
  const streams = new Map<string, ServerResponse>();
  let breakNextCall = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/mcp") {
      const id = String(++seen.streams);
      streams.set(id, res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: endpoint\ndata: /messages?stream=${id}\n\n`);
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/messages") return sendJson(res, 405);
    const stream = streams.get(url.searchParams.get("stream") ?? "");
    const frame = await bodyOf(req);
    if (!stream || stream.destroyed) return sendJson(res, 404);
    sendJson(res, 202);
    const answer = (result: unknown) => stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n\n`);
    if (frame.method === "initialize") { seen.initializes++; answer(OPENED); }
    else if (frame.method === "tools/list") answer({ tools: TOOLS });
    else if (frame.method === "tools/call") {
      seen.calls++;
      if (breakNextCall) { breakNextCall = false; seen.breaks++; stream.socket?.destroy(); }
      else answer({ content: [{ type: "text", text: "alpha ran" }] });
    } else if (frame.id !== undefined) answer({});
  });
  return { server, seen, breakNextCall: () => { breakNextCall = true; } };
}

interface ToolLine { server: string; tools: string[]; tool?: string; text: string; isError: boolean }
/** One line per start of the command server: who started it. */
interface Started { parent: string[] }
type View = { ok: true; tools: string[] } | { ok: false };

let home = "";
let toolLog = "";
let commandServer = "";
let shell: DesktopShell;
let bot: { id: string; threadId: string };
let pingFirst: ReturnType<typeof pingFirstServer> | undefined;
let legacy: ReturnType<typeof legacyBreakingServer> | undefined; let pingSameId: ReturnType<typeof pingFirstServer> | undefined;

const toolLines = (): ToolLine[] => existsSync(toolLog) ? readFileSync(toolLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ToolLine) : [];
const starts = (marker: string): Started[] => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Started) : [];
const busy = async () => Boolean(((await shell.desktop("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; busy?: boolean }>).find((entry) => entry.id === bot.id)?.busy);
/** The wrapper a process was started by, from the wrapper script on: null when its parent is not the wipe wrapper. */
const wrapperOf = (started: Started | undefined): string[] | null => {
  const at = started ? started.parent.findIndex((arg) => /mcp-wipe-proxy\.(ts|js)$/.test(arg)) : -1;
  return at < 0 ? null : started!.parent.slice(at).map((arg) => arg.replace(/^.*[\\/](?=mcp-wipe-proxy\.)/, ""));
};

/** Settings → Test, reduced to what the parity is about. */
async function settingsTest(name: string): Promise<{ view: View; raw: any }> {
  const tested = await shell.desktop("POST", `/api/mcp/servers/${name}/test`, {});
  expect(tested.status, JSON.stringify(tested.body)).toBe(200);
  const raw = tested.body;
  return { raw, view: raw.ok === true ? { ok: true, tools: (raw.tools as Array<{ name: string }>).map((tool) => tool.name).sort() } : { ok: false } };
}

/** One real owner turn that uses `name`: what the engine's own tools/list on its mount came back with. */
async function chatTurn(name: string): Promise<{ view: View; line: ToolLine | undefined }> {
  const before = toolLines().length;
  const sent = await shell.desktop("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `list my tools __custom_tool__:${name}` });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  // the engine writes its line when its use of the server ended, with or without tools; then the turn settles
  await expect.poll(() => toolLines().length - before, { timeout: 100_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(busy, { timeout: 60_000 }).toBe(false);
  const line = toolLines().slice(before).find((entry) => entry.server === name);
  return { line, view: line && line.tools.length > 0 ? { ok: true, tools: [...line.tools].sort() } : { ok: false } };
}

describe.skipIf(process.platform !== "linux")("q1023-connparity-fix: Settings → Test and a real chat turn agree on a command server", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-connparity-cmd-"));
    toolLog = join(home, "custom-tool.jsonl");
    mkdirSync(join(home, ".murage"), { recursive: true });
    // A command server that appends, to the file named in argv[2], the argv of the process that started it (its parent,
    // Linux /proc), then serves the handshake, two tools and a call. With "banner" in argv[3] it first prints a line
    // that is not MCP on stdout, as servers that log to stdout do.
    commandServer = join(home, "command-server.mjs");
    writeFileSync(commandServer, `import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.argv[2], JSON.stringify({ parent: readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").split("\\0").filter(Boolean) }) + "\\n");
if (process.argv[3] === "banner") process.stdout.write("command-check 1.0 listening on stdio\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n");
  if (frame.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "command-check", version: "1" } });
  else if (frame.method === "tools/list") reply({ tools: [{ name: "alpha", inputSchema: { type: "object" } }, { name: "beta", inputSchema: { type: "object" } }] });
  else if (frame.method === "tools/call") reply({ content: [{ type: "text", text: "alpha ran" }] });
  else if (frame.id !== undefined) reply({});
});
`);
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: { claude: { driver: "claudeAgent", environment: { FAKE_CUSTOM_TOOL_SERVER: "cmdclean", FAKE_CUSTOM_TOOL_LOG: toolLog, FAKE_CUSTOM_TOOL_TIMEOUT_MS: "40000" }, config: { cli: FAKE_CLAUDE } } },
    }));
    shell = await startDesktopShell({ home });
    const created = await shell.desktop("POST", "/api/bots", { name: "Parity command", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    bot = created.body.bot as { id: string; threadId: string };
    expect((await shell.desktop("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await shell?.stop();
    await closeServer(pingFirst?.server);
    await closeServer(legacy?.server); await closeServer(pingSameId?.server);
    if (home) await removeTempDir(home);
  });

  it("W6 a command server that works: Test passes with exactly the tools a real chat turn lists, and both start it from the same wrapper", async () => {
    const marker = join(home, "w6-starts.jsonl");
    const created = await shell.desktop("POST", "/api/mcp/servers", { name: "cmdclean", command: process.execPath, args: [commandServer, marker] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const settings = await settingsTest("cmdclean");
    const underTest = starts(marker).at(-1);
    expect((await shell.desktop("PATCH", "/api/mcp/servers/cmdclean", { enabled: true })).status).toBe(200);
    const chat = await chatTurn("cmdclean");
    const inChat = starts(marker).at(-1);
    // the chat side is real: the engine listed the tools on its own mount and called the first one
    expect({ view: chat.view, tool: chat.line?.tool, text: chat.line?.text, isError: chat.line?.isError })
      .toEqual({ view: { ok: true, tools: ["alpha", "beta"] }, tool: "alpha", text: "alpha ran", isError: false });
    // THE parity (ruling: "a passing test proves chats work"): what Test says is what the chat got
    expect(settings.view, JSON.stringify(settings.raw)).toEqual(chat.view);
    // and by the same path (ruling: "same wrapper process for command servers"): the chat's server was started by the
    // wipe wrapper, and so was the one under Test, with the same wrapper arguments
    expect(starts(marker)).toHaveLength(2);
    expect(wrapperOf(inChat)).not.toBeNull();
    expect(wrapperOf(underTest)).toEqual(wrapperOf(inChat));
  }, 180_000);

  it("W6b a command server that prints a line that is not MCP: a real chat turn gets no tools from it, and Test does not pass", async () => {
    const marker = join(home, "w6b-starts.jsonl");
    const created = await shell.desktop("POST", "/api/mcp/servers", { name: "cmdbanner", command: process.execPath, args: [commandServer, marker, "banner"] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const settings = await settingsTest("cmdbanner");
    expect((await shell.desktop("PATCH", "/api/mcp/servers/cmdbanner", { enabled: true })).status).toBe(200);
    const chat = await chatTurn("cmdbanner");
    // both sides really started the server: these are its own results, not a launch problem
    expect(starts(marker)).toHaveLength(2);
    // the field report: this server gives a chat no tools
    expect(chat.view).toEqual({ ok: false });
    // THE parity: Test must not pass where the chat gets nothing
    expect(settings.view, JSON.stringify(settings.raw)).toEqual(chat.view);
  }, 180_000);

  // ASTRA 14d1f27d48 High 2 (mcp-chat-path-test.ts frameIn): the chat's proxy answers a request the server sends while a
  // call is open (remote-mcp-proxy.ts serverRequest); Settings Test read the stream for its own answer only.
  it("W7 a link server that pings before it lists its tools: a real chat turn gets its tools, and Test passes with the same tools", async () => {
    pingFirst = pingFirstServer();
    const created = await shell.desktop("POST", "/api/mcp/servers", { name: "pingfirst", url: await listen(pingFirst.server), confirmLocal: "this-computer", auth: "none" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const settings = await settingsTest("pingfirst");
    const afterTest = { ...pingFirst.seen };
    expect((await shell.desktop("PATCH", "/api/mcp/servers/pingfirst", { enabled: true })).status).toBe(200);
    const chat = await chatTurn("pingfirst");
    // the chat side is real: its proxy answered the server's ping and the engine listed the tools
    // (an engine may list more than once in a turn: every ping of the turn was answered)
    const inChat = { pings: pingFirst.seen.pings - afterTest.pings, pongs: pingFirst.seen.pongs - afterTest.pongs };
    expect(inChat.pings).toBeGreaterThanOrEqual(1);
    expect({ view: chat.view, text: chat.line?.text, pongsInChat: inChat.pongs })
      .toEqual({ view: { ok: true, tools: ["alpha", "beta"] }, text: "alpha ran", pongsInChat: inChat.pings });
    // THE parity: Test answered the server's ping as the chat does, so it lists what the chat lists
    expect({ view: settings.view, pongs: afterTest.pongs }, JSON.stringify(settings.raw)) // (a first Test's transport finder lists once too, unanswered: not the verdict)
      .toEqual({ view: chat.view, pongs: 1 });
  }, 180_000);

  // ASTRA 14d1f27d48 High 3 (remote-mcp-sse-sessions.ts pump -> mcp-relay.ts viaSse -> remote-mcp-proxy.ts fail): a
  // legacy SSE stream that breaks mid-call is a stream break like any other (MAIN-RULING CONNPARITY-1022: "reconnects
  // once through the relay, then fails the call with a clear named error; it never seals the connector").
  it("W8 a legacy SSE server whose stream breaks under a chat's tool call: Murage reconnects once at once and the call fails as stream-broke", async () => {
    legacy = legacyBreakingServer();
    const created = await shell.desktop("POST", "/api/mcp/servers", { name: "legacybreak", url: await listen(legacy.server), confirmLocal: "this-computer", auth: "none" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const settings = await settingsTest("legacybreak");
    expect(settings.view, JSON.stringify(settings.raw)).toEqual({ ok: true, tools: ["alpha", "beta"] });
    expect((await shell.desktop("PATCH", "/api/mcp/servers/legacybreak", { enabled: true })).status).toBe(200);
    const before = { ...legacy.seen };
    legacy.breakNextCall();
    const chat = await chatTurn("legacybreak");
    // the fixture did what the field does: the chat listed the tools, called one, and the stream broke under that call
    expect({ view: chat.view, calls: legacy.seen.calls - before.calls, breaks: legacy.seen.breaks }).toEqual({ view: settings.view, calls: 1, breaks: 1 });
    // one reconnect through the relay, made for that call (the engine made no further call): a second stream, a second initialize
    expect({ streams: legacy.seen.streams - before.streams, initializes: legacy.seen.initializes - before.initializes }).toEqual({ streams: 2, initializes: 2 });
    // and the call failed by name
    expect({ isError: chat.line?.isError, text: chat.line?.text }).toEqual({ isError: true, text: expect.stringMatching(/^stream-broke: .*cannot tell whether the call ran/) });
  }, 180_000);

  // ASTRA e0b614f12d High: a server numbers its own requests in its own id space. Its ping carrying the very id of the
  // tools/list it arrives under is a request to answer (the chat's proxy answers it), never that call's answer.
  it("W7b the server's ping carries the same id as the tools/list it arrives under: the chat answers it and lists the tools, and so does Test", async () => {
    pingSameId = pingFirstServer(true);
    const created = await shell.desktop("POST", "/api/mcp/servers", { name: "pingsameid", url: await listen(pingSameId.server), confirmLocal: "this-computer", auth: "none" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const settings = await settingsTest("pingsameid");
    const afterTest = { ...pingSameId.seen };
    expect((await shell.desktop("PATCH", "/api/mcp/servers/pingsameid", { enabled: true })).status).toBe(200);
    const chat = await chatTurn("pingsameid");
    // the chat side is real: the engine listed the tools through its proxy, which answered every ping of the turn
    expect({ view: chat.view, text: chat.line?.text, pinged: pingSameId.seen.pings - afterTest.pings >= 1, unanswered: pingSameId.seen.pings - pingSameId.seen.pongs })
      .toEqual({ view: { ok: true, tools: ["alpha", "beta"] }, text: "alpha ran", pinged: true, unanswered: 1 }); // (unanswered: the first Test's transport finder, not the verdict)
    // THE parity: Test took the ping for what it is (not for its answer), and lists what the chat lists
    expect(settings.view, JSON.stringify(settings.raw)).toEqual(chat.view);
    // having answered it on its chat-path read (a Test that stopped reading at the ping returns before its reply lands)
    expect(afterTest.pongs).toBe(1);
  }, 180_000);
});
