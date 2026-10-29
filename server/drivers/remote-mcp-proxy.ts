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
  announcedElicitation,
  classifyFrame,
  failureFrame,
  failureText,
  isElicitationRequest,
  rewriteInitializeCapabilities,
  serverRequestReply,
  splitUpstreamFrames,
  SseFrameReader,
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
/** The engine announced elicitation in its initialize: a server's
 * elicitation/create is forwarded to it (MCP-ELICITATION-109). */
let engineElicits = false;
/** Elicitations forwarded to the engine, by the proxy's own id: the server's id
 * the engine's answer goes back under, and what to do when it closes. */
const forwarded = new Map<string, { upstreamId: string | number; session: string; closed: () => void }>();
let forwardSeq = 0;

/** A call's relay deadline. It is paused while an elicitation the call is
 * waiting on is open (a person is deciding: the card's own timeout bounds
 * that), and starts over in full once the last one closes. */
interface CallDeadline { signal: AbortSignal; pause(): void; resume(): void }
function callDeadline(ms: number): CallDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => { timer = setTimeout(() => controller.abort(new Error("timeout")), ms); };
  arm();
  return {
    signal: controller.signal,
    pause: () => { if (timer) clearTimeout(timer); timer = null; },
    resume: () => { if (!timer && !controller.signal.aborted) arm(); },
  };
}

/** Only the fields an elicitation is: never the server's `_meta`, which an
 * engine could read as its own (Codex's `codex_approval_kind`). */
function elicitationParams(params: unknown): JsonRpcMessage {
  const source = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as JsonRpcMessage) : {};
  const out: JsonRpcMessage = {};
  for (const key of ["mode", "message", "requestedSchema", "url", "elicitationId"]) if (key in source) out[key] = source[key];
  return out;
}

/** A request the server made while answering a call: an elicitation goes to
 * the engine (the owner's card), anything else is answered here. Returns the
 * proxy id of a forwarded elicitation. */
function serverRequest(frame: JsonRpcMessage, onClosed: (id: string) => void, callSession: string): string | null {
  if (engineElicits && isElicitationRequest(frame)) {
    const id = `murage-elicit-${++forwardSeq}`;
    // the session the question came on (the call's own, frozen at its answer's
    // headers): the answer goes back on it, whatever another call reopened since
    forwarded.set(id, { upstreamId: frame.id as string | number, session: callSession, closed: () => onClosed(id) });
    send({ jsonrpc: "2.0", id, method: "elicitation/create", params: elicitationParams(frame.params) });
    return id;
  }
  void post(serverRequestReply(frame), 30_000, callSession).then((r) => r.body?.cancel().catch(() => undefined), () => undefined);
  return null;
}

/** The engine's answer to a forwarded elicitation goes back to the server
 * under the server's own id. True when `message` was one. */
function engineAnswer(message: JsonRpcMessage): boolean {
  const id = message.id;
  if (typeof id !== "string" || !forwarded.has(id)) return false;
  const { upstreamId, session, closed } = forwarded.get(id)!;
  forwarded.delete(id);
  closed();
  const reply: JsonRpcMessage = "error" in message
    ? { jsonrpc: "2.0", id: upstreamId, error: message.error }
    : { jsonrpc: "2.0", id: upstreamId, result: message.result ?? { action: "cancel" } };
  void post(reply, 30_000, session).then((r) => r.body?.cancel().catch(() => undefined), () => undefined);
  return true;
}

/** The engine is told a forwarded elicitation is withdrawn (its card closes):
 * the server cancelled it, or the call it belonged to ended. */
function withdraw(ids: Iterable<string>, reason: string): void {
  for (const id of ids) {
    const entry = forwarded.get(id);
    if (!entry) continue;
    forwarded.delete(id);
    entry.closed();
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } });
  }
}

/** A server's `notifications/cancelled` for an elicitation it sent on THIS
 * call (`opened`: a server may number its ids per response, so another call's
 * question can share the id): the engine knows that request by the proxy's id,
 * so the cancel is renamed. Every match on the call is withdrawn; none is
 * guessed. True when it named one (and must not also pass through as is). */
function serverCancelled(frame: JsonRpcMessage, opened: ReadonlySet<string>): boolean {
  if (frame.method !== "notifications/cancelled") return false;
  const params = frame.params !== null && typeof frame.params === "object" ? (frame.params as JsonRpcMessage) : {};
  const matches = [...opened].filter((id) => forwarded.get(id)?.upstreamId === params.requestId);
  if (matches.length === 0) return false;
  withdraw(matches, typeof params.reason === "string" ? params.reason.slice(0, 200) : "The server cancelled its question.");
  return true;
}

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

async function post(message: JsonRpcMessage, timeoutMs: number | CallDeadline, session: string = sessionId): Promise<Response> {
  return fetch(`${HARNESS}/api/internal/mcp-remote/${encodeURIComponent(NAME)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token()}`,
      ...(session ? { "mcp-session-id": session } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(message),
    signal: typeof timeoutMs === "number" ? AbortSignal.timeout(timeoutMs) : timeoutMs.signal,
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
  // A reply from the engine: an answer to a forwarded elicitation, or to
  // something we never forwarded (nothing to do).
  if (!method) {
    engineAnswer(message);
    return;
  }
  const outgoing = rewriteInitializeCapabilities(message);
  if (method === "initialize") {
    initializeFrame = outgoing;
    const params = message.params !== null && typeof message.params === "object" && !Array.isArray(message.params) ? (message.params as JsonRpcMessage) : {};
    engineElicits = announcedElicitation(params.capabilities) !== null;
  }
  const sentSession = sessionId;
  const timeoutMs = method === "initialize" ? INITIALIZE_RELAY_TIMEOUT_MS : RELAY_TIMEOUT_MS;
  let response: Response;
  const deadline = callDeadline(timeoutMs);
  try {
    response = await post(outgoing, deadline);
  } catch {
    if (id !== undefined) send(failureFrame(method, id, "The server did not answer in time. Try again in a moment."));
    return;
  }
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) sessionId = nextSession;
  // An SSE answer is read as it arrives: a server's elicitation must reach the
  // engine while the call it belongs to is still open.
  if (response.ok && /^text\/event-stream/i.test(response.headers.get("content-type") ?? "") && response.body) {
    return streamAnswer(response, method, id, deadline, nextSession || sentSession);
  }
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
      void post(serverRequestReply(frame), 30_000, nextSession || sentSession).catch(() => undefined);
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

/** One SSE answer, frame by frame. Every id is still answered exactly once. */
async function streamAnswer(response: Response, method: string, id: unknown, deadline: CallDeadline, callSession: string): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameReader();
  const opened = new Set<string>();
  let answered = false;
  let size = 0;
  // this call's deadline waits while one of its questions is with the owner
  const closed = (forwardedId: string) => {
    opened.delete(forwardedId);
    if (opened.size === 0) deadline.resume();
  };
  const take = (frame: JsonRpcMessage) => {
    const kind = classifyFrame(frame, id);
    if (kind === "notification") {
      if (!serverCancelled(frame, opened)) send(frame);
    } else if (kind === "server-request") {
      const forwardedId = serverRequest(frame, closed, callSession);
      if (forwardedId) {
        opened.add(forwardedId);
        deadline.pause();
      }
    } else if (kind === "answer" && !answered) {
      send(frame);
      answered = true;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        if (id !== undefined && !answered) send(failureFrame(method, id, "The server sent more than Murage will read."));
        answered = true;
        return;
      }
      for (const frame of frames.push(decoder.decode(value, { stream: true }))) take(frame);
    }
    for (const frame of frames.push(decoder.decode())) take(frame);
    for (const frame of frames.end()) take(frame);
  } catch {
    if (id !== undefined && !answered) send(failureFrame(method, id, "The server did not answer in time. Try again in a moment."));
    answered = true;
  } finally {
    withdraw([...opened], "The server's call ended before the answer.");
  }
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
