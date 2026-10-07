// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Token revocation (RFC 7009, MCP-LINK 3.7 step 11): the refresh token first,
// then the access token, each to the endpoint the server advertised. A 200 is
// done (7009 answers 200 for a token that is already dead too); a 400
// `invalid_token` is a confirmed dead token. Anything else is a failure, and
// the caller decides whether to keep the tokens (sign out) or forget them
// anyway (remove).
import { guardedRequest } from "../../shared/guarded-http.mjs";
import { LIMITS } from "../../shared/remote-mcp-url.mjs";

/**
 * @returns {Promise<{ revoked: true } | { revoked: false, reason: "not-offered" | "nothing" | "failed" }>}
 */
export async function revokeTokens(oauth, { request = guardedRequest, signal } = {}) {
  const tokens = [[oauth?.refreshToken, "refresh_token"], [oauth?.accessToken, "access_token"]].filter(([token]) => typeof token === "string" && token);
  if (tokens.length === 0) return { revoked: false, reason: "nothing" };
  // No client registration (the server rejected it, `invalid_client`): there is no client to
  // revoke as, and the server would refuse. The caller forgets the tokens locally.
  if (typeof oauth.clientId !== "string" || !oauth.clientId) return { revoked: false, reason: "not-offered" };
  if (typeof oauth.revocationEndpoint !== "string") return { revoked: false, reason: "not-offered" };
  for (const [token, hint] of tokens) {
    let response;
    try {
      response = await request({
        url: oauth.revocationEndpoint, method: "POST", kind: "token", mode: "request", confirmed: oauth.local ?? null,
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: oauth.clientId, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}) }).toString(),
        maxBytes: LIMITS.tokenBytes, signal,
      });
    } catch {
      return { revoked: false, reason: "failed" };
    }
    if (response.status === 200) continue;
    let code = "";
    try { code = String(JSON.parse(Buffer.from(response.body).toString("utf8"))?.error ?? ""); } catch { code = ""; }
    if (response.status === 400 && code === "invalid_token") continue;
    return { revoked: false, reason: "failed" };
  }
  return { revoked: true };
}
