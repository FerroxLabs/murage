// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE resolver for the control plane the desktop talks to and the signing key it trusts.
// Shared by cloud-home-client (base URL + pinned JWK) and companion-account-service (default URL).
//
// Order: MURAGE_CONTROL_PLANE_URL when it names a PINNED origin (one with a JWK built into the app),
// then the built-in prod entry. An origin with no pin, or a pin with no JWK, is refused and never trusted.
// Both entries carry their own key, and a home-key envelope is verified only against the key of the environment in use.
// Staging is reachable only for qualification (developer override on; MURAGE_CLOUD_CP=prod opts out)
// or by MURAGE_CONTROL_PLANE_URL naming the staging origin; it is never a customer-facing result.
import { normalizeControlPlaneURL } from "./control-plane-client.mjs";

/**
 * CP public verification keys built into the app, and the site Connect opens for each. prod.jwk is the production CP
 * signing key's public half (P-256, public members only). Having the key does not open Cloud to customers: the runtime
 * live gate (cloud-live.mjs) does, and only while the production control plane answers /v1/status with {"live":true}.
 * No user setting is involved.
 */
export const CLOUD_HOME_CP = Object.freeze({
  staging: Object.freeze({
    baseUrl: "https://murage-control-plane-staging.sean-874.workers.dev",
    siteOrigin: "https://murage-site-preview.vercel.app",
    jwk: Object.freeze({ kty: "EC", crv: "P-256", x: "i5M-386m8yAMLeXSx5h7WbET_2AafxG1j1slNbR0ryw", y: "QkbUUqaVFP311VUhx04G7cOXxalr_Xs6AmekK1JJX88" }),
  }),
  prod: Object.freeze({ baseUrl: "https://accounts.murage.ai", siteOrigin: "https://murage.ai", jwk: Object.freeze({ kty: "EC", crv: "P-256", x: "B3u5CZzfv4sBQKMvGYS-zblweYQNdEx_fBpOnpc8_KY", y: "bt8PYOR1VLwj1b-WbG6M81RHC_NJ4N1BX8OV0ai3gyU" }) }),
});

export const DEFAULT_CONTROL_PLANE_URL = CLOUD_HOME_CP.prod.baseUrl;

/** The origin MURAGE_CONTROL_PLANE_URL names, "" when unset, null when set but not a valid control-plane origin. */
export function configuredControlPlaneOrigin(environment = {}) {
  if (!Object.hasOwn(environment, "MURAGE_CONTROL_PLANE_URL")) return "";
  return normalizeControlPlaneURL(environment.MURAGE_CONTROL_PLANE_URL) || null;
}

/**
 * @returns {{ environment: "staging" | "prod", baseUrl: string, siteOrigin?: string, jwk: object, source: "env" | "qualification" | "builtin" } | null}
 * null means refuse: unpinned origin, or a pin without its JWK.
 */
export function resolveCloudControlPlane({ env = {}, qualification = false, table = CLOUD_HOME_CP } = {}) {
  const pick = (environment, source) => {
    const entry = table[environment];
    return entry?.jwk && entry.baseUrl ? { environment, baseUrl: entry.baseUrl, siteOrigin: entry.siteOrigin, jwk: entry.jwk, source } : null;
  };
  const configured = configuredControlPlaneOrigin(env);
  if (configured === null) return null;
  if (configured) {
    const environment = Object.keys(table).find((name) => normalizeControlPlaneURL(table[name].baseUrl) === configured);
    return environment ? pick(environment, "env") : null;
  }
  // Developer override on: staging unless MURAGE_CLOUD_CP=prod (the pre-existing qualification default).
  if (qualification && env.MURAGE_CLOUD_CP !== "prod") return pick("staging", "qualification");
  return pick("prod", "builtin");
}
