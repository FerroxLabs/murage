// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 9 (S6): the fake ACP engine's agents capability file is created new,
// owner-only, and never written through a link left at its path.
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("replaces a stale link or file at the capability path with a new 0600 file", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-fake-acp-capability-"));
  const target = join(root, "elsewhere.txt"), capability = join(root, "agents.json");
  writeFileSync(target, "UNTOUCHED", { mode: 0o644 });
  symlinkSync(target, capability);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, FAKE_ACP_AGENTS_CAPABILITY: capability },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: Array<{ id?: number }> = [];
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    for (;;) { const end = pending.indexOf("\n"); if (end < 0) break; frames.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); }
  });
  const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  try {
    send(1, "initialize", { protocolVersion: 1 });
    await expect.poll(() => frames.find((frame) => frame.id === 1), { timeout: 3000 }).toBeTruthy();
    send(2, "session/new", { cwd: root, mcpServers: [{ name: "agents", command: "x", args: [], env: [{ name: "TOKEN", value: "fixture" }] }] });
    await expect.poll(() => frames.find((frame) => frame.id === 2), { timeout: 3000 }).toBeTruthy();
    expect(readFileSync(target, "utf8")).toBe("UNTOUCHED");
    const stat = lstatSync(capability);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(capability, "utf8"))).toEqual([{ name: "TOKEN", value: "fixture" }]);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
