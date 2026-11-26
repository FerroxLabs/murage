// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-connparity (#29 #25 #22 #20, MAIN-RULING SEAN 2026-11-25): a connector that passes Settings → Test shows
// the same tools in a chat turn. Boots node server/index.ts on a throwaway home (testing/index-harness.ts) with a
// fake link server in this process. The Settings side is POST /api/mcp/servers/<name>/test; the chat side is what an
// engine's proxy sends for a real fixture turn: initialize, notifications/initialized and tools/list on
// /api/internal/mcp-remote/<name> with the token the turn's mount carries.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BASE, MCP_COMMIT_TOKEN as COMMIT_TOKEN, DESKTOP_HEADERS, desktopApi, startInternalFixtureTurn, stopFixtureTurn } from "./testing/index-harness.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";

/** The keyed fixture's value, built at runtime (a neutral fixture value, never a key-shaped literal). */
const FIXTURE_VALUE = ["fixture", "value", "w1b"].join("-");
// W4/W4b: a command server that writes, to the file named in argv[2], the argv of the process that started it (its
// parent, Linux /proc); then it serves the MCP handshake and two tools. With "banner" in argv[3] it first prints a
// line that is not MCP on stdout, as servers that log to stdout do: the chat's wrapper hands an engine nothing after
// such a line (the release refuses it and the mount is sealed for the turn), while a bare client can skip it.
const scratch = mkdtempSync(join(tmpdir(), "connparity-1022-"));
const COMMAND_SERVER = join(scratch, "command-server.mjs");
writeFileSync(COMMAND_SERVER, `import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], JSON.stringify({ parent: readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").split("\\0").filter(Boolean) }));
if (process.argv[3] === "banner") process.stdout.write("command-check 1.0 listening on stdio\\n");
const startsAt = Date.now() + (process.argv[3] === "slow-start" ? 12000 : 0);
createInterface({ input: process.stdin }).on("line", (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n");
  if (frame.method === "initialize") setTimeout(() => reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "command-check", version: "1" } }), Math.max(0, startsAt - Date.now()));
  else if (frame.method === "tools/list") reply({ tools: [{ name: "alpha", inputSchema: { type: "object" } }, { name: "beta", inputSchema: { type: "object" } }] });
});
`);
// W4c: an installer command (its name is what gives a first Test its long window): a stand-in `npx` that runs node.
const INSTALLER = join(scratch, "npx");
writeFileSync(INSTALLER, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
chmodSync(INSTALLER, 0o755);

let keyed: FakeRemoteMcp;
let anonymousList: FakeRemoteMcp;
beforeAll(async () => {
  keyed = await startFakeRemoteMcp({ auth: "api-key", apiKey: FIXTURE_VALUE, unauthorized: "api-key-only", prm: false, toolCount: 7 });
  // An OAuth server that lists its tools to anyone and asks for sign-in only on a call.
  anonymousList = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "bearer-resource-metadata", listsWithoutSignIn: true, toolCount: 5 });
});
afterAll(async () => {
  await keyed?.close();
  await anonymousList?.close();
  rmSync(scratch, { recursive: true, force: true });
});

const commit = (method: string, path: string, body?: unknown) => fetch(`${BASE}${path}`, {
  method, headers: { ...DESKTOP_HEADERS, authorization: `Bearer ${COMMIT_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json() as any }));
const relay = (token: string, name: string, message: object, extra: Record<string, string> = {}) => fetch(`${BASE}/api/internal/mcp-remote/${name}`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(message),
}).then(async (res) => ({ status: res.status, headers: res.headers, text: await res.text() }));

/** The answer frame for `id` in a JSON or SSE body. */
function frameOf(text: string, id: number): Record<string, any> | null {
  const bodies = text.trim().startsWith("{") ? [text] : text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5));
  for (const body of bodies) {
    try { const frame = JSON.parse(body); if (frame?.id === id) return frame; } catch { /* not a frame */ }
  }
  return null;
}

/** What the engine sees in a chat turn: the tool names the relay hands back, or no tools. */
async function chatTools(name: string): Promise<{ ok: true; tools: string[] } | { ok: false }> {
  const bot = (await desktopApi("POST", "/api/bots", { name: `Parity ${name}` })).body.bot;
  let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
  try {
    turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
    const mount = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>)[name];
    if (!mount) return { ok: false };
    const token = mount.env.MURAGE_MCP_TOKEN!;
    const init = await relay(token, name, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } } });
    const opened = init.status === 200 ? frameOf(init.text, 1) : null;
    if (!opened?.result) return { ok: false };
    const session = init.headers.get("mcp-session-id") ?? undefined;
    const sessionHeaders: Record<string, string> = { ...(session ? { "mcp-session-id": session } : {}), "mcp-protocol-version": String(opened.result.protocolVersion) };
    await relay(token, name, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders);
    const list = await relay(token, name, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionHeaders);
    const listed = list.status === 200 ? frameOf(list.text, 2) : null;
    if (!Array.isArray(listed?.result?.tools) || listed.result.tools.length === 0) return { ok: false };
    return { ok: true, tools: listed.result.tools.map((tool: { name: string }) => tool.name).sort() };
  } finally {
    if (turn) await stopFixtureTurn(bot.id, turn);
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
  }
}

/** Settings → Test, reduced to what the parity is about: passed with these tools, or did not pass. */
async function settingsTest(name: string): Promise<{ view: { ok: true; tools: string[] } | { ok: false }; raw: any }> {
  const tested = await desktopApi("POST", `/api/mcp/servers/${name}/test`, {});
  expect(tested.status, JSON.stringify(tested.body)).toBe(200);
  const raw = tested.body;
  return { raw, view: raw.ok === true ? { ok: true, tools: (raw.tools as Array<{ name: string }>).map((tool) => tool.name).sort() } : { ok: false } };
}

describe("q1022-connparity: Settings → Test and a chat turn see the same server", () => {
  it("W1 an OAuth server that lists tools without sign-in, never signed in: Test does not pass where the chat gets no tools, and offers Sign in", async () => {
    const created = await desktopApi("POST", "/api/mcp/servers", { name: "openlist", url: anonymousList.mcpUrl, confirmLocal: "this-computer", auth: "oauth" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    try {
      const settings = await settingsTest("openlist");
      expect((await desktopApi("PATCH", "/api/mcp/servers/openlist", { enabled: true })).status).toBe(200);
      const chat = await chatTools("openlist");
      // the fixture is what the field reports: a chat that sees no tools from this server
      expect(chat).toEqual({ ok: false });
      // THE parity: what Test says is what the chat gets
      expect(settings.view).toEqual(chat);
      // and the panel can offer the next step
      expect(settings.raw).toMatchObject({ ok: false, signIn: { host: "127.0.0.1" } });
      expect(["sign-in-ended", "needs-sign-in"]).toContain(settings.raw.reason);
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/openlist");
    }
  });

  it("W1b a keyed server that works: Test passes with exactly the tools the chat turn lists", async () => {
    const created = await desktopApi("POST", "/api/mcp/servers", { name: "keyedsvc", url: keyed.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await commit("PUT", "/api/mcp/servers/keyedsvc/secrets", { origin: keyed.origin, headers: { "x-api-key": FIXTURE_VALUE } })).status).toBe(200);
    try {
      const settings = await settingsTest("keyedsvc");
      expect((await desktopApi("PATCH", "/api/mcp/servers/keyedsvc", { enabled: true })).status).toBe(200);
      const chat = await chatTools("keyedsvc");
      expect(chat).toMatchObject({ ok: true });
      expect((chat as { tools: string[] }).tools).toHaveLength(7);
      expect(settings.view).toEqual(chat);
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/keyedsvc");
    }
  });

  // MAIN-RULING 2026-11-25T17:42:59Z CONNPARITY-1022 part 1: "the Settings Test must run the SAME code path chats use
  // (same wrapper process for command servers)". ASTRA/FABLE/OPUS 4ed978c679 H1.
  it.skipIf(process.platform !== "linux")("W4 a command server: Test starts the same process a chat mounts (the wipe wrapper), never the bare command, and lists its tools through it", async () => {
    const marker = join(scratch, "w4-parent.json");
    const created = await desktopApi("POST", "/api/mcp/servers", { name: "parentcheck", command: process.execPath, args: [COMMAND_SERVER, marker] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    let botId: string | undefined;
    try {
      const settings = await settingsTest("parentcheck");
      // the wrapper path works end to end: the Test's own release at the door lets the server's answers through
      expect(settings.view, JSON.stringify(settings.raw)).toEqual({ ok: true, tools: ["alpha", "beta"] });
      const underTest = JSON.parse(readFileSync(marker, "utf8")) as { parent: string[] };
      expect((await desktopApi("PATCH", "/api/mcp/servers/parentcheck", { enabled: true })).status).toBe(200);
      botId = (await desktopApi("POST", "/api/bots", { name: "Parity parentcheck" })).body.bot.id as string;
      turn = await startInternalFixtureTurn(botId, undefined, "__fixture_hold_authority__");
      const mount = (turn.dump.mcpConfig.mcpServers as unknown as Record<string, { command: string; args: string[] }>).parentcheck!;
      // the chat runs the owner's command inside the wipe wrapper
      expect(mount.args[0]).toMatch(/mcp-wipe-proxy\.(ts|js)$/);
      // THE parity: the process that started the server under Test is the process a chat's engine starts
      // (node's own --flags, which the server's spawn helper puts before the script for every child it starts, are not
      // part of the mount)
      expect(underTest.parent.filter((arg, at) => at === 0 || at >= underTest.parent.indexOf(mount.args[0]!) || !arg.startsWith("--"))).toEqual([mount.command, ...mount.args]);
    } finally {
      if (turn && botId) await stopFixtureTurn(botId, turn);
      if (botId) await desktopApi("DELETE", `/api/bots/${botId}`);
      await desktopApi("DELETE", "/api/mcp/servers/parentcheck");
    }
  });

  it.skipIf(process.platform !== "linux")("W4b a command server whose stdout carries a line that is not MCP fails Test, as it gives every chat no tools (the chat's wrapper refuses it)", async () => {
    const marker = join(scratch, "w4b-parent.json");
    const created = await desktopApi("POST", "/api/mcp/servers", { name: "bareonly", command: process.execPath, args: [COMMAND_SERVER, marker, "banner"] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    try {
      const settings = await settingsTest("bareonly");
      // the server really was started (so this is its own failure under the wrapper, not a launch problem)
      expect(existsSync(marker)).toBe(true);
      // a bare client skips the line and lists the tools; a chat never talks to it bare, so Test must not pass
      expect(settings.view, JSON.stringify(settings.raw)).toEqual({ ok: false });
      expect(settings.raw.reason).toBe("protocol");
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/bareonly");
    }
  });

  // Regression guard for this lane's own change (green on base, where Test started the bare command): the chat's
  // wrapper drops a server that has not answered initialize within 10 s, which would end every first Test of a
  // package that is still downloading. The add flow's first Test keeps its installer window through the wrapper.
  it.skipIf(process.platform !== "linux")("W4c a first Test of an installer command that needs longer than the wrapper's start window still passes (first-run patience reaches the wrapper)", async () => {
    const marker = join(scratch, "w4c-parent.json");
    const created = await desktopApi("POST", "/api/mcp/servers", { name: "slowinstall", command: INSTALLER, args: [COMMAND_SERVER, marker, "slow-start"] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    try {
      const tested = await desktopApi("POST", "/api/mcp/servers/slowinstall/test", { patience: "first-run" });
      expect(tested.status, JSON.stringify(tested.body)).toBe(200);
      expect({ ok: tested.body.ok, reason: tested.body.reason, tools: (tested.body.tools ?? []).map((tool: { name: string }) => tool.name).sort() })
        .toEqual({ ok: true, reason: undefined, tools: ["alpha", "beta"] });
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/slowinstall");
    }
  }, 60_000);
});
