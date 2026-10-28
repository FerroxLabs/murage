// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The rules of the stdio proxy an engine talks to for a link server (spec
// MCP-LINK 3.8), kept apart from the process so each is a function a test can
// call. The process is server/drivers/remote-mcp-proxy.ts. This file imports
// nothing: the proxy runs inside an engine's process tree.
//
// What the proxy guarantees, one function each:
//  - rewriteInitializeCapabilities: what Murage announces is only the
//    engine's own `elicitation` (MCP-ELICITATION-109: the engine shows it as the
//    owner's question card); never sampling or roots, so a server never sends
//    a request back that nobody will answer (decision D10).
//  - splitUpstreamFrames and classifyFrame: read a JSON or SSE answer and tell
//    the answer from a notification and from a request the server made.
//  - serverRequestReply: a ping is answered, everything else is -32601
//    (an elicitation reaches it only when the engine did not announce one).
//  - SseFrameReader: frames of an SSE answer as they arrive, so a server's
//    elicitation is forwarded while its call is still open.
//  - failureFrame: every id is answered, an error becomes a tool result or a
//    JSON-RPC error with the relay's fixed sentence, never silence.

export type JsonRpcMessage = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRpcMessage => value !== null && typeof value === "object" && !Array.isArray(value);

/** The elicitation modes an engine announced, as a fresh object of empty
 * markers (`form`, `url`); null when it announced none. Nothing else the
 * engine wrote is passed on. */
export function announcedElicitation(capabilities: unknown): JsonRpcMessage | null {
  if (!isRecord(capabilities) || !isRecord(capabilities.elicitation)) return null;
  const announced: JsonRpcMessage = {};
  for (const mode of ["form", "url"]) if (isRecord(capabilities.elicitation[mode])) announced[mode] = {};
  return announced;
}

/** The capabilities Murage announces to a link server: the engine's own
 * elicitation, when it announced one and `elicitation` is not false (a legacy
 * SSE server, whose requests have no open call to ride on), and nothing else. */
export function rewriteInitializeCapabilities(message: JsonRpcMessage, options: { elicitation?: boolean } = {}): JsonRpcMessage {
  if (message.method !== "initialize") return message;
  const params = isRecord(message.params) ? message.params : {};
  const elicitation = options.elicitation === false ? null : announcedElicitation(params.capabilities);
  return { ...message, params: { ...params, capabilities: elicitation ? { elicitation } : {} } };
}

/** An MCP elicitation the server sent (a request: it has a method and an id). */
export function isElicitationRequest(frame: JsonRpcMessage): boolean {
  return frame.method === "elicitation/create" && (typeof frame.id === "string" || typeof frame.id === "number");
}

/** An SSE body read as it arrives: `push` returns each JSON-RPC object whose
 * event is complete; `end` returns the last one. Same reading as
 * splitUpstreamFrames. */
export class SseFrameReader {
  private pending = "";
  private data: string[] = [];
  push(text: string): JsonRpcMessage[] {
    this.pending += text;
    const frames: JsonRpcMessage[] = [];
    let at: number;
    while ((at = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, at).replace(/\r$/, "");
      this.pending = this.pending.slice(at + 1);
      this.line(line, frames);
    }
    return frames;
  }
  end(): JsonRpcMessage[] {
    const frames: JsonRpcMessage[] = [];
    if (this.pending) this.line(this.pending.replace(/\r$/, ""), frames);
    this.pending = "";
    this.flush(frames);
    return frames;
  }
  private line(line: string, frames: JsonRpcMessage[]): void {
    if (line === "") this.flush(frames);
    else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
  }
  private flush(frames: JsonRpcMessage[]): void {
    if (this.data.length === 0) return;
    const joined = this.data.join("\n").trim();
    this.data = [];
    if (!joined || joined === "[DONE]") return;
    try {
      const value: unknown = JSON.parse(joined);
      if (isRecord(value)) frames.push(value);
    } catch {
      // not JSON: skip it
    }
  }
}

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
 * else (sampling, roots, an elicitation the engine did not announce) is refused
 * as an unknown method. */
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
