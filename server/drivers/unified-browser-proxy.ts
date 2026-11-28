import { NotModelRequest } from "../../shared/engine-transport.ts";
import "../../shared/win-hide-child-process.mjs";
import { createMcpCatalogWriter } from "../mcp-listed.ts";
// No native ports, encryption keys, or engine paths cross the turn boundary.
import { pathToFileURL } from "node:url";
import { createLineSplitter } from "../mcp-bridge.ts";
import { proxyTransportLost, proxyFetch } from "../proxy-turn-release.ts";
// No native ports, encryption keys, or engine paths cross the turn boundary.
import type { Readable } from "node:stream";
import { BuiltinFloorGate, builtinNoLimits, floorToolResult, readBrowserRefusal } from "../browser-floor-builtin.ts";
import { BROWSER_EXTENSION_CALL_TIMEOUT_MS } from "../../shared/browser-extension-protocol.ts";
import { turnSecret, turnSecretWired } from "../turn-credential.ts";
export async function runUnifiedBrowserProxy(env: NodeJS.ProcessEnv = process.env, options: { transport?: "builtin" | "extension"; input?: Readable } = {}) {
  const catalog = NotModelRequest("MCP catalog observer emits local tool discovery metadata to child stdout.", createMcpCatalogWriter(env, process.stdout, "unifiedBrowser"));
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
  const splitter = createLineSplitter(line => lines.push(line));
  const forward = async (method: string | undefined, params: Record<string, unknown> | undefined): Promise<unknown> => {
    const response = await proxyFetch("unifiedBrowser", url, { method: "POST", headers: { authorization: `Bearer ${turnSecret("MURAGE_CONTROL_TOKEN", env)}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }), redirect: "error", signal: AbortSignal.timeout(callTimeout) });
    if (!response.ok) { throw Object.assign(new Error(), { refusal: await readBrowserRefusal(response), lostReason: `http-${response.status}` }); }
    if (!response.body) throw Object.assign(new Error(), { lostReason: "no-body" });
    const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); } }
    catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error(), { lostReason: "decode" }); }
  };
  // The flag only says the mount was made for an owner at No limits; the host re-reads the live policy and marks on every held step.
  const gate = transport === "builtin" ? new BuiltinFloorGate(builtinNoLimits(env), async () => ((await forward("murage/floor-lift", {})) as { lift?: unknown })?.lift === true) : undefined;
  const drain = async () => {
    for (const line of lines.splice(0)) {
      let rpc: { id?: number | string; method?: string; params?: Record<string, unknown> };
      try { rpc = JSON.parse(line); } catch { continue; }
      if (rpc.id === undefined) continue;
      const req = catalog.observeRequest(rpc);
      await req.published;
    let result: unknown;
      try {
        if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-browser", version: "1" } };
        else if (rpc.method === "ping") result = {};
        // BROWSERROOT-1020: Claude Code opens every MCP server with a `server/discover` probe before `initialize`. Forwarded, the
        // route refused it uncoded and the proxy sealed the whole mount ("mount unavailable mount=browser cause=ipc") on every turn.
        // Only tools reach the browser; any other request is answered here, as the agents proxy answers it.
        else if (rpc.method !== "tools/list" && rpc.method !== "tools/call") {
          await req.respond({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Method not found: ${String(rpc.method).slice(0, 64)}` } });
          continue;
        }
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
        let failure = (error as { refusal?: { code: string; text: string } } | undefined)?.refusal;
        // sweep-1021 B6: an uncoded HTTP 500 is the local route failing on THIS request: it answered, authenticated, and never executed a fallback.
        // It used to seal the mount, so one route error took every browser tool away for the rest of the turn. It now fails that request only (the
        // body is still never read or forwarded). A tool listing is retried once, being a read; a tool call is not replayed, since the step may have run.
        // Every other loss (no connection, decode, no body, 401/403, 502..504) still seals.
        if (!failure && (error as { lostReason?: unknown } | undefined)?.lostReason === "http-500") {
          if (rpc.method === "tools/list") {
            const again = await forward(rpc.method, rpc.params).then(value => ({ value }), (retryError: unknown) => ({ retryError }));
            if ("value" in again) { await req.respond({ jsonrpc: "2.0", id: rpc.id, result: again.value }); continue; }
            const retried = again.retryError as { refusal?: { code: string; text: string }; lostReason?: unknown } | undefined;
            if (retried?.refusal) failure = retried.refusal;
            else if (retried?.lostReason !== "http-500") { proxyTransportLost("unifiedBrowser", `tools-list:${String(retried?.lostReason ?? "fetch").slice(0, 40)}`); continue; }
            else failure = { code: "browser_route_error", text: "The browser is not available right now. Try again in a moment." };
          } else if (rpc.method === "tools/call") {
            failure = { code: "browser_route_error", text: "The browser step failed inside Murage and may have happened. Check the page before repeating it." };
          }
        }
        // A recognized policy answer is an application response. Transport,
        // decoding and unknown failures still seal before any local fallback.
        // The terminal message names this cause (a status or code word, never the body).
        if (!failure) { proxyTransportLost("unifiedBrowser", `${rpc.method === "tools/list" ? "tools-list" : rpc.method === "tools/call" ? "tools-call" : "rpc"}:${(error as { lostReason?: unknown } | undefined)?.lostReason ?? "error"}`); return; }
        const text = failure.text;
        // A tool call fails as a tool result the model reads. Anything else
        // (tools/list above all) fails as a JSON-RPC error: a "result" with
        // no tools in it connected the server with zero tools and no reason.
        if (rpc.method !== "tools/call") { await req.respond({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: text, ...(failure ? { data: { code: failure.code } } : {}) } }); continue; }
        result = { isError: true, ...(failure ? { code: failure.code } : {}), content: [{ type: "text", text }] };
      }
      await req.respond({ jsonrpc: "2.0", id: rpc.id, result });
    }
  };
  for await (const chunk of options.input ?? process.stdin) { splitter.push(chunk); await drain(); }
  splitter.flush(); await drain();
}
// BROWSERROOT-1020: a failed start used to exit 1 with nothing written. Its class and code (never its message) reach stderr,
// which the relay names on its dropped-mount line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runUnifiedBrowserProxy().catch(error => {
  const shape = error as { name?: unknown; code?: unknown } | null;
  try {
    NotModelRequest("Local browser proxy startup records only the failure class and code on stderr.", process.stderr.write(
      `[browser-proxy] start failed class=${String(shape?.name ?? typeof error).slice(0, 40)} code=${String(shape?.code ?? "-").slice(0, 40)}\n`));
  } catch { /* exit code still says it */ }
  process.exitCode = 1;
});
