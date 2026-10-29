// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  FLUX_DESKTOP_CLIENT_ID, FluxSigninError, buildAuthorizeUrl, cancelFluxDesktopSignin, interpretOutcome,
  keyFromTokenResponse, redirectUriFor, runFluxDesktopSignin, tokenRequest,
} from "./flux-desktop-signin.mjs";
import { createPkce, s256Challenge } from "./oauth/pkce.mjs";

const FAKE_KEY = "sk-flux-" + "a1b2c3d4e5f6".repeat(4);
const rejects = (promise, code) => assert.rejects(promise, (e) => e instanceof FluxSigninError && e.code === code);

test("PKCE challenge is S256 of the verifier, state is unguessable and fresh", () => {
  const a = createPkce(), b = createPkce();
  assert.equal(a.challenge, createHash("sha256").update(a.verifier).digest("base64url"));
  assert.equal(s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.notEqual(a.state, b.state);
  assert.ok(a.state.length >= 43);
});

test("authorize URL carries client, S256 challenge, state and loopback redirect", () => {
  const url = new URL(buildAuthorizeUrl({ redirectUri: redirectUriFor(5555), challenge: "ch", state: "st" }));
  assert.equal(url.origin + url.pathname, "https://fluxrouter.ai/desktop/authorize");
  assert.equal(url.searchParams.get("client_id"), FLUX_DESKTOP_CLIENT_ID);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5555/callback");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("redirect parser: code, access_denied, missing code, other errors", () => {
  assert.equal(interpretOutcome({ code: "abc", port: 1 }), "abc");
  assert.throws(() => interpretOutcome({ error: "cancelled", providerError: "access_denied" }), (e) => e.code === "cancelled");
  assert.throws(() => interpretOutcome({ error: "cancelled" }), (e) => e.code === "no_code");
  assert.throws(() => interpretOutcome({ error: "cancelled", providerError: "server_error" }), (e) => e.code === "rejected");
  assert.throws(() => interpretOutcome({ error: "timeout" }), (e) => e.code === "timeout");
});

test("token request and response shapes; only a Flux key shape is accepted", () => {
  const request = tokenRequest({ code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1/callback" });
  assert.deepEqual(JSON.parse(request.body), { code: "c", code_verifier: "v", redirect_uri: "http://127.0.0.1:1/callback" });
  assert.equal(keyFromTokenResponse({ api_key: FAKE_KEY }), FAKE_KEY);
  assert.equal(keyFromTokenResponse({ api_key: "sk-other-123" }), null);
  assert.equal(keyFromTokenResponse(null), null);
});

/** A stub Flux: the consent page redirects (via fetch) as the browser would. */
async function stubFlux({ decision = "allow", tokenStatus = 200, wrongState = false, noCode = false } = {}) {
  const seen = { token: null, authorize: null, tokenCalls: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    if (url.pathname === "/desktop/authorize") {
      seen.authorize = url.searchParams;
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("state", wrongState ? "forged" : url.searchParams.get("state"));
      if (decision === "deny") back.searchParams.set("error", "access_denied");
      else if (!noCode) back.searchParams.set("code", "stub-code-1");
      await fetch(back).catch(() => {});
      res.end("ok");
    } else if (url.pathname === "/api/desktop/token") {
      seen.tokenCalls++;
      let body = ""; for await (const chunk of req) body += chunk;
      seen.token = JSON.parse(body);
      const verified = s256Challenge(seen.token.code_verifier) === seen.authorize.get("code_challenge") && seen.token.code === "stub-code-1";
      res.writeHead(verified ? tokenStatus : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(verified && tokenStatus === 200 ? { api_key: FAKE_KEY } : { error: "invalid_grant" }));
    } else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { seen, base, close: () => new Promise((r) => server.close(r)), options: {
    authorizeUrl: `${base}/desktop/authorize`, tokenUrl: `${base}/api/desktop/token`,
    openExternal: (url) => { void fetch(url); },
  } };
}

test("full exchange against a stub Flux returns the key and verifies PKCE", async () => {
  const flux = await stubFlux();
  try {
    const { key } = await runFluxDesktopSignin(flux.options);
    assert.equal(key, FAKE_KEY);
    assert.deepEqual(Object.keys(flux.seen.token).sort(), ["code", "code_verifier", "redirect_uri"]);
    assert.equal(flux.seen.token.redirect_uri, flux.seen.authorize.get("redirect_uri"));
    assert.equal(flux.seen.tokenCalls, 1);
  } finally { await flux.close(); }
});

test("Cancel on the consent page (access_denied) ends cleanly with no token call", async () => {
  const flux = await stubFlux({ decision: "deny" });
  try {
    await rejects(runFluxDesktopSignin(flux.options), "cancelled");
    assert.equal(flux.seen.tokenCalls, 0);
  } finally { await flux.close(); }
});

test("a redirect with the wrong state is refused and never exchanged", async () => {
  const flux = await stubFlux({ wrongState: true });
  try {
    await rejects(runFluxDesktopSignin({ ...flux.options, timeoutMs: 400 }), "timeout");
    assert.equal(flux.seen.tokenCalls, 0);
  } finally { await flux.close(); }
});

test("a redirect with no code is refused", async () => {
  const flux = await stubFlux({ noCode: true });
  try { await rejects(runFluxDesktopSignin(flux.options), "no_code"); assert.equal(flux.seen.tokenCalls, 0); }
  finally { await flux.close(); }
});

test("nobody completes the browser step: times out and frees the listener", async () => {
  await rejects(runFluxDesktopSignin({ openExternal: () => {}, timeoutMs: 50 }), "timeout");
  await rejects(runFluxDesktopSignin({ openExternal: () => {}, timeoutMs: 50 }), "timeout");
});

test("browser cannot open, and Cancel button, are coded", async () => {
  await rejects(runFluxDesktopSignin({ openExternal: () => { throw new Error("no browser"); } }), "browser");
  const pending = runFluxDesktopSignin({ openExternal: () => { setTimeout(cancelFluxDesktopSignin, 10); } });
  await rejects(pending, "cancelled");
});

test("a token endpoint refusal or a non-key answer is coded and carries no key", async () => {
  const flux = await stubFlux({ tokenStatus: 500 });
  try { await rejects(runFluxDesktopSignin(flux.options), "exchange"); } finally { await flux.close(); }
  const bad = await stubFlux();
  try {
    await rejects(runFluxDesktopSignin({ ...bad.options, fetchImpl: async () => new Response(JSON.stringify({ api_key: "nope" })) }), "bad_key");
  } finally { await bad.close(); }
});

test("feature switch: explicit off refuses with FLUX_SIGNIN_UNAVAILABLE, explicit on allows, unset follows the default", async () => {
  const { assertFluxDesktopSigninEnabled, fluxDesktopSigninEnabledIn } = await import("./flux-desktop-signin.mjs");
  const { FLUX_DESKTOP_SIGNIN_DEFAULT } = await import("../shared/flux-desktop-signin-default.mjs");
  assert.throws(() => assertFluxDesktopSigninEnabled({ features: { fluxDesktopSignin: false } }), (e) => e instanceof FluxSigninError && e.code === "FLUX_SIGNIN_UNAVAILABLE");
  assert.doesNotThrow(() => assertFluxDesktopSigninEnabled({ features: { fluxDesktopSignin: true } }));
  for (const config of [null, {}, { features: {} }]) assert.equal(fluxDesktopSigninEnabledIn(config), FLUX_DESKTOP_SIGNIN_DEFAULT);
});

test("bot email (2.4, contract r2.5): the token request asks scope email:owner and returns the owner credential, never a plain key", async () => {
  const { readEmailOwnerToken } = await import("./flux-desktop-signin.mjs");
  const { EMAIL_OWNER_SCOPE } = await import("./email-secrets.mjs");
  const plain = new URL(buildAuthorizeUrl({ redirectUri: redirectUriFor(1), challenge: "c", state: "s" }));
  assert.equal(plain.searchParams.has("scope"), false);
  assert.equal(JSON.parse(tokenRequest({ code: "c", verifier: "v", redirectUri: "r" }).body).scope, undefined);
  const flux = await stubFlux();
  try {
    const owner = { api_key: "flux-owner-token-fixture", key_prefix: "sk-flux-x", name: "Murage Desktop", key_id: "key_owner_1", scopes: [EMAIL_OWNER_SCOPE] };
    const { key } = await runFluxDesktopSignin({ ...flux.options, scope: EMAIL_OWNER_SCOPE, readToken: readEmailOwnerToken,
      fetchImpl: async (url, init) => { await fetch(url, init); return new Response(JSON.stringify(owner)); } });
    // r2.5: the scope rides the token request body, not the authorize URL
    assert.equal(flux.seen.token.scope, "email:owner");
    assert.equal(flux.seen.authorize.has("scope"), false);
    assert.deepEqual(key, { token: "flux-owner-token-fixture", keyId: "key_owner_1" });
  } finally { await flux.close(); }
  for (const scopes of [[], ["email:bot"], undefined]) {
    const dark = await stubFlux();
    try {
      // scopes [] (Flux's bot key switch off) or no email:owner: owner email stays dark, the calm email_dark line, nothing stored
      await rejects(runFluxDesktopSignin({ ...dark.options, scope: EMAIL_OWNER_SCOPE, readToken: readEmailOwnerToken,
        fetchImpl: async () => new Response(JSON.stringify({ api_key: "flux-owner-token-fixture", key_id: "key_owner_1", ...(scopes ? { scopes } : {}) })) }), "email_dark");
    } finally { await dark.close(); }
  }
  const noId = await stubFlux();
  try {
    await rejects(runFluxDesktopSignin({ ...noId.options, scope: EMAIL_OWNER_SCOPE, readToken: readEmailOwnerToken,
      fetchImpl: async () => new Response(JSON.stringify({ api_key: "flux-owner-token-fixture", scopes: [EMAIL_OWNER_SCOPE] })) }), "bad_key");
  } finally { await noId.close(); }
});
