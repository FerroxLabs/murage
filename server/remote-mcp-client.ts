// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The client half of "add a server by link" (spec MCP-LINK 3.5, 3.6). It
// connects to a remote MCP server over streamable HTTP and falls back to the
// older HTTP+SSE transport, proves the handshake, lists the tools, and turns
// every failure into one of a fixed set of reasons with a fixed sentence.
//
// Two rules shape this file:
//  - Every byte goes out through shared/guarded-http.mjs, so the address rules
//    of spec 3.9 hold on every request, and a credential is sent only to the
//    exact origin of the server URL (an MCP request never follows a redirect).
//  - Nothing the upstream says reaches the result except redacted tool names and
//    descriptions. Error bodies, headers and status text are read to classify,
//    then dropped.
//
// Each security rule is a named function so the review can read and test it
// alone: parseWwwAuthenticate, classifyUnauthorized, safeResourceMetadataUrl,
// reasonForGuardedError, isSameOriginEndpoint, redactUpstreamText, createSseReader.
import { Readable } from "node:stream";

import { GuardedHttpError, guardedRequest, type GuardedRequestOptions, type GuardedStreamResponse } from "../shared/guarded-http.mjs";
import { LIMITS, parseServerUrl, sameOrigin, type LocalConfirmation } from "../shared/remote-mcp-url.mjs";
import { displayUrl, urlHasSecret } from "../shared/mcp-secret-url.mjs";
import type { McpProbeFailureReason, McpProbeResult, McpProbeTool } from "./mcp-probe.ts";

export type RemoteTransport = "http" | "sse";

export interface RemoteProbeInput {
  /** The dialable link (full, from the secret store or the dev config). */
  url: string;
  transport?: RemoteTransport;
  /** Header values by name, already resolved from the secret store. */
  headers?: Record<string, string>;
  /** An OAuth access token, sent as `Authorization: Bearer`. */
  bearer?: string;
  confirmed?: LocalConfirmation | null;
  mode?: "inspect" | "request";
  signal?: AbortSignal;
  totalMs?: number;
  /** Tests only: a fixed DNS answer. Every answer is still judged. */
  resolver?: GuardedRequestOptions["resolver"];
  /** How long the legacy SSE stream may be silent (review L7). */
  idleMs?: number;
}

// ── named security rules ────────────────────────────────────────────────

export interface WwwAuthenticate {
  scheme: string;
  params: Record<string, string>;
}

/** Parse one `WWW-Authenticate` challenge: a scheme and quoted or bare params.
 * Only the first challenge is read; nothing is evaluated or followed here. */
export function parseWwwAuthenticate(header: string | string[] | undefined): WwwAuthenticate | null {
  const text = Array.isArray(header) ? header[0] : header;
  if (!text) return null;
  const match = /^\s*([A-Za-z][A-Za-z0-9._~+-]*)\s*(.*)$/s.exec(text.slice(0, 4_096));
  if (!match) return null;
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  const rest = match[2] ?? "";
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;
  for (let item = pattern.exec(rest); item; item = pattern.exec(rest)) {
    const key = (item[1] ?? "").toLowerCase();
    if (key === "__proto__") continue;
    params[key] = (item[2] ?? item[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return { scheme: match[1]!.toLowerCase(), params };
}

/** A `resource_metadata` value is a link the server chose. Keep it only when it
 * is a plain http(s) address without userinfo; the sign-in code in main judges
 * it again before fetching. */
export function safeResourceMetadataUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = parseServerUrl(raw);
  return parsed.ok ? parsed.href : undefined;
}

/** Which header an API key goes in, from the words the server used. */
export function headerHintFrom(...texts: Array<string | undefined>): "x-api-key" | "authorization" {
  return texts.some((text) => text !== undefined && /x-api-key/i.test(text)) ? "x-api-key" : "authorization";
}

function mentionsApiKey(...texts: Array<string | undefined>): boolean {
  return texts.some((text) => text !== undefined && /x-api-key|api[ _-]?key/i.test(text));
}

export interface UnauthorizedInput {
  status: number;
  wwwAuthenticate?: string | string[];
  body?: string;
  /** A protected-resource metadata document exists at a well-known path. */
  prmExists?: boolean;
  /** What this request carried. */
  sent: "nothing" | "key" | "bearer";
}

export type UnauthorizedClass =
  | { reason: "needs-sign-in"; resourceMetadataUrl?: string; scope?: string; apiKey?: { headerHint: "x-api-key" | "authorization" } }
  | { reason: "needs-key"; apiKey: { headerHint: "x-api-key" | "authorization" } }
  | { reason: "key-rejected" }
  | { reason: "sign-in-ended" }
  | { reason: "needs-more-access"; scopes: string[] };

/** Classify a 401 or 403 (spec 3.5 steps 4 and 5). Reads the challenge and the
 * first 2 KiB of the body to decide; returns only fixed fields. */
export function classifyUnauthorized(input: UnauthorizedInput): UnauthorizedClass {
  const challenge = parseWwwAuthenticate(input.wwwAuthenticate);
  const body = input.body?.slice(0, 2_048);
  const header = Array.isArray(input.wwwAuthenticate) ? input.wwwAuthenticate.join(" ") : input.wwwAuthenticate;
  if (input.status === 403 && challenge?.params.error === "insufficient_scope") {
    return { reason: "needs-more-access", scopes: (challenge.params.scope ?? "").split(/\s+/).filter(Boolean).slice(0, 20) };
  }
  if (input.sent === "key") return { reason: "key-rejected" };
  if (input.sent === "bearer") return { reason: "sign-in-ended" };
  const resourceMetadataUrl = safeResourceMetadataUrl(challenge?.params.resource_metadata);
  if (resourceMetadataUrl || input.prmExists) {
    return {
      reason: "needs-sign-in",
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(challenge?.params.scope ? { scope: challenge.params.scope.slice(0, 500) } : {}),
      ...(mentionsApiKey(body, header) ? { apiKey: { headerHint: headerHintFrom(body, header) } } : {}),
    };
  }
  return { reason: "needs-key", apiKey: { headerHint: headerHintFrom(body, header) } };
}

/** Map a guarded-http failure to a probe reason. */
export function reasonForGuardedError(code: string): McpProbeFailureReason {
  switch (code) {
    case "not-found":
    case "unresolved-address":
      return "not-found";
    case "dns-timeout":
    case "timeout":
      return "no-answer";
    case "unreachable":
      return "unreachable";
    case "https-required":
      return "https-required";
    case "local-confirm":
      return "local-confirm";
    case "address-changed":
      return "address-changed";
    case "refused-address":
    case "address-mismatch":
      return "blocked-address";
    case "aborted":
      return "cancelled";
    default:
      return "wrong-address";
  }
}

/** The legacy transport announces where to POST. It must be on the server's own
 * origin, or a hostile server could steer the credential to another host. */
export function isSameOriginEndpoint(serverUrl: string, endpoint: string): boolean {
  try {
    return sameOrigin(serverUrl, new URL(endpoint, serverUrl).href);
  } catch {
    return false;
  }
}

/** Replace every configured secret value in text with a marker. Values shorter
 * than 4 characters are not replaced (they would shred ordinary words). */
export function redactUpstreamText(text: string, secrets: Iterable<string>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

// ── reasons and their fixed sentences ───────────────────────────────────

export interface RemoteFailureDetail {
  host: string;
  suggestUrl?: string;
  needs?: LocalConfirmation;
}

/** The one sentence per reason (spec 7.3). Only the server host, which the owner
 * typed, is ever interpolated. */
export function remoteFailureSentence(reason: McpProbeFailureReason, detail: RemoteFailureDetail): string {
  const { host } = detail;
  switch (reason) {
    case "needs-sign-in": return `This server needs you to sign in to ${host}.`;
    case "needs-key": return "This server needs an API key.";
    case "key-rejected": return `${host} did not accept this API key. Check it and try again.`;
    case "sign-in-ended": return `Your sign-in to ${host} has ended. Sign in again.`;
    case "needs-more-access": return `${host} needs you to allow more access for this tool. Sign in again to allow it.`;
    case "not-found": return `Murage could not find ${host}. Check the link and your internet connection.`;
    case "unreachable": return `${host} did not accept the connection. Check the link, or try again in a moment.`;
    case "wrong-address": return "Nothing at this address answers as an MCP server. Check that you copied the whole link.";
    case "moved": return `This server has moved to ${detail.suggestUrl ? displayUrl(detail.suggestUrl) : "a new address"}. Use the new link?`;
    case "https-required": return "Murage connects to servers on the internet over https only. Check the link starts with https://.";
    case "local-confirm":
      return detail.needs === "local-network"
        ? `This link points to a device on your local network (${host}). Only continue if you know what runs there.`
        : "This link points to this computer. Only continue if you started this server yourself.";
    case "address-changed": return "This name now points somewhere else than when you added it. Remove it and add it again if that is expected.";
    case "blocked-address": return "Murage does not connect to that kind of address.";
    case "server-error": return `${host} had a problem answering. Try again in a moment.`;
    case "no-answer": return "The server did not answer in time. Try again in a moment.";
    case "session-gone": return "The connection to this server was closed. Try again in a moment.";
    case "cancelled": return "Connection test was cancelled.";
    default: return "The server did not complete MCP initialization.";
  }
}

// ── SSE reading with an idle timeout and a per-event cap (review L7) ─────

export class SseReaderError extends Error {
  // No parameter properties: the server runs under node's strip-only TypeScript mode.
  readonly code: "idle-timeout" | "event-too-large" | "closed";
  constructor(code: "idle-timeout" | "event-too-large" | "closed") {
    super(code);
    this.name = "SseReaderError";
    this.code = code;
  }
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Read server-sent events from a byte stream. Fails with `idle-timeout` when
 * nothing arrives for `idleMs`, and with `event-too-large` when one event
 * (its data lines together) passes `maxEventBytes`. Comment lines count as
 * activity but carry no bytes toward the cap. */
export async function* createSseReader(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  options: { idleMs: number; maxEventBytes: number },
): AsyncGenerator<SseEvent> {
  const iterator = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffered = "";
  let event = "message";
  let data: string[] = [];
  let eventBytes = 0;
  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      event = "message";
      return null;
    }
    const out = { event, data: data.join("\n") };
    event = "message";
    data = [];
    eventBytes = 0;
    return out;
  };
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SseReaderError("idle-timeout")), options.idleMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) {
        buffered += decoder.decode();
        break;
      }
      const chunk = next.value;
      buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      // A line that never ends is an event that never ends.
      if (buffered.length > options.maxEventBytes + 1_024 && !buffered.includes("\n")) throw new SseReaderError("event-too-large");
      let newline = buffered.search(/\r\n|\n|\r/);
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        const eol = buffered.startsWith("\r\n", newline) ? 2 : 1;
        buffered = buffered.slice(newline + eol);
        if (line === "") {
          const out = flush();
          if (out) yield out;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") {
            eventBytes += Buffer.byteLength(value) + 1;
            if (eventBytes > options.maxEventBytes) throw new SseReaderError("event-too-large");
            data.push(value);
          }
        }
        newline = buffered.search(/\r\n|\n|\r/);
      }
    }
    const last = flush();
    if (last) yield last;
    throw new SseReaderError("closed");
  } finally {
    // Not awaited: a stream iterator with a read still pending does not finish
    // `return()` until that read does, which for a silent server is never.
    // The caller closes the stream.
    void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
  }
}

// ── JSON-RPC over the wire ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The answer to request `id` from a JSON body or an SSE body, or null. */
export function parseRpcResponse(text: string, id: number): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      return isRecord(value) && value.id === id ? value : null;
    } catch {
      return null;
    }
  }
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? null;
}

function validInitialize(frame: Record<string, unknown> | null): boolean {
  if (!frame || frame.jsonrpc !== "2.0" || "error" in frame || !isRecord(frame.result)) return false;
  const result = frame.result;
  return typeof result.protocolVersion === "string" && result.protocolVersion !== "" && isRecord(result.capabilities)
    && isRecord(result.serverInfo) && typeof result.serverInfo.name === "string" && typeof result.serverInfo.version === "string";
}

function collectTools(frame: Record<string, unknown> | null, secrets: string[]): McpProbeTool[] | null {
  if (!frame || frame.jsonrpc !== "2.0" || "error" in frame || !isRecord(frame.result) || !Array.isArray(frame.result.tools)) return null;
  const tools: McpProbeTool[] = [];
  for (const raw of frame.result.tools.slice(0, LIMITS.toolsListed)) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name.trim()) continue;
    tools.push({
      name: redactUpstreamText(raw.name, secrets).slice(0, 200),
      ...(typeof raw.description === "string" ? { description: redactUpstreamText(raw.description, secrets).slice(0, 500) } : {}),
    });
  }
  return tools;
}

function initializeFrame(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0", id, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Murage", version: "probe" } },
  });
}

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The next event, or a rejection when `deadline` passes or `signal` aborts,
 * whichever comes first. */
export function nextBefore<T>(
  source: { next(): Promise<IteratorResult<T>> },
  deadline: number,
  signal: AbortSignal | undefined,
  onDeadline: () => Error,
  onAbort: () => Error,
): Promise<IteratorResult<T>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(onAbort()); return; }
    const timer = setTimeout(() => reject(onDeadline()), Math.max(1, deadline - Date.now()));
    timer.unref?.();
    const abort = () => reject(onAbort());
    signal?.addEventListener("abort", abort, { once: true });
    source.next().then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });
}

// ── the probe ───────────────────────────────────────────────────────────

class Stop extends Error {
  readonly result: McpProbeResult;
  constructor(result: McpProbeResult) {
    super("stop");
    this.result = result;
  }
}

/** Connect, handshake and list tools over streamable HTTP, then the legacy SSE
 * transport. Always returns a result; never throws. */
export async function probeRemoteMcp(input: RemoteProbeInput): Promise<McpProbeResult> {
  const parsed = parseServerUrl(input.url);
  const host = parsed.ok ? parsed.hostname : "this server";
  const secrets = [...Object.values(input.headers ?? {}), ...(input.bearer ? [input.bearer] : []), input.url].filter(Boolean);
  const sent: UnauthorizedInput["sent"] = input.bearer ? "bearer" : Object.keys(input.headers ?? {}).length > 0 ? "key" : "nothing";
  const totalMs = input.totalMs ?? LIMITS.probeTotalMs;
  const deadline = Date.now() + totalMs;
  const fail = (reason: McpProbeFailureReason, extra: Partial<Extract<McpProbeResult, { ok: false }>> & { needs?: LocalConfirmation } = {}): McpProbeResult => ({
    ok: false,
    reason,
    error: remoteFailureSentence(reason, { host, suggestUrl: extra.suggestUrl, needs: extra.needs }),
    ...extra,
  });
  const authHeaders = (): Record<string, string> => ({
    ...(input.headers ?? {}),
    ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
  });
  const request = async (options: Partial<GuardedRequestOptions> & { url: string }) => {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      return await guardedRequest({
        kind: "mcp",
        mode: input.mode ?? "request",
        confirmed: input.confirmed ?? null,
        signal: input.signal,
        totalMs: remaining,
        resolver: input.resolver,
        ...options,
      } as GuardedRequestOptions & { responseMode?: "buffer" });
    } catch (error) {
      const code = error instanceof GuardedHttpError ? error.code : "unreachable";
      throw new Stop(fail(reasonForGuardedError(code), code === "local-confirm" && error instanceof GuardedHttpError ? { needs: error.needs as LocalConfirmation } : {}));
    }
  };

  const prmExists = async (): Promise<boolean> => {
    if (!parsed.ok) return false;
    const origin = `${parsed.scheme}://${new URL(input.url).host}`;
    for (const path of [`/.well-known/oauth-protected-resource${parsed.path === "/" ? "" : parsed.path}`, "/.well-known/oauth-protected-resource"]) {
      try {
        const response = await request({ url: `${origin}${path}`, kind: "metadata", headers: { accept: "application/json" } });
        if (response.status !== 200 || !("body" in response)) continue;
        const document: unknown = JSON.parse(response.body.toString("utf8"));
        if (isRecord(document) && Array.isArray(document.authorization_servers) && document.authorization_servers.length > 0) return true;
      } catch {
        // A missing or unreadable document is simply "no".
      }
    }
    return false;
  };

  const explainStatus = async (status: number, headers: Record<string, string | string[] | undefined>, body: string): Promise<McpProbeResult> => {
    if (status === 401 || status === 403) {
      const classified = classifyUnauthorized({
        status, wwwAuthenticate: headers["www-authenticate"], body, sent,
        prmExists: sent === "nothing" && !headers["www-authenticate"]?.includes("resource_metadata") ? await prmExists() : false,
      });
      const { reason, ...rest } = classified;
      const extras: Partial<Extract<McpProbeResult, { ok: false }>> = {};
      if ("resourceMetadataUrl" in rest || reason === "needs-sign-in") {
        extras.signIn = { host, ...("resourceMetadataUrl" in rest && rest.resourceMetadataUrl ? { resourceMetadataUrl: rest.resourceMetadataUrl } : {}), ...("scope" in rest && rest.scope ? { scopeHint: rest.scope } : {}) };
      }
      if ("apiKey" in rest && rest.apiKey) extras.apiKey = rest.apiKey;
      if ("scopes" in rest) extras.scopes = rest.scopes;
      return fail(reason, extras);
    }
    if ([301, 302, 307, 308].includes(status)) {
      const location = header(headers.location);
      const suggest = location ? parseServerUrl(new URL(location, input.url).href) : null;
      // Never the address itself: a redirect can carry a path token, and this
      // result goes to the renderer. Main, which holds the secret, acts on it.
      return suggest?.ok ? fail("moved", { suggestUrl: displayUrl(suggest.href), suggestHoldsSecret: urlHasSecret(suggest.href) }) : fail("wrong-address");
    }
    if (status >= 500) return fail("server-error");
    return fail("wrong-address");
  };

  const textOf = (response: { body?: Buffer }) => (response.body ? response.body.toString("utf8", 0, 4_096) : "");

  const viaStreamableHttp = async (): Promise<McpProbeResult | "fallback"> => {
    const post = (body: string, session?: string, protocol?: string) => request({
      url: input.url, method: "POST", body,
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", ...authHeaders(),
        ...(session ? { "mcp-session-id": session } : {}), ...(protocol ? { "mcp-protocol-version": protocol } : {}),
      },
    });
    const init = await post(initializeFrame(1));
    if (init.status !== 200) {
      if ([400, 404, 405].includes(init.status) && input.transport !== "http") return "fallback";
      return explainStatus(init.status, init.headers, textOf(init as { body?: Buffer }));
    }
    const initFrame = parseRpcResponse((init as { body: Buffer }).body.toString("utf8"), 1);
    if (!validInitialize(initFrame)) return fail("wrong-address");
    const session = header(init.headers["mcp-session-id"]);
    const protocol = String((initFrame!.result as { protocolVersion: string }).protocolVersion);
    const initialized = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), session, protocol);
    if (initialized.status >= 400) return explainStatus(initialized.status, initialized.headers, textOf(initialized as { body?: Buffer }));
    const list = await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), session, protocol);
    if (list.status !== 200) return explainStatus(list.status, list.headers, textOf(list as { body?: Buffer }));
    const tools = collectTools(parseRpcResponse((list as { body: Buffer }).body.toString("utf8"), 2), secrets);
    return tools ? { ok: true, tools, transport: "http" } : fail("wrong-address");
  };

  const viaLegacySse = async (): Promise<McpProbeResult> => {
    const opened = await request({ url: input.url, method: "GET", kind: "sse", responseMode: "stream", headers: { accept: "text/event-stream", ...authHeaders() } });
    if (opened.status !== 200 || !("stream" in opened)) return explainStatus(opened.status, opened.headers, "");
    const stream = opened as unknown as GuardedStreamResponse;
    const events = createSseReader(stream.stream as Readable, { idleMs: input.idleMs ?? 10_000, maxEventBytes: LIMITS.sseEventBytes });
    // Every wait on the stream is bounded by the probe's own deadline and its
    // caller's abort, not only by the reader's per-event idle timer (comment
    // lines reset that one): M4.
    const next = () => nextBefore(events, deadline, input.signal, () => new Stop(fail("no-answer")), () => new Stop(fail("cancelled")));
    try {
      const first = await next();
      if (first.done || first.value.event !== "endpoint") return fail("wrong-address");
      if (!isSameOriginEndpoint(input.url, first.value.data.trim())) return fail("wrong-address");
      const endpoint = new URL(first.value.data.trim(), input.url).href;
      const send = (body: string) => request({ url: endpoint, method: "POST", body, headers: { "content-type": "application/json", ...authHeaders() } });
      const answer = async (id: number): Promise<Record<string, unknown> | null> => {
        for (;;) {
          const item = await next();
          if (item.done) return null;
          if (item.value.event !== "message") continue;
          try {
            const frame: unknown = JSON.parse(item.value.data);
            if (isRecord(frame) && frame.id === id) return frame;
          } catch {
            // not a JSON-RPC frame; keep reading
          }
        }
      };
      const sentInit = await send(initializeFrame(1));
      if (sentInit.status >= 300) return explainStatus(sentInit.status, sentInit.headers, textOf(sentInit as { body?: Buffer }));
      const initFrame = await answer(1);
      if (!validInitialize(initFrame)) return fail("wrong-address");
      await send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      const sentList = await send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
      if (sentList.status >= 300) return explainStatus(sentList.status, sentList.headers, textOf(sentList as { body?: Buffer }));
      const tools = collectTools(await answer(2), secrets);
      return tools ? { ok: true, tools, transport: "sse" } : fail("wrong-address");
    } catch (error) {
      if (error instanceof Stop) throw error;
      if (error instanceof SseReaderError) return fail(error.code === "idle-timeout" ? "no-answer" : "wrong-address");
      return fail("unreachable");
    } finally {
      stream.close();
    }
  };

  try {
    if (!parsed.ok) return fail("wrong-address");
    if (input.transport !== "sse") {
      const outcome = await viaStreamableHttp();
      if (outcome !== "fallback") return outcome;
    }
    return await viaLegacySse();
  } catch (error) {
    if (error instanceof Stop) return error.result;
    return fail("unreachable");
  }
}
