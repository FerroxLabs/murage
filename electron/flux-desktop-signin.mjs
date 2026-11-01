// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-click Flux Router sign-in: the PKCE desktop flow (RFC 7636 + RFC 8252).
//
// The browser opens Flux's consent page, Flux redirects to a one-shot loopback
// listener with a short-lived code, and this module trades the code plus the
// PKCE verifier for the person's Flux key at the token endpoint. The key is
// RETURNED to the main process only; the caller stores it exactly where a
// pasted key goes (mutateFluxCredentials) and nothing here logs or echoes it.
// The verifier and state live in this closure's memory and nowhere else.
//
import { createServer } from "node:http";
import { createPkce } from "./oauth/pkce.mjs";
import { LOOPBACK_HOST, runLoopback } from "./oauth/loopback.mjs";
import { isFluxKeyShape } from "./provider-connections.mjs";

import { fluxDesktopSigninOn } from "../shared/flux-desktop-signin-default.mjs";
import { emailOwnerFromTokenResponse, emailOwnerScopeGranted } from "./email-secrets.mjs";

export const FLUX_DESKTOP_CLIENT_ID = "murage-desktop";
export const FLUX_DESKTOP_AUTHORIZE_URL = "https://fluxrouter.ai/desktop/authorize";
export const FLUX_DESKTOP_TOKEN_URL = "https://fluxrouter.ai/api/desktop/token";
/** Time the person has to finish in the browser. */
export const FLUX_DESKTOP_SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
export const FLUX_DESKTOP_EXCHANGE_TIMEOUT_MS = 15_000;

// Contract: MURAGE-DESKTOP-SIGNIN.md (FluxMain PR #207, not yet deployed).
// Documented: any loopback path and port (http://127.0.0.1:<port>/<path>), the
// exact redirect_uri reused at exchange; JSON body {code, code_verifier,
// redirect_uri} with NO client_id or grant_type; response {api_key, ...}.
export const REDIRECT_PATH = "/callback";
export const TOKEN_RESPONSE_FIELD = "api_key";
// Confirmed with Flux (10-16): the apex fluxrouter.ai serves both URLs above
// (www redirects to it), and the token route only ever issues sk-flux- keys, so
// any other prefix is refused as bad_key (isFluxKeyShape).
export const FLUX_APP_HOST = "fluxrouter.ai";

export class FluxSigninError extends Error {
  constructor(code, message) { super(message); this.name = "FluxSigninError"; this.code = code; }
}

const MESSAGES = Object.freeze({
  cancelled: "Sign-in was cancelled. Nothing was changed.",
  timeout: "Sign-in timed out. Try again, or paste your key instead.",
  browser: "Could not open your browser. Paste your key instead.",
  port: "Could not start the local sign-in listener. Paste your key instead.",
  rejected: "Sign-in did not finish. Try again, or paste your key instead.",
  no_code: "Sign-in did not return a code. Try again, or paste your key instead.",
  exchange: "Flux Router did not complete the sign-in. Try again, or paste your key instead.",
  bad_key: "Flux Router returned something that is not a key. Paste your key instead.",
  busy: "Sign-in is already open in your browser.",
  // bot email (contract r2.5): the token came back without email:owner, so bot email is not open on this Flux account yet
  email_dark: "Bot email opens on your Flux account soon. Everything else stays as it is.",
  FLUX_SIGNIN_UNAVAILABLE: "Sign in with Flux is not available yet. Paste your key instead.",
});
const fail = (code) => new FluxSigninError(code, MESSAGES[code] ?? MESSAGES.rejected);

/** readToken for the bot email owner sign-in (contract r2.5): a token that came back without email:owner (scopes [] while Flux's bot key
 *  switch is off) ends the sign-in with the calm `email_dark` line and stores nothing; otherwise the email:owner credential, or null. */
export function readEmailOwnerToken(body) {
  if (body && typeof body === "object" && typeof body.api_key === "string" && body.api_key.trim() && !emailOwnerScopeGranted(body)) throw fail("email_dark");
  return emailOwnerFromTokenResponse(body);
}

export function buildAuthorizeUrl({ authorizeUrl = FLUX_DESKTOP_AUTHORIZE_URL, redirectUri, challenge, state }) {
  const url = new URL(authorizeUrl);
  url.searchParams.set("client_id", FLUX_DESKTOP_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

export const redirectUriFor = (port) => `http://${LOOPBACK_HOST}:${port}${REDIRECT_PATH}`;

/** Map the loopback outcome to code, or a coded refusal. access_denied is the
 * consent page's Cancel button. */
export function interpretOutcome(outcome) {
  if (outcome && typeof outcome.code === "string" && outcome.code) return outcome.code;
  if (outcome?.error === "cancelled") throw fail(outcome.providerError === "access_denied" ? "cancelled" : outcome.providerError ? "rejected" : "no_code");
  throw fail(MESSAGES[outcome?.error] ? outcome.error : "rejected");
}

/** Bot email (contract r2.5, BOT-EMAIL-MURAGE-109 2.4): the owner act of turning email on asks the token route for `scope: "email:owner"`
 *  (the only value Flux accepts). Absent for the plain sign-in. */
export function tokenRequest({ code, verifier, redirectUri, scope }) {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri, ...(scope ? { scope } : {}) }),
  };
}

export function keyFromTokenResponse(body) {
  const value = body?.[TOKEN_RESPONSE_FIELD];
  return typeof value === "string" && isFluxKeyShape(value.trim()) ? value.trim() : null;
}

let active = null;

/** Cancel an open sign-in (Cancel button, app quit). */
/** The fluxDesktopSignin feature switch, read from a parsed config.json. Follows the single default in shared/flux-desktop-signin-default.mjs unless set. */
export function fluxDesktopSigninEnabledIn(config) {
  return fluxDesktopSigninOn(config?.features);
}

/** Throws FLUX_SIGNIN_UNAVAILABLE when the switch is off. */
export function assertFluxDesktopSigninEnabled(config) {
  if (!fluxDesktopSigninEnabledIn(config)) throw fail("FLUX_SIGNIN_UNAVAILABLE");
}

export function cancelFluxDesktopSignin() { active?.cancel(); }

/**
 * Run the flow. Resolves with `{ key }`; rejects with FluxSigninError.
 * Tests inject fetchImpl, openExternal and urls (a stub server).
 */
export async function runFluxDesktopSignin({
  openExternal,
  fetchImpl = globalThis.fetch,
  authorizeUrl = FLUX_DESKTOP_AUTHORIZE_URL,
  tokenUrl = FLUX_DESKTOP_TOKEN_URL,
  timeoutMs = FLUX_DESKTOP_SIGNIN_TIMEOUT_MS,
  exchangeTimeoutMs = FLUX_DESKTOP_EXCHANGE_TIMEOUT_MS,
  makeServer = createServer,
  pkce = createPkce(),
  /** Requested token scope (bot email: "email:owner"); the plain Flux key sign-in sends none. */
  scope,
  /** Reads the token response; resolves the value returned as `key`, or null (bad_key). Default: an sk-flux- account key. */
  readToken = keyFromTokenResponse,
} = {}) {
  if (active) throw fail("busy");
  let finishFlow = () => {};
  const handle = { cancel: () => finishFlow({ error: "cancelled", providerError: "access_denied" }) };
  active = handle;
  try {
    const outcome = await runLoopback({
      createServer: makeServer,
      path: REDIRECT_PATH,
      state: pkce.state,
      timeoutMs,
      register: ({ finish }) => { finishFlow = finish; },
      onListening: async (port) => {
        handle.port = port;
        await openExternal(buildAuthorizeUrl({ authorizeUrl, redirectUri: redirectUriFor(port), challenge: pkce.challenge, state: pkce.state }));
      },
    });
    const code = interpretOutcome(outcome);
    const request = tokenRequest({ code, verifier: pkce.verifier, redirectUri: redirectUriFor(outcome.port), scope });
    let response;
    try {
      response = await fetchImpl(tokenUrl, { method: "POST", ...request, redirect: "error", signal: AbortSignal.timeout(exchangeTimeoutMs) });
    } catch { throw fail("exchange"); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw fail("exchange");
    const key = await readToken(body);
    if (!key) throw fail("bad_key");
    return { key };
  } finally {
    active = null;
  }
}
