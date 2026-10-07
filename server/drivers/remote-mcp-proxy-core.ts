// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The rules of the stdio proxy an engine talks to for a link server (spec
// MCP-LINK 3.8), kept apart from the process so each is a function a test can
// call. The process is server/drivers/remote-mcp-proxy.ts. This file imports
// nothing: the proxy runs inside an engine's process tree.
//
// What the proxy guarantees, one function each:
//  - rewriteInitializeCapabilities: what Murage announces is nothing, so a
//    server never sends a request back that nobody will answer (decision D10).
//  - splitUpstreamFrames and classifyFrame: read a JSON or SSE answer and tell
//    the answer from a notification and from a request the server made.
//  - serverRequestReply: a ping is answered, everything else is -32601.
//  - failureFrame: every id is answered, an error becomes a tool result or a
//    JSON-RPC error with the relay's fixed sentence, never silence.

export type JsonRpcMessage = Record<string, unknown>;

/** The capabilities Murage announces to a link server: none. */
export function rewriteInitializeCapabilities(message: JsonRpcMessage): JsonRpcMessage {
  if (message.method !== "initialize") return message;
  const params = message.params !== null && typeof message.params === "object" && !Array.isArray(message.params) ? (message.params as JsonRpcMessage) : {};
  return { ...message, params: { ...params, capabilities: {} } };
}

const isRecord = (value: unknown): value is JsonRpcMessage => value !== null && typeof value === "object" && !Array.isArray(value);

/** Every JSON-RPC object in an upstream answer, from a JSON body or an SSE body. */
export function splitUpstreamFrames(text: string, contentType: string): JsonRpcMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!/^text\/event-stream/i.test(contentType) && trimmed.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  }
  const frames: JsonRpcMessage[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length === 0) return;
    const joined = data.join("\n").trim();
    data = [];
    if (!joined || joined === "[DONE]") return;
    try {
      const value: unknown = JSON.parse(joined);
      if (isRecord(value)) frames.push(value);
    } catch {
      // not JSON: skip it
    }
  };
  for (const line of trimmed.split(/\r?\n/)) {
    if (line === "") flush();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  flush();
  return frames;
}

export type FrameKind = "answer" | "notification" | "server-request" | "other";

/** What a frame in the answer to request `id` is. */
export function classifyFrame(frame: JsonRpcMessage, id: unknown): FrameKind {
  const hasMethod = typeof frame.method === "string";
  if (hasMethod && frame.id === undefined) return "notification";
  if (hasMethod) return "server-request";
  if (frame.id === id && id !== undefined && ("result" in frame || "error" in frame)) return "answer";
  return "other";
}

/** The reply to a request the server sent: ping gets an empty result, anything
 * else (sampling, elicitation, roots) is refused as an unknown method. */
export function serverRequestReply(frame: JsonRpcMessage): JsonRpcMessage {
  if (frame.method === "ping") return { jsonrpc: "2.0", id: frame.id, result: {} };
  return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } };
}

/** The frame that answers `id` when the relay failed or its answer could not be
 * read. A tool call gets a tool result the model can read; anything else gets a
 * JSON-RPC error. `text` is the relay's fixed sentence. */
export function failureFrame(method: string, id: unknown, text: string): JsonRpcMessage {
  if (method === "tools/call") {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32000, message: text } };
}

/** The sentence from a relay failure body, or a fixed fallback. */
export function failureText(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.trim()) return body.error.slice(0, 400);
  return fallback;
}
