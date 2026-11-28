// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: the chat MCP stop (chat-mcp-client.ts ChatMcpDescendants / openChatMcpServers). TRAIN-1024 S08 (N8): when a chat is
// stopped, the tool child processes it spawned (exact pids) are ended AND logged, so none outlives the chat unnoticed.
// Everything is real: the MCP server is a real child started through openChatMcpServers, it starts one helper in the
// server's process group and one in its own session (setsid-style, beyond the group signal), and the stop is the session's
// own close(). Only console output is captured. A bystander process the chat did not spawn must never be named or ended.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { removeTempDirSync } from "../testing/cleanup.ts";
import { fixtureMcpServers } from "../testing/mcp-admission-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import type { ChildTeardown } from "./child-teardown.ts";
import { openChatMcpServers, type ChatMcpSession } from "./chat-mcp-client.ts";

const SERVER = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const sleeper = ["-e", "setInterval(() => {}, 1000)"];
const inGroup = spawn(process.execPath, sleeper, { stdio: "ignore" });
const escaped = spawn(process.execPath, sleeper, { stdio: "ignore", detached: true });
writeFileSync(process.env.PID_FILE, [process.pid, inGroup.pid, escaped.pid].join(" "));
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "t", inputSchema: { type: "object" } }] });
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));
`;

let dir: string;
const cleanup: Array<() => void> = [];
const opened: ChatMcpSession[] = [];
const spawned: ChildTeardown[] = [];
const lines: string[] = [];

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "chat-mcp-stop-pid-")); writeFileSync(join(dir, "server.mjs"), SERVER); });
afterAll(() => removeTempDirSync(dir));
beforeEach(() => {
  lines.length = 0;
  for (const level of ["info", "log", "warn"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of opened.splice(0)) session.close();
  await Promise.all(spawned.splice(0).map((teardown) => teardown.wait({ closeMs: 3_000, maxMs: 8_000 })));
  for (const fn of cleanup.splice(0)) fn();
});

const running = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch { return process.platform !== "linux"; }
};

it.skipIf(process.platform === "win32")("a stopped chat ends the exact tool pids it spawned and logs each one; a bystander is neither ended nor named", async () => {
  const pidFile = join(dir, "pids.txt");
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  cleanup.push(() => { try { process.kill(bystander.pid!, "SIGKILL"); } catch { /* gone */ } });
  const result = await openChatMcpServers(fixtureMcpServers({ one: { command: process.execPath, args: [join(dir, "server.mjs")], env: { PID_FILE: pidFile } } }), {
    cwd: fixtureBotFolder(),
    onSpawn: (_server, teardown) => { spawned.push(teardown); },
  });
  opened.push(...result.sessions);
  expect(result.sessions).toHaveLength(1);
  expect(existsSync(pidFile)).toBe(true);
  const [server, inGroup, escaped] = readFileSync(pidFile, "utf8").split(" ").map(Number) as [number, number, number];
  for (const pid of [server, inGroup, escaped]) expect(running(pid)).toBe(true);

  // the chat is stopped: the session's own close, then the confirmed teardown
  result.sessions[0]!.close();
  const confirmed = await spawned[0]!.wait({ closeMs: 8_000, maxMs: 15_000 });
  expect(confirmed.closeConfirmed).toBe(true);

  for (const pid of [server, inGroup, escaped]) expect(running(pid)).toBe(false);
  expect(running(bystander.pid!)).toBe(true);
  const stop = lines.filter((line) => line.includes("[chat-mcp]") && /stop/i.test(line));
  const record = stop.join("\n");
  for (const pid of [server, inGroup, escaped]) expect(record).toMatch(new RegExp(`\\b${pid}\\b`));
  expect(record).not.toMatch(new RegExp(`\\b${bystander.pid}\\b`));
  const endedList = /ended \[([\d, ]*)\]/.exec(record)?.[1]?.split(", ").map(Number).sort((a, b) => a - b);
  expect(endedList).toEqual([inGroup, escaped].sort((a, b) => a - b));
  expect(record).toContain("survived []");
  // q1024-weakfix (AUDIT-WEAK orphantool): the record is ONE line per stop with each field in its own slot, so a pid that only appears
  // somewhere in the text, or a record that drops its separate `spawned` list, does not pass: the server pid is the root, the two helpers
  // are the spawned list (in the order they were seen, as a set), and the same two are the ended list.
  expect(stop).toHaveLength(1);
  const fields = /server pid (\d+); tool processes spawned \[([\d, ]*)\]; ended \[([\d, ]*)\]; survived \[([\d, ]*)\]$/.exec(stop[0]!);
  expect(fields, stop[0]).not.toBeNull();
  const numbers = (list: string) => list.split(", ").filter(Boolean).map(Number).sort((a, b) => a - b);
  expect(Number(fields![1])).toBe(server);
  expect(numbers(fields![2]!)).toEqual([inGroup, escaped].sort((a, b) => a - b));
  expect(numbers(fields![3]!)).toEqual(numbers(fields![2]!));
  expect(numbers(fields![4]!)).toEqual([]);
}, 40_000);

// A helper that outlives SIGTERM and SIGKILL for as long as the stop waits (the signals are dropped here, as a process stuck in the
// kernel would drop them) is named as a survivor in the stop record; when it finally exits, ONE late record says so and lists it as
// ended. Only the delivery of the signals to that one pid is withheld: the server, the teardown, the process listing and the exit are real.
it.skipIf(process.platform === "win32")("a helper that outlives the stop is recorded as surviving, and its late exit is recorded as ended", async () => {
  const pidFile = join(dir, "pids-late.txt");
  const realKill = process.kill.bind(process);
  let withheld: number | null = null;
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => (pid === withheld && (signal === "SIGTERM" || signal === "SIGKILL") ? true : realKill(pid, signal as never))) as typeof process.kill);
  const result = await openChatMcpServers(fixtureMcpServers({ one: { command: process.execPath, args: [join(dir, "server.mjs")], env: { PID_FILE: pidFile } } }), {
    cwd: fixtureBotFolder(),
    onSpawn: (_server, teardown) => { spawned.push(teardown); },
  });
  opened.push(...result.sessions);
  const [server, inGroup, escaped] = readFileSync(pidFile, "utf8").split(" ").map(Number) as [number, number, number];
  cleanup.push(() => { try { realKill(escaped, "SIGKILL"); } catch { /* gone */ } });
  withheld = escaped;
  result.sessions[0]!.close();
  const confirmed = await spawned[0]!.wait({ closeMs: 8_000, maxMs: 15_000 });
  expect(confirmed.closeConfirmed).toBe(false);
  const records = () => lines.filter((line) => line.includes("[chat-mcp] stop of MCP server"));
  await vi.waitFor(() => expect(records()).toHaveLength(1), { timeout: 10_000 });
  expect(records()[0]).toContain(`survived [${escaped}]`);
  expect(records()[0]).not.toContain("(late exit)");
  expect(running(inGroup)).toBe(false);
  expect(running(escaped)).toBe(true);
  withheld = null;
  realKill(escaped, "SIGKILL");
  await vi.waitFor(() => expect(records()).toHaveLength(2), { timeout: 15_000 });
  const late = records()[1]!;
  expect(late).toContain("(late exit)");
  expect(late).toContain(`server pid ${server};`);
  expect(late).toMatch(new RegExp(`ended \\[[\\d, ]*\\b${escaped}\\b[\\d, ]*\\]; survived \\[\\]$`));
}, 60_000);

// Windows: the engine job holds the tool processes, so no child pid is listed. The record must come only after the tree stop is
// confirmed, and must say so when it is not. The platform value is the only injected thing; the child, the kill and the
// confirmation (chatMcpTeardown -> awaitCliTreeStopped) are real.
const winTeardown = async (owned = true) => {
  const { ChatMcpDescendants, chatMcpTeardown } = await import("./chat-mcp-client.ts");
  const { killCliTree, spawnCli, engineJob } = await import("../procs.ts");
  const sleeper = ["-e", "setInterval(() => {}, 1000)"];
  // a child the stop machinery never owned: awaitCliTreeStopped has nothing to stop and answers "not confirmed"
  const child = owned ? spawnCli(process.execPath, sleeper, { cwd: fixtureBotFolder(), stdio: "ignore" }, engineJob({ ownerTurn: false })) : spawn(process.execPath, sleeper, { stdio: "ignore" });
  cleanup.push(() => { try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ } });
  const teardown = chatMcpTeardown(child, new ChatMcpDescendants(child, "win32"));
  spawned.push(teardown);
  const record = () => lines.filter((line) => line.includes("[chat-mcp]") && /stop/i.test(line)).join("\n");
  return { child, teardown, record, kill: () => killCliTree(child) };
};

it("Windows: no stop record is written before the tree stop is confirmed, then it names the server pid and says confirmed", async () => {
  const { child, teardown, record, kill } = await winTeardown();
  // a wait that nobody asked to stop confirms nothing and must log nothing
  await teardown.wait({ closeMs: 100, maxMs: 300 });
  expect(record()).toBe("");
  teardown.markStopRequested();
  kill();
  expect((await teardown.wait({ closeMs: 3_000, maxMs: 10_000 })).closeConfirmed).toBe(true);
  expect(record()).toMatch(new RegExp(`\\b${child.pid}\\b`));
  expect(record()).toMatch(/engine job/);
  expect(record()).toMatch(/was confirmed/);
  expect(record()).not.toMatch(/NOT confirmed|ended with it/);
}, 20_000);

it("Windows: a tree stop that is not confirmed is never recorded as ended", async () => {
  const { child, teardown, record } = await winTeardown(false);
  teardown.markStopRequested();
  const result = await teardown.wait({ closeMs: 200, maxMs: 2_500 });
  expect(result.closeConfirmed).toBe(false);
  expect(running(child.pid!)).toBe(true);
  expect(record()).not.toMatch(/ended with it|was confirmed/);
  expect(record()).toMatch(/NOT confirmed/);
}, 20_000);

it("Windows: a server that exits on its own, with no stop asked for, writes no stop record", async () => {
  const { child, teardown, record } = await winTeardown();
  process.kill(child.pid!, "SIGKILL");
  await teardown.wait({ closeMs: 3_000, maxMs: 6_000 });
  expect(record()).toBe("");
}, 20_000);
