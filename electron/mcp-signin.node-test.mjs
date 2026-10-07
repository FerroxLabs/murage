// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP-LINK T11: sign-in to a server added by link, in the desktop main
// process. Runs against the T15 fake (server/testing/fake-remote-mcp.ts: an
// MCP server and its OAuth authorization server on 127.0.0.1) through the
// real guarded client, a real loopback listener and a stand-in for the
// harness's commit routes. No browser, no real account, no ~/.murage.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { guardedRequest } from "../shared/guarded-http.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { startFakeRemoteMcp, fakeBrowserApprove } from "../server/testing/fake-remote-mcp.ts";
import { createMcpServers } from "./mcp-signin/service.mjs";
import { asMetadataUrls, discoverAuthorization, endpointAllowed, prmUrls, resourceMatches } from "./mcp-signin/discovery.mjs";
import { handleSecretsStale, MCP_SECRETS_KEY } from "./mcp-signin/custody.mjs";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The harness side of the contract, reduced to what main talks to: the listing,
 * the sign-in target, and the secrets commit route with the origin rule
 * (NEXT-T11 L-d: a push must name its origin; another origin is 409).
 */
function fakeHarness(fake, entries) {
  const held = new Map();
  const pushes = [];
  const origin = (url) => new URL(url).origin;
  const listing = () => Object.entries(entries).map(([name, entry]) => entry.kind === "stdio"
    ? { kind: "stdio", name, command: "npx", args: [], envKeys: entry.envKeys ?? [], enabled: true }
    : { kind: "remote", name, url: entry.url, host: new URL(entry.url).hostname, auth: entry.auth, headerNames: entry.headerNames ?? [], enabled: false, status: "unknown", ...(entry.local ? { local: entry.local } : {}) });
  async function commit(route, { method = "GET", body } = {}) {
    if (method === "GET" && route === "/api/mcp/servers") return { status: 200, body: { servers: listing() } };
    const target = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]*)\/oauth-target$/.exec(route);
    if (target && method === "GET") {
      const entry = entries[target[1]];
      if (!entry) return { status: 404, body: { error: "MCP server not found." } };
      return { status: 200, body: { url: entry.url, ...(entry.local ? { local: entry.local } : {}), ...(entry.scopeHint ? { scopeHint: entry.scopeHint } : {}) } };
    }
    const secrets = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]*)\/secrets$/.exec(route);
    if (secrets) {
      const name = secrets[1];
      const entry = entries[name];
      pushes.push({ method, name, body: body === undefined ? undefined : structuredClone(body) });
      if (!entry) return { status: 404, body: { error: "MCP server not found." } };
      if (method === "DELETE") { held.delete(name); return { status: 200, body: { ok: true } }; }
      if (entry.kind !== "stdio") {
        if (typeof body?.origin !== "string") return { status: 400, body: { error: "Name the address." } };
        if (body.origin !== origin(entry.url)) return { status: 409, body: { error: "These secrets were issued for another address." } };
      }
      held.set(name, structuredClone(body));
      return { status: 200, body: { ok: true } };
    }
    const server = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]*)$/.exec(route);
    if (server && method === "DELETE") {
      if (!entries[server[1]]) return { status: 404, body: { error: "MCP server not found." } };
      delete entries[server[1]];
      held.delete(server[1]);
      return { status: 200, body: { servers: listing() } };
    }
    return { status: 404, body: { error: "no such route" } };
  }
  return { commit, held, pushes, entries };
}

/** The whole main-side service over an in-memory credentials.bin. */
function harness({ fake, entries, browser = "approve", document = {}, failWrites = false, log, request, onTokenExchange, onPersist, timers } = {}) {
  let saved = structuredClone(document);
  let writesFail = failWrites;
  const events = [];
  const state = createSecureCredentialState(saved, async (next) => {
    if (writesFail) throw new Error("keychain busy");
    saved = structuredClone(next);
  });
  const server = fakeHarness(fake, entries ?? {});
  const opened = [];
  const redirects = [];
  const service = createMcpServers({
    ...(request || onTokenExchange ? { request: async (options) => {
      if (onTokenExchange && options.kind === "token" && String(options.body).includes("grant_type=authorization_code")) await onTokenExchange();
      return (request ?? guardedRequest)(options);
    } } : {}),
    readDocument: () => state.read(),
    updateDocument: (derive) => state.update(async (current) => { const next = await derive(current); if (onPersist) await onPersist(next); events.push("persist"); return next; }),
    commit: async (route, init) => {
      const answer = await server.commit(route, init);
      if (/\/secrets$/.test(route)) events.push(`push:${init?.method ?? "GET"}:${answer.status}`);
      return answer;
    },
    openExternal: async (url) => {
      opened.push(url);
      if (browser === "none") return;
      const approved = await fakeBrowserApprove(url);
      let back = approved.redirectUrl;
      if (typeof browser === "function") back = browser(back);
      redirects.push(back);
      if (back) await fetch(back).then((response) => response.text()).catch(() => "");
    },
    createServer: () => http.createServer(),
    platform: "darwin",
    env: { DISPLAY: ":0" },
    log: log ?? (() => {}),
    // refresher timers never fire in a test: each test drives refresh itself
    setTimeout: timers?.set ?? (() => ({ unref() {} })), clearTimeout: timers?.clear ?? (() => {}),
  });
  return {
    service, server, events, opened, redirects,
    doc: (name) => {
      const store = saved[MCP_SECRETS_KEY];
      return store && typeof store === "object" ? store[name] : undefined;
    },
    saved: () => saved,
    failWrites: (value) => { writesFail = value; },
  };
}

async function signedIn(options = {}) {
  const fake = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "bearer-resource-metadata", ...options.fake });
  const h = harness({ fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } }, ...options });
  const result = await h.service.signIn("comfy");
  return { fake, h, result };
}

// ── discovery: the refusals S3 names ──────────────────────────────────────

test("the PRM resource must be the server URL (scheme, host, port; path equal or a parent)", () => {
  assert.equal(resourceMatches("https://a.example/mcp", "https://a.example/mcp"), true);
  assert.equal(resourceMatches("https://a.example", "https://a.example/mcp"), true);
  assert.equal(resourceMatches("https://a.example/", "https://a.example/mcp"), true);
  assert.equal(resourceMatches("https://a.example/mc", "https://a.example/mcp"), false, "a prefix only at a segment boundary");
  assert.equal(resourceMatches("https://a.example/mcp/x", "https://a.example/mcp"), false);
  assert.equal(resourceMatches("https://b.example/mcp", "https://a.example/mcp"), false);
  assert.equal(resourceMatches("http://a.example/mcp", "https://a.example/mcp"), false);
  assert.equal(resourceMatches("https://a.example:8443/mcp", "https://a.example/mcp"), false);
  assert.equal(resourceMatches("https://a.example/mcp?x=1", "https://a.example/mcp"), false);
  assert.equal(resourceMatches("not a url", "https://a.example/mcp"), false);
});

test("the discovery order: PRM path-inserted then root; AS 8414 then OIDC, path then root", () => {
  assert.deepEqual(prmUrls("https://a.example/v1/mcp"), ["https://a.example/.well-known/oauth-protected-resource/v1/mcp", "https://a.example/.well-known/oauth-protected-resource"]);
  assert.deepEqual(prmUrls("https://a.example/"), ["https://a.example/.well-known/oauth-protected-resource"]);
  assert.deepEqual(asMetadataUrls("https://as.example/tenant"), [
    "https://as.example/.well-known/oauth-authorization-server/tenant",
    "https://as.example/.well-known/openid-configuration/tenant",
    "https://as.example/tenant/.well-known/openid-configuration",
    "https://as.example/.well-known/oauth-authorization-server",
    "https://as.example/.well-known/openid-configuration",
  ]);
  assert.deepEqual(asMetadataUrls("https://as.example"), ["https://as.example/.well-known/oauth-authorization-server", "https://as.example/.well-known/openid-configuration"]);
});

test("endpoints must be https unless the server was confirmed local, and then stay in its class", () => {
  assert.equal(endpointAllowed("https://as.example/token", null), true);
  assert.equal(endpointAllowed("http://as.example/token", null), false);
  assert.equal(endpointAllowed("https://user:pw@as.example/token", null), false);
  assert.equal(endpointAllowed("http://127.0.0.1:9/token", "this-computer"), true);
  assert.equal(endpointAllowed("http://192.168.1.4/token", "this-computer"), false, "a different class");
  assert.equal(endpointAllowed("http://192.168.1.4/token", "local-network"), true);
  assert.equal(endpointAllowed("http://169.254.169.254/token", "local-network"), false);
  assert.equal(endpointAllowed("javascript:alert(1)", "this-computer"), false);
});

test("PRM resource mismatch is refused before any registration", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", prmResource: "http://127.0.0.1:1/elsewhere" });
  try {
    const found = await discoverAuthorization({ url: fake.mcpUrl, local: "this-computer" });
    assert.equal(found.ok, false);
    assert.equal(found.error, "refused");
    const h = harness({ fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } } });
    const result = await h.service.signIn("comfy");
    assert.equal(result.ok, false);
    assert.equal(result.error, "refused");
    assert.equal(fake.registrations.length, 0);
    assert.equal(h.opened.length, 0, "no browser opened");
  } finally { await fake.close(); }
});

test("issuer mismatch is refused", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", metadataIssuer: "https://someone-else.example" });
  try {
    const found = await discoverAuthorization({ url: fake.mcpUrl, local: "this-computer" });
    assert.deepEqual([found.ok, found.error], [false, "refused"]);
    assert.equal(fake.registrations.length, 0);
  } finally { await fake.close(); }
});

test("an authorization server without S256 is refused", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", pkceMethods: ["plain"] });
  try {
    const found = await discoverAuthorization({ url: fake.mcpUrl, local: "this-computer" });
    assert.deepEqual([found.ok, found.error], [false, "refused"]);
  } finally { await fake.close(); }
});

test("an http authorization server is refused for a public server", async () => {
  const docs = {
    "https://mcp.example/.well-known/oauth-protected-resource/mcp": { resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example"] },
    "https://mcp.example/.well-known/oauth-authorization-server": {
      issuer: "https://mcp.example", authorization_endpoint: "http://mcp.example/authorize", token_endpoint: "https://mcp.example/token",
      registration_endpoint: "https://mcp.example/register", code_challenge_methods_supported: ["S256"],
    },
  };
  const seen = [];
  const request = async ({ url }) => { seen.push(url); const doc = docs[url]; return { status: doc ? 200 : 404, headers: {}, body: Buffer.from(JSON.stringify(doc ?? {})) }; };
  const found = await discoverAuthorization({ url: "https://mcp.example/mcp" }, { request });
  assert.deepEqual([found.ok, found.error], [false, "refused"]);
  // And an http issuer is refused before its metadata is fetched.
  docs["https://mcp.example/.well-known/oauth-protected-resource/mcp"].authorization_servers = ["http://mcp.example"];
  seen.length = 0;
  const plain = await discoverAuthorization({ url: "https://mcp.example/mcp" }, { request });
  assert.deepEqual([plain.ok, plain.error], [false, "refused"]);
  assert.ok(seen.every((url) => url.startsWith("https://")));
});

test("no registration endpoint gives the API key sentence", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", dcr: false });
  try {
    const h = harness({ fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } } });
    const result = await h.service.signIn("comfy");
    assert.equal(result.error, "no-registration");
    assert.equal(result.message, "127.0.0.1 does not let apps sign in this way. Use an API key instead.");
  } finally { await fake.close(); }
});

// ── the flow ──────────────────────────────────────────────────────────────

test("sign-in: DCR, PKCE S256, resource bound, token stored in main, only the access token pushed with its origin", async () => {
  const { fake, h, result } = await signedIn();
  try {
    assert.deepEqual(result, { ok: true });
    const registration = fake.registrations[0];
    assert.equal(registration.client_name, "Murage");
    assert.equal(registration.application_type, "native");
    assert.equal(registration.token_endpoint_auth_method, "none");
    assert.deepEqual(registration.grant_types, ["authorization_code", "refresh_token"]);
    assert.match(registration.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const authorize = fake.authorizeRequests[0];
    assert.equal(authorize.code_challenge_method, "S256");
    assert.equal(authorize.resource, fake.mcpUrl);
    assert.equal(authorize.response_type, "code");
    assert.ok(Buffer.from(authorize.state, "base64url").length >= 32, "state is 32 random bytes");
    const exchange = fake.tokenRequests.find((row) => row.grant_type === "authorization_code");
    assert.equal(exchange.resource, fake.mcpUrl);
    assert.ok(exchange.code_verifier.length >= 43);
    const stored = h.doc("comfy");
    assert.equal(stored.origin, fake.origin);
    assert.equal(stored.oauth.issuer, fake.issuer);
    assert.equal(stored.oauth.accessToken, fake.issuedAccessTokens()[0]);
    assert.equal(stored.oauth.refreshToken, fake.issuedRefreshTokens()[0]);
    const pushed = h.server.held.get("comfy");
    assert.deepEqual(Object.keys(pushed).sort(), ["oauth", "origin"]);
    assert.equal(pushed.origin, fake.origin, "every push names its origin (L-d)");
    assert.equal(pushed.oauth.accessToken, stored.oauth.accessToken);
    const wire = JSON.stringify(h.server.pushes);
    assert.equal(wire.includes(stored.oauth.refreshToken), false, "the refresh token never leaves main");
    assert.equal(wire.includes(stored.oauth.clientId), false, "nor the client registration");
    // persist, then push
    assert.deepEqual(h.events.slice(-2), ["persist", "push:PUT:200"]);
    // the loopback page carried nothing
    assert.equal(h.redirects.length, 1);
  } finally { await fake.close(); }
});

test("a wrong state from the browser is refused and cannot end the flow", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer" });
  try {
    const h = harness({ fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } }, browser: (back) => { const url = new URL(back); url.searchParams.set("state", "forged"); return url.toString(); } });
    const pending = h.service.signIn("comfy");
    for (let i = 0; i < 100 && h.redirects.length === 0; i += 1) await tick(20);
    assert.equal(h.redirects.length, 1);
    await tick(20);
    assert.equal(fake.tokenRequests.length, 0, "no code was exchanged");
    assert.equal(h.service.cancelSignIn("comfy"), true);
    const result = await pending;
    assert.equal(result.error, "cancelled");
    assert.equal(h.doc("comfy"), undefined);
  } finally { await fake.close(); }
});

test("an iss that is not the issuer is refused (RFC 9207)", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", issParameter: true, issValue: "https://evil.example" });
  try {
    const h = harness({ fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } } });
    const result = await h.service.signIn("comfy");
    assert.equal(result.ok, false);
    assert.equal(result.error, "refused");
    assert.equal(fake.tokenRequests.length, 0);
    assert.equal(h.doc("comfy"), undefined);
  } finally { await fake.close(); }
  const good = await startFakeRemoteMcp({ auth: "bearer", issParameter: true });
  try {
    const h = harness({ fake: good, entries: { comfy: { url: good.mcpUrl, auth: "oauth", local: "this-computer" } } });
    assert.deepEqual(await h.service.signIn("comfy"), { ok: true });
  } finally { await good.close(); }
});

test("the owner saying no is a plain denial", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", approve: "deny" });
  try {
    const h = harness({ fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } } });
    const result = await h.service.signIn("comfy");
    assert.equal(result.error, "denied");
    assert.doesNotMatch(result.message, /[—–]/);
  } finally { await fake.close(); }
});

test("a second sign-in reuses the client on the same port, and re-registers when that port is busy", async () => {
  const { fake, h } = await signedIn();
  try {
    const port = h.doc("comfy").oauth.redirectPort;
    assert.equal(fake.registrations.length, 1);
    assert.deepEqual(await h.service.signIn("comfy"), { ok: true });
    assert.equal(fake.registrations.length, 1, "same issuer and free port: no new registration");
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      assert.deepEqual(await h.service.signIn("comfy"), { ok: true });
      assert.equal(fake.registrations.length, 2, "a new port means a new registration (exact redirect match)");
      assert.notEqual(h.doc("comfy").oauth.redirectPort, port);
    } finally { blocker.close(); }
  } finally { await fake.close(); }
});

test("every push says when its access token was issued and what scope it carries, so a stale token cannot pass for a new sign-in", async () => {
  const { fake, h } = await signedIn();
  try {
    const first = h.server.held.get("comfy").oauth;
    assert.equal(typeof first.issuedAt, "number");
    assert.ok(Math.abs(first.issuedAt - Date.now()) < 10_000, "issued now");
    assert.equal(first.scope, h.doc("comfy").oauth.scope);
    assert.equal(h.doc("comfy").oauth.issuedAt, first.issuedAt, "main keeps it with the token");
    await tick(5);
    assert.equal(await h.service.refresh("comfy"), true);
    const second = h.server.held.get("comfy").oauth;
    assert.ok(second.issuedAt > first.issuedAt, "a refresh is a new issue");
    // but a refresh is not a new sign-in: only the owner's sign-in stamps signedInAt (review M1)
    assert.equal(typeof first.signedInAt, "number");
    assert.equal(second.signedInAt, first.signedInAt, "a refresh keeps the sign-in time");
    assert.equal(h.doc("comfy").oauth.signedInAt, first.signedInAt);
    assert.notEqual(second.accessToken, first.accessToken);
    // after a restart main pushes what it holds: the SAME issue time, never a new one
    h.server.held.clear();
    await h.service.resume();
    assert.equal(h.server.held.get("comfy").oauth.issuedAt, second.issuedAt);
  } finally { await fake.close(); }
});

test("step-up: a new sign-in asks for the union of the old and new scopes", async () => {
  const { fake, h } = await signedIn();
  try {
    const before = h.doc("comfy").oauth.scope;
    // the harness's sign-in target carries the server's latest scope hint
    h.server.entries.comfy.scopeHint = "tools:write";
    const answer = await h.service.signIn("comfy");
    assert.deepEqual(answer, { ok: true });
    const asked = fake.authorizeRequests.at(-1).scope.split(" ").sort();
    for (const scope of before.split(" ")) assert.ok(asked.includes(scope), `keeps ${scope}`);
    assert.ok(asked.includes("tools:write"));
  } finally { await fake.close(); }
});

test("sign-in refuses a server that is not a sign-in, one that does not exist, and a headless host", async () => {
  const fake = await startFakeRemoteMcp({ auth: "api-key" });
  try {
    const h = harness({ fake, entries: { keyed: { url: fake.mcpUrl, auth: "header", headerNames: ["x-api-key"], local: "this-computer" } } });
    assert.equal((await h.service.signIn("keyed")).error, "not-sign-in");
    assert.equal((await h.service.signIn("missing")).error, "not-found");
    const headless = createMcpServers({ readDocument: () => ({}), updateDocument: async () => {}, commit: async () => ({ status: 500 }), openExternal: async () => {}, createServer: () => http.createServer(), platform: "linux", env: {} });
    const result = await headless.signIn("keyed");
    assert.deepEqual(result, { ok: false, error: "headless", message: "Sign in needs the Murage desktop app." });
  } finally { await fake.close(); }
});

// ── refresher ─────────────────────────────────────────────────────────────

test("concurrent refreshes collapse into one token POST", async () => {
  const { fake, h } = await signedIn({ fake: { tokenDelayMs: 50 } });
  try {
    const before = fake.tokenRequests.length;
    const results = await Promise.all([h.service.refresh("comfy"), h.service.refresh("comfy"), h.service.refresh("comfy")]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(fake.tokenRequests.length - before, 1);
    assert.equal(fake.tokenRequests.at(-1).grant_type, "refresh_token");
  } finally { await fake.close(); }
});

test("the rotated refresh token is persisted before the new access token is pushed", async () => {
  const { fake, h } = await signedIn();
  try {
    const firstRefresh = h.doc("comfy").oauth.refreshToken;
    h.events.length = 0;
    assert.equal(await h.service.refresh("comfy"), true);
    assert.deepEqual(h.events, ["persist", "push:PUT:200"]);
    const stored = h.doc("comfy").oauth;
    assert.notEqual(stored.refreshToken, firstRefresh);
    assert.equal(stored.refreshToken, fake.issuedRefreshTokens().at(-1));
    assert.equal(h.server.held.get("comfy").oauth.accessToken, fake.issuedAccessTokens().at(-1));
    assert.equal(fake.tokenRequests.at(-1).refresh_token, firstRefresh);
    assert.equal(fake.tokenRequests.at(-1).resource, fake.mcpUrl, "resource bound on refresh too");
  } finally { await fake.close(); }
});

test("invalid_grant clears the tokens, keeps the client, and the server hears needs-sign-in", async () => {
  const { fake, h } = await signedIn();
  try {
    const clientId = h.doc("comfy").oauth.clientId;
    fake.options.refreshMode = "invalid-grant";
    assert.equal(await h.service.refresh("comfy"), false);
    const stored = h.doc("comfy").oauth;
    assert.equal(stored.clientId, clientId, "the client registration is kept");
    assert.equal(stored.accessToken, undefined);
    assert.equal(stored.refreshToken, undefined);
    assert.equal(h.server.held.has("comfy"), false, "the harness no longer holds a token");
    assert.equal(h.server.pushes.at(-1).method, "DELETE");
  } finally { await fake.close(); }
});

test("a server with 1-second tokens: every refresh keeps the owner's sign-in time, so no card is ever settled by one (review M1)", async () => {
  const { fake, h } = await signedIn({ fake: { accessTokenTtlSeconds: 1 } });
  try {
    const signedInAt = h.server.held.get("comfy").oauth.signedInAt;
    assert.equal(typeof signedInAt, "number");
    for (let round = 0; round < 5; round += 1) {
      await tick(5);
      assert.equal(await h.service.refresh("comfy"), true);
      assert.equal(h.server.held.get("comfy").oauth.signedInAt, signedInAt);
    }
    h.server.held.clear();
    await h.service.resume();
    assert.equal(h.server.held.get("comfy").oauth.signedInAt, signedInAt, "nor does a restart");
    assert.deepEqual(await h.service.signIn("comfy"), { ok: true });
    assert.ok(h.server.held.get("comfy").oauth.signedInAt > signedInAt, "an owner sign-in does");
  } finally { await fake.close(); }
});

test("a 401 from the token endpoint that is neither invalid_grant nor invalid_client keeps the tokens and retries; invalid_grant clears them (review L3)", async () => {
  let mode = "pass";
  const request = async (options) => {
    if (mode === "401" && options.kind === "token" && String(options.body).includes("grant_type=refresh_token")) {
      return { status: 401, headers: {}, body: Buffer.from(JSON.stringify({ error: "temporarily_unavailable" })) };
    }
    return guardedRequest(options);
  };
  const { fake, h } = await signedIn({ request });
  try {
    const before = structuredClone(h.doc("comfy"));
    mode = "401";
    assert.equal(await h.service.refresh("comfy"), false);
    assert.deepEqual(h.doc("comfy"), before, "nothing erased");
    assert.equal(h.server.held.get("comfy").oauth.accessToken, before.oauth.accessToken);
    mode = "pass";
    fake.options.refreshMode = "invalid-grant";
    assert.equal(await h.service.refresh("comfy"), false);
    assert.equal(h.doc("comfy").oauth.refreshToken, undefined, "invalid_grant still ends the grant");
  } finally { await fake.close(); }
});

test("invalid_client stops the retry timer, drops the client registration, keeps the access token, and the next sign-in registers a new client (0.1.62 L3)", async () => {
  let mode = "pass";
  let registrations = 0, refreshPosts = 0;
  const request = async (options) => {
    if (options.kind === "register") registrations += 1;
    if (options.kind === "token" && String(options.body).includes("grant_type=refresh_token")) {
      refreshPosts += 1;
      if (mode === "rejected") return { status: 401, headers: {}, body: Buffer.from(JSON.stringify({ error: "invalid_client" })) };
    }
    return guardedRequest(options);
  };
  const pending = new Set();
  let next = 0;
  const timers = {
    set: (fn, ms) => { const t = { id: next += 1, fn, ms, unref() {} }; pending.add(t); return t; },
    clear: (t) => { pending.delete(t); },
  };
  const { fake, h } = await signedIn({ request, timers });
  try {
    const before = structuredClone(h.doc("comfy").oauth);
    assert.equal(registrations, 1);
    mode = "rejected";
    assert.equal(await h.service.refresh("comfy"), false);
    assert.equal(pending.size, 0, "no retry timer is left running for that server");
    const stored = h.doc("comfy").oauth;
    assert.equal(stored.clientId, undefined, "the rejected client registration is dropped");
    assert.equal(stored.clientSecret, undefined);
    assert.equal(stored.refreshToken, undefined, "the refresh token belonged to the dead client");
    assert.equal(stored.accessToken, before.accessToken, "the access token is kept until it expires");
    assert.equal(stored.expiresAt, before.expiresAt);
    assert.equal(h.server.held.get("comfy").oauth.accessToken, before.accessToken, "the harness still holds it");
    const posts = refreshPosts;
    assert.equal(await h.service.refresh("comfy"), false);
    assert.equal(refreshPosts, posts, "nothing posts to the token endpoint again");
    assert.equal(pending.size, 0);
    mode = "pass";
    assert.deepEqual(await h.service.signIn("comfy"), { ok: true });
    assert.equal(registrations, 2, "the next sign-in registers a new client");
    assert.notEqual(h.doc("comfy").oauth.clientId, before.clientId);
    assert.ok(h.doc("comfy").oauth.refreshToken);
  } finally { await fake.close(); }
});

test("after invalid_client the rejected access token ends the sign-in: the harness hears needs-sign-in", async () => {
  let rejected = false;
  const request = async (options) => {
    if (rejected && options.kind === "token" && String(options.body).includes("grant_type=refresh_token")) {
      return { status: 400, headers: {}, body: Buffer.from(JSON.stringify({ error: "invalid_client" })) };
    }
    return guardedRequest(options);
  };
  const { fake, h } = await signedIn({ request });
  try {
    rejected = true;
    assert.equal(await h.service.refresh("comfy"), false);
    assert.equal(await h.service.handleTokenRejected("comfy"), false);
    assert.equal(h.doc("comfy").oauth.accessToken, undefined);
    assert.equal(h.server.held.has("comfy"), false, "the card state: no token, sign in again");
  } finally { await fake.close(); }
});

test("sign-out after invalid_client (no stored client) clears the local tokens and succeeds, without a revoke", async () => {
  let rejected = false;
  const request = async (options) => {
    if (rejected && options.kind === "token" && String(options.body).includes("grant_type=refresh_token")) {
      return { status: 401, headers: {}, body: Buffer.from(JSON.stringify({ error: "invalid_client" })) };
    }
    return guardedRequest(options);
  };
  const { fake, h } = await signedIn({ request, fake: { revocationStatus: 401 } });
  try {
    rejected = true;
    assert.equal(await h.service.refresh("comfy"), false);
    assert.equal(h.doc("comfy").oauth.clientId, undefined);
    const out = await h.service.signOut("comfy");
    assert.equal(out.ok, true);
    assert.doesNotMatch(out.message, /could not reach/);
    assert.equal(fake.revocationRequests.length, 0);
    assert.equal(h.doc("comfy").oauth?.accessToken, undefined);
    assert.equal(h.server.held.has("comfy"), false);
  } finally { await fake.close(); }
});

test("a sign-in that finishes after Remove is revoked at the server, and nothing survives (review L2)", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "bearer-resource-metadata" });
  try {
    let h;
    let removed;
    h = harness({ fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } }, onTokenExchange: async () => { removed = await h.service.remove("comfy"); } });
    const result = await h.service.signIn("comfy");
    assert.deepEqual(removed.ok, true);
    assert.notDeepEqual(result, { ok: true });
    assert.equal(h.doc("comfy"), undefined);
    assert.equal(h.server.held.has("comfy"), false);
    assert.ok(fake.issuedAccessTokens().length >= 1);
    assert.ok(fake.revocations.length >= 2, "the issued refresh and access tokens were revoked");
  } finally { await fake.close(); }
});

test("Remove landing while the sign-in is being saved still revokes what the server issued (review L2, Opus)", async () => {
  const fake = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "bearer-resource-metadata" });
  try {
    let h;
    let removal;
    h = harness({
      fake, entries: { comfy: { url: fake.mcpUrl, auth: "oauth", local: "this-computer" } },
      // the sign-in's own write is in progress (past its cancel check, not yet
      // saved) when the owner presses Remove
      onPersist: async (next) => {
        if (removal || !next?.[MCP_SECRETS_KEY]?.comfy?.oauth?.accessToken) return;
        removal = h.service.remove("comfy");
        await tick(5);
      },
    });
    const result = await h.service.signIn("comfy");
    const removed = await removal;
    assert.equal(removed.ok, true);
    assert.notDeepEqual(result, { ok: true }, "a sign-in for a removed server does not report success");
    assert.equal(h.doc("comfy"), undefined);
    assert.equal(h.server.held.has("comfy"), false);
    assert.ok(fake.issuedAccessTokens().length >= 1);
    assert.ok(fake.revocations.length >= 1, "the grant issued for the removed server was revoked");
  } finally { await fake.close(); }
});

test("a 503 from the token endpoint keeps every token", async () => {
  const { fake, h } = await signedIn();
  try {
    const before = structuredClone(h.doc("comfy"));
    fake.options.refreshMode = "unavailable";
    assert.equal(await h.service.refresh("comfy"), false);
    assert.deepEqual(h.doc("comfy"), before);
    assert.equal(h.server.held.get("comfy").oauth.accessToken, before.oauth.accessToken);
  } finally { await fake.close(); }
});

test("a token rejected upstream triggers one refresh; a burst does not storm", async () => {
  const { fake, h } = await signedIn();
  try {
    const before = fake.tokenRequests.length;
    await h.service.handleTokenRejected("comfy");
    await h.service.handleTokenRejected("comfy");
    await h.service.handleTokenRejected("not a name");
    assert.equal(fake.tokenRequests.length - before, 1);
  } finally { await fake.close(); }
});

test("after the server starts, every saved doc is pushed with its origin, and expired tokens are refreshed", async () => {
  const { fake, h } = await signedIn();
  try {
    h.server.held.clear();
    h.server.pushes.length = 0;
    fake.expireAccessTokens();
    const doc = h.doc("comfy");
    await h.service.resume({ now: doc.oauth.expiresAt + 1 });
    for (let i = 0; i < 50 && fake.tokenRequests.at(-1)?.grant_type !== "refresh_token"; i += 1) await tick(20);
    assert.ok(h.server.pushes.length >= 1);
    assert.ok(h.server.pushes.every((push) => push.method === "DELETE" || push.body.origin === fake.origin));
    assert.equal(fake.tokenRequests.at(-1).grant_type, "refresh_token");
  } finally { await fake.close(); }
});

test("a saved doc for an address the entry no longer has is dropped at resume, not pushed elsewhere", async () => {
  const fake = await startFakeRemoteMcp({ auth: "api-key" });
  try {
    const entries = { keyed: { url: fake.mcpUrl, auth: "header", headerNames: ["x-api-key"], local: "this-computer" } };
    const document = { [MCP_SECRETS_KEY]: { keyed: { origin: "https://old.example", headers: { "x-api-key": "OLD-KEY" } } } };
    const lines = [];
    const h = harness({ fake, entries, document, log: (line) => lines.push(line) });
    await h.service.resume();
    assert.equal(h.doc("keyed"), undefined);
    assert.equal(h.server.held.has("keyed"), false);
    assert.equal(JSON.stringify(lines).includes("OLD-KEY"), false);
  } finally { await fake.close(); }
});

// ── sign out and remove ───────────────────────────────────────────────────

test("sign-out revokes the refresh token then the access token when the server offers it", async () => {
  const { fake, h } = await signedIn();
  try {
    const { refreshToken, accessToken, clientId } = h.doc("comfy").oauth;
    const result = await h.service.signOut("comfy");
    assert.deepEqual(result, { ok: true, revoked: true, message: "Signed out. Murage also signed you out of 127.0.0.1." });
    assert.deepEqual(fake.revocationRequests.map((row) => [row.token, row.token_type_hint, row.client_id]), [[refreshToken, "refresh_token", clientId], [accessToken, "access_token", clientId]]);
    assert.equal(h.doc("comfy")?.oauth?.accessToken, undefined);
    assert.equal(h.server.held.has("comfy"), false);
  } finally { await fake.close(); }
});

test("sign-out with no revocation endpoint forgets locally and says how to cut access", async () => {
  const { fake, h } = await signedIn({ fake: { revocation: false } });
  try {
    const result = await h.service.signOut("comfy");
    assert.deepEqual(result, { ok: true, revoked: false, message: "Signed out. Murage forgot this sign-in. To cut access completely, remove Murage from your 127.0.0.1 account settings." });
    assert.equal(fake.revocationRequests.length, 0);
    assert.equal(h.doc("comfy")?.oauth?.refreshToken, undefined);
  } finally { await fake.close(); }
});

test("a failed revoke on remove still removes and says it could not reach the server", async () => {
  const { fake, h } = await signedIn({ fake: { revocationStatus: 503 } });
  try {
    const removed = await h.service.remove("comfy");
    assert.deepEqual(removed, { ok: true, revoked: false, message: "Removed. Murage could not reach 127.0.0.1 to sign out. To cut access completely, remove Murage from your 127.0.0.1 account settings." });
    assert.equal(h.doc("comfy"), undefined);
    assert.equal(h.server.entries.comfy, undefined, "the entry is deleted");
  } finally { await fake.close(); }
});

test("a failed revoke on sign-out still clears the local tokens, and remove still removes", async () => {
  const { fake, h } = await signedIn({ fake: { revocationStatus: 503 } });
  try {
    const kept = h.doc("comfy").oauth.refreshToken;
    const out = await h.service.signOut("comfy");
    assert.equal(out.ok, false);
    assert.match(out.message, /could not reach 127\.0\.0\.1/);
    assert.notEqual(h.doc("comfy").oauth?.refreshToken, kept, "the local tokens are cleared even then");
    assert.equal(h.doc("comfy").oauth?.accessToken, undefined);
    assert.equal(h.server.held.has("comfy"), false);
    assert.deepEqual(await h.service.remove("comfy"), { ok: true, revoked: null, message: "Removed." });
    assert.equal(h.doc("comfy"), undefined);
    assert.equal(h.server.entries.comfy, undefined, "the entry is deleted");
  } finally { await fake.close(); }
});

test("remove revokes first, drops every secret, then deletes the entry", async () => {
  const { fake, h } = await signedIn();
  try {
    const result = await h.service.remove("comfy");
    assert.deepEqual(result, { ok: true, revoked: true, message: "Removed. Murage also signed you out of 127.0.0.1." });
    assert.equal(fake.revocations.length, 2);
    assert.equal(h.doc("comfy"), undefined);
    assert.equal(h.server.entries.comfy, undefined);
    const keyed = await startFakeRemoteMcp({ auth: "api-key" });
    try {
      const k = harness({ fake: keyed, entries: { keyed: { url: keyed.mcpUrl, auth: "header", headerNames: ["x-api-key"], local: "this-computer" } } });
      assert.deepEqual(await k.service.saveSecrets("keyed", { headers: { "x-api-key": "K1" } }), { ok: true });
      assert.deepEqual(await k.service.remove("keyed"), { ok: true, revoked: null, message: "Removed." });
      assert.equal(k.doc("keyed"), undefined);
    } finally { await keyed.close(); }
  } finally { await fake.close(); }
});

// ── API keys, links and the L-d / L-f contract ────────────────────────────

test("saveSecrets before the entry exists is not-found (save only after the 201)", async () => {
  const fake = await startFakeRemoteMcp({ auth: "api-key" });
  try {
    const h = harness({ fake, entries: {} });
    const early = await h.service.saveSecrets("keyed", { headers: { "x-api-key": "K1" } });
    assert.equal(early.error, "not-found");
    assert.equal(h.doc("keyed"), undefined, "nothing written before the entry exists");
  } finally { await fake.close(); }
});

test("create, then the stale message the POST posts, then save: the key stays (L-f)", async () => {
  const fake = await startFakeRemoteMcp({ auth: "api-key" });
  try {
    const h = harness({ fake, entries: {} });
    // POST /api/mcp/servers: the harness saves the entry and posts stale for the name
    h.server.entries.keyed = { url: fake.mcpUrl, auth: "header", headerNames: ["x-api-key"], local: "this-computer" };
    const at = Date.now();
    await h.service.handleSecretsStale({ type: "murage:mcp-secrets-stale", name: "keyed", at });
    assert.deepEqual(await h.service.saveSecrets("keyed", { headers: { "x-api-key": "K1" } }), { ok: true });
    // a stale message that raced in late (sent before the save) does not erase it
    await h.service.handleSecretsStale({ type: "murage:mcp-secrets-stale", name: "keyed", at });
    assert.equal(h.doc("keyed").headers["x-api-key"], "K1");
    assert.deepEqual(h.server.held.get("keyed"), { origin: fake.origin, headers: { "x-api-key": "K1" } });
    // a stale message sent after the save drops it
    await tick(2);
    await h.service.handleSecretsStale({ type: "murage:mcp-secrets-stale", name: "keyed", at: Date.now() + 1 });
    assert.equal(h.doc("keyed"), undefined);
  } finally { await fake.close(); }
});

test("a failing drop writes one log line with the server name and nothing else", async () => {
  const lines = [];
  const updateDocument = async () => { throw new Error("keychain said SECRET-DETAIL"); };
  await handleSecretsStale({ type: "murage:mcp-secrets-stale", name: "comfy", at: 1 }, { updateDocument, log: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /comfy/);
  assert.doesNotMatch(lines[0], /SECRET-DETAIL|keychain/);
  lines.length = 0;
  await handleSecretsStale({ type: "murage:mcp-secrets-stale", name: "../../bad" }, { updateDocument, log: (line) => lines.push(line) });
  assert.equal(lines.length, 0, "an invalid name is ignored");
});

test("saveSecrets: header values bound to the entry's origin, merged by name, validated", async () => {
  const fake = await startFakeRemoteMcp({ auth: "api-key" });
  try {
    const h = harness({ fake, entries: { keyed: { url: fake.mcpUrl, auth: "header", headerNames: ["x-api-key", "x-team"], local: "this-computer" } } });
    assert.deepEqual(await h.service.saveSecrets("keyed", { headers: { "x-api-key": "K1", "x-team": "T1" } }), { ok: true });
    assert.deepEqual(await h.service.saveSecrets("keyed", { headers: { "x-api-key": "K2" } }), { ok: true });
    assert.deepEqual(h.doc("keyed").headers, { "x-api-key": "K2", "x-team": "T1" });
    assert.equal(h.doc("keyed").origin, fake.origin);
    assert.deepEqual(h.server.held.get("keyed").headers, { "x-api-key": "K2", "x-team": "T1" }, "a push carries the whole doc");
    for (const bad of [
      { headers: { "x-other": "v" } },                  // not a header the entry names
      { headers: { "x-api-key": "a\r\nb" } },
      { headers: { "x-api-key": "x".repeat(9000) } },
      { url: "https://elsewhere.example/mcp?key=1" },   // another origin
      { env: { TOKEN: "v" } },                          // env belongs to command servers
      {},
      null,
    ]) {
      const result = await h.service.saveSecrets("keyed", bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.equal(result.error, "invalid");
    }
    assert.deepEqual(h.doc("keyed").headers, { "x-api-key": "K2", "x-team": "T1" });
    assert.deepEqual(await h.service.saveSecrets("keyed", { url: `${fake.mcpUrl}?key=Q1` }), { ok: true });
    assert.equal(h.doc("keyed").url, `${fake.mcpUrl}?key=Q1`);
  } finally { await fake.close(); }
});

test("an entry edited to another address while saving: the push is refused and main drops its copy", async () => {
  const fake = await startFakeRemoteMcp({ auth: "api-key" });
  try {
    const h = harness({ fake, entries: { keyed: { url: fake.mcpUrl, auth: "header", headerNames: ["x-api-key"], local: "this-computer" } } });
    // the owner's edit lands between main's listing read and its push
    const commit = h.server.commit;
    let listed = false;
    h.server.commit = async (route, init) => {
      const answer = await commit(route, init);
      if (route === "/api/mcp/servers" && !listed) { listed = true; h.server.entries.keyed.url = "https://moved.example/mcp"; }
      return answer;
    };
    const result = await h.service.saveSecrets("keyed", { headers: { "x-api-key": "K1" } });
    assert.equal(result.ok, false);
    assert.equal(result.error, "stale");
    assert.equal(h.doc("keyed"), undefined, "main keeps no key bound to the old address");
    assert.equal(h.server.held.has("keyed"), false);
  } finally { await fake.close(); }
});

test("command servers (T16): env values go to main and are pushed without an origin", async () => {
  const fake = await startFakeRemoteMcp();
  try {
    const h = harness({ fake, entries: { notes: { kind: "stdio", envKeys: ["NOTES_TOKEN", "LOG_LEVEL"] } } });
    assert.deepEqual(await h.service.saveSecrets("notes", { env: { NOTES_TOKEN: "nt-1", LOG_LEVEL: "debug" } }), { ok: true });
    assert.deepEqual(h.doc("notes").env, { NOTES_TOKEN: "nt-1", LOG_LEVEL: "debug" });
    assert.equal(h.doc("notes").origin, undefined);
    assert.deepEqual(h.server.held.get("notes"), { env: { NOTES_TOKEN: "nt-1", LOG_LEVEL: "debug" } });
    for (const bad of [{ env: { OTHER: "v" } }, { env: { MURAGE_MCP_TOKEN: "v" } }, { headers: { "x-api-key": "v" } }]) {
      assert.equal((await h.service.saveSecrets("notes", bad)).error, "invalid");
    }
  } finally { await fake.close(); }
});

test("a write the credential store refuses is reported and nothing is pushed", async () => {
  const fake = await startFakeRemoteMcp({ auth: "api-key" });
  try {
    const h = harness({ fake, entries: { keyed: { url: fake.mcpUrl, auth: "header", headerNames: ["x-api-key"], local: "this-computer" } }, failWrites: true });
    const result = await h.service.saveSecrets("keyed", { headers: { "x-api-key": "K1" } });
    assert.equal(result.error, "storage");
    assert.equal(h.server.pushes.length, 0);
  } finally { await fake.close(); }
});

test("messages carry no secret and follow the copy rules; modules never touch files", () => {
  for (const file of ["service.mjs", "flow.mjs", "discovery.mjs", "register.mjs", "custody.mjs", "refresher.mjs", "revoke.mjs"]) {
    const source = readFileSync(new URL(`./mcp-signin/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:node:)?fs(?:\/promises)?["']/, `${file} imports no filesystem module`);
    assert.doesNotMatch(source, /[—–]/, `${file}: no em or en dash`);
    assert.doesNotMatch(source, /\b[Ss]afe(ly|ty)?\b|\b[Uu]nsafe\b|[Cc]omposio/, `${file}: copy rules`);
    assert.doesNotMatch(source, /console\.(log|error|warn)/, `${file}: logs only through the injected logger`);
    assert.doesNotMatch(source, /\bfetch\(/, `${file}: every request goes through the guarded client`);
  }
});
