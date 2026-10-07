// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan sign-in, main process: OAuth details ported from Wayland, Murage's own
// custody (encrypted document only), the single refresher, the per-provider
// flag, and the guard that the Codex CLI and Grok Build logins are never
// touched. Fakes only: no browser, no network, no real account.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { MODEL_SIGNIN_DOCUMENT_KEY, createModelSignIn, publicSignInEntries, readSignInRecords } from "./model-signin.mjs";
import {
  CHATGPT_OAUTH_CLIENT_ID_DEFAULT, XAI_OAUTH_CLIENT_ID_DEFAULT, buildChatGptAuthorizeUrl, buildXaiAuthorizeUrl, classifyTokenFailure,
  createPkce, isPinnedXaiHttps, isPinnedXaiTokenUrl, isPinnedXaiVerificationUrl, parseChatGptIdToken, parseRetryAfterMs, parseTokenResponse, parseXaiDiscovery, resolveClientId, s256Challenge,
} from "./model-signin-oauth.mjs";
import { SIGNIN_CONNECTION_IDS, signInProviderEnabled } from "./model-signin-presets.mjs";

const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = payload => `${b64({ alg: "none" })}.${b64(payload)}.sig`;
const ID_TOKEN = jwt({ exp: 2_000_000_000, email: "owner@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "plus" } });

/** A loopback server stand-in: records the listen, lets the test deliver the
 * browser's redirect, and tracks close. */
function fakeServerFactory(busyPorts = []) {
  const servers = [];
  const create = () => {
    const server = new EventEmitter();
    server.closed = false;
    server.listen = (port, host, callback) => {
      assert.equal(host, "127.0.0.1", "the sign-in listener binds loopback only");
      if (busyPorts.includes(port)) { queueMicrotask(() => server.emit("error", new Error("EADDRINUSE"))); return; }
      server.port = port === 0 ? 43123 : port;
      queueMicrotask(callback);
    };
    server.address = () => ({ port: server.port });
    server.close = () => { server.closed = true; };
    servers.push(server);
    return server;
  };
  const deliver = (server, url) => new Promise(resolve => {
    const res = { status: 0, body: "", writeHead(status) { this.status = status; return this; }, end(body = "") { this.body = body; resolve(this); return this; } };
    server.emit("request", { url }, res);
  });
  return { create, servers, deliver };
}

function harness({ tokenReplies = [], env = {}, busyPorts = [] } = {}) {
  let document = { unrelatedCredential: "PRESERVE_ME" };
  const state = createSecureCredentialState(document, async next => { document = structuredClone(next); });
  const events = [], published = [], opened = [], posts = [];
  const servers = fakeServerFactory(busyPorts);
  let ids = 0, clock = 1_700_000_000_000;
  const fetch = async (url, init) => {
    if (String(url).includes("openid-configuration")) return Response.json({ authorization_endpoint: "https://accounts.x.ai/oauth2/authorize", token_endpoint: "https://auth.x.ai/oauth2/token" });
    const form = new URLSearchParams(String(init.body));
    posts.push({ url: String(url), form });
    events.push(`post:${form.get("grant_type")}`);
    const reply = tokenReplies.shift();
    if (!reply) return Response.json({ error: "no fixture" }, { status: 500 });
    if (reply === "offline") throw new TypeError("fetch failed");
    return typeof reply.status === "number" ? Response.json(reply.body ?? {}, { status: reply.status }) : Response.json(reply);
  };
  const signIn = createModelSignIn({
    readDocument: () => state.read(),
    updateDocument: (derive, afterPersist) => state.update(async current => { const next = await derive(current); events.push("persist"); return next; }, afterPersist),
    publish: entries => { events.push("publish"); published.push(structuredClone(entries)); },
    openExternal: async url => { opened.push(url); },
    createServer: servers.create,
    fetch, env: { DISPLAY: ":0", ...env }, platform: "darwin",
    now: () => clock, randomId: () => `rev-${++ids}`,
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  return { signIn, events, published, opened, posts, servers, document: () => document, tick: ms => { clock += ms; } };
}

async function signInChatGpt(h) {
  h.posts.length = 0;
  const pending = h.signIn.start("chatgpt");
  await new Promise(resolve => setTimeout(resolve, 5));
  const url = new URL(h.opened.at(-1));
  const server = h.servers.servers.at(-1);
  await h.servers.deliver(server, `/auth/callback?code=code-1&state=${url.searchParams.get("state")}`);
  return pending;
}

test("the authorize URLs are Wayland's: Codex client and params for ChatGPT, Grok Build client for xAI", () => {
  const pkce = createPkce("chatgpt");
  assert.equal(pkce.challenge, s256Challenge(pkce.verifier));
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
  const chat = new URL(buildChatGptAuthorizeUrl({ clientId: resolveClientId("chatgpt", {}), challenge: pkce.challenge, state: pkce.state, redirectUri: "http://localhost:1455/auth/callback" }));
  assert.equal(chat.origin + chat.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(chat.searchParams.get("client_id"), CHATGPT_OAUTH_CLIENT_ID_DEFAULT);
  assert.equal(chat.searchParams.get("originator"), "codex_cli_rs");
  assert.equal(chat.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(chat.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(chat.searchParams.get("code_challenge_method"), "S256");
  assert.match(chat.searchParams.get("scope"), /offline_access/);
  const grok = new URL(buildXaiAuthorizeUrl("https://accounts.x.ai/oauth2/authorize", { clientId: resolveClientId("supergrok", {}), challenge: "c", state: "s", redirectUri: "http://127.0.0.1:1/callback" }));
  assert.equal(grok.searchParams.get("client_id"), XAI_OAUTH_CLIENT_ID_DEFAULT);
  assert.equal(grok.searchParams.get("scope"), "openid profile offline_access grok-cli:access api:access");
  assert.equal(resolveClientId("supergrok", { MURAGE_XAI_OAUTH_CLIENT_ID: "murage-own-client" }), "murage-own-client");
});

test("xAI discovery is pinned to https on x.ai", () => {
  assert.deepEqual(parseXaiDiscovery({ authorization_endpoint: "https://auth.x.ai/a", token_endpoint: "https://auth.x.ai/t" }), { authorizeUrl: "https://auth.x.ai/a", tokenUrl: "https://auth.x.ai/t" });
  assert.equal(parseXaiDiscovery({ authorization_endpoint: "https://evil.example/a", token_endpoint: "https://auth.x.ai/t" }), null);
  assert.equal(parseXaiDiscovery({ authorization_endpoint: "https://auth.x.ai/a", token_endpoint: "https://other.x.ai/t" }), null, "refresh tokens go to auth.x.ai only");
  assert.equal(isPinnedXaiTokenUrl("https://auth.x.ai/oauth2/token"), true);
  assert.equal(isPinnedXaiTokenUrl("https://api.x.ai/oauth2/token"), false);
  assert.equal(isPinnedXaiHttps("https://x.ai.evil.example/t"), false);
  assert.equal(isPinnedXaiHttps("http://auth.x.ai/t"), false);
});

test("token and id_token parsing reads the account id, plan and email", () => {
  assert.deepEqual(parseChatGptIdToken(ID_TOKEN), { expiresAt: 2_000_000_000_000, email: "owner@example.com", accountId: "acct-123", plan: "plus" });
  const tokens = parseTokenResponse("chatgpt", { access_token: "a", refresh_token: "r", id_token: ID_TOKEN, expires_in: 60 }, 1000);
  assert.equal(tokens.expiresAt, 61_000);
  assert.equal(tokens.accountId, "acct-123");
  assert.equal(parseTokenResponse("chatgpt", { refresh_token: "r" }), null);
});

test("refusal classes: a dead refresh token wipes; a hiccup never does", () => {
  assert.equal(classifyTokenFailure(400, { error: "invalid_grant" }), "dead");
  assert.equal(classifyTokenFailure(401, { error: { code: "refresh_token_reused" } }), "dead");
  assert.equal(classifyTokenFailure(503, null), "retry");
  assert.equal(classifyTokenFailure(400, { error: "invalid_scope" }), "retry", "a bare 400 does not erase a sign-in");
  assert.equal(classifyTokenFailure(500, { error: "server_error" }), "retry");
});

test("ChatGPT sign-in stores tokens in the encrypted document and publishes only the access token", async () => {
  const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }];
  const h = harness({ tokenReplies: replies });
  const result = await signInChatGpt(h);
  assert.deepEqual(result, { ok: true, email: "owner@example.com", plan: "plus" });
  const opened = new URL(h.opened[0]);
  assert.equal(opened.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(h.posts[0].url, "https://auth.openai.com/oauth/token");
  assert.equal(h.posts[0].form.get("grant_type"), "authorization_code");
  assert.ok(h.posts[0].form.get("code_verifier"));
  assert.ok(h.servers.servers.every(server => server.closed), "the loopback listener is always closed");
  const saved = readSignInRecords(h.document()).chatgpt;
  assert.equal(saved.refreshToken, "rt-1");
  assert.equal(saved.accountId, "acct-123");
  assert.equal(h.document().unrelatedCredential, "PRESERVE_ME");
  const pushed = h.published.at(-1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].accessToken, "at-1");
  assert.equal(pushed[0].connectionId, SIGNIN_CONNECTION_IDS.chatgpt);
  assert.equal(JSON.stringify(pushed).includes("rt-1"), false, "the refresh token never leaves main");
  assert.equal(JSON.stringify(pushed).includes(ID_TOKEN), false);
  assert.equal(JSON.stringify(h.signIn.status()).includes("at-1"), false, "status carries no token");
  assert.deepEqual(h.events.slice(-2), ["persist", "publish"]);
});

test("the ChatGPT listener falls back to 1457 when 1455 is busy", async () => {
  const h = harness({ tokenReplies: [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }], busyPorts: [1455] });
  const result = await signInChatGpt(h);
  assert.equal(result.ok, true);
  assert.equal(new URL(h.opened[0]).searchParams.get("redirect_uri"), "http://localhost:1457/auth/callback");
});

test("a forged callback (wrong or missing state) is refused, and cannot end or hijack the waiting flow", async () => {
  const h = harness({ tokenReplies: [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }] });
  const pending = h.signIn.start("chatgpt");
  await new Promise(resolve => setTimeout(resolve, 5));
  const server = h.servers.servers[0];
  assert.equal((await h.servers.deliver(server, "/auth/callback?code=x&state=not-it")).status, 400);
  assert.equal((await h.servers.deliver(server, "/auth/callback?error=access_denied")).status, 400);
  assert.equal(h.posts.length, 0);
  assert.equal(h.signIn.status().find(row => row.provider === "chatgpt").state, "waiting", "still waiting for the real browser");
  const state = new URL(h.opened[0]).searchParams.get("state");
  await h.servers.deliver(server, `/auth/callback?code=real&state=${state}`);
  assert.equal((await pending).ok, true);
  assert.equal(h.posts[0].form.get("code"), "real");
});

test("a ChatGPT account without a plan workspace id is refused", async () => {
  const h = harness({ tokenReplies: [{ access_token: "at-1", refresh_token: "rt-1", id_token: jwt({ exp: 2_000_000_000 }), expires_in: 3600 }] });
  assert.deepEqual(await signInChatGpt(h), { ok: false, error: "unauthorized" });
  assert.deepEqual(readSignInRecords(h.document()), {});
});

test("Grok: a pasted code finishes the waiting flow (Wayland's paste box)", async () => {
  const h = harness({ tokenReplies: [{ access_token: "gat-1", refresh_token: "grt-1", expires_in: 3600 }] });
  const pending = h.signIn.start("supergrok");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.signIn.status().find(row => row.provider === "supergrok").acceptsCode, true);
  assert.equal(h.signIn.submitCode("supergrok", "has space"), false);
  assert.equal(h.signIn.submitCode("supergrok", "pasted-code"), true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(h.posts[0].url, "https://auth.x.ai/oauth2/token");
  assert.equal(h.posts[0].form.get("code"), "pasted-code");
  assert.equal(new URL(h.opened[0]).origin, "https://accounts.x.ai");
  assert.equal(readSignInRecords(h.document()).supergrok.refreshToken, "grt-1");
});

test("refresh is single flight, and the rotated refresh token is saved before the new access token is published", async () => {
  const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }];
  const h = harness({ tokenReplies: replies });
  await signInChatGpt(h);
  h.events.length = 0; h.posts.length = 0;
  replies.push({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  const [a, b] = await Promise.all([h.signIn.refresh("chatgpt"), h.signIn.refresh("chatgpt")]);
  assert.equal(a, true); assert.equal(b, true);
  assert.equal(h.posts.length, 1, "two callers, one refresh POST (xAI refresh tokens are single use)");
  assert.equal(h.posts[0].form.get("refresh_token"), "rt-1");
  assert.deepEqual(h.events, ["post:refresh_token", "persist", "publish"]);
  const saved = readSignInRecords(h.document()).chatgpt;
  assert.equal(saved.refreshToken, "rt-2");
  assert.equal(saved.accountId, "acct-123", "fields the refresh omits are carried forward");
  assert.equal(saved.revision, "rev-1", "a refresh keeps the revision, so running turns are not cancelled");
  assert.equal(h.published.at(-1)[0].accessToken, "at-2");
});

test("a dead refresh token ends the sign-in; a network failure keeps it", async () => {
  const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }];
  const h = harness({ tokenReplies: replies });
  await signInChatGpt(h);
  replies.push("offline");
  assert.equal(await h.signIn.refresh("chatgpt"), false);
  assert.equal(readSignInRecords(h.document()).chatgpt.refreshToken, "rt-1", "offline never erases a sign-in");
  h.tick(16 * 60 * 1000); // past the back-off the offline failure set
  replies.push({ status: 503, body: { error: "unavailable" } });
  assert.equal(await h.signIn.refresh("chatgpt"), false);
  assert.equal(readSignInRecords(h.document()).chatgpt.state, "connected");
  h.tick(16 * 60 * 1000);
  replies.push({ status: 400, body: { error: "invalid_grant" } });
  assert.equal(await h.signIn.refresh("chatgpt"), false);
  const ended = readSignInRecords(h.document()).chatgpt;
  assert.equal(ended.state, "needs-sign-in");
  assert.equal(ended.accessToken, undefined);
  assert.equal(ended.refreshToken, undefined);
  assert.equal(ended.email, "owner@example.com");
  assert.deepEqual(h.published.at(-1), [{ provider: "chatgpt", connectionId: "signin-chatgpt", revision: "rev-1", state: "needs-sign-in", email: "owner@example.com", plan: "plus" }]);
});

test("a refreshed bundle whose save fails is kept private (never published), and the next refresh uses the new token", async () => {
  const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }];
  let failSaves = false;
  let document = {};
  const state = createSecureCredentialState(document, async next => { if (failSaves) throw new Error("keychain busy"); document = structuredClone(next); });
  const published = [], posts = [];
  const servers = fakeServerFactory();
  const opened = [];
  const signIn = createModelSignIn({
    readDocument: () => state.read(), updateDocument: derive => state.update(derive),
    publish: entries => published.push(structuredClone(entries)), openExternal: async url => { opened.push(url); }, createServer: servers.create,
    fetch: async (url, init) => {
      if (String(url).includes("openid-configuration")) return Response.json({}, { status: 404 });
      posts.push(new URLSearchParams(String(init.body))); return Response.json(replies.shift());
    },
    env: { DISPLAY: ":0" }, platform: "darwin", randomId: () => "rev-1", setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  const pending = signIn.start("supergrok");
  await new Promise(resolve => setTimeout(resolve, 5));
  signIn.submitCode("supergrok", "code");
  assert.equal((await pending).ok, true);
  failSaves = true;
  replies.push({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  const publishedBefore = published.length;
  assert.equal(await signIn.refresh("supergrok"), false);
  assert.equal(published.length, publishedBefore, "a rotated pair that is not on disk is not published");
  replies.push({ access_token: "at-3", refresh_token: "rt-3", expires_in: 3600 });
  assert.equal(await signIn.refresh("supergrok"), false);
  assert.equal(posts.at(-1).get("refresh_token"), "rt-2", "never the spent single-use token");
  assert.equal(published.length, publishedBefore);
  failSaves = false;
  replies.push({ access_token: "at-4", refresh_token: "rt-4", expires_in: 3600 });
  assert.equal(await signIn.refresh("supergrok"), true);
  assert.equal(posts.at(-1).get("refresh_token"), "rt-3");
  assert.equal(readSignInRecords(document).supergrok.refreshToken, "rt-4", "saved once the store is back");
});

test("a sign-out that lands during a refresh wins", async () => {
  const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }];
  const h = harness({ tokenReplies: replies });
  await signInChatGpt(h);
  replies.push({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  const refreshing = h.signIn.refresh("chatgpt");
  await h.signIn.signOut("chatgpt");
  await refreshing;
  assert.deepEqual(readSignInRecords(h.document()), {});
  assert.deepEqual(h.published.at(-1), []);
});

test("reactive refreshes from the gateway are rate limited", async () => {
  const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }, { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }];
  const h = harness({ tokenReplies: replies });
  await signInChatGpt(h);
  assert.equal(await h.signIn.refresh("chatgpt", { reactive: true }), true);
  assert.equal(await h.signIn.refresh("chatgpt", { reactive: true }), false, "no refresh storm from repeated 401s");
});

test("one flag per provider: off hides it, refuses sign-in and stops publishing, without deleting tokens", async () => {
  assert.equal(signInProviderEnabled("chatgpt", {}), true);
  assert.equal(signInProviderEnabled("supergrok", { MURAGE_SIGNIN_GROK: "off" }), false);
  const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }];
  const h = harness({ tokenReplies: replies, env: { MURAGE_SIGNIN_GROK: "0" } });
  assert.deepEqual(await h.signIn.start("supergrok"), { ok: false, error: "disabled" });
  assert.equal(h.signIn.status().find(row => row.provider === "supergrok").enabled, false);
  await signInChatGpt(h);
  const records = readSignInRecords(h.document());
  assert.equal(publicSignInEntries(records, { MURAGE_SIGNIN_CHATGPT: "false" }).length, 0);
  assert.equal(publicSignInEntries(records, {}).length, 1);
});

test("a headless Linux host is told so instead of waiting three minutes", async () => {
  const h = harness();
  const signIn = createModelSignIn({ readDocument: () => ({}), updateDocument: async () => {}, publish: () => {}, openExternal: async () => {}, createServer: h.servers.create, env: {}, platform: "linux", randomId: () => "x" });
  assert.deepEqual(await signIn.start("chatgpt"), { ok: false, error: "headless" });
});

test("never touches the Codex CLI or Grok Build login files", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-signin-home-"));
  const previousHome = process.env.HOME;
  try {
    mkdirSync(join(home, ".codex")); mkdirSync(join(home, ".grok"));
    const codex = join(home, ".codex", "auth.json"), grok = join(home, ".grok", "auth.json");
    writeFileSync(codex, JSON.stringify({ tokens: { access_token: "users-own-codex" } }));
    writeFileSync(grok, JSON.stringify({ access_token: "users-own-grok" }));
    const before = [statSync(codex).mtimeMs, statSync(grok).mtimeMs];
    process.env.HOME = home;
    const replies = [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 }, { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }];
    const h = harness({ tokenReplies: replies });
    await signInChatGpt(h);
    await h.signIn.refresh("chatgpt");
    await h.signIn.signOut("chatgpt");
    assert.equal(readFileSync(codex, "utf8"), JSON.stringify({ tokens: { access_token: "users-own-codex" } }));
    assert.equal(readFileSync(grok, "utf8"), JSON.stringify({ access_token: "users-own-grok" }));
    assert.deepEqual([statSync(codex).mtimeMs, statSync(grok).mtimeMs], before);
    // The sign-in never reused the CLI's token either (Wayland did).
    assert.equal(JSON.stringify(h.published).includes("users-own"), false);
  } finally {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
  // Structural: the sign-in modules cannot touch files at all.
  for (const file of ["model-signin.mjs", "model-signin-oauth.mjs", "model-signin-presets.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:node:)?fs(?:\/promises)?["']/, `${file} imports no filesystem module`);
    assert.doesNotMatch(source, /homedir|os\.homedir|process\.env\.HOME/, `${file} never resolves a home directory`);
  }
});

test("an unreadable saved entry reads as signed out and the document key is the one main writes", () => {
  assert.deepEqual(readSignInRecords({ [MODEL_SIGNIN_DOCUMENT_KEY]: "{not json" }), {});
  assert.deepEqual(readSignInRecords({ [MODEL_SIGNIN_DOCUMENT_KEY]: JSON.stringify({ chatgpt: { state: "weird", revision: "r" } }) }), {});
});

test("Grok loopback: a cancel during the code exchange wins and nothing is saved", async () => {
  const h = harness({ tokenReplies: [{ access_token: "gat-1", refresh_token: "grt-1", expires_in: 3600 }] });
  const pending = h.signIn.start("supergrok");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.signIn.submitCode("supergrok", "pasted-code"), true);
  h.signIn.cancel("supergrok"); // the flow already unregistered; the exchange is in flight
  assert.deepEqual(await pending, { ok: false, error: "cancelled" });
  assert.deepEqual(readSignInRecords(h.document()), {});
});

test("Retry-After is honored in full, with no ceiling", () => {
  assert.equal(parseRetryAfterMs("1800"), 1_800_000);
  assert.equal(parseRetryAfterMs("7200"), 7_200_000);
  assert.equal(parseRetryAfterMs("172800"), 2 * 24 * 60 * 60 * 1000);
  assert.equal(parseRetryAfterMs("999999999"), 999_999_999_000);
  assert.equal(parseRetryAfterMs(new Date(1_000_000 + 3 * 24 * 60 * 60 * 1000).toUTCString(), 1_000_000), 3 * 24 * 60 * 60 * 1000 - 0);
  assert.equal(parseRetryAfterMs("nonsense"), undefined);
});

test("Grok verification pages are exact xAI origins, not any x.ai subdomain", () => {
  assert.equal(isPinnedXaiVerificationUrl("https://accounts.x.ai/device?user_code=A"), true);
  assert.equal(isPinnedXaiVerificationUrl("https://auth.x.ai/device"), true);
  for (const url of ["https://api.x.ai/device", "https://x.ai/device", "https://evil.x.ai/d", "https://accounts.x.ai:444/d", "https://a:b@accounts.x.ai/d", "http://accounts.x.ai/d", "not a url"]) assert.equal(isPinnedXaiVerificationUrl(url), false, url);
});
