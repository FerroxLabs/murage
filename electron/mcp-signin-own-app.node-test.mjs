// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B98: sign in with an app the owner registered with a provider that has no
// registration endpoint. The flow uses that client, tries ONLY the port whose
// redirect address was shown, keeps the app on invalid_client, and a client
// secret that does not fit is refused with a reason (never silently dropped).
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { runSignInFlow } from "./mcp-signin/flow.mjs";
import { withoutClient } from "./mcp-signin/custody.mjs";
import { checkOwnClient, registerClient } from "./mcp-signin/register.mjs";

const ISSUER = "https://auth.example.com";
const discovery = {
  issuer: ISSUER,
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  issParameterSupported: false,
};
const target = { url: "https://mcp.example.com/mcp" };

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function tokenRequest(seen) {
  return async (options) => {
    seen.push(options);
    return { status: 200, body: Buffer.from(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", token_type: "Bearer", expires_in: 3600 })) };
  };
}

function approvingBrowser(opened) {
  return async (authorizeUrl) => {
    opened.push(authorizeUrl);
    const url = new URL(authorizeUrl);
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "code-1");
    back.searchParams.set("state", url.searchParams.get("state"));
    setImmediate(() => { http.get(back, (res) => res.resume()).on("error", () => {}); });
  };
}

test("a saved own app signs in with its client id and secret on its pinned port, no registration endpoint needed", async () => {
  const port = await freePort();
  const stored = { issuer: ISSUER, clientId: "own-client", clientSecret: "own-secret", preRegistered: true, redirectPort: port, authorizationEndpoint: discovery.authorizationEndpoint, tokenEndpoint: discovery.tokenEndpoint };
  const opened = [], seen = [];
  const result = await runSignInFlow({ discovery, target, stored, scope: "" }, {
    createServer: () => http.createServer(), openExternal: approvingBrowser(opened), request: tokenRequest(seen),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const authorize = new URL(opened[0]);
  assert.equal(authorize.searchParams.get("client_id"), "own-client");
  assert.equal(authorize.searchParams.get("redirect_uri"), `http://127.0.0.1:${port}/callback`);
  const form = new URLSearchParams(seen[0].body);
  assert.equal(form.get("client_id"), "own-client");
  assert.equal(form.get("client_secret"), "own-secret");
  assert.equal(result.oauth.preRegistered, true);
  assert.equal(result.oauth.redirectPort, port);
  assert.equal(result.oauth.clientSecret, "own-secret");
  assert.equal(result.oauth.authorizationEndpoint, discovery.authorizationEndpoint);
});

test("a moved token endpoint or authorize page never gets the owner's app, and no new registration replaces it", async () => {
  const port = await freePort();
  const stored = { issuer: ISSUER + "/", clientId: "own-client", clientSecret: "own-secret", preRegistered: true, redirectPort: port, authorizationEndpoint: discovery.authorizationEndpoint, tokenEndpoint: discovery.tokenEndpoint };
  for (const moved of [{ tokenEndpoint: "https://evil.example.net/token" }, { authorizationEndpoint: "https://evil.example.net/authorize" }]) {
    const opened = [], seen = [];
    const result = await runSignInFlow({ discovery: { ...discovery, ...moved, registrationEndpoint: "https://auth.example.com/register" }, target, stored, scope: "" }, {
      createServer: () => http.createServer(), openExternal: approvingBrowser(opened), request: tokenRequest(seen),
    });
    assert.deepEqual(result, { ok: false, error: "own-app-changed" });
    assert.equal(opened.length + seen.length, 0);
  }
  // Only a trailing slash on the issuer differs: still the same app.
  const same = await runSignInFlow({ discovery, target, stored, scope: "" }, {
    createServer: () => http.createServer(), openExternal: approvingBrowser([]), request: tokenRequest([]),
  });
  assert.equal(same.ok, true, JSON.stringify(same));
});

test("the pinned port taken: port-busy, no other port, no browser", async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  try {
    const stored = { issuer: ISSUER, clientId: "own-client", preRegistered: true, redirectPort: port, authorizationEndpoint: discovery.authorizationEndpoint, tokenEndpoint: discovery.tokenEndpoint };
    const opened = [];
    const result = await runSignInFlow({ discovery, target, stored, scope: "" }, {
      createServer: () => http.createServer(), openExternal: approvingBrowser(opened), request: tokenRequest([]),
    });
    assert.deepEqual(result, { ok: false, error: "port-busy" });
    assert.equal(opened.length, 0);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("no own app and no registration endpoint is still no-registration", async () => {
  const result = await runSignInFlow({ discovery, target, stored: undefined, scope: "" }, {
    createServer: () => http.createServer(), openExternal: async () => {}, request: tokenRequest([]),
  });
  assert.deepEqual(result, { ok: false, error: "no-registration" });
});

test("invalid_client keeps the owner's own app and drops only the tokens", () => {
  const oauth = { issuer: ISSUER, clientId: "own-client", clientSecret: "s", preRegistered: true, redirectPort: 4567, accessToken: "a", refreshToken: "r", expiresAt: 1, issuedAt: 1, signedInAt: 1 };
  assert.deepEqual(withoutClient(oauth), { issuer: ISSUER, clientId: "own-client", clientSecret: "s", preRegistered: true, redirectPort: 4567 });
  // A dynamic registration is still dropped so the next sign-in registers anew.
  assert.equal(withoutClient({ issuer: ISSUER, clientId: "dyn", redirectPort: 1, accessToken: "a" }).clientId, undefined);
});

test("the entry form refuses a secret that does not fit, with a reason", () => {
  assert.deepEqual(checkOwnClient({ clientId: "id", clientSecret: "x".repeat(513) }), { ok: false, field: "clientSecret", reason: "long" });
  assert.deepEqual(checkOwnClient({ clientId: "id", clientSecret: "a b" }), { ok: false, field: "clientSecret", reason: "characters" });
  assert.deepEqual(checkOwnClient({ clientId: "id", clientSecret: "a\0b" }), { ok: false, field: "clientSecret", reason: "characters" });
  assert.deepEqual(checkOwnClient({ clientId: "i\0d" }), { ok: false, field: "clientId", reason: "characters" });
  assert.deepEqual(checkOwnClient({ clientId: "" }), { ok: false, field: "clientId", reason: "empty" });
  assert.deepEqual(checkOwnClient({ clientId: "id", clientSecret: "x".repeat(512) }), { ok: true, clientId: "id", clientSecret: "x".repeat(512) });
});

test("a dynamic registration whose secret does not fit is refused, never dropped", async () => {
  const request = async () => ({ status: 201, body: Buffer.from(JSON.stringify({ client_id: "dyn", client_secret: "y".repeat(600) })) });
  assert.deepEqual(await registerClient({ registrationEndpoint: "https://auth.example.com/register", redirectUri: "http://127.0.0.1:1/callback", request }), { ok: false, error: "bad-client" });
});
