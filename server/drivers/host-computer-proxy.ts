// Only scoped harness authority crosses into the model's MCP process.
import { pathToFileURL } from "node:url";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";

export async function runHostComputerProxy(env: NodeJS.ProcessEnv = process.env) {
  const base = new URL(env.MURAGE_CONTROL_URL!);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !env.MURAGE_CONTROL_TOKEN || !env.MURAGE_BOT_ID || !env.MURAGE_THREAD_ID) throw new Error("Missing computer authority");
  const url = new URL("/api/internal/host-computer", base);
  url.searchParams.set("botId", env.MURAGE_BOT_ID); url.searchParams.set("threadId", env.MURAGE_THREAD_ID);
  const unavailable = "Computer action unavailable, busy, or control changed. A failed response does not prove the action stopped. Inspect the screen before retrying.";
  const stopped = "Stopped: this computer action was cancelled. An action already sent to the computer may still have taken effect. Inspect the screen before continuing.";
  // Requests still run one at a time, but stdin keeps being read while one is
  // in flight so the engine's `notifications/cancelled` can withdraw it.
  const withdrawable = new Map<string, AbortController>();
  const key = (id: unknown) => JSON.stringify(id);
  const call = async (rpc: { id: number | string; method?: string; params?: Record<string, unknown> }, withdrawn: AbortController) => {
    if (withdrawn.signal.aborted) return;
    let result: unknown;
    try {
      if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-host-computer", version: "1" } };
      else if (rpc.method === "ping") result = {};
      else {
        const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${env.MURAGE_CONTROL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ method: rpc.method, params: rpc.params }), redirect: "error", signal: AbortSignal.any([withdrawn.signal, AbortSignal.timeout(65_000)]) });
        if ((!response.ok && response.status !== 409) || !response.body) throw new Error();
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 16 * 1024 * 1024) throw new Error(); chunks.push(chunk.value); } }
        catch (error) { await reader.cancel(); throw error; }
        finally { reader.releaseLock(); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (response.status === 409) result = { isError: true, content: [{ type: "text", text: body?.code === "cancelled" ? stopped : unavailable }] };
        else result = body;
      }
    } catch { result = { isError: true, content: [{ type: "text", text: unavailable }] }; }
    finally { if (withdrawable.get(key(rpc.id)) === withdrawn) withdrawable.delete(key(rpc.id)); }
    // MCP: a request the client cancelled gets no response.
    if (withdrawn.signal.aborted) return;
    await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  };
  let queue = Promise.resolve();
  const splitter = createLineSplitter(line => {
    let rpc: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try { rpc = JSON.parse(line); } catch { return; }
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled") withdrawable.get(key(rpc.params?.requestId))?.abort();
      return;
    }
    const withdrawn = new AbortController();
    withdrawable.set(key(rpc.id), withdrawn);
    const request = { ...rpc, id: rpc.id };
    queue = queue.then(() => call(request, withdrawn));
  }, 64 * 1024);
  for await (const chunk of process.stdin) splitter.push(chunk);
  splitter.flush(); await queue;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runHostComputerProxy().catch(() => { process.exitCode = 1; });
