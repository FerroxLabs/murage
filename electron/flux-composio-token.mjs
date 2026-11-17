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
