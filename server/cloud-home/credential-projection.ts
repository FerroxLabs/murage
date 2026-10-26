// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CLOUD_MODEL_SIGNINS_KEY } from "./model-signin.ts";

/** Sealed-only: broker tokens of replaced Flux keys awaiting a confirmed revoke (JSON array, at most PENDING_REVOKE_MAX). */
export const PENDING_REVOKES_KEY = "fluxComposioPendingRevokeTokens";
/** The 1.0.4 single-token field; read and migrated into the list, never written again. */
export const LEGACY_PENDING_REVOKE_KEY = "fluxComposioPendingRevokeToken";
export const PENDING_REVOKE_MAX = 4;
const sealedOnly = (key: string) => key === PENDING_REVOKES_KEY || key === LEGACY_PENDING_REVOKE_KEY;

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
  return Object.fromEntries(Object.entries(records).filter(([key]) => key !== CLOUD_MODEL_SIGNINS_KEY && !sealedOnly(key)));
}

export function isGenericCredentialPatch(records: Record<string, unknown>): boolean {
  return !Object.hasOwn(records, CLOUD_MODEL_SIGNINS_KEY) && !Object.hasOwn(records, PENDING_REVOKES_KEY) && !Object.hasOwn(records, LEGACY_PENDING_REVOKE_KEY) && Object.values(records).every(value => typeof value === "string");
}

export function connectedAppsCredentials(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(["fluxApiKey", ...brokerFields].filter(key => typeof records[key] === "string").map(key => [key, records[key]]));
}

export function connectedAppsPatch(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(brokerFields.map(key => [key, typeof records[key] === "string" ? records[key] : ""]));
}
