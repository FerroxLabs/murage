// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1020 nolimits dump race. A mounted turn's stop reads the MCP server's descendants BEFORE it signals the group, bounded by
// CHAT_MCP_SNAPSHOT_CAP_MS. Under host load the `ps` the snapshot spawned answered after the cap, the stop went blind, and a blind
// stop can never be confirmed: cli-mount-relay.ts kept the bot quarantined and refused every later turn (MOUNT_RELAY_STOP_UNCONFIRMED),
// so a test file failed at its first turn after the miss, and every turn after it, until the server was restarted.
// The interleaving is forced here, not produced by load: the process-table probe (execFile) never answers.
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), execFile: vi.fn(() => undefined) }));

const { ChatMcpDescendants } = await import("./chat-mcp-client.ts");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform !== "linux")("a stop's descendant snapshot does not depend on a process-table probe answering in time (Linux)", () => {
  it("S1 a server with no descendants is confirmed gone although the probe never answers", async () => {
    const root = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      expect(await new ChatMcpDescendants(root).stop()).toBe(true);
    } finally { root.kill("SIGKILL"); }
  }, 15_000);

  it("S2 a descendant is found, ended and confirmed gone although the probe never answers", async () => {
    const root = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const pid = await new Promise<number>((resolve) => root.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
      expect(alive(pid)).toBe(true);
      const descendants = new ChatMcpDescendants(root);
      expect(await descendants.stop()).toBe(true);
      expect(alive(pid)).toBe(false);
    } finally { root.kill("SIGKILL"); }
  }, 15_000);
});
