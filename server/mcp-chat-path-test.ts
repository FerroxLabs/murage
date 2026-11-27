// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// q1022-connparity (#29 #25 #22 #20). Owners: this file and the Test route in index.ts = q1022-connparity
// (MurageMain desktop); the relay it calls (mcp-relay.ts) and the chat mount (custom-mcp-mounts.ts) = their
// existing owners, unchanged here.
//
// Settings → Test for a link server runs the path a chat turn runs, not a second client of its own. Before
// this, Test dialed the server with probeRemoteMcp, a separate client with its own transport, auth and
// answer reading, while a chat went through the mount filter and relayMcpCall. A server could pass Test
// with tools listed and still show zero tools in every chat. Now Test asks the chat's own mount filter
// whether the entry would mount, then sends the engine's handshake and tools/list through relayMcpCall,
// the function behind /api/internal/mcp-remote/<name>. The tools Test shows are the tools the relay hands
// the engine. probeRemoteMcp is still used for the paste inspect (nothing saved yet) and the sign-in
// target; it never decides a Test.
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { AppConfig } from "./config.ts";
import { customIntegrations, customMountEntries } from "./custom-mcp-mounts.ts";
import type { McpProbeResult } from "./mcp-probe.ts";
import { isHarnessOwnedMcpEnvName, type StoredRemoteMcpServer } from "./mcp-registry.ts";
import { relayMcpCall, type RelayContext, type RelayResult } from "./mcp-relay.ts";
import { resolveDialUrl, resolveRequestAuth } from "./mcp-secrets.ts";
import type { RemoteSseSessions } from "./remote-mcp-sse-sessions.ts";
import { collectTools, parseRpcResponse } from "./remote-mcp-client.ts";
import { classifyFrame, serverRequestReply, SseFrameReader } from "./drivers/remote-mcp-proxy-core.ts";

/** The sentence when a chat would not mount the entry, whatever the server answers. */
export const NOT_IN_CHATS_LINE = "Chats cannot use this server as it is set up now. Check that its keys are entered, then test again.";

/** The initialize an engine sends (the relay adds the capabilities the proxy announces, as for a chat). */
export const ENGINE_INITIALIZE = Object.freeze({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "murage-settings-test", version: "1" } },
});

/** Would a chat turn mount `name`? The chat's own filter, judged as if the entry were switched on: the add
 * flow saves a server off, tests it, and turns it on only when Test passed. */
export function mountsInChats(cfg: AppConfig, name: string): boolean {
  const raw = cfg.mcpServers?.[name];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const only = { ...cfg, mcpServers: { [name]: { ...(raw as Record<string, unknown>), enabled: true } } } as AppConfig;
  const custom = customIntegrations(only, { execPath: "node", proxyPath: "remote-mcp-proxy", harnessUrl: "http://127.0.0.1", token: () => "" });
  return customMountEntries(custom).some((mount) => mount.name === name);
}

/** The process a chat spawns for the command server `name`, built by the chat's own mount code (customIntegrations
 * with the wipe wrapper, then the mount filter): the same executable and the same wrapper argv. Null when a chat
 * would not mount it. `env` is the harness's part of that mount's environment; its capability token is empty here
 * (a Test has no turn) and the Test route fills in the Test's own. */
export function chatCommandLaunch(cfg: AppConfig, name: string, context: { execPath: string; wipeProxyPath: string; harnessUrl: string }):
  { command: string; args: string[]; env: Record<string, string> } | null {
  const raw = cfg.mcpServers?.[name];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const only = { ...cfg, mcpServers: { [name]: { ...(raw as Record<string, unknown>), enabled: true } } } as AppConfig;
  const custom = customIntegrations(only, { ...context, proxyPath: "remote-mcp-proxy", token: () => "" });
  const mount = customMountEntries(custom).find((entry) => entry.name === name);
  if (!mount) return null;
  // Murage's own part of the mount's environment, as the chat's mount code wrote it (the wrapper's harness URL and its
  // effect-hint switch); the caller puts the Test's token where a chat has the turn's.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(mount.env)) if (isHarnessOwnedMcpEnvName(key)) env[key] = value;
  return { command: mount.command, args: [...mount.args], env };
}

export interface ChatPathTestDeps {
  sseSessions: RemoteSseSessions;
  postTokenRejected: () => boolean;
  signal?: AbortSignal;
  relay?: (ctx: RelayContext) => Promise<RelayResult>;
}

type Frame = Record<string, unknown>;

/** The frame that ANSWERS request `id` in a JSON or SSE body: parseRpcResponse's reading, but a frame counts only when
 * it is an answer (no method; a result or an error), as the chat's proxy tells them apart (classifyFrame). A server
 * numbers its own requests in its own id space: its `ping` with the id of the call it arrives under is a request to
 * answer, never the call's answer (q1023-connparity-fix, ASTRA e0b614f12d High). */
function answerIn(text: string, id: number): Frame | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    const whole = parseRpcResponse(trimmed, id);
    return whole && classifyFrame(whole, id) === "answer" ? whole : null;
  }
  const frames = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).flatMap((line): Frame[] => {
    try {
      const value: unknown = JSON.parse(line.slice(5).trim());
      return value !== null && typeof value === "object" && !Array.isArray(value) ? [value as Frame] : [];
    } catch { return []; }
  });
  return frames.findLast((frame) => classifyFrame(frame, id) === "answer") ?? null;
}

/** Most requests of its own one server may have answered within one Test (a chat has no such bound; a Test is short). */
const MAX_SERVER_REQUESTS = 64;

/** The answer frame for `id` in a relay answer, read the way the proxy reads it: a JSON body, or the SSE
 * stream up to the frame that answers. A stream is closed as soon as its answer is in.
 * `onServerRequest` (q1023-connparity-fix, ASTRA 14d1f27d48 High 2): a request the SERVER sends on the stream while
 * the call is open (a ping, most often) is handed over as it arrives, as the chat's proxy takes it
 * (remote-mcp-proxy.ts serverRequest); a server that waits for that reply before it answers lists its tools in a chat. */
async function frameIn(result: Extract<RelayResult, { ok: true }>, id: number, signal?: AbortSignal, onServerRequest?: (frame: Frame) => void): Promise<Frame | null> {
  if (typeof result.body === "string" || Buffer.isBuffer(result.body)) return answerIn(String(result.body), id);
  const stream = result.body as Readable;
  const abort = () => stream.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  let text = "";
  const events = new SseFrameReader();
  try {
    for await (const chunk of stream) {
      const piece = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      text += piece;
      if (onServerRequest) for (const frame of events.push(piece)) if (classifyFrame(frame, id) === "server-request") onServerRequest(frame);
      const found = answerIn(text.slice(0, text.lastIndexOf("\n") + 1), id);
      if (found) return found;
    }
    return answerIn(text, id);
  } catch {
    return null;
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}

function discard(result: RelayResult): void {
  if (result.ok && typeof result.body !== "string" && !Buffer.isBuffer(result.body)) result.body.destroy();
}

/** Test one saved link server through the chat path. Always returns a result; never throws. */
export async function testRemoteServerAsChat(cfg: AppConfig, name: string, server: StoredRemoteMcpServer, deps: ChatPathTestDeps): Promise<McpProbeResult> {
  if (!mountsInChats(cfg, name)) return { ok: false, reason: "not-in-chats", error: NOT_IN_CHATS_LINE };
  const relay = deps.relay ?? relayMcpCall;
  // Its own generation: an SSE session it opens is never one a turn holds, and is closed when Test ends.
  const generation = `settings-test-${randomUUID()}`;
  const call = (message: Frame, sessionId?: string, protocolVersion?: string) => relay({
    name, server, message, sessionId, protocolVersion, generation, signal: deps.signal,
    postTokenRejected: deps.postTokenRejected, sseSessions: deps.sseSessions,
  });
  const refused = (result: Extract<RelayResult, { ok: false }>): McpProbeResult =>
    ({ ok: false, reason: result.body.code, error: result.body.error });
  const wrongAddress = (): McpProbeResult => ({ ok: false, reason: "wrong-address", error: "Nothing at this address answers as an MCP server. Check that you copied the whole link." });
  // A request of the server's own gets the reply the chat's proxy gives it (ping: an empty result; anything else,
  // an elicitation included, since a Test has nobody to ask: unknown method), on the session the call runs on.
  let serverRequests = 0;
  const answering = (session?: string, protocol?: string) => (frame: Frame): void => {
    if (++serverRequests > MAX_SERVER_REQUESTS) return;
    void call(serverRequestReply(frame), session, protocol).then(discard, () => undefined);
  };
  try {
    const init = await call({ ...ENGINE_INITIALIZE, params: { ...ENGINE_INITIALIZE.params } });
    if (!init.ok) return refused(init);
    const opened = await frameIn(init, 1, deps.signal);
    const result = opened?.result as { protocolVersion?: unknown } | undefined;
    if (!opened || "error" in opened || !result || typeof result !== "object" || typeof result.protocolVersion !== "string") return wrongAddress();
    const session = init.sessionId;
    const protocol = result.protocolVersion;
    const initialized = await call({ jsonrpc: "2.0", method: "notifications/initialized" }, session, protocol);
    discard(initialized);
    if (!initialized.ok) return refused(initialized);
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session, protocol);
    if (!list.ok) return refused(list);
    const auth = resolveRequestAuth(name, server);
    const secrets = [...Object.values(auth.headers), ...(auth.bearer ? [auth.bearer] : []), resolveDialUrl(name, server) ?? ""].filter(Boolean);
    const listed = collectTools(await frameIn(list, 2, deps.signal, answering(session, protocol)), secrets);
    if (!listed) return wrongAddress();
    return { ok: true, ...listed, transport: session && deps.sseSessions.has(session) ? "sse" : "http" };
  } catch {
    return { ok: false, reason: "unreachable", error: "The server could not be reached." };
  } finally {
    deps.sseSessions.closeGeneration(generation);
  }
}

const SIGN_IN_REASONS = new Set(["needs-sign-in", "sign-in-ended", "needs-more-access"]);
const KEY_REASONS = new Set(["needs-key", "key-rejected"]);

/** What the panel needs to offer the next step (Sign in, Enter key, the moved link) after the chat path
 * refused. `diagnose` (the server's own hints) adds fields only; it never turns a refusal into a pass. */
export async function withNextStep(result: McpProbeResult, server: StoredRemoteMcpServer, diagnose: () => Promise<McpProbeResult>): Promise<McpProbeResult> {
  if (result.ok || !result.reason || !(SIGN_IN_REASONS.has(result.reason) || KEY_REASONS.has(result.reason) || result.reason === "moved")) return result;
  const hint = await diagnose().catch(() => null);
  const extra = hint && !hint.ok ? hint : null;
  let host = "this server";
  try { host = new URL(server.url).hostname; } catch { /* stays generic */ }
  return {
    ...result,
    ...(extra?.signIn ? { signIn: extra.signIn } : SIGN_IN_REASONS.has(result.reason) ? { signIn: { host } } : {}),
    ...(extra?.apiKey ? { apiKey: extra.apiKey } : KEY_REASONS.has(result.reason) ? { apiKey: { headerHint: "authorization" as const } } : {}),
    ...(extra?.scopes ? { scopes: extra.scopes } : {}),
    ...(extra?.suggestUrl ? { suggestUrl: extra.suggestUrl, ...(extra.suggestHoldsSecret ? { suggestHoldsSecret: true } : {}) } : {}),
  };
}
