// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { OWNER_REVOKES_KEY } from "./email-owner-revokes.ts";
import { CLOUD_MODEL_SIGNINS_KEY } from "./model-signin.ts";
import { isHomeFluxKey } from "./flux-home-gate.ts";
import { isPrimaryFluxKeyShape, serializedFluxViolation } from "./flux-key-policy.ts";
import { isSignInEngineCredentialName, looksLikeFlux } from "./engine-flux-guard.ts";

/** Sealed-only: broker tokens of replaced Flux keys awaiting a confirmed revoke (JSON array, at most PENDING_REVOKE_MAX). */
export const PENDING_REVOKES_KEY = "fluxComposioPendingRevokeTokens";
/** The 1.0.4 single-token field; read and migrated into the list, never written again. */
export const LEGACY_PENDING_REVOKE_KEY = "fluxComposioPendingRevokeToken";
export const PENDING_REVOKE_MAX = 4;
/** Sealed-only: the key generation of the last renewal hand-off applied, and when (ms) the owner last saved a different key. */
export const FLUX_KEY_GENERATION_KEY = "fluxKeyGeneration";
export const FLUX_KEY_OWNER_SAVED_AT_KEY = "fluxKeyOwnerSavedAtMs";
/** Sealed-only: the whole sanitized bot-email key doc as one JSON string (CLOUD-EMAIL-KEYSTORE-1019). Matches the boot pipe's credential-name rule. */
export const BOT_EMAIL_SECRETS_KEY = "botEmailSecrets";
const sealedOnly = (key: string) => key === OWNER_REVOKES_KEY || key === PENDING_REVOKES_KEY || key === LEGACY_PENDING_REVOKE_KEY || key === FLUX_KEY_GENERATION_KEY || key === FLUX_KEY_OWNER_SAVED_AT_KEY || key === BOT_EMAIL_SECRETS_KEY;

/** The pending revokes, oldest first; a legacy single-field value is migrated in. */
export function pendingRevokes(records: Record<string, string>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value && !out.includes(value)) out.push(value); };
  try { const list: unknown = JSON.parse(records[PENDING_REVOKES_KEY] || "[]"); if (Array.isArray(list)) list.forEach(add); } catch { /* unreadable list: only the legacy field survives */ }
  add(records[LEGACY_PENDING_REVOKE_KEY]);
  return out;
}

/** The sealed write that stores `tokens` (and retires the legacy field). */
export function pendingRevokesPatch(tokens: string[]): Record<string, string> {
  return { [PENDING_REVOKES_KEY]: tokens.length ? JSON.stringify(tokens) : "", [LEGACY_PENDING_REVOKE_KEY]: "" };
}
const brokerFields = ["fluxComposioBrokerToken", "fluxComposioBrokerTokenExpiresAt", "fluxComposioBrokerTokenKeyFingerprint", "fluxComposioAccountKind", "fluxComposioTokenError"] as const;

/** The model manager alone owns its sealed document. */
export function serverCredentialProjection(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(records).filter(([key, value]) => key !== CLOUD_MODEL_SIGNINS_KEY && !sealedOnly(key) && !(isSignInEngineCredentialName(key) && looksLikeFlux(value)) && serializedFluxViolation(value) === null));
}

/** A home holds only the key Flux issued for it (B4, finding C-01). The owner's primary Flux key is never accepted here. */
export function isGenericCredentialPatch(records: Record<string, unknown>): boolean {
  if (Object.hasOwn(records, OWNER_REVOKES_KEY) || Object.hasOwn(records, BOT_EMAIL_SECRETS_KEY) || Object.hasOwn(records, CLOUD_MODEL_SIGNINS_KEY) || Object.hasOwn(records, PENDING_REVOKES_KEY) || Object.hasOwn(records, LEGACY_PENDING_REVOKE_KEY) || !Object.values(records).every(value => typeof value === "string")) return false;
  if (Object.hasOwn(records, "fluxApiKey") && records.fluxApiKey !== "" && !isHomeFluxKey(records.fluxApiKey)) return false;
  // Every other slot too: a primary Flux key saved as, say, openaiCompatKey is the same theft by another door.
  if (Object.entries(records).some(([name, value]) => isSignInEngineCredentialName(name) && looksLikeFlux(value))) return false;
  // Hole 7: parse every serialized credential (the provider bank is a JSON string) and look inside, recursively.
  if (Object.values(records).some(value => serializedFluxViolation(value) !== null)) return false;
  return Object.entries(records).every(([name, value]) => name === "fluxApiKey" || !isPrimaryFluxKeyShape(value as string));
}

export function connectedAppsCredentials(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(["fluxApiKey", ...brokerFields].filter(key => typeof records[key] === "string").map(key => [key, records[key]]));
}

export function connectedAppsPatch(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(brokerFields.map(key => [key, typeof records[key] === "string" ? records[key] : ""]));
}
