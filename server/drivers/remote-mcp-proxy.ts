// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Stdio MCP server an engine mounts for ONE link server (spec MCP-LINK 3.8). It
// holds no credential and knows no address: every message goes to the harness's
// /api/internal/mcp-remote/<name> with this turn's token, and the harness does
// the sign-in, the headers and the network. The server name is in argv, not in
// the environment, because Codex shares one environment across all its servers.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";

import { turnSecret } from "../turn-credential.ts";
import {
  classifyFrame,
  failureFrame,
  failureText,
  rewriteInitializeCapabilities,
  serverRequestReply,
  splitUpstreamFrames,
  type JsonRpcMessage,
} from "./remote-mcp-proxy-core.ts";

const HARNESS = process.env.MURAGE_HARNESS_URL ?? "http://127.0.0.1:8799";
const token = () => turnSecret("MURAGE_MCP_TOKEN");
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 30_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;

const serverIndex = process.argv.indexOf("--server");
const NAME = serverIndex >= 0 ? process.argv[serverIndex + 1] ?? "" : "";

let sessionId = "";
let protocolVersion = "";
// The engine's own initialize, kept so a dead session can be reopened without it.
let initializeFrame: JsonRpcMessage | null = null;
const send = (message: JsonRpcMessage) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("too large");
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
      throw new Error("too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function post(message: JsonRpcMessage, timeoutMs: number): Promise<Response> {
  return fetch(`${HARNESS}/api/internal/mcp-remote/${encodeURIComponent(NAME)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token()}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** The harness no longer knows our session (a reused process outlives the
 * generation that opened it): open a new one with the engine's initialize.
 * Best effort; the retry that follows reports any failure. */
async function reopenSession(): Promise<void> {
  const frame = initializeFrame;
  sessionId = "";
  if (!frame) return;
  try {
    const opened = await post({ ...frame, id: `reopen-${Date.now()}` }, INITIALIZE_RELAY_TIMEOUT_MS);
    const next = opened.headers.get("mcp-session-id");
    if (next) sessionId = next;
    await opened.body?.cancel().catch(() => undefined);
    if (opened.ok) await post({ jsonrpc: "2.0", method: "notifications/initialized" }, INITIALIZE_RELAY_TIMEOUT_MS).then((r) => r.body?.cancel().catch(() => undefined));
  } catch {
    // the retry will say what is wrong
  }
}

function sessionLost(response: Response, body: unknown): boolean {
  // Only the relay's own "the stream you named is not held, nothing was sent".
  // Any other failure may have run the call already; resending could run it twice.
  void response;
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "session-gone";
}

async function handle(message: JsonRpcMessage, retried = false): Promise<void> {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  // A reply from the engine to something we never forwarded: nothing to do.
  if (!method) return;
  const outgoing = rewriteInitializeCapabilities(message);
  if (method === "initialize") initializeFrame = outgoing;
  const sentSession = sessionId;
  const timeoutMs = method === "initialize" ? INITIALIZE_RELAY_TIMEOUT_MS : RELAY_TIMEOUT_MS;
  let response: Response;
  try {
    response = await post(outgoing, timeoutMs);
  } catch {
    if (id !== undefined) send(failureFrame(method, id, "The server did not answer in time. Try again in a moment."));
    return;
  }
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) sessionId = nextSession;
  let text: string;
  try {
    text = await readBounded(response);
  } catch {
    if (id !== undefined) send(failureFrame(method, id, "The server sent more than Murage will read."));
    return;
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (sentSession && !retried && method !== "initialize" && initializeFrame && sessionLost(response, body)) {
      // Forget the dead session, reopen once, retry once; never twice.
      await reopenSession();
      return handle(message, true);
    }
    if (id !== undefined) send(failureFrame(method, id, failureText(body, "The server could not be reached.")));
    return;
  }
  const frames = splitUpstreamFrames(text, response.headers.get("content-type") ?? "");
  let answered = false;
  for (const frame of frames) {
    const kind = classifyFrame(frame, id);
    if (kind === "notification") send(frame);
    else if (kind === "server-request") {
      // Nobody on this side answers sampling or elicitation: say so to the server.
      void post(serverRequestReply(frame), 30_000).catch(() => undefined);
    } else if (kind === "answer") {
      if (method === "initialize" && frame.result && typeof frame.result === "object") {
        const version = (frame.result as { protocolVersion?: unknown }).protocolVersion;
        if (typeof version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(version)) protocolVersion = version;
      }
      send(frame);
      answered = true;
    }
  }
  // Every id is answered. An unreadable or empty answer to a request is an error
  // result, never silence (a hung tool call looks like the model thinking).
  if (id !== undefined && !answered) send(failureFrame(method, id, "The server sent an answer Murage could not read."));
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpcMessage;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    message = value as JsonRpcMessage;
  } catch {
    return;
  }
  void handle(message).catch(() => {
    const method = typeof message.method === "string" ? message.method : "";
    if (message.id !== undefined) send(failureFrame(method, message.id, "The server sent an answer Murage could not read."));
  });
});
input.on("close", () => process.exit(0));
