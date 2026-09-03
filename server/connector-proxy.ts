// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class Murage chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;

const UPSTREAM = process.env.MURAGE_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.MURAGE_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.MURAGE_BOT_ID ?? "";
const THREAD_ID = process.env.MURAGE_THREAD_ID ?? "";
const TOKEN = process.env.MURAGE_COMMS_TOKEN ?? "";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 1_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(process.env.MURAGE_CONNECTOR_UPSTREAM_HEADERS ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textResult(id: unknown, text: string, isError = false): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

function jsonRpcError(id: unknown, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function initializeResult(id: unknown, protocolVersion: unknown): Json {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: typeof protocolVersion === "string" && protocolVersion ? protocolVersion : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "murage-connectors", version: "1" },
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("connector response exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("connector response exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id: unknown): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  // Only the frame that answers THIS request.
  //
  // The `?? frames.at(-1)` fallback forwarded a stranger: an SSE frame
  // carrying a different jsonrpc id was handed back as though it were the
  // answer, so the client never resolved the id it actually asked about and
  // waited forever. A mismatched id is a failure, and it has to be reported
  // as one rather than papered over with whatever arrived last.
  return frames.findLast((frame) => frame.id === id) ?? null;
}

async function relay(message: Json, timeoutMs = RELAY_TIMEOUT_MS): Promise<Json | null> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...upstreamHeaders,
      ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) {
    // The body, not just the number.
    //
    // Every distinct upstream failure used to collapse to a bare status: an
    // expired key, a billing hold, a disabled account and the broker's daily
    // ceiling were all "connector service returned HTTP 4xx". The broker
    // writes a real sentence — "This install has hit today's connected-app
    // request limit. It resets at 00:00 UTC." with a `code` and a
    // `retry-after` — and all of it was discarded before anyone could read
    // it. That is why a dead connector could never be diagnosed from inside
    // the app, and why a whole afternoon went into guessing which hop was
    // broken.
    //
    // Bounded and best-effort: a body that will not read must not turn a
    // useful status into an exception of its own.
    let detail = "";
    try {
      detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
    } catch {
      detail = "";
    }
    throw new Error(
      `connector service returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return parseUpstream(await readBounded(response), message.id);
}

function connectorAdds(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  return [...new Set(toolkits.flatMap((item) => {
    if (typeof item === "string") return [item.toLowerCase()];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown };
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    const action = String(row.action ?? "add").toLowerCase();
    return typeof slug === "string" && ["add", "connect", "initiate"].includes(action) ? [slug.toLowerCase()] : [];
  }))];
}

async function showConnectorCards(slugs: string[]): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, slugs, resumeKey: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
  }
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  // OpenCode (and other MCP clients) mark a stdio server failed unless
  // initialize returns capabilities/serverInfo. Relaying that handshake to
  // Composio can time out, return a newer protocolVersion, or throw when the
  // upstream URL never reached the child env — all of which previously
  // surfaced as a tools/call-shaped {content,isError} payload.
  if (method === "notifications/initialized" || method === "initialized") {
    if (UPSTREAM) void relay(message).catch(() => {});
    return;
  }
  if (method === "initialize") {
    if (UPSTREAM) {
      try {
        // Capture the upstream session id when the service is healthy, but
        // never let a stalled provider prevent the local MCP client from
        // mounting the connector tools. The client sends initialized only
        // after this bounded attempt and the local initialize response.
        await relay(message, INITIALIZE_RELAY_TIMEOUT_MS);
      } catch {
        // Best-effort session setup. The client still needs a valid result.
      }
    }
    if (id !== undefined) {
      const params = (message.params ?? {}) as Json;
      send(initializeResult(id, params.protocolVersion));
    }
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    const slugs = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    if (slugs.length) {
      await showConnectorCards(slugs);
      send(textResult(
        id,
        `Murage showed the user a secure connection card for ${slugs.join(", ")}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "Murage is handling connection completion and will continue the task automatically."));
      return;
    }
  }
  try {
    const response = await relay(message);
    // A request is never dropped on the floor.
    //
    // `relay()` returns null when the upstream answered with something this
    // bridge could not parse — an empty 200, or frames that never carried
    // this id. The old code simply wrote nothing to stdout, and an MCP client
    // waits on an unanswered id indefinitely. Inside an agent turn a hung
    // tool call is indistinguishable from the model thinking, so the failure
    // was invisible in the one place it mattered most.
    if (id === undefined) return;
    if (response) send(response);
    else send(textResult(id, "connector service returned an unreadable response", true));
  } catch (error) {
    if (id === undefined) return;
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, messageText, true));
    else send(jsonRpcError(id, messageText));
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Json;
  try {
    message = JSON.parse(trimmed) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id === undefined) return;
    const method = String(message.method ?? "");
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(message.id, messageText, true));
    else send(jsonRpcError(message.id, messageText));
  });
});
input.on("close", () => process.exit(0));
