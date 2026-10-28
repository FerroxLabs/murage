// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The hardened chat MCP client (OPENAI-TOOLS-109 section 3) against a real stdio child: a small fake MCP server written to a
// temp dir and run with this node, started through the client's default spawnCli path. Hermetic: no DATA_DIR, no network.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ChildTeardown } from "./child-teardown.ts";
import {
  CHAT_MCP_FAILED_MESSAGE, ChatMcpError, chatMcpChildEnv, mountSecrets, openChatMcpServers, type ChatMcpSession,
} from "./chat-mcp-client.ts";

const FAKE_SERVER = String.raw`
import { appendFileSync } from "node:fs";
const mode = process.env.FAKE_MODE ?? "normal";
const log = process.env.FAKE_LOG;
process.stderr.write("stderr carries " + (process.env.ENTRY_TOKEN ?? "") + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
let pendingAsk = null;
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));
function handle(m) {
  if (log) appendFileSync(log, JSON.stringify(m) + "\n");
  if (m.method === "initialize") {
    if (mode === "hang") return;
    if (mode === "badjson") { process.stdout.write("this is not json\n"); return; }
    return reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  }
  if (m.method === "tools/list") {
    const cursor = m.params && m.params.cursor;
    if (mode === "dupcursor") return reply(m.id, { tools: [{ name: "t" + (cursor ?? "0"), inputSchema: { type: "object" } }], nextCursor: "same" });
    if (!cursor) {
      return reply(m.id, {
        tools: [
          { name: "env", description: "echo env", inputSchema: { type: "object", properties: {} } },
          { name: "img" }, { name: "slow" }, { name: "big" }, { name: "ask" }, { name: "fail" },
        ],
        nextCursor: "p2",
      });
    }
    return reply(m.id, { tools: [{ name: "second", inputSchema: { type: "object" } }] });
  }
  if (m.method === "tools/call") {
    const name = m.params.name;
    if (name === "env") return reply(m.id, { content: [{ type: "text", text: JSON.stringify(process.env) }] });
    if (name === "img") {
      return reply(m.id, { isError: true, content: [
        { type: "text", text: "a" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "b" },
        { type: "resource", resource: { uri: "file:///x", text: "r" } },
      ] });
    }
    if (name === "slow") return;
    if (name === "big") {
      process.stdout.write('{"jsonrpc":"2.0","id":' + m.id + ',"result":{"content":[{"type":"text","text":"' + "x".repeat(2 * 1024 * 1024) + '"}]}}\n');
      return;
    }
    if (name === "ask") { pendingAsk = m.id; return send({ jsonrpc: "2.0", id: "s1", method: "sampling/createMessage", params: {} }); }
    if (name === "fail") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "leaked " + process.env.ENTRY_TOKEN } });
  }
  if (m.id === "s1" && pendingAsk !== null) {
    const id = pendingAsk;
    pendingAsk = null;
    return reply(id, { content: [{ type: "text", text: "client answered " + (m.error ? m.error.code : "none") }] });
  }
}
`;

const SENTINELS = ["MURAGE_MCP_TOKEN", "MURAGEBOX_BOX_TOKEN", "FLUX_API_KEY", "OPENAI_COMPAT_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "MURAGE_X"];
const ENTRY_TOKEN = "entry-token-value-1234";
const budget = { closeMs: 3_000, maxMs: 8_000 };

let dir: string;
let script: string;
const saved = new Map<string, string | undefined>();
const opened: ChatMcpSession[] = [];
const spawned: ChildTeardown[] = [];

const entry = (mode = "normal", log?: string): Record<string, unknown> => ({
  command: process.execPath,
  args: [script],
  env: { FAKE_MODE: mode, ENTRY_TOKEN, ...(log ? { FAKE_LOG: log } : {}) },
});
const open = async (servers: Record<string, unknown>, options: Parameters<typeof openChatMcpServers>[1] = {}) => {
  const result = await openChatMcpServers(servers, {
    ...options,
    onSpawn: (server, teardown) => { spawned.push(teardown); options.onSpawn?.(server, teardown); },
  });
  opened.push(...result.sessions);
  return result;
};
const logLines = (path: string): Array<Record<string, unknown>> =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-mcp-client-"));
  script = join(dir, "fake-mcp-server.mjs");
  writeFileSync(script, FAKE_SERVER);
  for (const name of SENTINELS) { saved.set(name, process.env[name]); process.env[name] = `sentinel-${name}`; }
});

afterEach(async () => {
  for (const session of opened.splice(0)) session.close();
  const teardowns = spawned.splice(0);
  await Promise.all(teardowns.map((teardown) => teardown.wait(budget)));
});

afterAll(() => {
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  removeTempDirSync(dir);
});

describe("chatMcpChildEnv", () => {
  it("copies only the allowlist plus PATH, and the entry's own env last", () => {
    const source: Record<string, string> = { HOME: "/home/o", LANG: "en_US.UTF-8", home: "/lower", PATH: "/bin" };
    for (const name of SENTINELS) source[name] = `sentinel-${name}`;
    const env = chatMcpChildEnv({ ENTRY_TOKEN, LANG: "C", NUM: 3 }, source, "darwin");
    for (const name of SENTINELS) expect(env[name]).toBeUndefined();
    expect(env.home).toBeUndefined(); // POSIX names are exact
    expect(env.HOME).toBe("/home/o");
    expect(env.LANG).toBe("C");
    expect(env.ENTRY_TOKEN).toBe(ENTRY_TOKEN);
    expect(env.NUM).toBeUndefined();
    expect(typeof env.PATH).toBe("string");
    expect(Object.keys(env).sort()).toEqual(["ENTRY_TOKEN", "HOME", "LANG", "PATH"]);
  });

  it("compares names case-insensitively on Windows, a later name replacing any case of it", () => {
    const source: Record<string, string> = { systemroot: "C:\\Windows", Temp: "C:\\t", Path: "C:\\bin", murage_mcp_token: "x", ANTHROPIC_API_KEY: "k" };
    const env = chatMcpChildEnv({ path: "C:\\mine", TEMP: "C:\\override" }, source, "win32");
    expect(env.systemroot).toBe("C:\\Windows");
    expect(env.murage_mcp_token).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.path).toBe("C:\\mine");
    expect(env.PATH).toBeUndefined();
    expect(env.Path).toBeUndefined();
    expect(env.TEMP).toBe("C:\\override");
    expect(env.Temp).toBeUndefined();
  });
});

describe("mountSecrets", () => {
  it("collects secret-named env values of 4+ characters, deduped", () => {
    expect(mountSecrets(null)).toEqual([]);
    const secrets = mountSecrets({
      a: { command: "x", env: { API_KEY: "abcd1234", NOTE: "plain-value", Cookie: "c=1;", PASSWORD: "abc" } },
      b: { command: "y", env: { MY_TOKEN: "abcd1234", authorization: "Bearer zz" } },
      c: "not an entry",
    });
    expect(secrets.sort()).toEqual(["Bearer zz", "abcd1234", "c=1;"]);
  });
});

describe("openChatMcpServers", () => {
  it("a real child gets only the allowlisted env plus its own token, and stderr never surfaces", async () => {
    const { sessions, failed } = await open({ fake: entry() });
    expect(failed).toEqual([]);
    const result = await sessions[0]!.callTool("env", {}, {});
    const childEnv = JSON.parse(result.text) as Record<string, string>;
    for (const name of SENTINELS) expect(childEnv[name]).toBeUndefined();
    expect(childEnv.ENTRY_TOKEN).toBe(ENTRY_TOKEN);
    expect(result.text).not.toContain("stderr carries");
  });

  it("pages tools/list across cursors and fails a server that repeats a cursor", async () => {
    const { sessions, failed } = await open({ good: entry(), loop: entry("dupcursor") });
    expect(failed).toEqual(["loop"]);
    expect(sessions.map((session) => session.server)).toEqual(["good"]);
    expect(sessions[0]!.tools.map((tool) => tool.name)).toEqual(["env", "img", "slow", "big", "ask", "fail", "second"]);
    expect(sessions[0]!.tools[0]).toEqual({ name: "env", description: "echo env", inputSchema: { type: "object", properties: {} } });
    expect(sessions[0]!.tools[1]!.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("returns sessions in config order; a malformed envelope and a missing command fail that server only", async () => {
    const { sessions, failed } = await open({ first: entry(), nocmd: { args: ["x"], env: {} }, broken: entry("badjson"), last: entry() });
    expect(sessions.map((session) => session.server)).toEqual(["first", "last"]);
    expect(failed).toEqual(["nocmd", "broken"]);
    expect(spawned).toHaveLength(3);
  });

  it("an entry with no string command is failed without spawning", async () => {
    const spawnCalls: string[] = [];
    const reported: string[] = [];
    const { sessions, failed } = await openChatMcpServers(
      { a: { args: [] }, b: { command: 7 }, c: null },
      { spawn: (command) => { spawnCalls.push(command); throw new Error("must not spawn"); }, onSpawn: (server) => reported.push(server) },
    );
    expect(sessions).toEqual([]);
    expect(failed).toEqual(["a", "b", "c"]);
    expect(spawnCalls).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("reports every spawn synchronously, before startup resolves, even for a server that then fails", async () => {
    const order: string[] = [];
    const pending = open({ ok: entry(), slow: entry("hang") }, { startupMs: 400, onSpawn: (server) => order.push(`spawn:${server}`) });
    expect(order).toEqual(["spawn:ok", "spawn:slow"]);
    const { sessions, failed } = await pending;
    order.push("resolved");
    expect(order).toEqual(["spawn:ok", "spawn:slow", "resolved"]);
    expect(sessions.map((session) => session.server)).toEqual(["ok"]);
    expect(failed).toEqual(["slow"]);
    // The failed server's child was already closed: its teardown confirms.
    await expect(spawned[1]!.wait(budget)).resolves.toEqual({ closeConfirmed: true });
  });

  it("an abort during startup closes everything spawned and resolves with no sessions", async () => {
    const controller = new AbortController();
    const pending = open({ a: entry("hang"), b: entry("hang") }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).resolves.toEqual({ sessions: [], failed: [] });
    expect(spawned).toHaveLength(2);
    for (const teardown of spawned) await expect(teardown.wait(budget)).resolves.toEqual({ closeConfirmed: true });
  });
});

describe("ChatMcpSession.callTool", () => {
  it("joins text parts, counts images as dropped, keeps other parts as JSON and reads isError", async () => {
    const { sessions } = await open({ fake: entry() });
    await expect(sessions[0]!.callTool("img", {}, {})).resolves.toEqual({
      isError: true,
      text: `a\nb\n${JSON.stringify({ type: "resource", resource: { uri: "file:///x", text: "r" } })}`,
      droppedImages: 1,
    });
  });

  it("answers a server-initiated request with -32601", async () => {
    const { sessions } = await open({ fake: entry() });
    await expect(sessions[0]!.callTool("ask", {}, {})).resolves.toMatchObject({ text: "client answered -32601", isError: false });
  });

  it("a JSON-RPC error rejects with the fixed message, never the server's text", async () => {
    const { sessions } = await open({ fake: entry() });
    const error = await sessions[0]!.callTool("fail", {}, {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ChatMcpError);
    expect((error as Error).message).toBe(CHAT_MCP_FAILED_MESSAGE);
    expect((error as Error).message).not.toContain(ENTRY_TOKEN);
  });

  it("an oversize frame kills the session", async () => {
    const { sessions } = await open({ fake: entry() });
    const session = sessions[0]!;
    const error = await session.callTool("big", {}, {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ChatMcpError);
    expect((error as Error).message).toBe(CHAT_MCP_FAILED_MESSAGE);
    expect(session.closed).toBe(true);
    await expect(session.teardown.wait(budget)).resolves.toEqual({ closeConfirmed: true });
    await expect(session.callTool("env", {}, {})).rejects.toBeInstanceOf(ChatMcpError);
  });

  it("an abort sends notifications/cancelled, closes the session and the teardown confirms the close", async () => {
    const log = join(dir, "abort.ndjson");
    const { sessions } = await open({ fake: entry("normal", log) });
    const session = sessions[0]!;
    const controller = new AbortController();
    const call = session.callTool("slow", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const error = await call.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ChatMcpError);
    expect((error as ChatMcpError).kind).toBe("aborted");
    expect(session.closed).toBe(true);
    await expect(session.teardown.wait(budget)).resolves.toEqual({ closeConfirmed: true });
    const lines = logLines(log);
    const callLine = lines.find((line) => line.method === "tools/call");
    const cancelled = lines.find((line) => line.method === "notifications/cancelled");
    expect(cancelled?.params).toEqual({ requestId: callLine?.id, reason: "cancelled" });
    session.close(); // idempotent
    expect(session.closed).toBe(true);
  });

  it("a timeout sends notifications/cancelled and closes the session", async () => {
    const log = join(dir, "timeout.ndjson");
    const { sessions } = await open({ fake: entry("normal", log) });
    const session = sessions[0]!;
    const error = await session.callTool("slow", {}, { timeoutMs: 150 }).catch((err: unknown) => err);
    expect((error as ChatMcpError).kind).toBe("timeout");
    expect(session.closed).toBe(true);
    await expect(session.teardown.wait(budget)).resolves.toEqual({ closeConfirmed: true });
    expect(logLines(log).some((line) => line.method === "notifications/cancelled"
      && (line.params as { reason?: string }).reason === "timed out")).toBe(true);
  });
});
