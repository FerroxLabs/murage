// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls 1.0.9 (design BOT-CALLS-109 5.10): needs_owner_now on the agents tool server. Listed only when the harness
// says so (MURAGE_NEEDS_OWNER_NOW=1, never on a proposal turn); it forwards the line to /api/internal/needs-owner-now and
// answers "Noted." whatever the harness says, so the model never learns whether a call follows.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const open: Array<{ child: ChildProcess; stub: Server }> = [];
afterEach(async () => {
  for (const { child, stub } of open.splice(0)) { child.kill(); await new Promise<void>(r => stub.close(() => r())); }
});

async function start(env: Record<string, string>, status: number) {
  const seen: Array<{ path: string; body: string; auth: string }> = [];
  const stub = createServer((req, res) => {
    let body = ""; req.on("data", c => { body += c; });
    req.on("end", () => { seen.push({ path: req.url ?? "", body, auth: String(req.headers.authorization) }); res.writeHead(status, { "content-type": "application/json" }); res.end(status === 200 ? '{"text":"Noted."}' : '{"error":"no"}'); });
  });
  await new Promise<void>(r => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as { port: number }).port;
  const child = spawn(process.execPath, [PROXY], { env: { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${port}`, MURAGE_BOT_ID: "scout", MURAGE_THREAD_ID: "t1",
    MURAGE_COMMS_TOKEN: "tok-bc109", MURAGE_TURN_DEPTH: "0", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  open.push({ child, stub });
  const pending = new Map<number, (m: { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }) => void>();
  let buf = ""; let n = 0;
  child.stdout!.on("data", c => {
    buf += c; let nl;
    while ((nl = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); }
  });
  const rpc = (method: string, params?: unknown) => new Promise<Parameters<typeof pending.set>[1] extends (m: infer M) => void ? M : never>(resolve => {
    const id = ++n; pending.set(id, resolve as never); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05" });
  return { rpc, seen };
}

describe("needs_owner_now (5.10)", () => {
  it("is not listed unless the harness offers it, and never on a proposal turn", async () => {
    const off = await start({}, 200);
    expect((await off.rpc("tools/list")).result!.tools!.map(t => t.name)).not.toContain("needs_owner_now");
    const proposal = await start({ MURAGE_NEEDS_OWNER_NOW: "1", MURAGE_PROJECT_ROLE: "proposal" }, 200);
    expect((await proposal.rpc("tools/list")).result!.tools!.map(t => t.name)).not.toContain("needs_owner_now");
  }, 30_000);
  it("forwards the line with the turn's token and answers Noted. even when the harness refuses", async () => {
    for (const status of [200, 500]) {
      const on = await start({ MURAGE_NEEDS_OWNER_NOW: "1" }, status);
      expect((await on.rpc("tools/list")).result!.tools!.map(t => t.name)).toContain("needs_owner_now");
      const r = await on.rpc("tools/call", { name: "needs_owner_now", arguments: { line: "The deploy is stuck" } });
      expect(r.result!.isError).toBeFalsy();
      expect(r.result!.content![0]!.text).toBe("Noted.");
      expect(on.seen.at(-1)).toEqual({ path: "/api/internal/needs-owner-now", body: JSON.stringify({ line: "The deploy is stuck" }), auth: "Bearer tok-bc109" });
    }
  }, 30_000);
});
