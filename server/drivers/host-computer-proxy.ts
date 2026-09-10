// Only scoped harness authority crosses into the model's MCP process.
import { pathToFileURL } from "node:url";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";

export async function runHostComputerProxy(env: NodeJS.ProcessEnv = process.env) {
  const base = new URL(env.MURAGE_CONTROL_URL!);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !env.MURAGE_CONTROL_TOKEN || !env.MURAGE_BOT_ID || !env.MURAGE_THREAD_ID) throw new Error("Missing computer authority");
  const url = new URL("/api/internal/host-computer", base);
  url.searchParams.set("botId", env.MURAGE_BOT_ID); url.searchParams.set("threadId", env.MURAGE_THREAD_ID);
  const lines: string[] = [];
  const splitter = createLineSplitter(line => lines.push(line), 64 * 1024);
  const drain = async () => {
    for (const line of lines.splice(0)) {
      let rpc: { id?: number | string; method?: string; params?: Record<string, unknown> };
      try { rpc = JSON.parse(line); } catch { continue; }
      if (rpc.id === undefined) continue;
      let result: unknown;
      try {
        if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-host-computer", version: "1" } };
        else if (rpc.method === "ping") result = {};
        else {
          const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${env.MURAGE_CONTROL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ method: rpc.method, params: rpc.params }), redirect: "error", signal: AbortSignal.timeout(65_000) });
          if (!response.ok || !response.body) throw new Error();
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 16 * 1024 * 1024) throw new Error(); chunks.push(chunk.value); } }
          catch (error) { await reader.cancel(); throw error; }
          finally { reader.releaseLock(); }
          result = JSON.parse(Buffer.concat(chunks).toString());
        }
      } catch { result = { isError: true, content: [{ type: "text", text: "Computer action unavailable, busy, or control changed. A failed response does not prove the action stopped. Inspect the screen before retrying." }] }; }
      await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    }
  };
  for await (const chunk of process.stdin) { splitter.push(chunk); await drain(); }
  splitter.flush(); await drain();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runHostComputerProxy().catch(() => { process.exitCode = 1; });
