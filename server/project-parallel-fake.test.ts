// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it.each([["parallel-card", false], ["cancel-ack", true], ["parallel-card-retry", false], ["parallel-card-retry", true]] as const)("%s publishes prompt acceptance while held (cancel: %s)", async (mode, cancel) => {
  const root = mkdtempSync(join(tmpdir(), "parallel-proof-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url))], { env: { ...process.env, FAKE_ACP_MODE: mode, FAKE_ACP_ACCEPT_DIR: root, FAKE_ACP_GATE_FILE: join(root, "finish"), FAKE_ACP_FAIL_ONCE_FILE: join(root, "failed") }, stdio: ["pipe", "pipe", "pipe"] });
  const messages: any[] = []; let buffer = "";
  child.stdout.on("data", chunk => { buffer += chunk.toString(); let i: number; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) messages.push(JSON.parse(line)); } });
  const prompt = (id: number) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "desk", prompt: [{ type: "text", text: cancel ? "Work on card 1\n__fixture_cancel_ack__" : "Work on card 1" }] } }) + "\n");
  try {
    prompt(1);
    if (mode === "parallel-card-retry") {
      await expect.poll(() => messages.find(m => m.id === 1)?.error?.message).toContain("429");
      expect(readdirSync(root).filter(f => f.endsWith(".accepted"))).toHaveLength(0);
      prompt(2);
    }
    await expect.poll(() => readdirSync(root).filter(f => f.endsWith(".accepted")).length).toBe(1);
    const id = mode === "parallel-card-retry" ? 2 : 1;
    expect(messages.some(m => m.id === id)).toBe(false);
    if (cancel) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "desk" } }) + "\n");
    else writeFileSync(join(root, "finish"), "finish");
    await expect.poll(() => messages.find(m => m.id === id)?.result?.stopReason).toBe(cancel ? "cancelled" : "end_turn");
  } finally {
    const closed = once(child, "close"); child.kill(); await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
