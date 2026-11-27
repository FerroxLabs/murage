// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 cause22 caps (Sean STANDING, MAIN-RULING local-memory-budget: an owner turn is never stopped, refused or sealed by a size or
// memory cap). Owners: lane cause22-caps owns the owner-turn behaviour of every cap this file drives (owner-turn-caps.ts and its
// callers); the harness, the fake remote MCP server and the fake Claude CLI belong to MCP-LINK T15 (mcp-link.e2e.test.ts).
//
// End to end, nothing of the path replaced: node server/index.ts as the desktop app runs it, the owner's own remote MCP server
// (testing/fake-remote-mcp.ts) added through the real routes, the real spawned remote-mcp-proxy child, the real release door
// (/api/internal/turn-release/v1/verdict), the real mount relay and shim, and the fake Claude CLI calling the server's first tool.
// The server answers that call with one very large result. On c187b11166 each size below meets a different cap:
//   3 MiB JSON    cli-mount-relay.ts:172 (2 MiB stdio line): the relay seals, the owner's turn ends with the stop line
//   1.5 MiB SSE   remote-mcp-proxy.ts:138 (1 MiB event): the server is sealed for the turn, the call fails
//   12 MiB JSON   remote-mcp-proxy.ts:136/:67, proxy-turn-release.ts:183/:68, consuming-turn-ingress.ts decodeProxyFrame (8 MiB)
//   24 MiB room   the same on a room turn answering only the owner (the room binder says whose turn it is, index.ts), and the
//                 16 MiB bounds of the door body, the verdict answer and the release envelope
//   70 MiB JSON   over the 64 MiB ceiling: that one call gets the fixed line, the turn completes, the server stays usable
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { startDesktopShell, type DesktopShell } from "./testing/desktop-shell.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";
import { BUDGET_REFUSAL_LINE, LEDGER_REFUSAL_LINE } from "./ledger-refusal-line.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const MIB = 1024 * 1024;
const HEADER_VALUE = "caps-fixture";
// The fixed line of owner-turn-caps.ts, pinned here by its words (this file also runs on the base, where that module does not exist).
const OVERSIZE_RESULT_LINE = "This tool result was too large to pass on (over 64 MiB).";
const posixOnly = describe.skipIf(process.platform === "win32");

interface ToolLine { engine: string; server: string; tool?: string; text: string; isError: boolean }

let home = "", toolLog = "";
let shell: DesktopShell;
let big: FakeRemoteMcp;
let bot: { id: string; threadId: string };
let room: { id: string; threadId: string };

const toolLines = (): ToolLine[] => existsSync(toolLog) ? readFileSync(toolLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as ToolLine) : [];
/** A read of the harness's own state. A connection the harness reset under a heavy turn is asked again (reads only; never a send). */
async function read(path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try { return (await shell.desktop("GET", path)).body; }
    catch (error) { if (attempt >= 5) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
}
const messages = async (threadId: string) => (await read(`/api/threads/${threadId}/messages?limit=200`)).messages as Array<Record<string, any>>;
const directBusy = async () => Boolean(((await read("/api/bots?messages=0")).bots as Array<{ id: string; busy?: boolean }>).find(entry => entry.id === bot.id)?.busy);
const roomBusy = async () => Boolean(((await read("/api/bots?messages=0")).groups as Array<{ threadId: string; busyBotId?: string }>).find(group => group.threadId === room.threadId)?.busyBotId);
/** What the fake CLI reports for a tool text of `bytes` "x" after "hello from claude": its first 64 characters, its size and its digest. */
const reported = (pad: number) => {
  const text = "hello from claude" + "x".repeat(pad);
  return `${text.slice(0, 64)} [${Buffer.byteLength(text)} bytes sha256 ${createHash("sha256").update(text).digest("hex")}]`;
};

/** One owner turn asking for the big server's tool. Waits until the turn is over, however it ended (a reply, or a stop line), and
 * returns what it left: the fake CLI's tool line(s), the bot's new messages, and the harness log written meanwhile. Never throws on a
 * turn that ended badly: the caller's assertions say what was expected. */
async function ownerTurn(where: "direct" | "room", pad: number, respondWith: "json" | "sse" = "json") {
  big.options.toolResultPadBytes = pad;
  big.options.respondWith = respondWith;
  const threadId = where === "room" ? room.threadId : bot.threadId;
  const seen = new Set((await messages(threadId)).map(message => String(message.id)));
  const linesBefore = toolLines().length, logBefore = shell.stderr().length, callsBefore = big.toolCalls.length;
  const sent = await shell.desktop("POST", where === "room" ? `/api/groups/${room.id}/messages` : `/api/bots/${bot.id}/messages`, { threadId, text: "__custom_tool__:big use the big tool" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const fresh = async () => (await messages(threadId)).filter(message => !seen.has(String(message.id)) && message.role === "bot");
  const deadline = Date.now() + 240_000;
  let replies: Array<Record<string, any>> = [];
  for (;;) {
    replies = await fresh();
    const idle = !(await (where === "room" ? roomBusy() : directBusy()));
    if (idle && replies.some(message => typeof message.text === "string" && message.text.length > 0)) break;
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { lines: toolLines().slice(linesBefore), replies, told: JSON.stringify(replies), log: shell.stderr().slice(logBefore), calls: big.toolCalls.length - callsBefore };
}

posixOnly("cause22 caps: an owner turn is never stopped by the size of a tool result (real server, real proxy child, real relay)", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-cause22-caps-e2e-"));
    toolLog = join(home, "custom-tool.jsonl");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: { claude: { driver: "claudeAgent", environment: { FAKE_CUSTOM_TOOL_SERVER: "big", FAKE_CUSTOM_TOOL_LOG: toolLog, FAKE_CUSTOM_TOOL_TIMEOUT_MS: "200000" }, config: { cli: FAKE_CLAUDE } } },
    }));
    big = await startFakeRemoteMcp({ auth: "api-key", apiKey: HEADER_VALUE, apiKeyHeader: "x-api-key", unauthorized: "api-key-only", prm: false });
    shell = await startDesktopShell({ home });
    expect((await shell.desktop("POST", "/api/mcp/servers", { name: "big", url: big.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(201);
    expect(await shell.service.saveSecrets("big", { headers: { "x-api-key": HEADER_VALUE } })).toEqual({ ok: true });
    expect((await shell.desktop("POST", "/api/mcp/servers/big/test", {})).body).toMatchObject({ ok: true });
    expect((await shell.desktop("PATCH", "/api/mcp/servers/big", { enabled: true })).status).toBe(200);
    const created = await shell.desktop("POST", "/api/bots", { name: "Caps owner", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    bot = created.body.bot as { id: string; threadId: string };
    expect((await shell.desktop("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
    const group = await shell.desktop("POST", "/api/groups", { name: "Caps room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(group.status, JSON.stringify(group.body)).toBeLessThan(300);
    room = group.body.group as { id: string; threadId: string };
  }, 120_000);

  afterAll(async () => {
    await shell?.stop();
    await big?.close();
    if (home) await removeTempDir(home);
  });

  it("E0 control: an ordinary small result on the owner's turn", async () => {
    const turn = await ownerTurn("direct", 0);
    expect(turn.lines.map(line => ({ text: line.text, isError: line.isError }))).toEqual([{ text: "hello from claude", isError: false }]);
  }, 300_000);

  it.each([
    { name: "E1 a 3 MiB JSON result (over the 2 MiB stdio line of the mount relay)", pad: 3 * MIB, respondWith: "json" as const, where: "direct" as const },
    { name: "E2 a 1.5 MiB result as one SSE event (over the 1 MiB event cap of the proxy child)", pad: Math.floor(1.5 * MIB), respondWith: "sse" as const, where: "direct" as const },
    { name: "E3 a 12 MiB JSON result (over every 8 MiB frame and body cap)", pad: 12 * MIB, respondWith: "json" as const, where: "direct" as const },
    { name: "E4 a 24 MiB result on a room turn answering only the owner (over the 16 MiB door body, verdict answer and envelope bounds too)", pad: 24 * MIB, respondWith: "json" as const, where: "room" as const },
  ])("$name passes whole: the turn completes and its reply is delivered", async ({ pad, respondWith, where }) => {
    const turn = await ownerTurn(where, pad, respondWith);
    // the whole result reached the engine: size and digest of every byte, and no error
    expect(turn.lines.map(line => ({ text: line.text, isError: line.isError })), "the tool result reached the engine whole").toEqual([{ text: reported(pad), isError: false }]);
    // the owner's reply is delivered, and the turn was not ended by a stop line of either kind
    expect(turn.told, "the turn's reply is delivered").toContain(`custom tool said: ${reported(pad)}`);
    expect(turn.told, "no stop line").not.toContain(LEDGER_REFUSAL_LINE);
    expect(turn.told, "no budget stop line").not.toContain(BUDGET_REFUSAL_LINE);
    // nothing was refused, sealed or made unavailable on the way
    expect(turn.log, "no ledger refusal").not.toMatch(/\[memory\] ledger refusal/);
    expect(turn.log, "the relay was not sealed").not.toMatch(/seals the relay/);
    expect(turn.log, "the server stayed mounted").not.toMatch(/\[mount-relay\] mount unavailable/);
    expect(turn.calls, "the server was called once").toBe(1);
  }, 300_000);

  it("E5 a 70 MiB result (over the deleted 64 MiB ceiling) reaches the engine whole, the turn completes with its reply, and the next turn's call works", async () => {
    const turn = await ownerTurn("direct", 70 * MIB);
    // MAIN-RULING cause22-no-transport-caps (2026-11-22T14:29:39Z): the 64 MiB owner ceiling is deleted on the combined candidate (group D
    // upstream reader, group A relay/proxies, group C ingress), so this row asserts the whole result where it asserted the fixed line.
    expect(turn.lines.map(line => ({ text: line.text, isError: line.isError })), "the 70 MiB result reached the engine whole").toEqual([{ text: reported(70 * MIB), isError: false }]);
    expect(turn.told, "the turn completes and its reply is delivered").toContain(`custom tool said: ${reported(70 * MIB)}`);
    expect(turn.told, "never the old fixed line").not.toContain(OVERSIZE_RESULT_LINE);
    expect(turn.told).not.toContain(LEDGER_REFUSAL_LINE);
    expect(turn.told).not.toContain(BUDGET_REFUSAL_LINE);
    expect(turn.log, "the cut is not a refusal").not.toMatch(/\[memory\] ledger refusal/);
    expect(turn.log, "the relay was not sealed").not.toMatch(/seals the relay/);
    expect(turn.log, "the server stayed mounted").not.toMatch(/\[mount-relay\] mount unavailable/);
    const next = await ownerTurn("direct", MIB);
    expect(next.lines.map(line => ({ text: line.text, isError: line.isError })), "the server is still usable").toEqual([{ text: reported(MIB), isError: false }]);
  }, 600_000);

});
