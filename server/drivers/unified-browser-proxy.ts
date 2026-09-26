// No native ports, encryption keys, or engine paths cross the turn boundary.
import { pathToFileURL } from "node:url";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
/** Murage's own refusal, word for word, and nothing else: the server marks
 * the sentences it wrote for the bot with a `browser_` code, and any other
 * error body (which could quote a page) is never forwarded. */
async function refusalReason(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length > 4096) return undefined;
    const body = JSON.parse(text) as { error?: unknown; code?: unknown };
    return typeof body.code === "string" && body.code.startsWith("browser_") && typeof body.error === "string" ? body.error : undefined;
  } catch { return undefined; }
}
export async function runUnifiedBrowserProxy(env: NodeJS.ProcessEnv = process.env) {
  const base = new URL(env.MURAGE_CONTROL_URL!);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !env.MURAGE_CONTROL_TOKEN) throw new Error("Missing browser authority");
  const url = new URL("/api/internal/unified-browser", base);
  url.searchParams.set("botId", env.MURAGE_BOT_ID!); url.searchParams.set("threadId", env.MURAGE_THREAD_ID!);
  // Longer for "Use my Chrome", whose first call waits on the owner's Allow.
  const callTimeout = Math.min(600_000, Math.max(60_000, Number(env.MURAGE_BROWSER_CALL_TIMEOUT_MS) || 60_000));
  const lines: string[] = [];
  const splitter = createLineSplitter(line => lines.push(line), 64 * 1024);
  const drain = async () => {
    for (const line of lines.splice(0)) {
      let rpc: { id?: number | string; method?: string; params?: Record<string, unknown> };
      try { rpc = JSON.parse(line); } catch { continue; }
      if (rpc.id === undefined) continue;
      let result: unknown;
      let failure: string | undefined;
      try {
        if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-browser", version: "1" } };
        else if (rpc.method === "ping") result = {};
        else {
          const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${env.MURAGE_CONTROL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ method: rpc.method, params: rpc.params }), redirect: "error", signal: AbortSignal.timeout(callTimeout) });
          if (!response.ok) { failure = await refusalReason(response); throw new Error(); }
          if (!response.body) throw new Error();
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 16 * 1024 * 1024) throw new Error(); chunks.push(chunk.value); } }
          catch (error) { await reader.cancel(); throw error; }
          finally { reader.releaseLock(); }
          result = JSON.parse(Buffer.concat(chunks).toString());
        }
      } catch {
        const text = failure ?? "Browser unavailable or control changed. Ask the owner to open the browser panel.";
        // A tool call fails as a tool result the model reads. Anything else
        // (tools/list above all) fails as a JSON-RPC error: a "result" with
        // no tools in it connected the server with zero tools and no reason.
        if (rpc.method !== "tools/call") { await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: text } })); continue; }
        result = { isError: true, content: [{ type: "text", text }] };
      }
      await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    }
  };
  for await (const chunk of process.stdin) { splitter.push(chunk); await drain(); }
  splitter.flush(); await drain();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runUnifiedBrowserProxy().catch(() => { process.exitCode = 1; });
