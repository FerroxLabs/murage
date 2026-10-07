// No native ports, encryption keys, or engine paths cross the turn boundary.
import { pathToFileURL } from "node:url";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
import { BuiltinFloorGate, floorToolResult, readBrowserRefusal } from "../browser-floor-builtin.ts";
import { BROWSER_EXTENSION_CALL_TIMEOUT_MS } from "../../shared/browser-extension-protocol.ts";
import { turnSecret, turnSecretWired } from "../turn-credential.ts";
export async function runUnifiedBrowserProxy(env: NodeJS.ProcessEnv = process.env, options: { transport?: "builtin" | "extension" } = {}) {
  // Only the owner-controlled mount selects the extension executor as the floor authority.
  const transport = options.transport ?? env.MURAGE_BROWSER_TRANSPORT ?? "builtin";
  if (transport !== "builtin" && transport !== "extension") throw new Error("Unknown browser transport");
  const base = new URL(env.MURAGE_CONTROL_URL!);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !turnSecretWired("MURAGE_CONTROL_TOKEN", env)) throw new Error("Missing browser authority");
  const url = new URL("/api/internal/unified-browser", base);
  url.searchParams.set("botId", env.MURAGE_BOT_ID!); url.searchParams.set("threadId", env.MURAGE_THREAD_ID!);
  // Longer for "Use my Chrome", whose first call waits on the owner's Allow.
  const callTimeout = transport === "extension" ? BROWSER_EXTENSION_CALL_TIMEOUT_MS : Math.min(600_000, Math.max(60_000, Number(env.MURAGE_BROWSER_CALL_TIMEOUT_MS) || 60_000));
  const lines: string[] = [];
  const splitter = createLineSplitter(line => lines.push(line), 64 * 1024);
  const gate = transport === "builtin" ? new BuiltinFloorGate() : undefined;
  const forward = async (method: string | undefined, params: Record<string, unknown> | undefined): Promise<unknown> => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${turnSecret("MURAGE_CONTROL_TOKEN", env)}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }), redirect: "error", signal: AbortSignal.timeout(callTimeout) });
    if (!response.ok) { throw Object.assign(new Error(), { refusal: await readBrowserRefusal(response) }); }
    if (!response.body) throw new Error();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 16 * 1024 * 1024) throw new Error(); chunks.push(chunk.value); } }
    catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const drain = async () => {
    for (const line of lines.splice(0)) {
      let rpc: { id?: number | string; method?: string; params?: Record<string, unknown> };
      try { rpc = JSON.parse(line); } catch { continue; }
      if (rpc.id === undefined) continue;
      let result: unknown;
      try {
        if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-browser", version: "1" } };
        else if (rpc.method === "ping") result = {};
        else {
          // Built-in transports preflight here. The extension executor collects current
          // target/focus facts on the server; its restricted tools never expose get_html.
          const name = rpc.method === "tools/call" ? String(rpc.params?.name ?? "") : "";
          const stop = name && gate ? await gate.guardAgentBrowser(name, (rpc.params?.arguments ?? {}) as Record<string, unknown>, async selector => {
            const html = (await forward("tools/call", { name: "agent_browser_get_html", arguments: { selector } })) as { content?: Array<{ text?: unknown }> };
            return (html.content ?? []).map(c => (typeof c.text === "string" ? c.text : "")).join("\n");
          }) : null;
          if (stop !== null) result = floorToolResult(stop);
          else {
            result = await forward(rpc.method, rpc.params);
            if (name) gate?.rememberToolResult(name, result);
          }
        }
      } catch (error) {
        const failure = (error as { refusal?: { code: string; text: string } } | undefined)?.refusal;
        const text = failure?.text ?? "Browser unavailable or control changed. Ask the owner to open the browser panel.";
        // A tool call fails as a tool result the model reads. Anything else
        // (tools/list above all) fails as a JSON-RPC error: a "result" with
        // no tools in it connected the server with zero tools and no reason.
        if (rpc.method !== "tools/call") { await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: text, ...(failure ? { data: { code: failure.code } } : {}) } })); continue; }
        result = { isError: true, ...(failure ? { code: failure.code } : {}), content: [{ type: "text", text }] };
      }
      await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    }
  };
  for await (const chunk of process.stdin) { splitter.push(chunk); await drain(); }
  splitter.flush(); await drain();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runUnifiedBrowserProxy().catch(() => { process.exitCode = 1; });
