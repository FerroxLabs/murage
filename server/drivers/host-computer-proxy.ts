import "../../shared/win-hide-child-process.mjs";
import { createMcpCatalogWriter, type McpRequest } from "../mcp-listed.ts";
import { NotModelRequest } from "../../shared/engine-transport.ts";
import { proxyTransportLost } from "../proxy-turn-release.ts";
// Only scoped harness authority crosses into the model's MCP process.
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { createLineSplitter } from "../mcp-bridge.ts";
import { turnSecret, turnSecretWired } from "../turn-credential.ts";

/** One loopback POST with no clock; `signal` withdraws it. At most 16 MB back. */
export function post(url: URL, token: string, body: string, signal: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = NotModelRequest("MCP tool/control traffic to the harness or tool server; this adapter does not submit model inference", httpRequest(url, { method: "POST", signal, agent: false, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    }));
    req.on("error", reject);
    NotModelRequest("MCP tool/control traffic to the harness or tool server; this adapter does not submit model inference", req.end(body));
  });
}

// DESIGN 1022-cua-windows D10, D15, D17: a gate refusal is a tool error worded by its code and cause, and whether the
// action had already reached the driver (`sent`). Never a transport loss, so the mount stays open for the next call.
const HOST_OFF_TEXT: Record<string, string> = {
  disable: "Local control was switched off on this PC; nothing was performed.",
  restart: "Computer control is restarting on this PC; nothing was performed. Try again in a moment.",
  integrity: "This computer's driver failed its integrity check, so nothing was performed. The owner can reinstall Murage.",
  quit: "Murage is closing or updating; nothing was performed.",
  update: "Murage is closing or updating; nothing was performed.",
  "bot-off": "This bot is no longer set to use this computer; nothing was performed.",
};
export function hostRefusalText(body: { code?: unknown; cause?: unknown; sent?: unknown } | null | undefined): string | null {
  if (body?.code === "host-locked") {
    return body.sent === true
      ? "This PC was locked while this action ran; it was cancelled, but part of it may already have taken effect. Check the screen after the owner unlocks it."
      : "This PC is locked. Computer actions resume when the owner unlocks it; nothing was performed.";
  }
  if (body?.code === "driver-integrity") return HOST_OFF_TEXT.integrity;
  // C8 / C4 (D16 a): the driver connection broke, or the driver was stopped, while this action ran
  if (body?.code === "driver-lost") return "This computer's driver connection broke while this action ran. It may have partly happened; check the screen before continuing.";
  if (body?.code === "driver-exited") return "This computer's driver stopped while this action ran. It may have partly happened; check the screen before continuing.";
  if (body?.code === "driver-busy") return "This computer's driver file could not be read just now, so nothing was performed. Try again in a moment.";
  if (body?.code === "host-off") {
    if (body.cause === "bot-off" && body.sent === true) return "This bot was taken off this computer while this action ran; it was cancelled, but part of it may already have taken effect.";
    return HOST_OFF_TEXT[String(body.cause)] ?? HOST_OFF_TEXT.restart;
  }
  return null;
}

export async function runHostComputerProxy(env: NodeJS.ProcessEnv = process.env) {
  const catalog = NotModelRequest("MCP catalog observer emits local tool discovery metadata to child stdout.", createMcpCatalogWriter(env, process.stdout, "hostComputer"));
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
  const engineCancellation = new Error("MCP request withdrawn");
  const key = (id: unknown) => JSON.stringify(id);
  const call = async (rpc: { id: number | string; method?: string; params?: Record<string, unknown> }, withdrawn: AbortController, req: McpRequest) => {
    // MCP: a request the client cancelled gets no response, and its catalog entry ends with it.
    if (withdrawn.signal.aborted) { req.cancel(); return; }
    await req.published;
    let result: unknown;
    try {
      if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-host-computer", version: "1" } };
      else if (rpc.method === "ping") result = {};
      // BROWSERROOT-1020: Claude Code's `server/discover` probe (and any other non-tool request) is answered here; forwarded, a
      // refusal from the route sealed the mount for the whole turn.
      else if (rpc.method !== "tools/list" && rpc.method !== "tools/call") {
        await NotModelRequest("MCP tool/control traffic to the harness or tool server; this adapter does not submit model inference",
          req.respond({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Method not found: ${String(rpc.method).slice(0, 64)}` } }));
        return;
      }
      else {
        // node:http, not fetch: fetch gives up on a reply that takes over five
        // minutes (its default header and body timeouts)
        const response = await post(url, turnSecret("MURAGE_CONTROL_TOKEN", env), JSON.stringify({ method: rpc.method, params: rpc.params }), withdrawn.signal);
        if (response.status !== 200 && response.status !== 409) throw new Error();
        const body = JSON.parse(response.body);
        if (response.status === 409) result = { isError: true, content: [{ type: "text", text: hostRefusalText(body) ?? (body?.code === "cancelled" ? stopped : unavailable) }] };
        else result = body;
      }
    } catch (error) {
      // Node attaches the signal's reason to the HTTP AbortError.
      if (error instanceof Error && error.name === "AbortError" && error.cause === engineCancellation) req.cancel();
      else proxyTransportLost("hostComputer");
      return;
    }
    finally { if (withdrawable.get(key(rpc.id)) === withdrawn) withdrawable.delete(key(rpc.id)); }
    // MCP: a request the client cancelled gets no response.
    if (withdrawn.signal.aborted) { req.cancel(); return; }
    await NotModelRequest("MCP tool/control traffic to the harness or tool server; this adapter does not submit model inference", req.respond({ jsonrpc: "2.0", id: rpc.id, result }));
  };
  let queue = Promise.resolve();
  const splitter = createLineSplitter(line => {
    let rpc: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try { rpc = JSON.parse(line); } catch { return; }
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled") withdrawable.get(key(rpc.params?.requestId))?.abort(engineCancellation);
      return;
    }
    const withdrawn = new AbortController();
    withdrawable.set(key(rpc.id), withdrawn);
    const req = catalog.observeRequest(rpc);
    const request = { ...rpc, id: rpc.id };
    queue = queue.then(() => call(request, withdrawn, req)).catch((error) => { NotModelRequest("Local proxy exit diagnostic to stderr.", process.stderr.write(`host-computer proxy output failed: ${error instanceof Error ? error.message : String(error)}\n`)); process.exitCode = 1; });
  });
  for await (const chunk of process.stdin) splitter.push(chunk);
  splitter.flush();
  // The engine closed this tool: withdraw what is in flight and queued.
  for (const withdrawn of withdrawable.values()) withdrawn.abort();
  await queue;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runHostComputerProxy().catch(() => { process.exitCode = 1; });
