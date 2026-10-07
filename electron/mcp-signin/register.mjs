// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dynamic client registration (RFC 7591, MCP-LINK 3.7 step 4). Murage is a
// public native client: no secret asked for, one loopback redirect. A stored
// registration is reused for the same issuer while the loopback port is the one
// it was registered with; a different port means a new registration, because
// many servers match the redirect exactly.
import { guardedRequest } from "../../shared/guarded-http.mjs";
import { LIMITS } from "../../shared/remote-mcp-url.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clientText = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\0]/.test(value);

/** The stored registration if it can be used for this issuer and port. */
export function reusableClient(oauth, issuer, port) {
  if (!isRecord(oauth) || oauth.issuer !== issuer || oauth.redirectPort !== port || !clientText(oauth.clientId)) return null;
  return { clientId: oauth.clientId, ...(clientText(oauth.clientSecret) ? { clientSecret: oauth.clientSecret } : {}) };
}

export function registrationBody(redirectUri) {
  return {
    client_name: "Murage",
    application_type: "native",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * @returns {Promise<{ ok: true, clientId: string, clientSecret?: string } | { ok: false, error: "no-registration" | "network" }>}
 */
export async function registerClient({ registrationEndpoint, redirectUri, local, request = guardedRequest, signal }) {
  let response;
  try {
    response = await request({
      url: registrationEndpoint, method: "POST", kind: "register", mode: "request", confirmed: local ?? null,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(registrationBody(redirectUri)), maxBytes: LIMITS.registerBytes, signal,
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (response.status >= 500) return { ok: false, error: "network" };
  if (response.status !== 200 && response.status !== 201) return { ok: false, error: "no-registration" };
  let json = null;
  try { json = JSON.parse(Buffer.from(response.body).toString("utf8")); } catch { json = null; }
  if (!isRecord(json) || !clientText(json.client_id)) return { ok: false, error: "no-registration" };
  return { ok: true, clientId: json.client_id, ...(clientText(json.client_secret) ? { clientSecret: json.client_secret } : {}) };
}
