// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A delegated turn's prompt ends in the delegation-context block (bf42746ca). Each fake engine must still see the marker ahead of it.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const pack = `<<page-content id=abc123 origin=yourchatwithsource kind=delegation-context>>\n{"rows":[]}\n<<end page-content id=abc123>>`;
const delegated = (marker: string) => `intro\n\n${marker} delegated target request\n\n${pack}`;

type Run = { send: (m: unknown) => void; frames: () => string[]; bytes: () => number; stop: () => void };
const run = (file: string, args: string[], env: Record<string, string> = {}): Run => {
  const child = spawn(process.execPath, [new URL(file, import.meta.url).pathname, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; let total = 0; const frames: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    total += c.length; buf += c;
    const parts = buf.split("\n"); buf = parts.pop() ?? "";
    for (const p of parts) frames.push(p.length > 4000 ? p.slice(0, 4000) : p);
  });
  return { send: (m) => { child.stdin.write(JSON.stringify(m) + "\n"); }, frames: () => frames, bytes: () => total, stop: () => { child.kill(); } };
};
const until = async (ok: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); return ok(); };
const hasId = (r: Run, id: number) => r.frames().some(f => { try { return (JSON.parse(f) as { id?: number }).id === id; } catch { return f.startsWith(`{"jsonrpc":"2.0","id":${id},`); } });

describe("fake engines see the marker ahead of a delegation-context block", () => {
  it("fake-acp-cli holds the prompt open (delegate-peer mode, FAKE_ACP_DELEGATE_TO set), then a cancel releases it", async () => {
    const r = run("./fake-acp-cli.ts", [], { FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "Helper" });
    try {
      r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
      r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
      expect(await until(() => hasId(r, 2))).toBe(true);
      r.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "fake-acp-session", prompt: [{ type: "text", text: delegated("__fixture_cancel_ack__") }] } });
      expect(await until(() => r.frames().some(f => f.includes("fixture cancellation ready")))).toBe(true);
      await new Promise(res => setTimeout(res, 300));
      expect(hasId(r, 3)).toBe(false);
      r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "fake-acp-session" } });
      expect(await until(() => hasId(r, 3))).toBe(true);
    } finally { r.stop(); }
  });
  it("fake-codex-app-server answers the large-frame fixture", async () => {
    const r = run("./fake-codex-app-server.ts", ["app-server"]);
    try {
      r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      r.send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: process.cwd() } });
      expect(await until(() => hasId(r, 2))).toBe(true);
      r.send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "t", input: [{ type: "text", text: delegated("__fixture_large_frame__") }] } });
      expect(await until(() => r.bytes() > 5_000_000)).toBe(true);
    } finally { r.stop(); }
  });
  it("fake-pi-cli answers the large-frame fixture", async () => {
    const r = run("./fake-pi-cli.ts", ["--mode", "rpc"]);
    try {
      r.send({ type: "prompt", id: "1", message: delegated("__fixture_large_frame__") });
      expect(await until(() => r.bytes() > 5_000_000)).toBe(true);
    } finally { r.stop(); }
  });
});
