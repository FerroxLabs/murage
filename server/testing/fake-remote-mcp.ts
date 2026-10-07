// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Fixture (spec MCP-LINK T15, stub): one local process that stands in for a
// remote MCP server AND its OAuth authorization server, with switchable modes.
// It is what the T4 client tests, the T7 relay tests and the T11 sign-in tests
// run against. Nothing here starts an engine; the per-engine "call the first
// custom tool" mode of the fake CLIs and the end-to-end run come with the full
// T15 in a later wave.
//
// Listens on 127.0.0.1 only, on an ephemeral port, over plain http. A test that
// reaches it through the guarded client must therefore confirm "this-computer".
// Dependency-free apart from node built-ins.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRemoteMcpOptions {
  /** What the MCP endpoint asks for. "both" accepts a bearer token or the API key, like ComfyUI. */
  auth: "none" | "bearer" | "api-key" | "both";
  apiKey: string;
  apiKeyHeader: string;
  /** Shape of the 401 answer. */
  unauthorized: "comfy" | "comfy-verbatim" | "bearer-resource-metadata" | "api-key-only" | "plain";
  /** "http" is streamable HTTP. "sse" is the older HTTP+SSE transport (GET the url, POST to the announced endpoint). */
  transport: "http" | "sse";
  respondWith: "json" | "sse";
  legacyPostStatus: 400 | 404 | 405;
  /** Where the legacy stream says to POST: a relative path, an absolute same-origin url, or another origin. */
  sseEndpoint: "relative" | "absolute" | "cross-origin";
  // protected-resource and authorization-server metadata
  prm: boolean;
  prmResource: string | undefined;
  asMetadata: "rfc8414" | "oidc" | "oidc-suffix" | "none";
  issuerOverride: string | undefined;
  /** The `issuer` the AS metadata document states, when it should differ from the identifier the PRM names (issuer mismatch). */
  metadataIssuer: string | undefined;
  pkceMethods: string[];
  dcr: boolean;
  revocation: boolean;
  issParameter: boolean;
  /** The `iss` the authorize redirect carries when issParameter is on (default: the issuer). */
  issValue: string | undefined;
  /** Status the revocation endpoint answers. */
  revocationStatus: number;
  // authorize and token
  approve: "auto" | "deny";
  accessTokenTtlSeconds: number;
  refreshMode: "rotate" | "keep" | "invalid-grant" | "unavailable";
  /** Hold every token endpoint answer this long (to prove single-flight refresh). */
  tokenDelayMs: number;
  strictResource: boolean;
  /** Calling this tool needs this scope on the bearer token, else 403 insufficient_scope. */
  requireScopeForTool: { tool: string; scope: string } | undefined;
  // misbehaviour
  initializeDelayMs: number;
  oversizeMcpBytes: number;
  oversizeMetadataBytes: number;
  mcpMovedTo: string | undefined;
  redirectTrapTarget: string;
  /** Answer every MCP POST with this status and a body that holds marker text. */
  mcpFailStatus: number | undefined;
  /** The description of the first tool (to prove redaction), and how many tools to list. */
  toolDescription: string | undefined;
  toolCount: number | undefined;
  /** Legacy SSE: accept the stream but never announce an endpoint. */
  sseSilent: boolean;
  /** Every access token expires right after a tools/list is answered: the
   * next call in the same session (a tool call mid-turn) answers 401. */
  expireOnToolsList: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeRemoteMcp {
  origin: string;
  port: number;
  mcpUrl: string;
  issuer: string;
  /** Live: change a field to change the fake's behaviour for the next request. */
  options: FakeRemoteMcpOptions;
  requests: RecordedRequest[];
  toolCalls: Array<{ name: string; arguments: unknown }>;
  registrations: Array<Record<string, unknown>>;
  tokenRequests: Array<Record<string, string>>;
  /** Every authorize request's query (client_id, redirect_uri, scope, resource, ...). */
  authorizeRequests: Array<Record<string, string>>;
  revocations: string[];
  /** Every revocation request's form (token, token_type_hint, client_id). */
  revocationRequests: Array<Record<string, string>>;
  redirectTrapHits: number;
  issuedAccessTokens(): string[];
  issuedRefreshTokens(): string[];
  /** Mint a valid access token without running the sign-in flow. */
  mintAccessToken(scope?: string): string;
  /** Every access token becomes expired: the next call answers 401 invalid_token. */
  expireAccessTokens(): void;
  /** Every refresh token becomes dead: the next refresh answers invalid_grant. */
  revokeRefreshTokens(): void;
  close(): Promise<void>;
}

/** The 401 ComfyUI answered on 2026-09-30 (spec 2.4), byte for byte. */
export const COMFY_VERBATIM_401 = {
  status: 401,
  headers: {
    "www-authenticate":
      'Bearer realm="comfy-cloud-mcp", resource_metadata="https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource", scope="comfy-mcp:tools:call"',
  },
  body: '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Authentication required. Provide an X-API-Key header or Authorization: Bearer token."},"id":null}',
} as const;

const DEFAULT_OPTIONS: FakeRemoteMcpOptions = {
  auth: "none",
  apiKey: "fake-api-key",
  apiKeyHeader: "x-api-key",
  unauthorized: "comfy",
  transport: "http",
  respondWith: "json",
  legacyPostStatus: 405,
  sseEndpoint: "relative",
  prm: true,
  prmResource: undefined,
  asMetadata: "rfc8414",
  issuerOverride: undefined,
  metadataIssuer: undefined,
  pkceMethods: ["S256"],
  dcr: true,
  revocation: true,
  issParameter: false,
  issValue: undefined,
  revocationStatus: 200,
  approve: "auto",
  accessTokenTtlSeconds: 3600,
  refreshMode: "rotate",
  tokenDelayMs: 0,
  strictResource: false,
  requireScopeForTool: undefined,
  initializeDelayMs: 0,
  oversizeMcpBytes: 0,
  oversizeMetadataBytes: 0,
  mcpMovedTo: undefined,
  redirectTrapTarget: "http://169.254.169.254/latest/meta-data/",
  mcpFailStatus: undefined,
  toolDescription: undefined,
  toolCount: undefined,
  sseSilent: false,
  expireOnToolsList: false,
};

const DEFAULT_SCOPE = "tools:call";

interface AccessToken { expiresAt: number; scope: string; clientId: string }
interface RefreshToken { clientId: string; scope: string; alive: boolean }
interface AuthCode { clientId: string; redirectUri: string; challenge: string; scope: string; resource: string | undefined }

const token = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", () => resolve(""));
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

export async function startFakeRemoteMcp(overrides: Partial<FakeRemoteMcpOptions> = {}): Promise<FakeRemoteMcp> {
  const options: FakeRemoteMcpOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const accessTokens = new Map<string, AccessToken>();
  const refreshTokens = new Map<string, RefreshToken>();
  const codes = new Map<string, AuthCode>();
  const clients = new Map<string, { redirectUris: string[] }>();
  const sessions = new Set<string>();
  const streams = new Map<string, http.ServerResponse>();
  const issuedAccess: string[] = [];
  const issuedRefresh: string[] = [];
  const state = {
    origin: "",
    requests: [] as RecordedRequest[],
    toolCalls: [] as Array<{ name: string; arguments: unknown }>,
    registrations: [] as Array<Record<string, unknown>>,
    tokenRequests: [] as Array<Record<string, string>>,
    authorizeRequests: [] as Array<Record<string, string>>,
    revocations: [] as string[],
    revocationRequests: [] as Array<Record<string, string>>,
    redirectTrapHits: 0,
  };
  const mcpPath = "/mcp";
  const mcpUrl = () => `${state.origin}${mcpPath}`;
  const issuer = () => options.issuerOverride ?? state.origin;

  const challenge = (error?: "invalid_token"): { headers: Record<string, string>; body: string } => {
    const rm = `${state.origin}/mcp/.well-known/oauth-protected-resource`;
    switch (options.unauthorized) {
      case "comfy-verbatim":
        return { headers: { ...COMFY_VERBATIM_401.headers }, body: COMFY_VERBATIM_401.body };
      case "comfy":
        return {
          headers: { "www-authenticate": `Bearer realm="comfy-cloud-mcp", resource_metadata="${rm}", scope="comfy-mcp:tools:call"${error ? `, error="${error}"` : ""}` },
          body: COMFY_VERBATIM_401.body,
        };
      case "bearer-resource-metadata":
        return {
          headers: { "www-authenticate": `Bearer resource_metadata="${rm}", scope="${DEFAULT_SCOPE}"${error ? `, error="${error}"` : ""}` },
          body: JSON.stringify({ error: "unauthorized" }),
        };
      case "api-key-only":
        return { headers: {}, body: JSON.stringify({ error: "Provide an X-API-Key header." }) };
      default:
        return { headers: {}, body: JSON.stringify({ error: "unauthorized" }) };
    }
  };

  /** null when allowed, else the answer to send. */
  const authorize = (req: http.IncomingMessage): { status: number; headers: Record<string, string>; body: string } | null => {
    if (options.auth === "none") return null;
    const key = req.headers[options.apiKeyHeader.toLowerCase()];
    if ((options.auth === "api-key" || options.auth === "both") && key === options.apiKey) return null;
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if ((options.auth === "bearer" || options.auth === "both") && bearer) {
      const record = accessTokens.get(bearer);
      if (record && record.expiresAt > Date.now()) return null;
      const answer = challenge("invalid_token");
      return { status: 401, ...answer };
    }
    return { status: 401, ...challenge() };
  };

  const bearerScope = (req: http.IncomingMessage): string | null => {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    return bearer ? accessTokens.get(bearer)?.scope ?? null : null;
  };

  const frame = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;

  const handleRpc = (raw: string, req: http.IncomingMessage): { status: number; headers?: Record<string, string>; message?: unknown; raw?: string; delay?: number } => {
    let body: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { status: 400, message: { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null } };
    }
    const id = body.id ?? null;
    switch (body.method) {
      case "initialize": {
        const session = `sess-${randomBytes(6).toString("hex")}`;
        sessions.add(session);
        return {
          status: 200,
          headers: { "mcp-session-id": session },
          delay: options.initializeDelayMs,
          message: { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-remote-mcp", version: "0.0.0" } } },
        };
      }
      case "notifications/initialized":
        return { status: 202 };
      case "ping":
        return { status: 200, message: { jsonrpc: "2.0", id, result: {} } };
      case "tools/list": {
        const padding = options.oversizeMcpBytes > 0 ? "x".repeat(options.oversizeMcpBytes) : undefined;
        const tools: Array<Record<string, unknown>> = options.toolCount !== undefined
          ? Array.from({ length: options.toolCount }, (_, index) => ({ name: `tool_${index}`, description: `Tool ${index}`, inputSchema: { type: "object" } }))
          : [
            { name: "echo", description: padding ?? options.toolDescription ?? "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
            { name: "sum", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
          ];
        if (options.expireOnToolsList) {
          options.expireOnToolsList = false;
          for (const record of accessTokens.values()) record.expiresAt = Date.now() - 1;
        }
        return { status: 200, message: { jsonrpc: "2.0", id, result: { tools } } };
      }
      case "tools/call": {
        const name = body.params?.name ?? "";
        const args = body.params?.arguments ?? {};
        const need = options.requireScopeForTool;
        if (need && need.tool === name && options.auth !== "none") {
          const scope = bearerScope(req);
          if (scope !== null && !scope.split(" ").includes(need.scope)) {
            return { status: 403, headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${need.scope}"` }, raw: JSON.stringify({ error: "insufficient_scope" }) };
          }
        }
        state.toolCalls.push({ name, arguments: args });
        const text = name === "sum" ? String(Number(args.a ?? 0) + Number(args.b ?? 0)) : String(args.text ?? "");
        return { status: 200, message: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } } };
      }
      default:
        return { status: 200, message: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } } };
    }
  };

  const asMetadata = () => ({
    issuer: options.metadataIssuer ?? issuer(),
    authorization_endpoint: `${state.origin}/oauth/authorize`,
    token_endpoint: `${state.origin}/oauth/token`,
    ...(options.dcr ? { registration_endpoint: `${state.origin}/oauth/register` } : {}),
    ...(options.revocation ? { revocation_endpoint: `${state.origin}/oauth/revoke` } : {}),
    code_challenge_methods_supported: options.pkceMethods,
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [DEFAULT_SCOPE, "tools:write"],
    ...(options.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.origin || "http://127.0.0.1");
    const path = url.pathname;
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
    state.requests.push({ method: req.method ?? "", path, headers: req.headers, body });

    // redirect trap
    if (path === "/redirect-trap") {
      state.redirectTrapHits += 1;
      res.writeHead(302, { location: options.redirectTrapTarget });
      res.end();
      return;
    }

    // protected resource metadata
    if (/^\/(mcp\/)?\.well-known\/oauth-protected-resource(\/mcp)?$/.test(path)) {
      if (!options.prm) return sendJson(res, 404, { error: "not found" });
      const document: Record<string, unknown> = {
        resource: options.prmResource ?? mcpUrl(),
        authorization_servers: [issuer()],
        scopes_supported: [DEFAULT_SCOPE, "tools:write"],
        bearer_methods_supported: ["header"],
      };
      if (options.oversizeMetadataBytes > 0) document.padding = "x".repeat(options.oversizeMetadataBytes);
      return sendJson(res, 200, document);
    }

    // authorization server metadata
    if (path === "/.well-known/oauth-authorization-server") {
      return options.asMetadata === "rfc8414" ? sendJson(res, 200, asMetadata()) : sendJson(res, 404, { error: "not found" });
    }
    if (path === "/.well-known/openid-configuration") {
      return options.asMetadata === "oidc" ? sendJson(res, 200, asMetadata()) : sendJson(res, 404, { error: "not found" });
    }
    if (path === "/.well-known/openid-configuration/mcp" || path === "/mcp/.well-known/openid-configuration") {
      return options.asMetadata === "oidc-suffix" ? sendJson(res, 200, asMetadata()) : sendJson(res, 404, { error: "not found" });
    }

    if (path === "/oauth/register" && req.method === "POST") {
      if (!options.dcr) return sendJson(res, 404, { error: "not found" });
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return sendJson(res, 400, { error: "invalid_client_metadata" });
      }
      const redirectUris = Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris.filter((entry): entry is string => typeof entry === "string") : [];
      if (redirectUris.length === 0) return sendJson(res, 400, { error: "invalid_redirect_uri" });
      const clientId = `client-${state.registrations.length + 1}-${randomBytes(4).toString("hex")}`;
      clients.set(clientId, { redirectUris });
      state.registrations.push(parsed);
      return sendJson(res, 201, { ...parsed, client_id: clientId, token_endpoint_auth_method: "none" });
    }

    if (path === "/oauth/authorize" && req.method === "GET") {
      const p = url.searchParams;
      state.authorizeRequests.push(Object.fromEntries(p));
      const client = clients.get(p.get("client_id") ?? "");
      const redirectUri = p.get("redirect_uri") ?? "";
      if (!client || !client.redirectUris.includes(redirectUri)) return sendJson(res, 400, { error: "invalid_request", error_description: "unknown client or redirect_uri" });
      const back = new URL(redirectUri);
      const reply = (extra: Record<string, string>) => {
        for (const [key, value] of Object.entries(extra)) back.searchParams.set(key, value);
        if (p.get("state")) back.searchParams.set("state", p.get("state")!);
        if (options.issParameter) back.searchParams.set("iss", options.issValue ?? issuer());
        res.writeHead(302, { location: back.toString() });
        res.end();
      };
      if (options.approve === "deny") return reply({ error: "access_denied" });
      if (p.get("response_type") !== "code" || !p.get("code_challenge") || p.get("code_challenge_method") !== "S256") return reply({ error: "invalid_request" });
      const code = token("code");
      codes.set(code, { clientId: p.get("client_id")!, redirectUri, challenge: p.get("code_challenge")!, scope: p.get("scope") ?? DEFAULT_SCOPE, resource: p.get("resource") ?? undefined });
      return reply({ code });
    }

    if (path === "/oauth/token" && req.method === "POST") {
      if (options.tokenDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.tokenDelayMs));
      if (options.refreshMode === "unavailable" && new URLSearchParams(body).get("grant_type") === "refresh_token") {
        state.tokenRequests.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(503, { "retry-after": "1" });
        res.end("unavailable");
        return;
      }
      const params = Object.fromEntries(new URLSearchParams(body));
      state.tokenRequests.push(params);
      const invalid = (error: string, status = 400) => sendJson(res, status, { error });
      const issue = (clientId: string, scope: string, refresh: RefreshToken | null) => {
        const access = token("at");
        accessTokens.set(access, { expiresAt: Date.now() + options.accessTokenTtlSeconds * 1000, scope, clientId });
        issuedAccess.push(access);
        let refreshValue: string | undefined;
        if (refresh) {
          if (options.refreshMode === "keep") refreshValue = params.refresh_token;
          else {
            refreshValue = token("rt");
            refreshTokens.set(refreshValue, { clientId, scope, alive: true });
            issuedRefresh.push(refreshValue);
          }
        }
        return sendJson(res, 200, { access_token: access, token_type: "Bearer", expires_in: options.accessTokenTtlSeconds, scope, ...(refreshValue ? { refresh_token: refreshValue } : {}) });
      };
      if (options.strictResource && params.resource !== undefined && params.resource !== mcpUrl()) return invalid("invalid_target");
      if (params.grant_type === "authorization_code") {
        const record = codes.get(params.code ?? "");
        codes.delete(params.code ?? ""); // single use, even on failure
        if (!record || record.clientId !== params.client_id || record.redirectUri !== (params.redirect_uri ?? record.redirectUri)) return invalid("invalid_grant");
        if (!params.code_verifier || s256(params.code_verifier) !== record.challenge) return invalid("invalid_grant");
        const refresh: RefreshToken = { clientId: record.clientId, scope: record.scope, alive: true };
        const refreshValue = token("rt");
        refreshTokens.set(refreshValue, refresh);
        issuedRefresh.push(refreshValue);
        const access = token("at");
        accessTokens.set(access, { expiresAt: Date.now() + options.accessTokenTtlSeconds * 1000, scope: record.scope, clientId: record.clientId });
        issuedAccess.push(access);
        return sendJson(res, 200, { access_token: access, token_type: "Bearer", expires_in: options.accessTokenTtlSeconds, scope: record.scope, refresh_token: refreshValue });
      }
      if (params.grant_type === "refresh_token") {
        if (options.refreshMode === "invalid-grant") return invalid("invalid_grant");
        const record = refreshTokens.get(params.refresh_token ?? "");
        if (!record || !record.alive || record.clientId !== params.client_id) return invalid("invalid_grant");
        if (options.refreshMode === "rotate") record.alive = false;
        return issue(record.clientId, record.scope, record);
      }
      return invalid("unsupported_grant_type");
    }

    if (path === "/oauth/revoke" && req.method === "POST") {
      if (!options.revocation) return sendJson(res, 404, { error: "not found" });
      const form = new URLSearchParams(body);
      const value = form.get("token") ?? "";
      state.revocationRequests.push(Object.fromEntries(form));
      if (options.revocationStatus !== 200) {
        res.writeHead(options.revocationStatus);
        res.end();
        return;
      }
      state.revocations.push(value);
      const refresh = refreshTokens.get(value);
      if (refresh) refresh.alive = false;
      accessTokens.delete(value);
      res.writeHead(200);
      res.end();
      return;
    }

    // ── the MCP endpoint ──
    const isMcp = path === mcpPath;
    const isMessages = path === "/messages";
    if (!isMcp && !isMessages) return sendJson(res, 404, { error: "not found" });

    if (options.mcpMovedTo && isMcp) {
      res.writeHead(307, { location: options.mcpMovedTo.startsWith("/") ? `${state.origin}${options.mcpMovedTo}` : options.mcpMovedTo });
      res.end();
      return;
    }
    const denied = authorize(req);
    if (denied) {
      res.writeHead(denied.status, { "content-type": "application/json", ...denied.headers });
      res.end(denied.body);
      return;
    }

    if (options.mcpFailStatus !== undefined && req.method !== "GET") {
      res.writeHead(options.mcpFailStatus, { "content-type": "text/plain", "x-upstream-marker": "UPSTREAM-HEADER-TEXT" });
      res.end("UPSTREAM-BODY-TEXT");
      return;
    }

    if (options.transport === "sse") {
      if (isMcp && req.method === "GET" && String(req.headers.accept ?? "").includes("text/event-stream")) {
        const id = randomBytes(6).toString("hex");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        streams.set(id, res);
        req.on("close", () => streams.delete(id));
        if (options.sseSilent) {
          res.write(": open\n\n");
          return;
        }
        const relative = `/messages?sessionId=${id}`;
        const target = options.sseEndpoint === "cross-origin" ? `http://evil.example${relative}` : options.sseEndpoint === "absolute" ? `${state.origin}${relative}` : relative;
        res.write(`event: endpoint\ndata: ${target}\n\n`);
        return;
      }
      if (isMcp) {
        res.writeHead(options.legacyPostStatus);
        res.end();
        return;
      }
      const stream = streams.get(url.searchParams.get("sessionId") ?? "");
      if (!stream) return sendJson(res, 404, { error: "unknown session" });
      const result = handleRpc(body, req);
      if (result.status === 403) {
        res.writeHead(403, { "content-type": "application/json", ...result.headers });
        res.end(result.raw ?? "");
        return;
      }
      res.writeHead(202);
      res.end("Accepted");
      if (result.message !== undefined) stream.write(frame(result.message));
      return;
    }

    if (isMessages) return sendJson(res, 404, { error: "not found" });
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    if (typeof sessionHeader === "string" && !sessions.has(sessionHeader)) return sendJson(res, 404, { error: "unknown session" });
    const result = handleRpc(body, req);
    if (result.delay) await new Promise((resolve) => setTimeout(resolve, result.delay));
    if (result.raw !== undefined) {
      res.writeHead(result.status, { "content-type": "application/json", ...result.headers });
      res.end(result.raw);
      return;
    }
    if (result.message === undefined) {
      res.writeHead(result.status, result.headers);
      res.end();
      return;
    }
    if (options.respondWith === "sse") {
      res.writeHead(result.status, { "content-type": "text/event-stream", ...result.headers });
      res.end(frame(result.message));
      return;
    }
    sendJson(res, result.status, result.message, result.headers);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  state.origin = `http://127.0.0.1:${port}`;

  return {
    origin: state.origin,
    port,
    get mcpUrl() { return mcpUrl(); },
    get issuer() { return issuer(); },
    options,
    requests: state.requests,
    toolCalls: state.toolCalls,
    registrations: state.registrations,
    tokenRequests: state.tokenRequests,
    authorizeRequests: state.authorizeRequests,
    revocations: state.revocations,
    revocationRequests: state.revocationRequests,
    get redirectTrapHits() { return state.redirectTrapHits; },
    issuedAccessTokens: () => [...issuedAccess],
    issuedRefreshTokens: () => [...issuedRefresh],
    mintAccessToken: (scope = DEFAULT_SCOPE) => {
      const minted = token("at");
      accessTokens.set(minted, { expiresAt: Date.now() + options.accessTokenTtlSeconds * 1000, scope, clientId: "minted" });
      issuedAccess.push(minted);
      return minted;
    },
    expireAccessTokens: () => {
      for (const record of accessTokens.values()) record.expiresAt = Date.now() - 1;
    },
    revokeRefreshTokens: () => {
      for (const record of refreshTokens.values()) record.alive = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams.values()) stream.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * The fake browser: open the authorize URL, approve without a page, and report
 * where the AS sent the browser back to, without following it (the test drives
 * the loopback callback itself).
 */
export async function fakeBrowserApprove(authorizeUrl: string): Promise<{ redirectUrl: string; code?: string; state?: string; error?: string; iss?: string }> {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) return { redirectUrl: "", error: response.status === 400 ? "invalid_request" : "no_redirect" };
  const back = new URL(location);
  const param = (name: string) => back.searchParams.get(name) ?? undefined;
  return { redirectUrl: location, code: param("code"), state: param("state"), error: param("error"), iss: param("iss") };
}
