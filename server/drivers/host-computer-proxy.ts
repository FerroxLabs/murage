// Only scoped harness authority crosses into the model's MCP process.
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
import { turnSecret, turnSecretWired } from "../turn-credential.ts";

/** One loopback POST with no clock; `signal` withdraws it. At most 16 MB back. */
function post(url: URL, token: string, body: string, signal: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", signal, agent: false, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { req.destroy(new Error("too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function runHostComputerProxy(env: NodeJS.ProcessEnv = process.env) {
  const base = new URL(env.MURAGE_CONTROL_URL!);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !turnSecretWired("MURAGE_CONTROL_TOKEN", env) || !env.MURAGE_BOT_ID || !env.MURAGE_THREAD_ID) throw new Error("Missing computer authority");
  const url = new URL("/api/internal/host-computer", base);
  url.searchParams.set("botId", env.MURAGE_BOT_ID); url.searchParams.set("threadId", env.MURAGE_THREAD_ID);
  const unavailable = "Computer action unavailable, busy, or control changed. A failed response does not prove the action stopped. Inspect the screen before retrying.";
  const stopped = "Stopped: this computer action was cancelled. An action already sent to the computer may still have taken effect. Inspect the screen before continuing.";
  // Requests still run one at a time, but stdin keeps being read while one is
  // in flight so the engine's `notifications/cancelled` can withdraw it.
  // There is no clock on an action: it ends when it answers, when it is
  // withdrawn (Stop, or the engine closing this tool), or when the harness
  // revokes the turn (its Stop, or the turn's silence limit).
  const withdrawable = new Map<string, AbortController>();
  const key = (id: unknown) => JSON.stringify(id);
  const call = async (rpc: { id: number | string; method?: string; params?: Record<string, unknown> }, withdrawn: AbortController) => {
    if (withdrawn.signal.aborted) return;
    let result: unknown;
    try {
      if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-host-computer", version: "1" } };
      else if (rpc.method === "ping") result = {};
      else {
        // node:http, not fetch: fetch gives up on a reply that takes over five
        // minutes (its default header and body timeouts)
        const response = await post(url, turnSecret("MURAGE_CONTROL_TOKEN", env), JSON.stringify({ method: rpc.method, params: rpc.params }), withdrawn.signal);
        if (response.status !== 200 && response.status !== 409) throw new Error();
        const body = JSON.parse(response.body);
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
  splitter.flush();
  // The engine closed this tool: withdraw what is in flight and queued.
  for (const withdrawn of withdrawable.values()) withdrawn.abort();
  await queue;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runHostComputerProxy().catch(() => { process.exitCode = 1; });
