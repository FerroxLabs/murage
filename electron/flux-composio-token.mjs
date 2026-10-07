// The FluxRouter connected-apps broker token.
//
// Two credentials, on purpose. The Flux API key reaches every engine (the
// claude CLI gets it as ANTHROPIC_API_KEY), so it must never be what unlocks
// the user's Gmail: any shell command a model runs could otherwise read mail
// past the owner's per-bot restrictions. The key is used ONCE, here, to mint
// a per-account broker token that only the harness holds and that is stripped
// from every engine environment. Only the STORED key mints; the ambient shell
// FLUX_API_KEY never does, so data calls and the legacy claim can never target
// two different accounts.
import { createHash } from "node:crypto";
import { normalizeManagedComposioBrokerUrl } from "./managed-composio.mjs";
import { isFluxKeyShape } from "./provider-connections.mjs";

export const FLUX_BROKER_TOKEN = /^[0-9a-f]{64}$/;
export const FLUX_COMPOSIO_TOKEN_FIELDS = Object.freeze([
  "fluxComposioBrokerToken",
  "fluxComposioBrokerTokenExpiresAt",
  "fluxComposioBrokerTokenKeyFingerprint",
  "fluxComposioAccountKind",
  "fluxComposioTokenError",
  "fluxComposioTokenRefusedKeyFingerprint",
]);
/** Re-mint once fewer than this many milliseconds of the token remain. */
export const FLUX_BROKER_TOKEN_REMINT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ERROR_CODE = /^[a-z_]{1,64}$/;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Names a token without carrying it: enough to tell "the token that was
 * rejected" from "the token held now". Never the token itself. */
export function brokerTokenFingerprint(token) {
  return sha256Hex(`broker-token:${token}`).slice(0, 16);
}

/** Which key minted the token, without keeping the key's hash whole. */
export function fluxKeyFingerprint(fluxKey) {
  return sha256Hex(fluxKey).slice(0, 16);
}

export function clearFluxComposioBrokerToken(credentials) {
  const next = { ...credentials };
  for (const field of FLUX_COMPOSIO_TOKEN_FIELDS) delete next[field];
  return next;
}

/** Best effort: a revoked or unreachable token is fine either way. */
export async function revokeFluxComposioBrokerToken({
  fluxBrokerUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
}) {
  const url = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  if (!url || !FLUX_BROKER_TOKEN.test(token ?? "")) return false;
  try {
    const response = await fetchImpl(`${url}/v1/tokens/current`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: timeoutSignal(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Mint or keep the broker token. Returns the next credentials document (a
 * copy) and never throws: this is optional background work. */
export async function ensureFluxComposioBrokerToken({
  fluxBrokerUrl,
  credentials,
  fluxKey,
  fetchImpl = globalThis.fetch,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = Date.now(),
  force = false,
  rejectedTokenFingerprint,
  onRateLimited = () => {},
  onTransientFailure = () => {},
  /** When given, the previous token is NOT revoked here: it is queued as
   * `{ fluxBrokerUrl, previous, minted }` for the caller to settle once the
   * new document is saved (revoke `previous` if it was, `minted` if it was
   * discarded), so a discarded result cannot orphan a token. */
  revokeSink,
  label = "murage-desktop",
}) {
  const url = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  const next = { ...credentials };
  if (!url) return next;
  // Only a Flux key is ever sent to Flux. A base URL, a short value or another
  // provider's key in the Flux slot is treated as no key at all (2026-10-01:
  // an install sent an sk- key Flux never issued here every ten minutes).
  const key = typeof fluxKey === "string" && isFluxKeyShape(fluxKey) ? fluxKey.trim() : "";
  const previousToken = FLUX_BROKER_TOKEN.test(next.fluxComposioBrokerToken ?? "") ? next.fluxComposioBrokerToken : null;
  if (!key) {
    // The key is gone: the token it minted goes with it. Revoke it at Flux so
    // it stops working immediately rather than at its expiry.
    if (previousToken) await revokeFluxComposioBrokerToken({ fluxBrokerUrl: url, token: previousToken, fetchImpl, timeoutSignal });
    return clearFluxComposioBrokerToken(next);
  }
  const fingerprint = fluxKeyFingerprint(key);
  // A forced re-mint is only for the token that was actually rejected. A
  // straggler naming a token that has since been replaced (several calls in
  // one turn all got the same 401) must not mint again.
  if (force && rejectedTokenFingerprint && previousToken && brokerTokenFingerprint(previousToken) !== rejectedTokenFingerprint) {
    force = false;
  }
  // Flux refused this exact key before: do not ask again until it changes.
  if (!force && next.fluxComposioTokenRefusedKeyFingerprint === fingerprint) return next;
  const expiresAt = Date.parse(next.fluxComposioBrokerTokenExpiresAt ?? "");
  if (
    !force
    && previousToken
    && next.fluxComposioBrokerTokenKeyFingerprint === fingerprint
    && Number.isFinite(expiresAt)
    && expiresAt - now > FLUX_BROKER_TOKEN_REMINT_WINDOW_MS
  ) return next;

  let response;
  try {
    response = await fetchImpl(`${url}/v1/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ label }),
      redirect: "error",
      signal: timeoutSignal(15_000),
    });
  } catch (error) {
    log(`FluxRouter connected-apps token request failed: ${error?.name === "TimeoutError" ? "timed out" : "network error"}`);
    onTransientFailure();
    return next;
  }
  const body = await response.json().catch(() => null);
  if (response.ok) {
    const kind = body?.accountKind === "personal" ? "personal" : "shared";
    if (!FLUX_BROKER_TOKEN.test(body?.token ?? "") || !Number.isFinite(Date.parse(body?.expiresAt ?? ""))) {
      log("FluxRouter returned an invalid connected-apps token");
      onTransientFailure();
      return next;
    }
    next.fluxComposioBrokerToken = body.token;
    next.fluxComposioBrokerTokenExpiresAt = new Date(Date.parse(body.expiresAt)).toISOString();
    next.fluxComposioBrokerTokenKeyFingerprint = fingerprint;
    next.fluxComposioAccountKind = kind;
    delete next.fluxComposioTokenError;
    delete next.fluxComposioTokenRefusedKeyFingerprint;
    if (previousToken && previousToken !== body.token) {
      // Mint first, then end THIS install's own previous token (never another
      // device's: it is the one this document held), so the app is never
      // tokenless and a renewal does not leave two live tokens counting
      // against the account's cap. Best effort: it may already be dead.
      if (revokeSink) revokeSink.push({ fluxBrokerUrl: url, previous: previousToken, minted: body.token });
      else await revokeFluxComposioBrokerToken({ fluxBrokerUrl: url, token: previousToken, fetchImpl, timeoutSignal });
    }
    log("FluxRouter connected-apps token ready");
    return next;
  }
  if (response.status === 401 || response.status === 403) next.fluxComposioTokenRefusedKeyFingerprint = fingerprint;
  if ([401, 402, 403].includes(response.status) && typeof body?.code === "string" && ERROR_CODE.test(body.code)) {
    // Keep whatever token exists: data routes never consult the key's model
    // budget, so a token minted before the budget ran out keeps working.
    next.fluxComposioTokenError = body.code;
    log(`FluxRouter declined a connected-apps token (${body.code})`);
    return next;
  }
  if (response.status === 429) onRateLimited();
  else if (response.status >= 500 || response.status === 408 || response.status === 404) onTransientFailure();
  log(`FluxRouter connected-apps token request returned HTTP ${response.status}`);
  return next;
}
