// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The relay behind POST /api/internal/mcp-remote/<name> (spec MCP-LINK 3.8): the
// one place an engine's tool call becomes a request to a server the owner added
// by link. The engine's proxy never sees a credential; this code reads them from
// the secret store, sends them to the exact origin of the link through the
// guarded client, and hands back the upstream's answer bytes, or one fixed
// sentence when something went wrong. Nothing an upstream says in an error
// reaches the caller.
//
// Each rule is a named function so it can be read and tested on its own:
// mcpRemoteAudienceRefusal, mcpRemoteBotRefusal, validateRelayBody,
// rewriteInitializeCapabilities, relayTimeoutFor, safeSessionId,
// safeProtocolVersion, relayFailure.
import { GuardedHttpError, guardedRequest, type GuardedBufferResponse } from "../shared/guarded-http.mjs";
import { LIMITS } from "../shared/remote-mcp-url.mjs";
import type { StoredRemoteMcpServer } from "./mcp-registry.ts";
import type { McpProbeFailureReason } from "./mcp-probe.ts";
import { classifyUnauthorized, reasonForGuardedError, remoteFailureSentence } from "./remote-mcp-client.ts";
import { RemoteSseSessions, type SseSessionFailure } from "./remote-mcp-sse-sessions.ts";
import { rewriteInitializeCapabilities } from "./drivers/remote-mcp-proxy-core.ts";
import { resolveDialUrl, resolveRequestAuth, waitForNewAccessToken } from "./mcp-secrets.ts";
import { botAccessPolicy, type AccessRole } from "./bot-access-role.ts";

export const MCP_REMOTE_OWNER_ONLY = "Your own MCP servers belong to the owner, so this conversation cannot use them.";
export const MCP_REMOTE_RESTRICTED_BOT = "This bot's access is restricted, so it cannot use your own MCP servers.";
export const TOKEN_WAIT_MS = 30_000;
/** On `initialize` the wait is capped here. The proxy gives initialize 30 s
 * (LIMITS.initializeRelayMs) from the moment the engine asked; when the wait
 * outlasted that, the proxy answered first, the engine ended the turn, and the
 * sign-in card the relay then posted was dropped (the turn was no longer
 * active). A wait is still worth having at all: the usual cause is a token that
 * expired between turns, and main's refresh finishes in a second or two. */
export const INITIALIZE_TOKEN_WAIT_MS = 20_000;
/** Kept free after the wait for the one retry and for posting the card. */
const INITIALIZE_RESERVE_MS = 4_000;
export { rewriteInitializeCapabilities };

export interface AudienceCheck { (threadId: string): boolean }

/** The refusal for a turn whose words were not proven to be the owner's. An
 * audience that cannot be read is not the owner's. */
export function mcpRemoteAudienceRefusal(threadId: string, isOwner: (threadId: string) => boolean): string | null {
  try {
    return isOwner(threadId) ? null : MCP_REMOTE_OWNER_ONLY;
  } catch {
    return MCP_REMOTE_OWNER_ONLY;
  }
}

/** A bot the owner restricted to approved connected-app tools, or hid, does not
 * get the owner's own tool servers either. */
export function mcpRemoteBotRefusal(bot: { hidden?: boolean }, accessMode: "restricted" | "unrestricted"): string | null {
  return bot.hidden === true || accessMode === "restricted" ? MCP_REMOTE_RESTRICTED_BOT : null;
}

/** The owner's own command and link servers are mounted for a bot only when the
 * owner has not restricted or hidden it (MCP-LINK H1). Both mount sites in
 * index.ts gate on this. */
export function ownServersAllowedFor(bot: AccessRole): boolean {
  return mcpRemoteBotRefusal(bot, botAccessPolicy(bot).mode) === null;
}

/** The relay's audience test on the turn's own record: the audience
 * beginInternalTurn was given, which is what both mount gates decided on. A
 * thread that is the owner's is not enough when this turn's words were not. */
export function relayTurnIsOwner(owner: { ownerAudience?: boolean } | undefined, claim: { notOwnerAudience?: true }): boolean {
  return owner?.ownerAudience === true && claim.notOwnerAudience !== true;
}

/** The relay route's whole audience decision (MCP-LINK M1): the thread must be
 * the owner's, and so must this turn's own recorded audience and its claim. The
 * route calls exactly this with its internalClaim and internalOwner. */
export function relayAudienceRefusal(
  claim: { threadId: string; notOwnerAudience?: true },
  owner: { ownerAudience?: boolean } | undefined,
  threadIsOwner: (threadId: string) => boolean,
): string | null {
  return mcpRemoteAudienceRefusal(claim.threadId, (threadId) => threadIsOwner(threadId) && relayTurnIsOwner(owner, claim));
}

type Message = Record<string, unknown>;

/** The relay takes one JSON-RPC message per call: a request, a notification, or
 * a client response (how the proxy answers a server request). No batches. */
export function validateRelayBody(body: unknown): { ok: true; message: Message } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send one JSON-RPC message." };
  const message = body as Message;
  if (message.jsonrpc !== "2.0") return { ok: false, error: "Send one JSON-RPC message." };
  const isCall = typeof message.method === "string" && message.method.length > 0 && message.method.length <= 200;
  const isResponse = message.method === undefined && ("result" in message || "error" in message) && message.id !== undefined;
  if (!isCall && !isResponse) return { ok: false, error: "Send one JSON-RPC message." };
  if (message.id !== undefined && typeof message.id !== "number" && typeof message.id !== "string") return { ok: false, error: "Send one JSON-RPC message." };
  return { ok: true, message };
}

/** initialize 30 s, a tool call 10 minutes, everything else 2 minutes. */
export function relayTimeoutFor(message: Message): number {
  if (message.method === "initialize") return LIMITS.initializeRelayMs;
  if (message.method === "tools/call") return LIMITS.toolCallMs;
  return 120_000;
}

/** How long to wait for a fresh token after a rejection. `elapsedMs` is how
 * long this relay call has run so far (the first request counts against the
 * proxy's limit on initialize). Every other method keeps the long wait. */
export function tokenWaitFor(message: Message, explicitMs: number | undefined, elapsedMs: number): number {
  if (message.method !== "initialize") return explicitMs ?? TOKEN_WAIT_MS;
  const room = Math.max(0, LIMITS.initializeRelayMs - INITIALIZE_RESERVE_MS - Math.max(0, elapsedMs));
  return Math.min(explicitMs ?? INITIALIZE_TOKEN_WAIT_MS, INITIALIZE_TOKEN_WAIT_MS, room);
}

/** A session id from the client, or undefined when it is not plain printable text. */
export function safeSessionId(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return text && /^[\x21-\x7e]{1,256}$/.test(text) ? text : undefined;
}

export function safeProtocolVersion(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

export function statusForReason(reason: McpProbeFailureReason): number {
  switch (reason) {
    case "needs-sign-in": case "needs-key": case "key-rejected": case "sign-in-ended": case "needs-more-access": return 401;
    case "blocked-address": case "address-changed": case "https-required": case "local-confirm": return 403;
    default: return 502;
  }
}

export interface RelayFailure { status: number; body: { code: McpProbeFailureReason; error: string } }

/** The only shape an error leaves the relay in: a code and its fixed sentence. */
export function relayFailure(reason: McpProbeFailureReason, host: string, extra: { suggestUrl?: string } = {}): RelayFailure {
  return { status: statusForReason(reason), body: { code: reason, error: remoteFailureSentence(reason, { host, suggestUrl: extra.suggestUrl }) } };
}

export interface RelayContext {
  name: string;
  server: StoredRemoteMcpServer;
  message: Message;
  /** The client's mcp-session-id header, if any. */
  sessionId?: string;
  protocolVersion?: string;
  /** The turn this call belongs to: SSE sessions are bound to it. */
  generation: string;
  signal?: AbortSignal;
  /** Tell the desktop shell the access token was rejected. False when there is no shell. */
  postTokenRejected: () => boolean;
  sseSessions: RemoteSseSessions;
  resolver?: Parameters<typeof guardedRequest>[0]["resolver"];
  tokenWaitMs?: number;
}

export type RelayResult =
  | { ok: true; status: number; contentType: string; sessionId?: string; body: Buffer | string }
  /** `stepUpScopes`: what a 403 insufficient_scope asked for. Kept out of the
   * body the engine reads; the harness puts it on the sign-in card so the next
   * sign-in asks for it (spec 3.7 step 10). */
  | ({ ok: false; stepUpScopes?: string[] } & RelayFailure);

const failed = (reason: McpProbeFailureReason, host: string, extra: { suggestUrl?: string } = {}): RelayResult => ({ ok: false, ...relayFailure(reason, host, extra) });

/** Send one engine message to the link server and return its answer. */
export async function relayMcpCall(ctx: RelayContext): Promise<RelayResult> {
  const dial = resolveDialUrl(ctx.name, ctx.server);
  const host = dial ? safeHost(dial) : "this server";
  if (dial === null) return failed("needs-key", host);
  const message = rewriteInitializeCapabilities(ctx.message);
  const timeoutMs = relayTimeoutFor(message);

  const attempt = async (): Promise<RelayResult | "unauthorized"> => {
    const auth = resolveRequestAuth(ctx.name, ctx.server);
    if (ctx.server.auth === "header" && auth.missing.length > 0) return failed("needs-key", host);
    if (ctx.server.auth === "oauth" && !auth.bearer) return "unauthorized";
    if (ctx.server.transport === "sse" || (ctx.sessionId && ctx.sseSessions.has(ctx.sessionId))) {
      return viaSse(ctx, dial, host, message, timeoutMs, auth);
    }
    return viaStreamableHttp(ctx, dial, host, message, timeoutMs, auth);
  };

  const startedAt = Date.now();
  const first = await attempt();
  if (first !== "unauthorized") return first;
  // The token was rejected (or is missing). Ask the desktop shell for a fresh
  // one, wait for it once, and try once more. Never a loop.
  const previous = resolveRequestAuth(ctx.name, ctx.server).bearer;
  if (!ctx.postTokenRejected()) return failed("sign-in-ended", host);
  const renewed = await waitForNewAccessToken(ctx.name, previous, tokenWaitFor(message, ctx.tokenWaitMs, Date.now() - startedAt));
  if (!renewed) return failed("sign-in-ended", host);
  const second = await attempt();
  return second === "unauthorized" ? failed("sign-in-ended", host) : second;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "this server";
  }
}

type Auth = ReturnType<typeof resolveRequestAuth>;

async function viaStreamableHttp(ctx: RelayContext, url: string, host: string, message: Message, timeoutMs: number, auth: Auth): Promise<RelayResult | "unauthorized"> {
  let response: GuardedBufferResponse;
  try {
    response = await guardedRequest({
      url, method: "POST", kind: "mcp", mode: "request", confirmed: ctx.server.local ?? null,
      signal: ctx.signal, resolver: ctx.resolver, totalMs: timeoutMs, body: JSON.stringify(message),
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", ...auth.headers,
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
        ...(ctx.sessionId ? { "mcp-session-id": ctx.sessionId } : {}),
        ...(ctx.protocolVersion ? { "mcp-protocol-version": ctx.protocolVersion } : {}),
      },
    });
  } catch (error) {
    return failed(reasonForGuardedError(error instanceof GuardedHttpError ? error.code : "unreachable"), host);
  }
  const { status } = response;
  if (status === 200 || status === 202) {
    const type = String(Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] : response.headers["content-type"] ?? "");
    const contentType = /^application\/json/i.test(type) ? "application/json" : /^text\/event-stream/i.test(type) ? "text/event-stream" : null;
    if (status === 202) return { ok: true, status: 202, contentType: "application/json", body: Buffer.alloc(0), ...sessionOf(response) };
    if (!contentType) return failed("wrong-address", host);
    return { ok: true, status: 200, contentType, body: response.body, ...sessionOf(response) };
  }
  if (status === 401 || status === 403) {
    const classified = classifyUnauthorized({ status, wwwAuthenticate: response.headers["www-authenticate"], sent: auth.bearer ? "bearer" : Object.keys(auth.headers).length > 0 ? "key" : "nothing" });
    if (classified.reason === "sign-in-ended" && status === 401) return "unauthorized";
    if (classified.reason === "needs-more-access") {
      const result = failed(classified.reason, host);
      return classified.scopes.length > 0 ? { ...result, stepUpScopes: classified.scopes } as RelayResult : result;
    }
    return failed(classified.reason, host);
  }
  if ([301, 302, 307, 308].includes(status)) return failed("moved", host);
  if (!ctx.server.transport && !ctx.sessionId && message.method === "initialize" && [400, 404, 405].includes(status)) {
    // A link that was never tested may be a legacy SSE server.
    return viaSse(ctx, url, host, message, timeoutMs, auth);
  }
  return failed(status >= 500 ? "server-error" : "wrong-address", host);
}

function sessionOf(response: GuardedBufferResponse): { sessionId?: string } {
  const id = safeSessionId(response.headers["mcp-session-id"]);
  return id ? { sessionId: id } : {};
}

async function viaSse(ctx: RelayContext, url: string, host: string, message: Message, timeoutMs: number, auth: Auth): Promise<RelayResult | "unauthorized"> {
  let sessionId = ctx.sessionId && ctx.sseSessions.has(ctx.sessionId) ? ctx.sessionId : undefined;
  if (!sessionId) {
    // Nothing was sent: the stream this call named is not held here, so resending after a fresh initialize is safe.
    if (message.method !== "initialize") return failed("session-gone", host);
    const opened = await ctx.sseSessions.open({ name: ctx.name, generation: ctx.generation, url, headers: auth.headers, bearer: auth.bearer, confirmed: ctx.server.local ?? null, signal: ctx.signal, resolver: ctx.resolver });
    if (!opened.ok) return sseFailure(opened, host);
    sessionId = opened.sessionId;
  }
  const answered = await ctx.sseSessions.call(sessionId, ctx.name, ctx.generation, message, {
    dialUrl: url, confirmed: ctx.server.local ?? null, headers: auth.headers, bearer: auth.bearer, timeoutMs, signal: ctx.signal, resolver: ctx.resolver,
  });
  if (!answered.ok) return sseFailure(answered, host);
  if (answered.frame === null) return { ok: true, status: 202, contentType: "application/json", body: Buffer.alloc(0), sessionId };
  return { ok: true, status: 200, contentType: "application/json", body: JSON.stringify(answered.frame), sessionId };
}

/** The same reading of a refusal as streamable HTTP: a 401 on a token is retried
 * once, a 403 is not (it is a scope refusal or a plain refusal), and a scope
 * refusal carries what the server asked for outside the body the engine reads. */
function sseFailure(failure: SseSessionFailure, host: string): RelayResult | "unauthorized" {
  if (failure.reason === "sign-in-ended" && failure.status !== 403) return "unauthorized";
  const result = failed(failure.reason, host);
  return failure.stepUpScopes && failure.stepUpScopes.length > 0 ? { ...result, stepUpScopes: failure.stepUpScopes } as RelayResult : result;
}
