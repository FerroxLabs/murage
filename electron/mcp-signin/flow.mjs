// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The browser sign-in itself (MCP-LINK 3.7 steps 5 to 7): loopback on
// 127.0.0.1, authorize with PKCE S256, a 32-byte state and `resource` bound to
// the server URL (RFC 8707), the callback checks (exact state; `iss` when the
// server offers it, RFC 9207), and the token exchange through the guarded
// client with a 64 KiB cap and no redirects.
import { guardedRequest } from "../../shared/guarded-http.mjs";
import { LIMITS } from "../../shared/remote-mcp-url.mjs";
import { runLoopback } from "../oauth/loopback.mjs";
import { createPkce } from "../oauth/pkce.mjs";
import { registerClient, reusableClient } from "./register.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** Space-separated scope strings, merged in order, each once. */
export function unionScopes(...lists) {
  const out = [];
  for (const list of lists) {
    const items = Array.isArray(list) ? list : typeof list === "string" ? list.split(/\s+/) : [];
    for (const item of items) if (item && SCOPE.test(item) && !out.includes(item)) out.push(item);
  }
  return out.join(" ");
}

export function buildAuthorizeUrl({ authorizationEndpoint, clientId, redirectUri, challenge, state, resource, scope }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", resource);
  if (scope) url.searchParams.set("scope", scope);
  return url.toString();
}

/** A token endpoint answer to a normalized bundle, or null. */
export function parseTokenBody(json, now) {
  if (!isRecord(json)) return null;
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, token_type: tokenType, scope } = json;
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 16_384 || /[\s\0]/.test(accessToken)) return null;
  if (tokenType !== undefined && (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer")) return null;
  return {
    accessToken,
    ...(typeof refreshToken === "string" && refreshToken && refreshToken.length <= 16_384 ? { refreshToken } : {}),
    ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(typeof scope === "string" && scope ? { scope: unionScopes(scope) } : {}),
  };
}

/**
 * POST a form to a token endpoint. Never throws.
 * `dead` means the grant is gone (sign in again); `retry` means try later and
 * erase nothing (a network failure, a 5xx, anything not clearly a dead grant).
 */
export async function postTokenForm({ tokenEndpoint, form, local, request = guardedRequest, now = Date.now, signal }) {
  let response;
  try {
    response = await request({
      url: tokenEndpoint, method: "POST", kind: "token", mode: "request", confirmed: local ?? null,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(), maxBytes: LIMITS.tokenBytes, signal,
    });
  } catch {
    return { ok: false, failure: "retry" };
  }
  let json = null;
  try { json = JSON.parse(Buffer.from(response.body).toString("utf8")); } catch { json = null; }
  if (response.status !== 200) {
    const code = String(isRecord(json) ? json.error ?? "" : "").toLowerCase();
    // Only invalid_grant ends a grant. Any other failure (a gateway, an incident)
    // is retried and the owner's tokens are not erased for it.
    if (code === "invalid_grant") return { ok: false, failure: "dead" };
    // invalid_client: the server no longer knows this client registration. Retrying
    // cannot help; the caller drops the registration so a new sign-in registers anew.
    if (code === "invalid_client" && (response.status === 401 || response.status === 400)) return { ok: false, failure: "client" };
    return { ok: false, failure: "retry" };
  }
  const tokens = parseTokenBody(json, now());
  return tokens ? { ok: true, tokens } : { ok: false, failure: "retry" };
}

/**
 * One browser sign-in. Resolves the new OAuth record (not yet saved) or a
 * failure code.
 *
 * @param {object} input
 * @param {any} input.discovery  a successful discoverAuthorization() result
 * @param {{ url: string, local?: string }} input.target
 * @param {object | undefined} input.stored  the saved OAuth record for this server, if any
 * @param {string} input.scope  the scopes to ask for, space separated ("" for none)
 */
export async function runSignInFlow(input, deps) {
  const { discovery, target, stored, scope } = input;
  const request = deps.request ?? guardedRequest;
  const now = deps.now ?? Date.now;
  const pkce = createPkce({ verifierBytes: 32, stateBytes: 32 });
  const sameIssuer = isRecord(stored) && stored.issuer === discovery.issuer;
  const ports = sameIssuer && Number.isInteger(stored.redirectPort) && stored.redirectPort > 0 ? [stored.redirectPort, 0] : [0];
  let client = null, setupError = null, redirectUri = "";
  const outcome = await runLoopback({
    createServer: deps.createServer,
    path: "/callback",
    ports,
    state: pkce.state,
    timeoutMs: LIMITS.signInMs,
    register: deps.register,
    onSettled: deps.onSettled,
    accept: (params) => {
      const iss = params.get("iss");
      if (discovery.issParameterSupported) return iss === discovery.issuer;
      return iss === null || iss === discovery.issuer;
    },
    onListening: async (port) => {
      redirectUri = `http://127.0.0.1:${port}/callback`;
      client = sameIssuer ? reusableClient(stored, discovery.issuer, port) : null;
      if (!client) {
        if (!discovery.registrationEndpoint) { setupError = "no-registration"; throw new Error(setupError); }
        const registered = await registerClient({ registrationEndpoint: discovery.registrationEndpoint, redirectUri, local: target.local, request });
        if (!registered.ok) { setupError = registered.error; throw new Error(setupError); }
        client = { clientId: registered.clientId, ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}) };
      }
      await deps.openExternal(buildAuthorizeUrl({
        authorizationEndpoint: discovery.authorizationEndpoint, clientId: client.clientId, redirectUri,
        challenge: pkce.challenge, state: pkce.state, resource: target.url, scope,
      }));
    },
  });
  if (outcome.error) {
    if (outcome.error === "browser" && setupError) return { ok: false, error: setupError };
    if (outcome.error === "cancelled" && outcome.providerError) return { ok: false, error: "denied" };
    if (outcome.error === "rejected") return { ok: false, error: "refused" };
    return { ok: false, error: outcome.error };
  }
  const exchanged = await postTokenForm({
    tokenEndpoint: discovery.tokenEndpoint, local: target.local, request, now,
    form: {
      grant_type: "authorization_code", code: outcome.code, code_verifier: pkce.verifier, redirect_uri: redirectUri,
      client_id: client.clientId, resource: target.url, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    },
  });
  if (!exchanged.ok) return { ok: false, error: "token" };
  const tokens = exchanged.tokens;
  return {
    ok: true,
    oauth: {
      issuer: discovery.issuer,
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      redirectPort: outcome.port,
      resource: target.url,
      scope: tokens.scope ?? scope,
      tokenEndpoint: discovery.tokenEndpoint,
      ...(discovery.revocationEndpoint ? { revocationEndpoint: discovery.revocationEndpoint } : {}),
      ...(target.local ? { local: target.local } : {}),
      accessToken: tokens.accessToken,
      issuedAt: now(),
      // Only an owner sign-in stamps this; a refresh keeps it. A card settles on it.
      signedInAt: now(),
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    },
  };
}
