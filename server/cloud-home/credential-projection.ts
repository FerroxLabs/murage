// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CLOUD_MODEL_SIGNINS_KEY } from "./model-signin.ts";

const brokerFields = ["fluxComposioBrokerToken", "fluxComposioBrokerTokenExpiresAt", "fluxComposioBrokerTokenKeyFingerprint", "fluxComposioAccountKind", "fluxComposioTokenError"] as const;

/** The model manager alone owns its sealed document. */
export function serverCredentialProjection(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(records).filter(([key]) => key !== CLOUD_MODEL_SIGNINS_KEY));
}

export function isGenericCredentialPatch(records: Record<string, unknown>): boolean {
  return !Object.hasOwn(records, CLOUD_MODEL_SIGNINS_KEY) && Object.values(records).every(value => typeof value === "string");
}

export function connectedAppsCredentials(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(["fluxApiKey", ...brokerFields].filter(key => typeof records[key] === "string").map(key => [key, records[key]]));
}

export function connectedAppsPatch(records: Record<string, string>): Record<string, string> {
  return Object.fromEntries(brokerFields.map(key => [key, typeof records[key] === "string" ? records[key] : ""]));
}
