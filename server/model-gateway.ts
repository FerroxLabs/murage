// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The local model gateway for plan sign-ins (ChatGPT, Grok).
//
//   engine ──(gateway key)──▶ 127.0.0.1:<harness>/api/model-gateway/<id>/v1/…
//                                  │ fresh plan token, upstream headers
//                                  ▼
//             chatgpt.com/backend-api/codex/responses  |  api.x.ai/v1/…
//
// Why a gateway: the plan token lasts about an hour and rotates, so it cannot
// sit in an engine's environment for a long turn, and the ChatGPT plan
// backend takes only streamed Responses calls. The upstream request shape
// (headers, endpoint) is Wayland's (chatgptOAuth.ts inference-seam notes).
//
// Rules this file keeps:
//  - The token is sent only to the preset's pinned host. Anything else fails.
//  - A plan usage limit pauses the connection and says so. There is no retry
//    loop and never a fallback to another provider or to Flux.
//  - Tokens never appear in a response, an error or a log line.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { CHATGPT_IDENTITY_HEADERS, SIGNIN_PRESETS, signInProviderForConnection } from "../electron/model-signin-presets.mjs";
import type { ProviderCatalog, SignInPreset } from "../shared/provider-connections.ts";
import { type ModelSignIns, needsSignInLine, planLimitLine } from "./model-signin.ts";
import { UpstreamStreamError, chatToResponses, collectResponse, createChatStreamTranslator, createResponsesPassthrough, createSseParser, normalizeResponsesBody, responseToChatCompletion } from "./model-gateway-translate.ts";

export const MODEL_GATEWAY_PREFIX = "/api/model-gateway/";
const ROUTE = /^\/api\/model-gateway\/([A-Za-z0-9_-]{1,100})\/v1\/(responses|chat\/completions|models)$/;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_ERROR_BODY = 64 * 1024;
const DEFAULT_PAUSE_MS = 15 * 60 * 1000;
const PINNED_HOSTS: Record<SignInPreset, string> = { chatgpt: "chatgpt.com", supergrok: "api.x.ai" };

export interface ModelGatewayDeps {
  signIns: ModelSignIns;
  catalog: (id: string) => ProviderCatalog;
  fetch?: typeof fetch;
  now?: () => number;
}

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function gatewayBaseUrl(port: number, connectionId: string): string {
  return `http://127.0.0.1:${port}${MODEL_GATEWAY_PREFIX}${connectionId}/v1`;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}
function sendError(res: ServerResponse, status: number, message: string, code: string): void {
  sendJson(res, status, { error: { message, type: code, code } });
}
/** The plan-limit answer, in the shape engines already treat as a hard
 * limit (type usage_limit_reached, Retry-After), so they stop instead of
 * retrying, and show the line. */
function sendPlanLimit(res: ServerResponse, provider: SignInPreset, until: number, now: number): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(Math.max(1, Math.ceil((until - now) / 1000))) })
    .end(JSON.stringify({ error: { message: planLimitLine(provider, until), type: "usage_limit_reached", code: "plan_limit_reached", resets_at: Math.floor(until / 1000) } }));
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); return record(parsed) ? parsed : null; }
  catch { return null; }
}

/** Remove anything token shaped before a vendor message reaches an engine. */
export function redact(textValue: string, secrets: string[]): string {
  let out = textValue;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]").replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]");
}

/** When a plan limit resets, from the vendor body or Retry-After. */
export function limitResetsAt(body: unknown, retryAfter: string | null, now: number): number | undefined {
  const error = record(body) && record(body.error) ? body.error : record(body) ? body : {};
  const at = Number(error.resets_at ?? NaN);
  if (Number.isFinite(at) && at > 0) return at < 1e12 ? at * 1000 : at;
  const inSeconds = Number(error.resets_in_seconds ?? NaN);
  if (Number.isFinite(inSeconds) && inSeconds > 0) return now + inSeconds * 1000;
  const header = Number(retryAfter ?? NaN);
  if (Number.isFinite(header) && header > 0) return now + header * 1000;
  return undefined;
}

/** Is this 429 the plan's usage limit, rather than a short rate limit? */
export function isPlanLimit(provider: SignInPreset, body: unknown): boolean {
  const error = record(body) && record(body.error) ? body.error : record(body) ? body : {};
  const words = `${error.type ?? ""} ${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  void provider;
  return /usage_limit|usage limit|limit_reached|plan limit|quota/.test(words) || error.resets_at !== undefined || error.resets_in_seconds !== undefined;
}

function upstreamUrl(provider: SignInPreset, route: string): string {
  const base = SIGNIN_PRESETS[provider].baseUrl;
  if (provider === "chatgpt") return `${base}/responses`;
  return `${base}/${route}`;
}

function upstreamHeaders(provider: SignInPreset, token: { accessToken: string; accountId?: string }, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token.accessToken}`, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" };
  if (provider === "chatgpt") {
    // Wayland's documented seam for the Codex backend.
    headers["openai-beta"] = "responses=experimental";
    Object.assign(headers, CHATGPT_IDENTITY_HEADERS);
    headers.accept = "text/event-stream";
    if (token.accountId) headers["chatgpt-account-id"] = token.accountId;
  }
  return headers;
}

/**
 * Handle one gateway request. Returns false when the path is not a gateway
 * path (the caller routes it elsewhere).
 */
export async function handleModelGateway(req: IncomingMessage, res: ServerResponse, path: string, deps: ModelGatewayDeps): Promise<boolean> {
  if (!path.startsWith(MODEL_GATEWAY_PREFIX)) return false;
  const match = ROUTE.exec(path);
  if (!match) { sendError(res, 404, "No such model gateway route.", "not_found"); return true; }
  if (!isLoopback(req.socket.remoteAddress)) { sendError(res, 403, "The model gateway answers this computer only.", "forbidden"); return true; }
  const [, id, route] = match as unknown as [string, string, "responses" | "chat/completions" | "models"];
  const provider = signInProviderForConnection(id);
  if (!provider || !deps.signIns.has(id) || !deps.signIns.verifyGatewayKey(id, req.headers.authorization)) {
    sendError(res, 401, "This model gateway key is not valid. Start the turn again.", "invalid_api_key");
    return true;
  }
  const method = req.method ?? "GET";
  if (route === "models") {
    if (method !== "GET") { sendError(res, 405, "Use GET for the model list.", "method_not_allowed"); return true; }
    const models = deps.catalog(id).models.filter(model => model.enabled && model.chatEligible);
    sendJson(res, 200, { object: "list", data: models.map(model => ({ id: model.id, object: "model", created: 0, owned_by: provider === "chatgpt" ? "openai" : "xai" })) });
    return true;
  }
  if (method !== "POST") { sendError(res, 405, "Use POST.", "method_not_allowed"); return true; }
  if (provider === "chatgpt" && route !== "responses" && route !== "chat/completions") { sendError(res, 404, "No such model gateway route.", "not_found"); return true; }
  const now = deps.now?.() ?? Date.now();
  const pausedUntil = deps.signIns.pausedUntil(id);
  if (pausedUntil) { sendPlanLimit(res, provider, pausedUntil, now); return true; }
  const body = await readJson(req);
  if (!body) { sendError(res, 400, "The request body must be one JSON object.", "invalid_request"); return true; }

  // Shape the upstream call.
  let upstreamBody: Json, wantStream: boolean, chat: ReturnType<typeof chatToResponses> | null = null;
  if (provider === "chatgpt") {
    if (route === "chat/completions") { chat = chatToResponses(body); upstreamBody = chat.request; wantStream = chat.wantStream; }
    else ({ request: upstreamBody, wantStream } = normalizeResponsesBody(body));
  } else { upstreamBody = body; wantStream = body.stream === true; }

  const controller = new AbortController();
  res.once("close", () => { if (!res.writableFinished) controller.abort(); });
  const fetcher = deps.fetch ?? fetch;
  const call = async (token: { accessToken: string; accountId?: string }) => {
    const url = upstreamUrl(provider, route);
    if (new URL(url).hostname !== PINNED_HOSTS[provider]) throw new Error("upstream host is not pinned");
    return fetcher(url, { method: "POST", headers: upstreamHeaders(provider, token, provider === "chatgpt" || wantStream), body: JSON.stringify(upstreamBody), signal: controller.signal, redirect: "error" });
  };

  // 401 is kept for a bad gateway key. A plan token problem is a 403 with
  // its own code, so engines show the line instead of an API-key screen.
  const signInProblem = () => deps.signIns.info(id)?.state === "needs-sign-in" || !deps.signIns.bearer(id)
    ? sendError(res, 403, needsSignInLine(provider), "needs_sign_in")
    : sendError(res, 503, `Could not refresh the ${provider === "chatgpt" ? "ChatGPT" : "Grok"} sign-in just now. Try again in a moment.`, "sign_in_refresh_pending");
  let token = deps.signIns.bearer(id);
  if (!token) { signInProblem(); return true; }
  // About to expire: wait for the refresher rather than send a dying token.
  if (token.expiresAt !== undefined && token.expiresAt - 60_000 <= now) {
    await deps.signIns.freshToken(provider, token.accessToken);
    token = deps.signIns.bearer(id);
    if (!token) { signInProblem(); return true; }
  }
  let upstream: Response;
  try {
    upstream = await call(token);
    if (upstream.status === 401) {
      void upstream.body?.cancel();
      const stale = token.accessToken;
      if (await deps.signIns.freshToken(provider, stale)) {
        const next = deps.signIns.bearer(id);
        if (next) { token = next; upstream = await call(next); }
      }
    }
  } catch {
    if (controller.signal.aborted) { res.end(); return true; }
    sendError(res, 502, `Could not reach the ${provider === "chatgpt" ? "ChatGPT" : "xAI"} service. Check the connection and try again.`, "upstream_unreachable");
    return true;
  }
  const secrets = [token.accessToken, token.accountId ?? ""];

  if (!upstream.ok) {
    const raw = await readLimited(upstream);
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (upstream.status === 429) {
      if (isPlanLimit(provider, parsed)) {
        const until = limitResetsAt(parsed, upstream.headers.get("retry-after"), now) ?? now + DEFAULT_PAUSE_MS;
        deps.signIns.pause(id, until);
        sendPlanLimit(res, provider, until, now);
      } else sendError(res, 429, `The ${provider === "chatgpt" ? "ChatGPT" : "Grok"} plan is limiting requests right now. Try again in a moment.`, "rate_limited");
      return true;
    }
    if (upstream.status === 401) { signInProblem(); return true; }
    if (upstream.status === 403) {
      sendError(res, 403, provider === "supergrok"
        ? "xAI has not enabled this sign-in for your account yet. Use an xAI API key instead."
        : "This ChatGPT plan cannot be used here. Try another account or add an OpenAI key.", "forbidden");
      return true;
    }
    const vendor = record(parsed) && record(parsed.error) && typeof parsed.error.message === "string" ? parsed.error.message : record(parsed) && typeof parsed.detail === "string" ? parsed.detail : "";
    sendError(res, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
      redact(`The ${provider === "chatgpt" ? "ChatGPT" : "xAI"} service answered ${upstream.status}${vendor ? `: ${vendor.slice(0, 2000)}` : "."}`, secrets), "upstream_error");
    return true;
  }

  // Grok: straight through, both protocols.
  if (provider === "supergrok") {
    res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? (wantStream ? "text/event-stream" : "application/json"), "cache-control": "no-store" });
    await pipe(upstream, chunk => { res.write(chunk); });
    res.end();
    return true;
  }

  // ChatGPT: the backend always streams Responses events.
  const created = Math.floor(now / 1000), chatId = `chatcmpl-${randomBytes(12).toString("hex")}`;
  if (wantStream && !chat) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const passthrough = createResponsesPassthrough(text => { res.write(text); });
    const decoder = new TextDecoder();
    await pipe(upstream, chunk => passthrough.push(decoder.decode(chunk, { stream: true })));
    passthrough.end();
    res.end();
    return true;
  }
  if (wantStream && chat) {
    const translator = createChatStreamTranslator(chat.model, chatId, created, chat.includeUsage);
    let failed: string | null = null, started = false;
    // Headers wait for the first real chunk: a failure before any answer is
    // an ordinary HTTP error every engine reads.
    const write = (piece: unknown) => {
      if (!started) { started = true; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" }); }
      res.write(`data: ${JSON.stringify(piece)}\n\n`);
    };
    let buffered: unknown[] = [];
    const parser = createSseParser(event => {
      if (failed) return;
      try {
        const pieces = translator.push(event);
        // Hold the opening role chunk until real content or the finish follows.
        const real = pieces.filter(piece => { const delta = (piece as { choices: Array<{ delta: Record<string, unknown>; finish_reason: unknown }> }).choices[0]; return delta.finish_reason !== null || Object.keys(delta.delta).some(key => key !== "role" && (key !== "content" || delta.delta.content !== "")); });
        if (!started && !real.length) { buffered.push(...pieces); return; }
        for (const piece of [...buffered, ...pieces]) write(piece);
        buffered = [];
      } catch (error) { failed = redact(error instanceof Error ? error.message : "The model service ended the answer with an error.", secrets); }
    });
    const decoder = new TextDecoder();
    await pipe(upstream, chunk => parser.push(decoder.decode(chunk, { stream: true })));
    parser.end();
    if (!failed && !translator.finished) failed = "The model service stopped before the answer finished.";
    if (failed && !started) { sendError(res, 502, failed, "upstream_error"); return true; }
    for (const piece of buffered) write(piece);
    if (failed) write({ id: chatId, object: "chat.completion.chunk", created, model: chat.model, choices: [], error: { message: failed, type: "upstream_error" } });
    res.end("data: [DONE]\n\n");
    return true;
  }
  // Not streamed by the caller: collect the stream into one answer.
  const events: Json[] = [];
  const parser = createSseParser(event => { events.push(event); });
  const decoder = new TextDecoder();
  await pipe(upstream, chunk => parser.push(decoder.decode(chunk, { stream: true })));
  parser.end();
  try {
    const response = collectResponse(events);
    sendJson(res, 200, chat ? responseToChatCompletion(response, chat.model, chatId, created) : response);
  } catch (error) {
    sendError(res, 502, redact(error instanceof UpstreamStreamError ? error.message : "The model service ended the answer with an error.", secrets), "upstream_error");
  }
  return true;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_ERROR_BODY) { await reader.cancel(); break; }
      chunks.push(next.value);
    }
  } catch { /* partial is fine for an error message */ }
  return Buffer.concat(chunks).toString("utf8");
}

async function pipe(response: Response, write: (chunk: Uint8Array) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      write(next.value);
    }
  } catch { /* the caller hung up or the vendor dropped; the stream just ends */ }
}
