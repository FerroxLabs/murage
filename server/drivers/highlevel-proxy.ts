// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The native HighLevel MCP proxy (GAP-HIGHLEVEL-109 sections 8 and 12 D): a stdio MCP server the engine mounts as
// "highlevel". It decides nothing. Each JSON-RPC request is forwarded as it is to /api/internal/highlevel/mcp with the
// turn's `highlevel` capability token, and the harness host (server/highlevel/host.ts) answers: catalog, authorization,
// owner review and receipts all live there, so every engine gets the same checks. It holds no CRM credential.
import { request as httpRequest } from "node:http";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
import { turnSecret, turnSecretWired } from "../turn-credential.ts";

export const HIGHLEVEL_MCP_ROUTE = "/api/internal/highlevel/mcp";
const RESPONSE_MAX = 4 * 1024 * 1024;
const UNAVAILABLE = "HighLevel is not available in this conversation.";

/** One loopback POST with no clock; `signal` withdraws it (a review wait ends when the engine cancels). */
function post(url: URL, token: string, body: string, signal: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", signal, agent: false, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_MAX) { req.destroy(new Error("too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function runHighLevelProxy(env: NodeJS.ProcessEnv = process.env, io: { stdin: AsyncIterable<Buffer | string>; stdout: Writable } = { stdin: process.stdin, stdout: process.stdout }): Promise<void> {
  const base = new URL(env.MURAGE_CONTROL_URL ?? "http://invalid");
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !turnSecretWired("MURAGE_CONTROL_TOKEN", env)) throw new Error("Missing HighLevel authority");
  const url = new URL(HIGHLEVEL_MCP_ROUTE, base);
  const withdrawable = new Map<string, AbortController>();
  const key = (id: unknown) => JSON.stringify(id);
  const forward = async (rpc: { id: number | string; method?: unknown; params?: unknown }, withdrawn: AbortController) => {
    if (withdrawn.signal.aborted) return;
    let reply: unknown;
    try {
      const response = await post(url, turnSecret("MURAGE_CONTROL_TOKEN", env), JSON.stringify({ jsonrpc: "2.0", id: rpc.id, method: rpc.method, ...(rpc.params === undefined ? {} : { params: rpc.params }) }), withdrawn.signal);
      const parsed = JSON.parse(response.body) as { jsonrpc?: unknown; result?: unknown; error?: unknown };
      if (response.status === 200 && parsed && parsed.jsonrpc === "2.0" && ("result" in parsed || "error" in parsed)) reply = { ...parsed, id: rpc.id };
    } catch { /* answered below */ }
    finally { if (withdrawable.get(key(rpc.id)) === withdrawn) withdrawable.delete(key(rpc.id)); }
    if (withdrawn.signal.aborted) return;
    // A refused or broken answer is a tool error for a call and a JSON-RPC error otherwise; it never claims success.
    reply ??= rpc.method === "tools/call"
      ? { jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: UNAVAILABLE }] } }
      : { jsonrpc: "2.0", id: rpc.id, error: { code: -32001, message: UNAVAILABLE } };
    await writeMcpLine(io.stdout, JSON.stringify(reply));
  };
  let queue = Promise.resolve();
  const splitter = createLineSplitter((line) => {
    let rpc: { id?: number | string; method?: unknown; params?: Record<string, unknown> };
    try { rpc = JSON.parse(line); } catch { return; }
    if (!rpc || typeof rpc !== "object") return;
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled") withdrawable.get(key(rpc.params?.requestId))?.abort();
      return;
    }
    const withdrawn = new AbortController();
    withdrawable.set(key(rpc.id), withdrawn);
    const request = { ...rpc, id: rpc.id };
    queue = queue.then(() => forward(request, withdrawn));
  }, 64 * 1024);
  for await (const chunk of io.stdin) splitter.push(chunk);
  splitter.flush();
  for (const withdrawn of withdrawable.values()) withdrawn.abort();
  await queue;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runHighLevelProxy().catch(() => { process.exitCode = 1; });
